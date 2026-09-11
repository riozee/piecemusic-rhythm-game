export interface PlaneGridResult {
  xs: number[];
  ys: number[];
  pathD: string;
  svgHtml: string;
}

/**
 * Generates a simple uniform grid across the plane:
 * evenly spaced vertical and horizontal lines (no note alignment, no adaptive LOD).
 */
export function computePlaneGrid(
  planeW: number,
  planeH: number,
  step = 50,
): PlaneGridResult {
  if (planeW <= 0 || planeH <= 0) {
    return { xs: [0], ys: [0], pathD: "", svgHtml: "" };
  }

  const xs: number[] = [];
  for (let x = 0; x <= planeW; x += step) xs.push(x);
  if (xs[xs.length - 1] !== planeW) xs.push(planeW);

  const ys: number[] = [];
  for (let y = 0; y <= planeH; y += step) ys.push(y);
  if (ys[ys.length - 1] !== planeH) ys.push(planeH);

  let pathD = "";
  for (let i = 0; i < xs.length; i++) {
    pathD += `M ${xs[i]} 0 V ${planeH} `;
  }
  for (let i = 0; i < ys.length; i++) {
    pathD += `M 0 ${ys[i]} H ${planeW} `;
  }

  return { xs, ys, pathD, svgHtml: "" };
}
