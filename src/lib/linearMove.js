const EPS = 1e-9;
const nearlyZero = (v, eps = EPS) => Math.abs(v) < eps;
const len2 = (dx, dy) => Math.hypot(dx, dy);

export function projectLimitsToLine(dx, dy, limits) {
  const L = len2(dx, dy);
  const cos = L > 0 ? Math.abs(dx) / L : 1;
  const sin = L > 0 ? Math.abs(dy) / L : 0;

  const vxCap = cos < EPS ? Infinity : limits.Vx / cos;
  const vyCap = sin < EPS ? Infinity : limits.Vy / sin;
  const axCap = cos < EPS ? Infinity : limits.Ax / cos;
  const ayCap = sin < EPS ? Infinity : limits.Ay / sin;

  return { Vline: Math.min(vxCap, vyCap), Aline: Math.min(axCap, ayCap), cos, sin };
}

export function trapezoidProfile(D, Vmax, Amax) {
  const Dcrit = (Vmax * Vmax) / Amax;
  if (D <= Dcrit) {
    const tAcc = Math.sqrt(D / Amax);
    const vPeak = Amax * tAcc;
    const T = 2 * tAcc;
    return { type: 'tri', T, tAcc, tCru: 0, tDec: tAcc, vPeak, dAcc: 0.5*Amax*tAcc*tAcc, dCru: 0, dDec: 0.5*Amax*tAcc*tAcc };
  } else {
    const tAcc = Vmax / Amax;
    const dAcc = 0.5 * Amax * tAcc * tAcc;
    const dDec = dAcc;
    const dCru = D - dAcc - dDec;
    const tCru = dCru / Vmax;
    const T = tAcc + tCru + tAcc;
    return { type: 'trap', T, tAcc, tCru, tDec: tAcc, vPeak: Vmax, dAcc, dCru, dDec };
  }
}

export function distanceAtTime(t, P, Amax) {
  const { type, tAcc, tCru, T, vPeak, dAcc, dCru } = P;
  if (t <= 0) return 0;
  if (t >= T) return dAcc + dCru + dAcc;

  if (type === 'tri') {
    if (t <= tAcc) return 0.5 * Amax * t * t;
    const tau = t - tAcc;
    return dAcc + (vPeak * tau - 0.5 * Amax * tau * tau);
  } else {
    if (t <= tAcc) return 0.5 * Amax * t * t;
    if (t <= tAcc + tCru) return dAcc + vPeak * (t - tAcc);
    const tau = t - (tAcc + tCru);
    return dAcc + dCru + (vPeak * tau - 0.5 * Amax * tau * tau);
  }
}

function to3(n) { return Number.isFinite(n) ? n.toFixed(3) : '0.000'; }
function toFeed(v_mm_s) { return Math.max(1, Math.round(v_mm_s * 60)); }

export function planLinearMove({ A, B, axis, dt = 0.01, moveZTogether = false }) {
  const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
  const Lxy = len2(dx, dy);

  if (nearlyZero(Lxy)) {
    const g = [`G1 Z${to3(B.z)} F${toFeed(axis.Vz ?? 10)}`];
    return { waypoints: [{ t: 0, x: A.x, y: A.y, z: B.z }], stats: { Lxy, Vline: 0, Aline: 0, T: 0 }, gcode: g };
  }

  const { Vline, Aline } = projectLimitsToLine(dx, dy, { Vx: axis.Vx, Vy: axis.Vy, Ax: axis.Ax, Ay: axis.Ay });
  const P = trapezoidProfile(Lxy, Vline, Aline);

  const nSteps = Math.max(2, Math.ceil(P.T / dt));
  const waypoints = [];
  for (let i = 0; i <= nSteps; i++) {
    const t = (i / nSteps) * P.T;
    const s = distanceAtTime(t, P, Aline);
    const u = Lxy > 0 ? s / Lxy : 0;
    const x = A.x + u * dx;
    const y = A.y + u * dy;
    const z = moveZTogether ? (A.z + u * dz) : A.z;
    waypoints.push({ t, x, y, z });
  }

  const F_line = toFeed(0.95 * Vline);
  const gcode = ['G90', 'G21'];
  if (moveZTogether) {
    gcode.push(`G1 X${to3(B.x)} Y${to3(B.y)} Z${to3(B.z)} F${F_line}`);
  } else {
    gcode.push(`G1 X${to3(B.x)} Y${to3(B.y)} F${F_line}`);
  }

  return { waypoints, stats: { Lxy, Vline, Aline, T: P.T }, gcode };
}

export function buildPlacementSequence({ A, B, Zsafe, Zwork, axis, approachFeedZ = axis.Vz ?? 10 }) {
  const g = ['G90', 'G21', `G0 Z${(Zsafe).toFixed(3)}`];

  const { gcode, waypoints, stats } = planLinearMove({
    A: { x: A.x, y: A.y, z: Zsafe },
    B: { x: B.x, y: B.y, z: Zsafe },
    axis,
    dt: 0.01,
    moveZTogether: false,
  });
  g.push(...gcode);
  g.push(`G1 Z${(Zwork).toFixed(3)} F${toFeed(approachFeedZ)}`);
  g.push(`G0 Z${(Zsafe).toFixed(3)}`);

  const preview = [
    { t: 0, x: A.x, y: A.y, z: Zsafe },
    ...waypoints,
    { t: stats.T + 0.01, x: B.x, y: B.y, z: Zwork },
    { t: stats.T + 0.02, x: B.x, y: B.y, z: Zsafe },
  ];

  return { gcode: g, preview, stats };
}
