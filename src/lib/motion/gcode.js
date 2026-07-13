export const defaultAxisMap = {
  X: "X",
  Y: "Y",
  Z: "Z",
  R: "A", // map rotation to "A" by default; change to "E" or custom if your firmware needs it
};

export const defaultFeeds = {
  travel: { X: 3000, Y: 3000, Z: 600, R: 600 }, // mm/min — 50 mm/s XY, 10 mm/s Z
  work: { X: 600, Y: 600, Z: 240, R: 240 },
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
  // No G90 here — caller restores absolute mode after jog session ends (debounced).
  // Keeping G91 between consecutive jog clicks lets Marlin's planner blend moves
  // instead of hard-stopping between each click.
  return [`G91\nG1 ${parts.join(" ")}${f}`];
}

export function dwell(ms = 50) {
  return [`G4 P${Math.max(0, Math.round(ms))}`];
}

function fmt(n) {
  // Keep 3 decimals max to avoid long floats
  return Number(n).toFixed(3).replace(/\.?0+$/, "");
}

export function dispensePoint({
  x, y,
  zWork = 0.5,
  zSafe = 5,
  feedXY = 1500,
  feedZ = 500,
  pressure = 0,
  dwellMs = 0,
  pwmDuty = 255,
  axisMap = defaultAxisMap
}) {
  const cmds = [];
  // Move to location at safe height
  cmds.push(...moveAbs({ x, y, z: zSafe, feed: feedXY }, axisMap));

  // Move down to work height
  cmds.push(...moveAbs({ z: zWork, feed: feedZ }, axisMap));

  // Trigger ON — M106 controls fan/relay output (0-255 PWM duty)
  if (pressure > 0) cmds.push(`M106 S${Math.min(255, Math.max(0, Math.round(pwmDuty)))}`);

  // Dwell
  if (dwellMs > 0) cmds.push(...dwell(dwellMs));

  // Trigger OFF
  if (pressure > 0) cmds.push('M107');

  // Retract to safe height
  cmds.push(...moveAbs({ z: zSafe, feed: feedZ }, axisMap));

  return cmds;
} 

/**
 * Dispense a continuous glue bead along the pad's longer axis.
 * Valve opens at the start position, machine moves to the end while dispensing, then valve closes.
 *
 * @param {string} beadAxis - 'X' or 'Y' — the axis to travel along
 * @param {number} beadLength - full length of the bead in mm (use pad.height or pad.width)
 * @param {number} feedBead - feed rate while dispensing (mm/min) — slower = more glue
 */
export function dispenseBead({
  x, y,
  beadLength,
  beadAxis = 'Y',
  zWork = 0.5,
  zSafe = 5,
  feedXY = 1500,
  feedZ = 500,
  feedBead = 500,
  pressure = 0,
  pwmDuty = 255,
  axisMap = defaultAxisMap
}) {
  const cmds = [];
  const half = beadLength / 2;

  const startX = beadAxis === 'X' ? x - half : x;
  const startY = beadAxis === 'Y' ? y - half : y;
  const endX   = beadAxis === 'X' ? x + half : x;
  const endY   = beadAxis === 'Y' ? y + half : y;

  // Travel to bead start at safe height
  cmds.push(...moveAbs({ x: startX, y: startY, z: zSafe, feed: feedXY }, axisMap));
  // Lower to work height
  cmds.push(...moveAbs({ z: zWork, feed: feedZ }, axisMap));
  // Trigger ON — M106 controls fan/relay output (0-255 PWM duty)
  if (pressure > 0) cmds.push(`M106 S${Math.min(255, Math.max(0, Math.round(pwmDuty)))}`);
  // Sweep to bead end with valve open
  cmds.push(...moveAbs({ x: endX, y: endY, feed: feedBead }, axisMap));
  // Trigger OFF
  if (pressure > 0) cmds.push('M107');
  // Retract to safe height
  cmds.push(...moveAbs({ z: zSafe, feed: feedZ }, axisMap));

  return cmds;
}
