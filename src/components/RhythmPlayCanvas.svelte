<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { TrackData } from '../types/track';
  import {
    generateSpeedTicksPath,
    getValueAtProgress,
    getOffsetAtProgress,
    buildTimeProgressTable,
    getTimeToProgress,
    buildSmoothTrackMetrics,
    smoothPointAtProgress,
    type SmoothTrackMetrics,
    type PathSample,
  } from '../core/track-math';
  import { computePlaneGrid } from '../core/grid';

  interface Props {
    trackData: TrackData;
    currentTimeSec: number;
    isPaused: boolean;
    containerWidth: number;
    containerHeight: number;
    onScoreChange?: (score: number, combo: number) => void;
    onGameComplete?: (finalScore: number, maxCombo: number, totalNotes: number, hitNotes: number) => void;
    onDurationCalculated?: (durationSec: number) => void;
  }

  const {
    trackData,
    currentTimeSec,
    isPaused,
    containerWidth,
    containerHeight,
    onScoreChange,
    onGameComplete,
    onDurationCalculated,
  }: Props = $props();

  let canvasEl: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let rafId: number | null = null;
  let lastCssW = 0;
  let lastCssH = 0;
  let lastDrawTime = 0;

  // ---- Static per-track data (rebuilt on track change, drawn every frame) ----
  let metrics: SmoothTrackMetrics | null = null;
  let pathSamples: PathSample[] = [];
  let totalPathLen = 0;
  let timeTable: { progress: number; time: number }[] = [];
  let chartDuration = 0;
  let gridPath: Path2D | null = null;
  let speedTicksPath: Path2D | null = null;
  let fullPath: Path2D | null = null;

  // Spatial index for O(log N) note culling + hit detection.
  let notesByX: number[] = [];
  let maxNoteW = 0;

  // ---- Mutable gameplay state (plain values, no Svelte reactivity needed) ----
  let currentProgress = 0;
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let hasEnded = false;
  let playNotesStatus: boolean[] = [];
  let hitEffects: { id: number; x: number; y: number; text: string; color: string }[] = [];
  let effectCounter = 0;
  let lastReportedDuration = -1;
  let lastTrackRef: TrackData | null = null;

  // First index in notesByX whose note.x >= minX (binary search).
  function firstNoteIndexByMinX(minX: number): number {
    const notes = trackData.notes;
    let lo = 0;
    let hi = notesByX.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[notesByX[mid]].x < minX) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function rebuildAll() {
    // Accurate arc-length metrics over the true quadratic-Bézier path. The drawn
    // path (Path2D quadraticCurveTo) and the playhead both derive from this, so the
    // playhead stays pixel-perfect on the smooth curve with zero drift.
    const m = buildSmoothTrackMetrics(trackData.nodes, trackData.bends);
    metrics = m;
    totalPathLen = m.totalLength;

    const result = buildTimeProgressTable(totalPathLen, trackData.speedBPs);
    timeTable = result.table;
    chartDuration = result.chartDuration;

    // Static full-plane uniform grid (zoom-independent).
    const gridRes = computePlaneGrid(trackData.planeW, trackData.planeH);
    gridPath = gridRes.pathD ? new Path2D(gridRes.pathD) : null;

    // Full smooth background path (real quadratic Bézier, matching original SVG).
    const full = new Path2D();
    if (m.segments.length > 0) {
      full.moveTo(m.segments[0].x0, m.segments[0].y0);
      for (let i = 0; i < m.segments.length; i++) {
        const s = m.segments[i];
        if (s.isCurve) full.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1);
        else full.lineTo(s.x1, s.y1);
      }
    }
    fullPath = full;

    // Dense chord-limited samples (used only for speed ticks now).
    const sampleCount = Math.max(512, Math.min(20000, Math.ceil(totalPathLen / 4)));
    pathSamples = new Array<PathSample>(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const p = i / (sampleCount - 1);
      const pt = smoothPointAtProgress(m, p);
      pathSamples[i] = { p, x: pt.x, y: pt.y };
    }

    // Speed ticks generated from the math samples (no SVG element required).
    const ticksD = generateSpeedTicksPath(
      null,
      trackData.speedBPs,
      totalPathLen,
      timeTable,
      chartDuration,
      pathSamples
    );
    speedTicksPath = ticksD ? new Path2D(ticksD) : null;

    // Rebuild the x-sorted note index.
    const notes = trackData.notes;
    const idx = new Array<number>(notes.length);
    for (let i = 0; i < notes.length; i++) idx[i] = i;
    idx.sort((a, b) => notes[a].x - notes[b].x);
    notesByX = idx;
    let maxW = 0;
    for (let i = 0; i < notes.length; i++) {
      if (notes[i].w > maxW) maxW = notes[i].w;
    }
    maxNoteW = maxW;

    if (Math.abs(chartDuration - lastReportedDuration) > 0.01) {
      lastReportedDuration = chartDuration;
      onDurationCalculated?.(chartDuration);
    }
  }

  function resetRun() {
    playNotesStatus = new Array(trackData.notes.length).fill(false);
    score = 0;
    combo = 0;
    maxCombo = 0;
    hasEnded = false;
    onScoreChange?.(score, combo);
  }

  function drawFrame(now: number) {
    rafId = requestAnimationFrame(drawFrame);
    // Throttle to ~60fps: on high-refresh (120/160Hz) displays, rendering on every
    // RAF callback (~6.25ms) is far more fill-rate work than needed and produces
    // erratic frame pacing. Skip frames until a full 60fps interval has elapsed.
    if (now - lastDrawTime < 1000 / 60 - 1) return;
    lastDrawTime = now;
    const canvas = canvasEl;
    if (!canvas) return;
    if (!ctx) {
      ctx = canvas.getContext('2d');
      if (!ctx) return;
    }

    // Rebuild when the track changes (component stays mounted across levels).
    if (trackData && trackData !== lastTrackRef) {
      lastTrackRef = trackData;
      rebuildAll();
      resetRun();
    }

    const w = containerWidth || 1280;
    const h = containerHeight || 720;

    // Backing-store resolution is fill-rate bound on large/4K windows, so cap the
    // total pixel count (not raw DPR). The browser upscales the smaller backing
    // store to the CSS size, keeping the clear+stroke pass comfortably at 60fps.
    const nativeDpr = window.devicePixelRatio || 1;
    let scale = Math.min(nativeDpr, 2);
    const maxPixels = 2560 * 1440; // ~3.7M px budget (1440p-class fill rate)
    if (w * h * scale * scale > maxPixels) {
      scale = Math.sqrt(maxPixels / (w * h));
    }
    const bw = Math.max(1, Math.round(w * scale));
    const bh = Math.max(1, Math.round(h * scale));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    if (lastCssW !== w || lastCssH !== h) {
      lastCssW = w;
      lastCssH = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);

    if (chartDuration <= 0 || !metrics || metrics.segments.length === 0) return;

    // Rewind / restart detection.
    if (currentTimeSec < 0.15 && (playNotesStatus.some(Boolean) || hasEnded)) {
      resetRun();
    }

    const prog = getTimeToProgress(timeTable, currentTimeSec, chartDuration);
    currentProgress = prog;

    if (prog >= 1.0 || currentTimeSec >= chartDuration) {
      if (!hasEnded) {
        hasEnded = true;
        const hitCount = playNotesStatus.filter(Boolean).length;
        onGameComplete?.(score, maxCombo, trackData.notes.length, hitCount);
      }
    }

    const pt = metrics ? smoothPointAtProgress(metrics, prog) : { x: 0, y: 0 };
    const zoom = getValueAtProgress(trackData.zoomBPs, prog, 1.0);
    const offset = getOffsetAtProgress(trackData.offsetBPs, prog, 0, 0);
    const offsetNx = Math.max(-1, Math.min(1, offset.nx));
    const offsetNy = Math.max(-1, Math.min(1, offset.ny));

    // Fit a fixed 1280x720 (16:9) camera frame into the window, letterboxed.
    // The camera center is shifted by the offset breakpoint so the playhead sits
    // away from the frame center (matches the editor's zoom/POV previews).
    const viewportScale = Math.min(w / 1280, h / 720);
    const finalZoom = zoom * viewportScale;
    const cameraX = pt.x - offsetNx * (640 / zoom);
    const cameraY = pt.y - offsetNy * (360 / zoom);
    const tx = w / 2 - cameraX * finalZoom;
    const ty = h / 2 - cameraY * finalZoom;

    // World-space transform (backing-store pixels).
    ctx.setTransform(scale * finalZoom, 0, 0, scale * finalZoom, scale * tx, scale * ty);

    // 1. Grid.
    if (gridPath) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 0.5;
      ctx.stroke(gridPath);
      ctx.restore();
    }

    // 2. Decorations (ghost rectangles, under the notes).
    drawDecorations(ctx, cameraX, cameraY, finalZoom);

    // 3. Notes (under the track path, same z-order as before).
    drawNotes(ctx, cameraX, cameraY, finalZoom);

    // 3. Background track path.
    if (fullPath) {
      ctx.save();
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(fullPath);
      ctx.restore();
    }

    // 4. Traveled foreground path (dash-clipped on the smooth full path).
    if (fullPath && prog > 0 && totalPathLen > 0) {
      ctx.save();
      ctx.strokeStyle = '#292524';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([prog * totalPathLen, totalPathLen]);
      ctx.stroke(fullPath);
      ctx.restore();
    }

    // 5. Speed ticks.
    if (speedTicksPath) {
      ctx.save();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.stroke(speedTicksPath);
      ctx.restore();
    }

    // 6. Playhead.
    drawPlayhead(ctx, pt.x, pt.y);

    // 7. Hit effects.
    drawHitEffects(ctx);
  }

  function drawDecorations(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number, finalZoom: number) {
    const decs = trackData.decorations;
    if (!decs || decs.length === 0) return;

    const w = containerWidth || 1280;
    const h = containerHeight || 720;
    const margin = 100;
    const viewLeft = cameraX - w / (2 * finalZoom) - margin;
    const viewRight = cameraX + w / (2 * finalZoom) + margin;
    const viewTop = cameraY - h / (2 * finalZoom) - margin;
    const viewBottom = cameraY + h / (2 * finalZoom) + margin;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < decs.length; i++) {
      const d = decs[i];
      if (d.x > viewRight || d.x + d.w < viewLeft || d.y > viewBottom || d.y + d.h < viewTop) continue;
      ctx.fillRect(d.x, d.y, d.w, d.h);
      ctx.strokeRect(d.x, d.y, d.w, d.h);
    }
    ctx.restore();
  }

  function drawNotes(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number, finalZoom: number) {
    const notes = trackData.notes;
    if (notes.length === 0 || notesByX.length === 0) return;

    const w = containerWidth || 1280;
    const h = containerHeight || 720;
    const margin = 200;
    const viewLeft = cameraX - w / (2 * finalZoom) - margin;
    const viewRight = cameraX + w / (2 * finalZoom) + margin;
    const viewTop = cameraY - h / (2 * finalZoom) - margin;
    const viewBottom = cameraY + h / (2 * finalZoom) + margin;

    const start = firstNoteIndexByMinX(viewLeft - maxNoteW);
    for (let j = start; j < notesByX.length; j++) {
      const i = notesByX[j];
      const n = notes[i];
      if (n.x > viewRight) break;
      if (n.x + n.w < viewLeft || n.y + n.h < viewTop || n.y > viewBottom) continue;

      const isHit = playNotesStatus[i];
      const isBlue = n.color !== 'green';

      ctx.fillStyle = isHit
        ? 'rgba(148, 163, 184, 0.2)'
        : isBlue
          ? 'rgba(59, 130, 246, 0.28)'
          : 'rgba(16, 185, 129, 0.28)';
      ctx.strokeStyle = isHit ? '#94a3b8' : isBlue ? '#3b82f6' : '#10b981';
      ctx.lineWidth = isHit ? 1 : 1.2;
      ctx.setLineDash(isHit ? [3, 3] : []);
      ctx.fillRect(n.x, n.y, n.w, n.h);
      ctx.strokeRect(n.x, n.y, n.w, n.h);
      ctx.setLineDash([]);

      if (!isHit) {
        ctx.save();
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = isBlue ? '#1d4ed8' : '#047857';
        ctx.globalAlpha = 0.9;
        ctx.fillText(isBlue ? 'Z' : 'X', n.x + n.w / 2, n.y + n.h / 2 + 2);
        ctx.restore();
      }
    }
  }

  function drawPlayhead(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#292524';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.restore();
  }

  function drawHitEffects(ctx: CanvasRenderingContext2D) {
    if (hitEffects.length === 0) return;
    ctx.save();
    ctx.font = '900 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < hitEffects.length; i++) {
      const e = hitEffects[i];
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.strokeText(e.text, e.x, e.y - 20);
      ctx.fillStyle = e.color;
      ctx.fillText(e.text, e.x, e.y - 20);
    }
    ctx.restore();
  }

  export function handleRhythmInput(rawKey: string, pressAudioTime?: number): boolean {
    if (isPaused || totalPathLen <= 0) return false;

    const k = rawKey.toLowerCase();
    // Blue keys: 'z', 'd', 'f'
    // Green keys: 'x', 'j', 'k'
    const isBlue = k === 'z' || k === 'd' || k === 'f';
    const isGreen = k === 'x' || k === 'j' || k === 'k';
    if (!isBlue && !isGreen) return false;

    // Latency compensation: judge against the time the key was pressed (already
    // mapped into host audio time), not the live playhead position at packet
    // arrival. Local keyboard input omits `pressAudioTime` and uses live time.
    const judgeProgress =
      pressAudioTime !== undefined && Number.isFinite(pressAudioTime)
        ? getTimeToProgress(timeTable, pressAudioTime, chartDuration)
        : currentProgress;
    const pt = metrics ? smoothPointAtProgress(metrics, judgeProgress) : { x: 0, y: 0 };

    const margin = 20;
    const notes = trackData.notes;
    const start = firstNoteIndexByMinX(pt.x - margin - maxNoteW);
    for (let j = start; j < notesByX.length; j++) {
      const i = notesByX[j];
      const n = notes[i];
      if (n.x > pt.x + margin) break;
      if (playNotesStatus[i]) continue;

      if (
        pt.x >= n.x - margin &&
        pt.x <= n.x + n.w + margin &&
        pt.y >= n.y - margin &&
        pt.y <= n.y + n.h + margin
      ) {
        const noteIsBlue = n.color !== 'green';
        if ((isBlue && noteIsBlue) || (isGreen && !noteIsBlue)) {
          playNotesStatus[i] = true;
          score += 100;
          combo += 1;
          maxCombo = Math.max(maxCombo, combo);
          onScoreChange?.(score, combo);

          const effId = ++effectCounter;
          hitEffects.push({
            id: effId,
            x: pt.x,
            y: pt.y,
            text: combo > 5 ? `+100 コンボ x${combo}!` : '+100 パーフェクト',
            color: n.color !== 'green' ? '#3b82f6' : '#10b981',
          });

          setTimeout(() => {
            const idx = hitEffects.findIndex((e) => e.id === effId);
            if (idx !== -1) hitEffects.splice(idx, 1);
          }, 800);

          return true;
        }
      }
    }

    return false;
  }

  onMount(() => {
    lastTrackRef = trackData;
    rebuildAll();
    resetRun();
    rafId = requestAnimationFrame(drawFrame);
  });

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (['z', 'x', 'd', 'f', 'j', 'k'].includes(k)) {
      handleRhythmInput(k);
    }
  }}
/>

<!-- Fullscreen Canvas Track Plane -->
<div class="absolute inset-0 w-full h-full overflow-hidden pointer-events-none z-10 select-none">
  <canvas
    bind:this={canvasEl}
    class="absolute top-0 left-0"
  ></canvas>
</div>
