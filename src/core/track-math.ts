import type {
  TrackNode,
  BendPoint,
  Breakpoint,
  OffsetBreakpoint,
  TrackData,
  TrackNote,
} from "../types/track";

export const BASE_SPEED = 400; // base speed in world px/sec

export function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Generates an SVG path string from track nodes and quadratic bezier bends.
 */
export function generatePathData(
  nodes: TrackNode[],
  bends: Record<number, BendPoint>,
): string {
  if (!nodes || nodes.length < 2) return "";
  let d = `M ${nodes[0].x},${nodes[0].y} `;
  for (let i = 1; i < nodes.length; i++) {
    const segId = i - 1;
    if (bends[segId]) {
      const { cx, cy } = bends[segId];
      d += `Q ${cx},${cy} ${nodes[i].x},${nodes[i].y} `;
    } else {
      d += `L ${nodes[i].x},${nodes[i].y} `;
    }
  }
  return d;
}

/**
 * Evaluates piecewise linear interpolated camera offset (nx, ny) at a given
 * progress (0..1). Values are normalized to the camera frame: nx/ny in [-1, 1]
 * where 0 = center and ±1 = frame edge.
 *
 * Semantics match speed/zoom breakpoints (hold):
 * - No breakpoints -> default (centered).
 * - Before the first breakpoint -> the first breakpoint's offset.
 * - After the last breakpoint -> the last breakpoint's offset.
 * - Between breakpoints -> linear interpolation.
 */
export function getOffsetAtProgress(
  bps: OffsetBreakpoint[],
  progress: number,
  defaultNx = 0,
  defaultNy = 0,
): { nx: number; ny: number } {
  if (!bps || bps.length === 0) return { nx: defaultNx, ny: defaultNy };
  const sorted = [...bps].sort((a, b) => a.progress - b.progress);
  if (progress <= sorted[0].progress)
    return { nx: sorted[0].nx, ny: sorted[0].ny };
  if (progress >= sorted[sorted.length - 1].progress) {
    const last = sorted[sorted.length - 1];
    return { nx: last.nx, ny: last.ny };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    if (progress >= sorted[i].progress && progress <= sorted[i + 1].progress) {
      const span = sorted[i + 1].progress - sorted[i].progress;
      if (span <= 0) return { nx: sorted[i].nx, ny: sorted[i].ny };
      const t = (progress - sorted[i].progress) / span;
      return {
        nx: sorted[i].nx + (sorted[i + 1].nx - sorted[i].nx) * t,
        ny: sorted[i].ny + (sorted[i + 1].ny - sorted[i].ny) * t,
      };
    }
  }
  return { nx: defaultNx, ny: defaultNy };
}

/**
 * Evaluates piecewise linear interpolated value at a given progress (0..1).
 */
export function getValueAtProgress(
  bps: Breakpoint[],
  progress: number,
  defaultVal: number,
): number {
  if (!bps || bps.length === 0) return defaultVal;
  const sorted = [...bps].sort((a, b) => a.progress - b.progress);
  if (progress <= sorted[0].progress) return sorted[0].val;
  if (progress >= sorted[sorted.length - 1].progress)
    return sorted[sorted.length - 1].val;

  for (let i = 0; i < sorted.length - 1; i++) {
    if (progress >= sorted[i].progress && progress <= sorted[i + 1].progress) {
      const span = sorted[i + 1].progress - sorted[i].progress;
      if (span <= 0) return sorted[i].val;
      const t = (progress - sorted[i].progress) / span;
      return sorted[i].val + (sorted[i + 1].val - sorted[i].val) * t;
    }
  }
  return defaultVal;
}

/**
 * Calculates the total duration in seconds needed to traverse the path with speed breakpoints.
 */
