export const defaultAxisMap = {
  X: "X",
  Y: "Y",
  Z: "Z",
  R: "A", // map rotation to "A" by default; change to "E" or custom if your firmware needs it
};

export const defaultFeeds = {
  travel: { X: 9000, Y: 9000, Z: 600, R: 1800 }, // mm/min
  work: { X: 1500, Y: 1500, Z: 300, R: 600 },
};

export function header({ units = "mm", absolute = true } = {}) {
  const lines = [];
  lines.push(units === "in" ? "G20" : "G21");
  lines.push(absolute ? "G90" : "G91");
  lines.push("M82"); // absolute extrusion (safe no-op if R != E)
  return lines;
}

export function setAbsolute(on = true) {
  return [on ? "G90" : "G91"];
}

export function setWorkZero({ x, y, z, r }, axisMap = defaultAxisMap) {
  // Any unset axis is omitted.
  const parts = [];
  if (x !== undefined) parts.push(`${axisMap.X}0`);
  if (y !== undefined) parts.push(`${axisMap.Y}0`);
  if (z !== undefined) parts.push(`${axisMap.Z}0`);
  if (r !== undefined) parts.push(`${axisMap.R}0`);
  return parts.length ? [`G92 ${parts.join(" ")}`] : [];
}

export function home({ x = true, y = true, z = true, r = false } = {}, axisMap = defaultAxisMap) {
  const parts = [];
  if (x) parts.push(axisMap.X);
  if (y) parts.push(axisMap.Y);
  if (z) parts.push(axisMap.Z);
  if (r) parts.push(axisMap.R);
  return [`G28 ${parts.join(" ")}`.trim()];
}

export function moveAbs({ x, y, z, r, feed }, axisMap = defaultAxisMap) {
  const parts = [];
  if (x !== undefined) parts.push(`${axisMap.X}${fmt(x)}`);
  if (y !== undefined) parts.push(`${axisMap.Y}${fmt(y)}`);
  if (z !== undefined) parts.push(`${axisMap.Z}${fmt(z)}`);
  if (r !== undefined) parts.push(`${axisMap.R}${fmt(r)}`);
  if (!parts.length) return [];
  const f = feed != null ? ` F${Math.max(1, Math.round(feed))}` : "";
  return [`G1 ${parts.join(" ")}${f}`];
}

export function jogRel({ dx, dy, dz, dr, feed }, axisMap = defaultAxisMap) {
  const parts = [];
  if (dx) parts.push(`${axisMap.X}${fmt(dx)}`);
  if (dy) parts.push(`${axisMap.Y}${fmt(dy)}`);
  if (dz) parts.push(`${axisMap.Z}${fmt(dz)}`);
  if (dr) parts.push(`${axisMap.R}${fmt(dr)}`);
  if (!parts.length) return [];
  const f = feed != null ? ` F${Math.max(1, Math.round(feed))}` : "";
  return ["G91", `G1 ${parts.join(" ")}${f}`, "G90"];
}

export function dwell(ms = 50) {
  return [`G4 P${Math.max(0, Math.round(ms))}`];
}

function fmt(n) {
  // Keep 3 decimals max to avoid long floats
  return Number(n).toFixed(3).replace(/\.?0+$/, "");
}



/**
 * Returns the absolute machine Z coordinate of the bed surface at (x, y),
 * interpolated from the 5-point (or 4-point) calibration mesh.
 * Returns null if mesh has not been calibrated (all zeros -> no correction).
 */
export function getBedSurfaceZ(x, y) {
  try {
    const meshStr = localStorage.getItem('bedLevelMesh');
    if (!meshStr) return null;
    const mesh = JSON.parse(meshStr);
    if (!mesh || mesh.length < 4) return null;

    // Skip if not calibrated yet
    const allZero = mesh.every(p => p.zParam === 0);
    if (allZero) return null;

    const pts = mesh.map(p => ({ x: p.x, y: p.y, z: p.zParam }));
    const [bl, br, tr, tl] = pts;

    if (mesh.length >= 5) {
      // 5-POINT: barycentric across 4 triangles sharing center
      const c = pts[4];
      const triangles = [
        [bl, br, c],
        [br, tr, c],
        [tr, tl, c],
        [tl, bl, c],
      ];
      for (const [p1, p2, p3] of triangles) {
        if (_pointInTriangle(x, y, p1, p2, p3)) {
          return _barycentricZ(x, y, p1, p2, p3);
        }
      }
    }

    // 4-POINT FALLBACK: bilinear
    const minX = Math.min(bl.x, tl.x), maxX = Math.max(br.x, tr.x);
    const minY = Math.min(bl.y, br.y), maxY = Math.max(tl.y, tr.y);
    const tX = Math.max(0, Math.min(1, (x - minX) / Math.max(1, maxX - minX)));
    const tY = Math.max(0, Math.min(1, (y - minY) / Math.max(1, maxY - minY)));
    return bl.z*(1-tX)*(1-tY) + br.z*tX*(1-tY) + tl.z*(1-tX)*tY + tr.z*tX*tY;
  } catch(e) {
    console.error("Bed mesh read error:", e);
    return null;
  }
}

