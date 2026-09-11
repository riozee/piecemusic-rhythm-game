/**
 * Uploads the song archives in public/levels/*.zip to Cloudflare R2.
 * The Worker serves them at /levels/<name>.zip via the LEVELS binding.
 *
 * Usage:
 *   bun run upload:levels                    # default bucket "piecemusic-rhythm-game"
 *   R2_BUCKET=my-bucket bun run upload:levels
 *
 * The archives are served publicly at https://data.piecemusic.party/<name>.zip.
 * Requires `wrangler` to be authenticated (`wrangler login`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const levelsDir = path.resolve(root, "public", "levels");
const bucket = process.env.R2_BUCKET || "piecemusic-rhythm-game";

const zips = fs
  .readdirSync(levelsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
  .map((entry) => entry.name);

if (zips.length === 0) {
  console.error("No .zip files found in public/levels/");
  process.exit(1);
}

for (const name of zips) {
  const file = path.resolve(levelsDir, name);
  console.log(`Uploading ${name} -> r2://${bucket}/${name}`);
  execFileSync(
    "wrangler",
    [
      "r2",
      "object",
      "put",
      `${bucket}/${name}`,
      "--file",
      file,
      "--content-type",
      "application/zip",
    ],
    { cwd: root, stdio: "inherit" },
  );
}

console.log(`Uploaded ${zips.length} archive(s) to bucket "${bucket}".`);