export function calculateTotalDuration(
  pathEl: SVGPathElement | null,
  speedBPs: Breakpoint[],
  baseSpeed = BASE_SPEED,
): number {
  if (!pathEl) return 0;
  const totalLen = pathEl.getTotalLength();
  if (totalLen <= 0) return 0;

  let dtSum = 0;
  const steps = 400;
  const stepSize = totalLen / steps;

  for (let i = 0; i < steps; i++) {
    const p = (i + 0.5) / steps;
    let speedMult = getValueAtProgress(speedBPs, p, 1.0);
    if (speedMult <= 0.05) speedMult = 0.05;
    const v = baseSpeed * speedMult;
    dtSum += stepSize / v;
  }
  return dtSum;
}

/**
 * Precomputes cumulative time table for fast O(log N) lookup from elapsed time to track progress.
 * Preserves the chart's native duration derived from path length and speed breakpoints.
 */
export function buildTimeProgressTable(
  pathElOrLen: SVGPathElement | number | null,
  speedBPs: Breakpoint[],
  baseSpeed = BASE_SPEED,
  steps = 500,
): { table: { progress: number; time: number }[]; chartDuration: number } {
  const totalLen =
    typeof pathElOrLen === "number"
      ? pathElOrLen
      : pathElOrLen
        ? pathElOrLen.getTotalLength()
        : 0;

  if (totalLen <= 0) {
    return {
      table: [
        { progress: 0, time: 0 },
        { progress: 1, time: 1 },
      ],
      chartDuration: 1,
    };
  }

  const stepSize = totalLen / steps;
  let rawTime = 0;
  const table: { progress: number; time: number }[] = [
    { progress: 0, time: 0 },
  ];

  for (let i = 0; i < steps; i++) {
    const p = (i + 0.5) / steps;
    let speedMult = getValueAtProgress(speedBPs, p, 1.0);
    if (speedMult <= 0.05) speedMult = 0.05;
    const v = baseSpeed * speedMult;
    rawTime += stepSize / v;
    table.push({ progress: (i + 1) / steps, time: rawTime });
  }

  return { table, chartDuration: Math.max(0.1, rawTime) };
}

/**
 * Converts elapsed chart time in seconds to track progress (0..1) based on native chart duration.
 */
export function getTimeToProgress(
  timeTable: { progress: number; time: number }[],
  currentTimeSec: number,
  chartDurationSec: number,
): number {
  if (currentTimeSec <= 0 || chartDurationSec <= 0) return 0;
  if (currentTimeSec >= chartDurationSec) return 1.0;
  if (!timeTable || timeTable.length === 0) {
    return Math.min(1.0, Math.max(0, currentTimeSec / chartDurationSec));
  }

  let low = 0;
  let high = timeTable.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeTable[mid].time < currentTimeSec) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const idx = Math.max(0, Math.min(low, timeTable.length - 1));
  if (idx === 0) return timeTable[0].progress;

  const prev = timeTable[idx - 1];
  const next = timeTable[idx];
  const timeSpan = next.time - prev.time;
  if (timeSpan <= 0) return next.progress;

  const t = (currentTimeSec - prev.time) / timeSpan;
  return prev.progress + (next.progress - prev.progress) * t;
}

/**
 * Converts track progress (0..1) to elapsed chart time in seconds based on native chart duration.
 */
export function getProgressToTime(
  timeTable: { progress: number; time: number }[],
  progress: number,
  chartDurationSec: number,
): number {
  if (progress <= 0 || chartDurationSec <= 0) return 0;
  if (progress >= 1.0) return chartDurationSec;
  if (!timeTable || timeTable.length === 0) {
    return Math.min(chartDurationSec, Math.max(0, progress * chartDurationSec));
  }

  let low = 0;
  let high = timeTable.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeTable[mid].progress < progress) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const idx = Math.max(0, Math.min(low, timeTable.length - 1));
  if (idx === 0) return timeTable[0].time;

  const prev = timeTable[idx - 1];
  const next = timeTable[idx];
  const pSpan = next.progress - prev.progress;
  if (pSpan <= 0) return next.time;

  const t = (progress - prev.progress) / pSpan;
  return prev.time + (next.time - prev.time) * t;
}

