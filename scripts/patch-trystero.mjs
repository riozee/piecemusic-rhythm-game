// Patches Trystero's WebRTC data channel to be low-latency:
//   - ordered: false        -> no head-of-line blocking on packet loss
//   - maxRetransmits: 0     -> don't wait for retransmission (real-time input)
//
// This is the single data channel used for ALL Trystero actions (keys, commands,
// state, clock-sync pings). The phone compensates by sending duplicate "down"
// key events (see WebRtcClient.sendKey).
//
// Idempotent: safe to run on every `postinstall`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(
  root,
  "node_modules",
  "@trystero-p2p",
  "core",
  "dist",
  "peer.mjs",
);

let src;
try {
  src = readFileSync(target, "utf8");
} catch (err) {
  console.warn(
    "[patch-trystero] target not found (package not installed?):",
    target,
  );
  process.exit(0);
}

if (src.includes("maxRetransmits: 0")) {
  console.log("[patch-trystero] already patched, skipping.");
  process.exit(0);
}

// Matches pc.createDataChannel("data") or pc.createDataChannel('data').
const pattern = /pc\.createDataChannel\((["'])data\1\)/;

if (!pattern.test(src)) {
  console.warn(
    "[patch-trystero] createDataChannel call not found; nothing patched.",
  );
  process.exit(0);
}

src = src.replace(
  pattern,
  'pc.createDataChannel("data", { ordered: false, maxRetransmits: 0 })',
);

writeFileSync(target, src);
console.log(
  "[patch-trystero] patched data channel -> { ordered: false, maxRetransmits: 0 }",
);
