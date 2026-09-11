# AGENTS.md — Performance Optimization Handoff

## Project Overview

**piecemusic-rhythm-game** — A high-precision 2D rhythm game built with Svelte 5 (Runes), Tailwind CSS, and Three.js (unused for core rendering). Audio-visual sync down to milliseconds. Players hit notes as a playhead traverses a 2D track path.

### Stack

- Svelte 5 (`$state`, `$derived`, `$effect`, `$state.raw`)
- Vite 8, TypeScript 6
- Three.js / Threlte (in deps but NOT used for note/track rendering)
- Web Audio API for audio playback
- SVG DOM for all rendering (track path, notes, grid, playhead)

### Core Problem

Severe FPS drops during chart editing and long-chart gameplay. Bottleneck is main-thread execution: SVG DOM overload, reactive state churn, and rendering pipeline inefficiency.

---

## Architecture

### Rendering Pipeline

**Gameplay (`RhythmPlayCanvas.svelte`) is Canvas 2D; the editor (`EditScreen.svelte`) is still SVG DOM.**

- Gameplay notes: Canvas `fillRect`/`strokeRect` + `fillText` drawn each frame (no per-frame DOM)
- Gameplay track path: Canvas `Path2D` built with `quadraticCurveTo`/`lineTo` (true Bézier, smooth)
- Gameplay grid: Canvas `Path2D` from `computePlaneGrid().pathD` (cached, stroked each frame)
- Gameplay playhead: Canvas `arc()` at `smoothPointAtProgress(metrics, prog)` — arc-length parameterized on the same Bézier path (zero drift)
- Gameplay camera: `ctx.setTransform()` per frame (no CSS/DOM)
- Editor: SVG DOM (unchanged)

### Key Files

| File                                     | Purpose                                                                     | Lines |
| ---------------------------------------- | --------------------------------------------------------------------------- | ----- |
| `src/components/RhythmPlayCanvas.svelte` | **Gameplay renderer** — renders track, notes, playhead during play          | ~444  |
| `src/components/EditScreen.svelte`       | **Chart editor** — full editing UI with PiP preview                         | ~2985 |
| `src/core/sync-engine.ts`                | **Audio/video sync** — master (audio) / slave (video) with drift correction | ~315  |
| `src/core/track-math.ts`                 | **Path math** — Bézier sampling, time↔progress tables, coordinate mapping   | ~1020 |
| `src/core/grid.ts`                       | **Grid generation** — adaptive LOD grid SVG path                            | ~164  |
| `src/core/viewport.ts`                   | **Viewport manager** — fullscreen, orientation, resize                      | ~146  |
| `src/types/track.ts`                     | **Data types** — `TrackNote`, `TrackNode`, `TrackData`, etc.                | ~34   |
| `src/App.svelte`                         | **Root orchestrator** — screen routing, media loading, game clock           | ~762  |

### Data Flow

```
TrackData (nodes, bends, speedBPs, zoomBPs, notes, planeW, planeH)
    ↓
generatePathData() → SVG path string
buildTimeProgressTable() → time↔progress lookup table (O(log N) binary search)
sampleTrackPoints() → pure-math polyline samples (for hit detection)
    ↓
Game loop ($effect reacting to currentTimeSec):
    getTimeToProgress(time) → progress (0..1)
    svgPathEl.getPointAtLength(progress * totalLen) → playhead (x,y)
    CSS translate3d + scale → camera follows playhead
    visibleNotes $derived filter → only render on-screen notes
```

### Game Loop Architecture