/**
 * Formats seconds into MM:SS format.
 */
export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Generates speed ticks SVG path data with one stripe for each second of the chart.
 * If the chart is 100 seconds long, there are 100 stripes.
 * The physical distance between stripes directly reflects local speed:
 * - Faster speed: more distance traveled in 1s -> wider distance between stripes.
 * - Slower speed: less distance traveled in 1s -> tighter distance between stripes.
 * - Every 5 seconds, a slightly longer stripe marks major intervals (like a ruler or gauge).
 */
export function generateSpeedTicksPath(
  pathEl: SVGPathElement | null,
  speedBPs: Breakpoint[],
  totalLen: number,
  timeTable?: { progress: number; time: number }[],
  chartDurationSec?: number,
  samples?: PathSample[],
): string {
  if (totalLen <= 0) return "";
  if (!pathEl && (!samples || samples.length === 0)) return "";

  let table = timeTable;
  let duration = chartDurationSec || 0;

  if (!table || duration <= 0) {
    const res = buildTimeProgressTable(totalLen, speedBPs);
    table = res.table;
    duration = res.chartDuration;
  }

  if (duration <= 0) return "";

  let d = "";
  const totalSeconds = Math.floor(duration);

  for (let sec = 1; sec <= totalSeconds; sec++) {
    const p = getTimeToProgress(table, sec, duration);
    let pt: { x: number; y: number };
    let ptNext: { x: number; y: number };

    if (pathEl && pathEl.getTotalLength() > 0) {
      const s = p * totalLen;
      pt = pathEl.getPointAtLength(s);
      const ahead = Math.min(totalLen, s + 3);
      ptNext = pathEl.getPointAtLength(ahead);
    } else if (samples && samples.length > 0) {
      pt = getPointOnTrack(samples, p);
      ptNext = getPointOnTrack(samples, Math.min(1.0, p + 0.005));
    } else {
      break;
    }

    const dx = ptNext.x - pt.x;
    const dy = ptNext.y - pt.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const nx = -dy / len;
      const ny = dx / len;
      const isMajor = sec % 5 === 0;
      const tickSize = isMajor ? 12 : 8;
      d += `M ${pt.x + nx * tickSize},${pt.y + ny * tickSize} L ${pt.x - nx * tickSize},${pt.y - ny * tickSize} `;
    }
  }

  return d;
}

export interface PathSample {
  p: number;
  x: number;
  y: number;
}

/**
 * Generates tick stripes for each musical beat (BPM) along the path, similar
 * to the speed ticks but spaced by 60/bpm seconds. Used to visualize tempo.
 */
export function generateBeatTicksPath(
  pathEl: SVGPathElement | null,
  bpm: number,
  totalLen: number,
  timeTable: { progress: number; time: number }[],
  chartDurationSec: number,
  samples?: PathSample[],
): string {
  if (!bpm || bpm <= 0 || totalLen <= 0 || chartDurationSec <= 0) return "";
  if (!pathEl && (!samples || samples.length === 0)) return "";

  const beatSec = 60 / bpm;
  let d = "";
  for (let t = beatSec; t < chartDurationSec; t += beatSec) {
    const p = getTimeToProgress(timeTable, t, chartDurationSec);
    let pt: { x: number; y: number };
    let ptNext: { x: number; y: number };

    if (pathEl && pathEl.getTotalLength() > 0) {
      const s = p * totalLen;
      pt = pathEl.getPointAtLength(s);
      ptNext = pathEl.getPointAtLength(Math.min(totalLen, s + 3));
    } else if (samples && samples.length > 0) {
      pt = getPointOnTrack(samples, p);
      ptNext = getPointOnTrack(samples, Math.min(1.0, p + 0.005));
    } else {
      break;
    }

    const dx = ptNext.x - pt.x;
    const dy = ptNext.y - pt.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const nx = -dy / len;
      const ny = dx / len;
      const tickSize = 6;
      d += `M ${pt.x + nx * tickSize},${pt.y + ny * tickSize} L ${pt.x - nx * tickSize},${pt.y - ny * tickSize} `;
    }
  }
  return d;
}