/** @deprecated use getBedSurfaceZ directly – kept for back-compat */
export function getInterpolatedZ(x, y, originalZ) {
  const bedZ = getBedSurfaceZ(x, y);
  if (bedZ === null) return originalZ; // mesh not calibrated – pass-through
  return bedZ + originalZ;
}

export function dispensePoint({
  x, y,
  zGapAboveBed = 0.1,   // mm ABOVE the calibrated bed surface for dispensing
  zLiftAboveBed = 5,    // mm ABOVE the calibrated bed surface for safe travel
  // Legacy params: used if mesh is not calibrated
  zWork = 0.1,
  zSafe = 5,
  feedXY = 1500,
  feedZ = 500,
  pressure = 0,
  dwellMs = 0,
  valvePin = 4,
  axisMap = defaultAxisMap
}) {
  const cmds = [];

  const bedZ = getBedSurfaceZ(x, y);
  const isMeshActive = bedZ !== null;

  let compWorkZ, compSafeZ;

  if (isMeshActive) {
    // CALIBRATED MODE: derive absolute Z from bed surface + gap
    compWorkZ = bedZ + zGapAboveBed;
    compSafeZ = bedZ + zLiftAboveBed;
    console.debug(`[Dispense @ X${x},Y${y}] BedZ=${bedZ.toFixed(3)} WorkZ=${compWorkZ.toFixed(3)} SafeZ=${compSafeZ.toFixed(3)}`);
  } else {
    // UNCALIBRATED MODE: use raw absolute Z values (original behavior)
    compWorkZ = zWork;
    compSafeZ = zSafe;
  }

  // Move to location at safe height
  cmds.push(...moveAbs({ x, y, z: compSafeZ, feed: feedXY }, axisMap));
  // Move down to work height
  cmds.push(...moveAbs({ z: compWorkZ, feed: feedZ }, axisMap));
  // Pressure ON
  if (pressure > 0) cmds.push(`M42 P${valvePin} S${Math.round(pressure)}`);
  // Dwell
  if (dwellMs > 0) cmds.push(...dwell(dwellMs));
  // Pressure OFF
  if (pressure > 0) cmds.push(`M42 P${valvePin} S0`);
  // Retract to safe height
  cmds.push(...moveAbs({ z: compSafeZ, feed: feedZ }, axisMap));

  return cmds;
}

function _barycentricZ(px, py, p1, p2, p3) {
  const denom = (p2.y - p3.y)*(p1.x - p3.x) + (p3.x - p2.x)*(p1.y - p3.y);
  if (Math.abs(denom) < 1e-9) return (p1.z + p2.z + p3.z) / 3;
  const w1 = ((p2.y - p3.y)*(px - p3.x) + (p3.x - p2.x)*(py - p3.y)) / denom;
  const w2 = ((p3.y - p1.y)*(px - p3.x) + (p1.x - p3.x)*(py - p3.y)) / denom;
  return w1*p1.z + w2*p2.z + (1-w1-w2)*p3.z;
}

function _pointInTriangle(px, py, p1, p2, p3) {
  const d1 = (px-p2.x)*(p1.y-p2.y) - (p1.x-p2.x)*(py-p2.y);
  const d2 = (px-p3.x)*(p2.y-p3.y) - (p2.x-p3.x)*(py-p3.y);
  const d3 = (px-p1.x)*(p3.y-p1.y) - (p3.x-p1.x)*(py-p1.y);
  return !((d1<0||d2<0||d3<0) && (d1>0||d2>0||d3>0));
}

