// src/lib/motion/gcode.js
// Tiny, predictable G-code helpers for XYZR machines.

export const defaultAxisMap = {
  X: "X",
  Y: "Y",
  Z: "Z",
  R: "A", // map rotation to "A" by default; change to "E" or custom if your firmware needs it
};

export const defaultFeeds = {
  travel: { X: 9000, Y: 9000, Z: 600, R: 1800 }, // mm/min
  work:   { X: 1500, Y: 1500, Z: 300, R: 600  },
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
  // only home R if your firmware supports it:
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
  return Number(n).toFixed(3).replace(/\.?0+$/,"");
}