export function samplePathPolyline(
  pathEl: SVGPathElement | null,
  count = 250,
): PathSample[] {
  if (!pathEl) return [];
  const totalLen = pathEl.getTotalLength();
  if (totalLen <= 0) return [];
  const samples: PathSample[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = i / (count - 1);
    const pt = pathEl.getPointAtLength(p * totalLen);
    samples[i] = { p, x: pt.x, y: pt.y };
  }
  return samples;
}

/**
 * Mathematically samples quadratic bezier and linear track segments into uniform progress points.
 * Runs instantly in <0.05ms without requiring DOM layout or SVG rendering.
 */
export function sampleTrackPoints(
  nodes: TrackNode[],
  bends: Record<number, BendPoint>,
  count = 300,
): { samples: PathSample[]; totalLength: number } {
  if (!nodes || nodes.length < 2) {
    return { samples: [], totalLength: 0 };
  }

  interface DensePoint {
    x: number;
    y: number;
    segIndex: number;
  }
  const densePts: DensePoint[] = [];

  for (let i = 0; i < nodes.length - 1; i++) {
    const p0 = nodes[i];
    const p1 = nodes[i + 1];
    const bend = bends[i];

    if (!bend) {
      const subSteps = 8;
      for (let s = 0; s < subSteps; s++) {
        const t = s / subSteps;
        densePts.push({
          x: p0.x + (p1.x - p0.x) * t,
          y: p0.y + (p1.y - p0.y) * t,
          segIndex: i,
        });
      }
    } else {
      const subSteps = 24;
      for (let s = 0; s < subSteps; s++) {
        const t = s / subSteps;
        const omt = 1 - t;
        const x = omt * omt * p0.x + 2 * omt * t * bend.cx + t * t * p1.x;
        const y = omt * omt * p0.y + 2 * omt * t * bend.cy + t * t * p1.y;
        densePts.push({ x, y, segIndex: i });
      }
    }
  }

  const lastNode = nodes[nodes.length - 1];
  densePts.push({
    x: lastNode.x,
    y: lastNode.y,
    segIndex: Math.max(0, nodes.length - 2),
  });

  const cumLens: number[] = [0];
  let totalLen = 0;
  for (let i = 1; i < densePts.length; i++) {
    const d = dist(
      densePts[i - 1].x,
      densePts[i - 1].y,
      densePts[i].x,
      densePts[i].y,
    );
    totalLen += d;
    cumLens.push(totalLen);
  }

  if (totalLen <= 0) {
    return {
      samples: [
        { p: 0, x: nodes[0].x, y: nodes[0].y },
        { p: 1, x: nodes[nodes.length - 1].x, y: nodes[nodes.length - 1].y },
      ],
      totalLength: 0,
    };
  }

  const samples: PathSample[] = new Array(count);
  let denseIdx = 0;

  for (let i = 0; i < count; i++) {
    const targetP = i / (count - 1);
    const targetLen = targetP * totalLen;

    while (denseIdx < cumLens.length - 2 && cumLens[denseIdx + 1] < targetLen) {
      denseIdx++;
    }

    const l0 = cumLens[denseIdx];
    const l1 = cumLens[denseIdx + 1];
    const span = l1 - l0;
    const t = span > 0 ? (targetLen - l0) / span : 0;

    const pt0 = densePts[denseIdx];
    const pt1 = densePts[denseIdx + 1];

    samples[i] = {
      p: targetP,
      x: pt0.x + (pt1.x - pt0.x) * t,
      y: pt0.y + (pt1.y - pt0.y) * t,
    };
  }

  return { samples, totalLength: totalLen };
}

