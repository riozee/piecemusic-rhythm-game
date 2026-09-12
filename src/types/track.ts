export interface TrackNode {
  x: number;
  y: number;
}

export interface BendPoint {
  cx: number;
  cy: number;
}

export interface Breakpoint {
  progress: number;
  val: number;
}

export interface OffsetBreakpoint {
  progress: number;
  nx: number; // -1..1 horizontal playhead offset within the camera frame (1 = right edge)
  ny: number; // -1..1 vertical playhead offset within the camera frame (1 = bottom edge)
}

export interface TrackNote {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: "blue" | "green";
}

export interface TrackDecoration {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrackData {
  nodes: TrackNode[];
  bends: Record<number, BendPoint>;
  speedBPs: Breakpoint[];
  zoomBPs: Breakpoint[];
  offsetBPs: OffsetBreakpoint[];
  notes: TrackNote[];
  decorations: TrackDecoration[];
  markers: number[];
  planeOriginX: number;
  planeOriginY: number;
  planeW: number;
  planeH: number;
}
