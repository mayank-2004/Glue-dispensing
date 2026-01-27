// src/lib/utils/transform2d.js
// 2D transforms: apply, fit similarity (2-pt), fit affine (3+), optional invert, error.

export function applyTransform(T, pt) {
  if (!T) return { ...pt };
  const { a, b, c, d, tx, ty } = T;
  return { x: a * pt.x + b * pt.y + tx, y: c * pt.x + d * pt.y + ty };
}

export function fitSimilarity(designPts, machinePts) {
  const n = designPts.length;
  if (n < 2) throw new Error("Need at least 2 pairs for similarity fit.");

  // centroids
  const cd = centroid(designPts);
  const cm = centroid(machinePts);

  // center the points
  const D = designPts.map(p => ({ x: p.x - cd.x, y: p.y - cd.y }));
  const M = machinePts.map(p => ({ x: p.x - cm.x, y: p.y - cm.y }));

  // Procrustes in 2D (Umeyama): A = sum(Dx*Mx + Dy*My), B = sum(Dx*My - Dy*Mx)
  let A = 0, B = 0, denom = 0;
  for (let i = 0; i < n; i++) {
    A += D[i].x * M[i].x + D[i].y * M[i].y;
    B += D[i].x * M[i].y - D[i].y * M[i].x;
    denom += D[i].x * D[i].x + D[i].y * D[i].y;
  }
  const theta = Math.atan2(B, A);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const scale = Math.sqrt(A * A + B * B) / (denom || 1e-9);

  const a = scale * cos, b = -scale * sin;
  const c = scale * sin, d =  scale * cos;
  const tx = cm.x - (a * cd.x + b * cd.y);
  const ty = cm.y - (c * cd.x + d * cd.y);

  return { type: "similarity", a, b, c, d, tx, ty, scale, theta };
}

export function fitAffine(designPts, machinePts) {
  const n = designPts.length;
  if (n < 3) throw new Error("Need at least 3 pairs for affine fit.");

  const A = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    const { x, y: yy } = designPts[i];
    const { x: X, y: Y } = machinePts[i];
    A.push([x, yy, 0, 0, 1, 0]); y.push(X);
    A.push([0, 0, x, yy, 0, 1]); y.push(Y);
  }
  const At = transpose(A);
  const AtA = matMul(At, A);
  const Aty = matVecMul(At, y);
  const p = solveGaussian(AtA, Aty);
  const [a, b, c, d, tx, ty] = p;
  return { type: "affine", a, b, c, d, tx, ty };
}

export function rmsError(T, designPts, machinePts) {
  let s2 = 0;
  for (let i = 0; i < designPts.length; i++) {
    const m = applyTransform(T, designPts[i]);
    const dx = m.x - machinePts[i].x;
    const dy = m.y - machinePts[i].y;
    s2 += dx * dx + dy * dy;
  }
  return Math.sqrt(s2 / designPts.length);
}

// Optional inverse (useful if you need to map back)
export function invert(T) {
  const { a, b, c, d, tx, ty } = T;
  const det = a * d - b * c || 1e-12;
  const ia =  d / det, ib = -b / det, ic = -c / det, id = a / det;
  const itx = -(ia * tx + ib * ty), ity = -(ic * tx + id * ty);
  return { type: T.type, a: ia, b: ib, c: ic, d: id, tx: itx, ty: ity };
}

/* ---------- helpers ---------- */
function centroid(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const n = Math.max(pts.length, 1);
  return { x: sx / n, y: sy / n };
}
function transpose(M) {
  const r = M.length, c = M[0].length;
  const T = Array.from({ length: c }, () => Array(r).fill(0));
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) T[j][i] = M[i][j];
  return T;
}
function matMul(A, B) {
  const r = A.length, k = A[0].length, c = B[0].length;
  const out = Array.from({ length: r }, () => Array(c).fill(0));
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    let s = 0; for (let t = 0; t < k; t++) s += A[i][t] * B[t][j];
    out[i][j] = s;
  }
  return out;
}
function matVecMul(A, v) {
  const r = A.length, c = A[0].length;
  const out = Array(r).fill(0);
  for (let i = 0; i < r; i++) {
    let s = 0; for (let j = 0; j < c; j++) s += A[i][j] * v[j];
    out[i] = s;
  }
  return out;
}
function solveGaussian(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) continue;
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}