/**
 * Fast piecewise linear interpolation of coordinates along sampled path points.
 */
export function getPointOnTrack(
  samples: PathSample[],
  progress: number,
): { x: number; y: number } {
  if (!samples || samples.length === 0) return { x: 0, y: 0 };
  if (progress <= 0) return { x: samples[0].x, y: samples[0].y };
  if (progress >= 1)
    return {
      x: samples[samples.length - 1].x,
      y: samples[samples.length - 1].y,
    };

  const idxFloat = progress * (samples.length - 1);
  const i = Math.floor(idxFloat);
  const t = idxFloat - i;
  const s0 = samples[i];
  const s1 = samples[Math.min(samples.length - 1, i + 1)];
  return {
    x: s0.x + (s1.x - s0.x) * t,
    y: s0.y + (s1.y - s0.y) * t,
  };
}

// ---- Smooth (true quadratic Bézier) path metrics for Canvas rendering ----
// These give accurate arc-length parameterization of the real Bézier curves, so a
// Canvas path drawn with quadraticCurveTo and a playhead positioned via these
// metrics stay pixel-perfectly attached (no polyline faceting, no drift).

const GL_T = [
  0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664,
  0.906179845938664,
];
const GL_W = [
  0.5688888888888889, 0.4786286704993665, 0.4786286704993665,
  0.2369268850561891, 0.2369268850561891,
];

const SEG_TABLE_N = 64;

export interface SmoothSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  isCurve: boolean;
  startLen: number;
  len: number;
  table: Float64Array;
}

export interface SmoothTrackMetrics {
  segments: SmoothSegment[];
  totalLength: number;
}

function quadSpeedSq(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  t: number,
): number {
  const ax = 2 * (cx - x0);
  const bx = 2 * (x1 - 2 * cx + x0);
  const ay = 2 * (cy - y0);
  const by = 2 * (y1 - 2 * cy + y0);
  const dx = ax + bx * t;
  const dy = ay + by * t;
  return dx * dx + dy * dy;
}

function quadLengthTo(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  tEnd: number,
): number {
  if (tEnd <= 0) return 0;
  let sum = 0;
  for (let k = 0; k < 5; k++) {
    const t = tEnd * 0.5 * (GL_T[k] + 1);
    sum += GL_W[k] * Math.sqrt(quadSpeedSq(x0, y0, cx, cy, x1, y1, t));
  }
  return sum * 0.5 * tEnd;
}

function quadPointAt(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  t: number,
): { x: number; y: number } {
  const omt = 1 - t;
  return {
    x: omt * omt * x0 + 2 * omt * t * cx + t * t * x1,
    y: omt * omt * y0 + 2 * omt * t * cy + t * t * y1,
  };
}

export function buildSmoothTrackMetrics(
  nodes: TrackNode[],
  bends: Record<number, BendPoint>,
): SmoothTrackMetrics {
  const segments: SmoothSegment[] = [];
  let total = 0;

  if (nodes && nodes.length >= 2) {
    for (let i = 0; i < nodes.length - 1; i++) {
      const p0 = nodes[i];
      const p1 = nodes[i + 1];
      const bend = bends[i];
      const isCurve = !!bend;
      const cx = bend ? bend.cx : (p0.x + p1.x) / 2;
      const cy = bend ? bend.cy : (p0.y + p1.y) / 2;
      const len = isCurve
        ? quadLengthTo(p0.x, p0.y, cx, cy, p1.x, p1.y, 1)
        : Math.hypot(p1.x - p0.x, p1.y - p0.y);

      const table = new Float64Array(SEG_TABLE_N);
      for (let k = 0; k < SEG_TABLE_N; k++) {
        const t = k / (SEG_TABLE_N - 1);
        table[k] = isCurve
          ? quadLengthTo(p0.x, p0.y, cx, cy, p1.x, p1.y, t)
          : len * t;
      }

      segments.push({
        x0: p0.x,
        y0: p0.y,
        x1: p1.x,
        y1: p1.y,
        cx,
        cy,
        isCurve,
        startLen: total,
        len,
        table,
      });
      total += len;
    }
  }

  return { segments, totalLength: total };
}