- **Gameplay**: `$effect` in RhythmPlayCanvas reacts to `currentTimeSec` prop (updated by sync engine's RAF loop in App.svelte)
- **Editor**: Event-driven (mouse handlers) + `pipLoop` RAF for PiP preview playback
- **Sync Engine**: `requestAnimationFrame` loop calling `updateSmoothedAudioTime()` → `stepSync()` → `notifyState()` → listeners update `gameElapsedSec` in App.svelte

### Note Hit Detection

- Spatial AABB check: playhead (x,y) tested against note bounding boxes with 20px margin
- Currently O(N) linear scan over ALL notes on every keystroke
- Keys: Z/D/F = red notes, X/J/K = green notes

---

## Changes Already Implemented

### Phase 1: Quick Wins ✅

1. **`$state` → `$state.raw` for chart data** (EditScreen.svelte L85-103, L337, L340)
   - `nodes`, `bends`, `speedBPs`, `zoomBPs`, `notes`, `pathSamples`, `timeProgressTable`
   - All in-place mutation sites fixed with reference reassignment (`arr = arr`)
   - Eliminates deep Proxy trap overhead on every array access/iteration

2. **Grid zoom quantization** (EditScreen.svelte L334)
   - `gridZoomTier = $derived(Math.round(zoom * 4) / 4)` — grid only recomputes at 0.25 boundaries
   - Prevents expensive `computePlaneGrid()` on every scroll pixel

3. **Deferred `captureState`** (EditScreen.svelte L502)
   - `dragStateBackup = null` on mousedown instead of `JSON.stringify(allData)`
   - Capture deferred to first mousemove (when actual mutation begins) or right before deletion
   - Eliminates multi-ms stall on every click for large charts

4. **Audio clock interpolation** (sync-engine.ts L94-127)
   - `updateSmoothedAudioTime()` now interpolates between coarse `audio.currentTime` updates using `performance.now()` delta
   - Monotonic, seek-aware, duration-clamped
   - Eliminates camera micro-stutter between 50-100ms browser audio clock updates

5. **Note IDs + keyed `{#each}`** (track.ts, track-math.ts, EditScreen.svelte, RhythmPlayCanvas.svelte)
   - `TrackNote` now has `id: string` field
   - All creation sites generate `crypto.randomUUID()`
   - `{#each}` blocks use `(note.id ?? fallback)` keys for efficient DOM reconciliation
   - **IMPORTANT**: Keys use `?? \`\_${index}\`` fallback for robustness against data without IDs

6. **Hit effect GC fix** (RhythmPlayCanvas.svelte L231-246)
   - Replaced `[...hitEffects, {...}]` spread + `.filter()` with `.push()` + `.splice()` + reference reassignment
   - Zero new array allocations per note hit

### Phase 2: Viewport Culling ✅ (with critical fix applied)

7. **Gameplay viewport culling** (RhythmPlayCanvas.svelte L68-84, L196-201)
   - `viewLeft/Top/Right/Bottom` as `$state` — updated per frame from camera position + viewport dimensions
   - `visibleNotes = $derived.by(...)` filters notes by AABB overlap with viewport (200px margin)
   - Template renders `visibleNotes` instead of `trackData.notes`
   - Hit detection still checks ALL notes (not affected by culling)
   - **BUG FOUND AND FIXED**: viewport bounds were originally plain `let` (not `$state`), making culling completely non-reactive. Fixed to `$state`.

8. **Editor viewport culling** (EditScreen.svelte L109-128)
   - `visibleEditorNotes = $derived.by(...)` using `panX/panY/zoom/viewportW/viewportH` (all `$state`)
   - `ResizeObserver` tracks viewport dimensions
   - Main canvas renders only visible notes
   - Editor uses correct `$state` variables — culling is reactive ✅

9. **PiP conditional rendering** (EditScreen.svelte ~L2283)
   - PiP note layer wrapped in `{#if activeTool === 'PREVIEW'}`
   - Zero PiP note SVG elements during editing (only shown in preview mode)

### Path Sampling Changes ⚠️ (partially reverted)

10. **`rebuildPathMetrics` always computes pathSamples** (RhythmPlayCanvas.svelte L90-93)
    - `sampleTrackPoints()` with 600 samples always runs (not just as SVG fallback)
    - Samples used for hit detection (`getPointOnTrack` in `handleRhythmInput`)
11. **Playhead position: reverted to `getPointAtLength`** (RhythmPlayCanvas.svelte L179-182) — ⚠️ OBSOLETE after Phase 3
    - Camera $effect uses `svgPathEl.getPointAtLength()` for pixel-perfect playhead attachment
    - **IMPORTANT**: Do NOT replace this with `getPointOnTrack` — the sampled path has visible precision drift from the rendered SVG path, causing the playhead to detach from the line
    - One `getPointAtLength` call per frame is acceptable (~0.05ms)
    - Hit detection still uses `getPointOnTrack` (20px margin makes precision irrelevant)

### Phase 3: Canvas 2D Gameplay Renderer ✅

12. **Full Canvas 2D rewrite of `RhythmPlayCanvas.svelte`**
    - All gameplay rendering (grid, notes, track path, progress path, speed ticks, playhead, hit effects) now draws to a single `<canvas>` every `requestAnimationFrame`.
    - No per-frame Svelte reactivity or DOM reconciliation: `currentTimeSec`, `containerWidth/Height` are read imperatively inside the RAF loop.
    - Track path is a `Path2D` built with `quadraticCurveTo`/`lineTo`; the playhead uses `buildSmoothTrackMetrics`/`smoothPointAtProgress` (Gauss-Legendre arc length + Newton refinement) for pixel-perfect attachment with **zero drift** (rule #2 only applies to the editor now).
    - Grid and speed ticks are cached `Path2D` objects; notes are culled via the x-sorted index before `fillRect`/`fillText`.
    - DPR-aware backing store (capped at 2x) with `ctx.setTransform` camera.
    - `handleRhythmInput` unchanged in signature; internal state is now plain (non-reactive) values.

### Phase 4: WebRTC Latency Compensation ✅

13. **Clock sync between host and phone** (`src/core/webrtc.ts`)
    - `WebRtcHost` pings the phone every 1.5s (`"ping"` action) and receives `"pong"` replies, maintaining an exponentially-smoothed `clockOffsetMs` estimate (`phoneClock - hostClock`). Exposed via `getClockOffsetMs()`.
    - `WebRtcClient` answers pings by echoing `{ pingT, phoneT: performance.now() }`.
14. **Press-time judgment (not arrival-time)** (`src/App.svelte`, `RhythmPlayCanvas.svelte`, `sync-engine.ts`)
    - `App.svelte` `onKeyMessage` converts the phone's `event.timestamp` into host audio time: `syncEngine.hostClockToAudioTime(event.timestamp - offsetMs)` and passes it to `handleRhythmInput(event.key, pressAudioTime)`.
    - `handleRhythmInput(rawKey, pressAudioTime?)` computes `judgeProgress = getTimeToProgress(timeTable, pressAudioTime, chartDuration)` when `pressAudioTime` is provided; local keyboard input omits it and uses live `currentProgress`.
    - `MasterSlaveSyncEngine.hostClockToAudioTime(hostPerfNow)` returns the linear interpolation `lastRawAudioTime + (hostPerfNow - lastAudioPerfTime)/1000` (NOT clamped monotonic — may be in the past).

**Effect**: network latency (~20-150ms) no longer shifts note timing — hits are judged at the exact moment the phone registered the touch. Only the visual hit feedback is delayed by the remaining latency.

### Phase 5: Low-Latency Data Channel (unordered + unreliable) ✅

15. **Trystero data channel patched to `{ ordered: false, maxRetransmits: 0 }`**
    - `scripts/patch-trystero.mjs` rewrites `pc.createDataChannel("data")` → `pc.createDataChannel("data", { ordered: false, maxRetransmits: 0 })` in `@trystero-p2p/core/dist/peer.mjs` (idempotent).
    - Registered as the `postinstall` script in `package.json`; bun runs root `postinstall` on `bun install`.
    - Removes SCTP head-of-line blocking: a lost packet no longer stalls all subsequent key events.
16. **Duplicate `down` events** (`WebRtcClient.sendKey`)
    - The phone sends 3 copies of each `"down"` (0ms / +4ms / +8ms) with the SAME `timestamp`, so they are idempotent on the host (press-time judgment + `playNotesStatus` dedup). A single dropped packet can no longer eat a note hit.

**Caveat**: the single data channel carries ALL actions (keys, commands, state, clock pings). Only `"down"` is duplicated — rare command drops (pause/restart) are possible and recoverable by re-tap. Clock-sync pings tolerate loss via the 1.5s re-ping + EMA smoothing.

---

## Known Issues & Pitfalls

### Critical Rules for Future Agents

1. **Never use plain `let` for variables read by `$derived`** — they must be `$state` or Svelte won't track changes
2. **Gameplay playhead is NOT `getPointAtLength` anymore** — Canvas draws the same `pathSamples` polyline used for hit detection and the playhead, so there is zero drift. In the **editor**, the SVG `<path>` and math-sampled polyline still differ; keep using `getPointAtLength` there.
3. **`$state.raw` requires a NEW reference after in-place mutation** — after `.splice()`, `.push()`, `.forEach(mutate)`, `delete obj[key]`, always reassign a fresh reference: `arr = [...arr]` or `obj = { ...obj }`. ⚠️ `arr = arr` (same reference) does NOT trigger reactivity — Svelte's raw setter skips equal values (verified in `svelte/src/internal/client/reactivity/sources.js` `internal_set`).
4. **Note `id` field is required** — all note creation must include `id: crypto.randomUUID()`. The `{#each}` keys use `note.id ?? fallback` but fresh data should always have IDs.
5. **The sync engine `play()` throws if video element is null** — songs without video won't have a `<video>` element rendered, so `videoElement` is null and `syncEngine.attach()` is skipped
6. **`handleRhythmInput(rawKey, pressAudioTime?)`** — the optional 2nd arg is press time in HOST AUDIO time (seconds). Always pass it from the WebRTC path (`syncEngine.hostClockToAudioTime(event.timestamp - webrtcHost.getClockOffsetMs())`); do NOT pass it from local keyboard input. It must be `undefined` (or omitted) for live-time judgment.
7. **The Trystero data channel is unordered + unreliable** — patched by `scripts/patch-trystero.mjs` (via `postinstall`). `bun install` re-applies it; do NOT remove the `postinstall` script or the patch. The phone compensates with duplicate `"down"` events. Only `"down"` is duplicated, so commands can rarely drop (recoverable by re-tap).

### Current Bugs (Not Yet Fixed)

- `syncEngine.play()` at App.svelte L400 may throw "Media elements are not attached" when a song has no video. The audio still plays because the browser autoplays it, but the error may affect screen transition.

---

## Remaining Optimization Opportunities

### High Impact (Should Do)

| ID     | Fix                    | File                    | Status                                                                         |
| ------ | ---------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| B7     | RAF-throttle mousemove | EditScreen.svelte       | ✅ Done — `onMouseMove` coalesces events into one `handleMouseMove` per frame. |
| B5     | Spatial note indexing  | RhythmPlayCanvas.svelte | ✅ Done — x-sorted index + binary search for culling and hit detection.        |
| Canvas | Canvas 2D rendering    | RhythmPlayCanvas.svelte | ✅ Done — full gameplay renderer migrated to Canvas 2D (see Phase 3).          |

### Medium Impact (Nice to Have)

| ID  | Fix                                  | File                                       | Description                                                                                                                                     |
| --- | ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| B11 | Imperative dashoffset in PiP         | EditScreen.svelte L1824-1826               | Editor PiP progress line uses reactive `stroke-dashoffset: {expr}`. Use imperative `el.style.strokeDashoffset` in `pipLoop` instead.            |
| B12 | Duplicate mouse listeners            | EditScreen.svelte L1505-1506 vs L1529-1530 | Mouse handlers bound to both `<svelte:window>` and container div — causes double event processing.                                              |
| BPs | Breakpoint template getPointAtLength | EditScreen.svelte L1867, L1940             | Speed/zoom breakpoint markers in the editor template call `getPointAtLength` for EACH breakpoint during render. Precompute positions and store. |

---

## File Checksums (for detecting conflicts)

After all changes:

```
src/types/track.ts                          — 34 lines
src/core/sync-engine.ts                     — ~315 lines
src/core/track-math.ts                      — ~1020 lines
src/components/RhythmPlayCanvas.svelte      — ~444 lines
src/components/EditScreen.svelte            — ~2985 lines
```

Build: `svelte-check` 0 errors, `vite build` clean.