function invertSegmentT(seg: SmoothSegment, local: number): number {
  if (seg.len <= 0 || local <= 0) return 0;
  if (local >= seg.len) return 1;

  const table = seg.table;
  const n = table.length;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < local) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, Math.min(lo, n - 1));
  const t0 = (i - 1) / (n - 1);
  const t1 = i / (n - 1);
  const l0 = table[i - 1];
  const l1 = table[i];
  let t = t0 + (t1 - t0) * ((local - l0) / (l1 - l0 || 1));

  // Newton refinement for sub-pixel accuracy.
  if (seg.isCurve) {
    for (let it = 0; it < 3; it++) {
      const cur = quadLengthTo(
        seg.x0,
        seg.y0,
        seg.cx,
        seg.cy,
        seg.x1,
        seg.y1,
        t,
      );
      const speed = Math.sqrt(
        quadSpeedSq(seg.x0, seg.y0, seg.cx, seg.cy, seg.x1, seg.y1, t),
      );
      if (speed < 1e-9) break;
      const dt = (local - cur) / speed;
      t += dt;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      if (Math.abs(dt) < 1e-6) break;
    }
  }

  return t;
}

export function smoothPointAtLength(
  m: SmoothTrackMetrics,
  len: number,
): { x: number; y: number } {
  const segs = m.segments;
  if (!segs || segs.length === 0) return { x: 0, y: 0 };
  if (len <= 0) return { x: segs[0].x0, y: segs[0].y0 };
  const last = segs[segs.length - 1];
  if (len >= m.totalLength) return { x: last.x1, y: last.y1 };

  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (s.startLen + s.len < len) lo = mid + 1;
    else hi = mid - 1;
  }
  const seg = segs[Math.max(0, Math.min(lo, segs.length - 1))];
  const local = Math.max(0, Math.min(seg.len, len - seg.startLen));
  const t = invertSegmentT(seg, local);
  return seg.isCurve
    ? quadPointAt(seg.x0, seg.y0, seg.cx, seg.cy, seg.x1, seg.y1, t)
    : { x: seg.x0 + (seg.x1 - seg.x0) * t, y: seg.y0 + (seg.y1 - seg.y0) * t };
}

export function smoothPointAtProgress(
  m: SmoothTrackMetrics,
  progress: number,
): { x: number; y: number } {
  const p = Math.max(0, Math.min(1, progress));
  return smoothPointAtLength(m, p * m.totalLength);
}

function projectOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { x: x1, y: y1, dist: dist(px, py, x1, y1), t: 0 };
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return { x: projX, y: projY, dist: dist(px, py, projX, projY), t };
}

/**
 * Returns the index of the track segment (0..nodes.length-2) whose line/curve
 * is closest to (mx, my). This is accurate for both straight and quadratic
 * Bézier segments, unlike a midpoint heuristic which fails on curved paths.
 */
function closestSegmentIndex(
  nodes: TrackNode[],
  bends: Record<number, BendPoint>,
  mx: number,
  my: number,
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < nodes.length - 1; i++) {
    const n1 = nodes[i];
    const n2 = nodes[i + 1];
    const bend = bends[i];
    let d: number;
    if (!bend) {
      d = projectOnSegment(mx, my, n1.x, n1.y, n2.x, n2.y).dist;
    } else {
      // Sample the quadratic Bézier and take the minimum distance.
      let minD = Infinity;
      const steps = 20;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const omt = 1 - t;
        const x = omt * omt * n1.x + 2 * omt * t * bend.cx + t * t * n2.x;
        const y = omt * omt * n1.y + 2 * omt * t * bend.cy + t * t * n2.y;
        const dd = dist(mx, my, x, y);
        if (dd < minD) minD = dd;
      }
      d = minD;
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Finds the closest point on the path to coordinates (mx, my).
 * Accepts pre-sampled polyline points for instantaneous 0-DOM lookups,
 * falls back to SVGPathElement, or computes mathematically from nodes and bends.
 */
export function getClosestPointOnPath(
  pathOrSamples: SVGPathElement | PathSample[] | null,
  nodes: TrackNode[],
  bends: Record<number, BendPoint>,
  mx: number,
  my: number,
): {
  x: number;
  y: number;
  progress: number;
  dist: number;
  segmentIndex: number;
} | null {
  if (
    pathOrSamples instanceof SVGElement &&
    pathOrSamples.getTotalLength() > 0
  ) {
    const path = pathOrSamples;
    const totalLen = path.getTotalLength();
    let bestDist = Infinity;
    let bestP = 0;
    let bestPt = { x: 0, y: 0 };

    // Coarse scan: 250 steps
    for (let p = 0; p <= 1.0; p += 0.004) {
      const pt = path.getPointAtLength(p * totalLen);
      const d = dist(mx, my, pt.x, pt.y);
      if (d < bestDist) {
        bestDist = d;
        bestP = p;
        bestPt = { x: pt.x, y: pt.y };
      }
    }

    // Fine refinement around bestP
    const fineStart = Math.max(0, bestP - 0.006);
    const fineEnd = Math.min(1.0, bestP + 0.006);
    for (let p = fineStart; p <= fineEnd; p += 0.0005) {
      const pt = path.getPointAtLength(p * totalLen);
      const d = dist(mx, my, pt.x, pt.y);
      if (d < bestDist) {
        bestDist = d;
        bestP = p;
        bestPt = { x: pt.x, y: pt.y };
      }
    }

    const segIndex = closestSegmentIndex(nodes, bends, mx, my);

    return {
      x: bestPt.x,
      y: bestPt.y,
      progress: Math.max(0, Math.min(1.0, bestP)),
      dist: bestDist,
      segmentIndex: segIndex,
    };
  }

  let samples: PathSample[];
  if (Array.isArray(pathOrSamples) && pathOrSamples.length > 0) {
    samples = pathOrSamples;
  } else if (nodes && nodes.length >= 2) {
    samples = sampleTrackPoints(nodes, bends, 200).samples;
  } else {
    return null;
  }

  if (!samples || samples.length === 0) return null;

  let bestDistSq = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dx = mx - s.x;
    const dy = my - s.y;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
    }
  }

  let bestPt = { x: samples[bestIdx].x, y: samples[bestIdx].y };
  let bestP = samples[bestIdx].p;
  let bestDist = Math.sqrt(bestDistSq);

  // Check segment with previous neighbor
  if (bestIdx > 0) {
    const p0 = samples[bestIdx - 1];
    const p1 = samples[bestIdx];
    const proj = projectOnSegment(mx, my, p0.x, p0.y, p1.x, p1.y);
    if (proj.dist < bestDist) {
      bestDist = proj.dist;
      bestPt = { x: proj.x, y: proj.y };
      bestP = p0.p + proj.t * (p1.p - p0.p);
    }
  }

  // Check segment with next neighbor
  if (bestIdx < samples.length - 1) {
    const p0 = samples[bestIdx];
    const p1 = samples[bestIdx + 1];
    const proj = projectOnSegment(mx, my, p0.x, p0.y, p1.x, p1.y);
    if (proj.dist < bestDist) {
      bestDist = proj.dist;
      bestPt = { x: proj.x, y: proj.y };
      bestP = p0.p + proj.t * (p1.p - p0.p);
    }
  }

  const segIndex = closestSegmentIndex(nodes, bends, mx, my);

  return {
    x: bestPt.x,
    y: bestPt.y,
    progress: Math.max(0, Math.min(1.0, bestP)),
    dist: bestDist,
    segmentIndex: segIndex,
  };
}
