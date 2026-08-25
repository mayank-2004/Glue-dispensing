import React from 'react';

export const SPC_KEY = 'spcDotQuality';
const SPC_MAX_JOBS = 60;

export function idwCorrect(x, y, vectors, power = 2) {
  if (!vectors || !vectors.length) return { dx: 0, dy: 0 };
  let wdx = 0, wdy = 0, wsum = 0;
  for (const v of vectors) {
    const d2 = (x - v.x) * (x - v.x) + (y - v.y) * (y - v.y);
    if (d2 < 1e-6) return { dx: v.dx, dy: v.dy };
    const w = 1 / Math.pow(d2, power);
    wdx += w * v.dx; wdy += w * v.dy; wsum += w;
  }
  return { dx: wdx / wsum, dy: wdy / wsum };
}

export function spcLoad() {
  try { return JSON.parse(localStorage.getItem(SPC_KEY) || '{"jobs":[]}'); }
  catch { return { jobs: [] }; }
}

export function spcAppend(dotResults, totalPads) {
  if (!dotResults || dotResults.length === 0) return;
  const data = spcLoad();
  const passed = dotResults.filter(r => r.passed).length;
  const diams = dotResults.filter(r => r.diameter_mm > 0).map(r => r.diameter_mm);
  data.jobs = [...data.jobs, {
    jobId: new Date().toISOString(), date: new Date().toLocaleDateString(), totalPads,
    checked: dotResults.length, passed, failed: dotResults.length - passed,
    passRate: passed / dotResults.length,
    avgDiameter: diams.length ? diams.reduce((a, b) => a + b, 0) / diams.length : null,
    minDiameter: diams.length ? Math.min(...diams) : null,
  }].slice(-SPC_MAX_JOBS);
  localStorage.setItem(SPC_KEY, JSON.stringify(data));
}

export function parsePnpCsv(text, filename = '') {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const findCol = (...names) => names.reduce((found, name) => found >= 0 ? found : headers.findIndex(h => h.includes(name)), -1);
  const colRef = findCol('ref', 'designator', 'reference');
  const colX = findCol('pos x', 'mid x', 'posx', 'x');
  const colY = findCol('pos y', 'mid y', 'posy', 'y');
  const colPkg = findCol('package', 'footprint', 'value', 'val');
  const colSide = findCol('side', 'layer');
  const colRot = findCol('rot', 'rotation', 'angle');
  if (colX < 0 || colY < 0) return [];
  const fn = filename.toLowerCase();
  const filenameSide = fn.includes('bot') || fn.includes('back') || fn.includes('-b.') || fn.includes('_b.') ? 'bottom' : 'top';
  const parseNum = s => parseFloat(String(s).replace(/[^\d.\-]/g, '') || '0');
  const resolveSide = raw => {
    if (!raw) return filenameSide;
    const r = raw.toLowerCase().trim();
    if (r === 'f.cu' || r === 'f' || r === 'front' || r === 'top') return 'top';
    if (r === 'b.cu' || r === 'b' || r === 'back' || r.includes('bot')) return 'bottom';
    return filenameSide;
  };
  return lines.slice(1).map((line, i) => {
    const cols = line.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const x = parseNum(cols[colX]), y = parseNum(cols[colY]);
    if (isNaN(x) || isNaN(y)) return null;
    return { id: colRef >= 0 ? cols[colRef] : `C${i + 1}`, x, y,
      pkg: colPkg >= 0 ? cols[colPkg] : '', side: resolveSide(colSide >= 0 ? cols[colSide] : null),
      rotation: colRot >= 0 ? parseNum(cols[colRot]) : 0 };
  }).filter(Boolean);
}

export function detectDnpComponents(comps) {
  const dnpKeywords = ['dnp', 'do not place', 'no fit', 'not fit', 'nf', 'nc', 'nm', 'x'];
  return new Set(comps.filter(c => {
    if (/^fid/i.test(c.id)) return true;
    const pkg = (c.pkg || '').toLowerCase().trim();
    return pkg === '' || dnpKeywords.some(kw => pkg === kw || pkg.startsWith(kw + ' '));
  }).map(c => c.id));
}

export function autoComputePnpOffset(csvComponents, appFiducials, toleranceMm = 5) {
  const csvFids = csvComponents.filter(c => /^fid/i.test(c.id));
  const appDesign = appFiducials.filter(f => f.design).map(f => f.design);
  if (!csvFids.length || !appDesign.length) return null;
  let bestScore = 0, bestOffset = null;
  for (const cf of csvFids) for (const af of appDesign) {
    const candDx = af.x - cf.x, candDy = af.y - cf.y;
    let sumDx = 0, sumDy = 0, matches = 0;
    for (const cf2 of csvFids) {
      const sx = cf2.x + candDx, sy = cf2.y + candDy;
      let minDist = Infinity, bestAf = null;
      for (const af2 of appDesign) {
        const d = Math.hypot(af2.x - sx, af2.y - sy);
        if (d < minDist) { minDist = d; bestAf = af2; }
      }
      if (minDist < toleranceMm) { sumDx += bestAf.x - cf2.x; sumDy += bestAf.y - cf2.y; matches++; }
    }
    if (matches > bestScore) { bestScore = matches; bestOffset = { x: sumDx / matches, y: sumDy / matches }; }
  }
  return bestOffset;
}

export function classifyDotPattern(pkg) {
  if (!pkg) return 'single';
  const p = pkg.toLowerCase();
  if (/^(qfp|qfn|soic|sop|ssop|tssop|lqfp|plcc|bga|lga|qsop|tso)/.test(p)) return 'quad';
  if (/(?:^|[_\-\s])(1206|1210|1812|2010|2512)(?:[_\-\s]|$)/.test(p)) return 'dual';
  if (/conn|hdr|jst|molex|usb|hdmi|sma/.test(p)) return 'dual';
  return 'single';
}

export function getComponentDotOffsets(comp, spacingMm, customPatterns = {}) {
  const pattern = customPatterns[comp.id] || classifyDotPattern(comp.pkg);
  const half = spacingMm / 2, angleRad = ((comp.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  const rot = (dx, dy) => ({ dx: dx * cos - dy * sin, dy: dx * sin + dy * cos });
  if (pattern === 'dual') return [rot(-half, 0), rot(half, 0)];
  if (pattern === 'quad') return [rot(-half, -half), rot(half, -half), rot(half, half), rot(-half, half)];
  return [{ dx: 0, dy: 0 }];
}

export function detectPanelFromFiducials(fiducials) {
  const valid = fiducials.filter(f => f.design && typeof f.design.x === 'number' && typeof f.design.y === 'number');
  if (valid.length < 4) return null;
  const xGroups = [];
  for (const fid of valid) {
    const group = xGroups.find(g => Math.abs(g.cx - fid.design.x) < 2);
    if (group) group.ys.push(fid.design.y); else xGroups.push({ cx: fid.design.x, ys: [fid.design.y] });
  }
  const rows = Math.max(...xGroups.map(g => g.ys.length));
  if (rows < 2) return null;
  let totalStep = 0, count = 0;
  for (const group of xGroups) if (group.ys.length === rows) {
    const sortedYs = [...group.ys].sort((a, b) => a - b);
    for (let i = 1; i < sortedYs.length; i++) { totalStep += sortedYs[i] - sortedYs[i - 1]; count++; }
  }
  if (!count) return null;
  const stepY = parseFloat((totalStep / count).toFixed(2));
  for (const group of xGroups) if (group.ys.length === rows) {
    const sortedYs = [...group.ys].sort((a, b) => a - b);
    for (let i = 1; i < sortedYs.length; i++) if (Math.abs(sortedYs[i] - sortedYs[i - 1] - stepY) > 5) return null;
  }
  return { rows, stepY };
}

export function nearestNeighborSort(components, startX = 0, startY = 0) {
  if (components.length <= 1) return [...components];
  const remaining = [...components], sorted = [];
  let cx = startX, cy = startY;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const dist = Math.hypot(remaining[i].x - cx, remaining[i].y - cy);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    const comp = remaining.splice(bestIdx, 1)[0];
    sorted.push(comp); cx = comp.x; cy = comp.y;
  }
  return sorted;
}

export function totalTravelMm(components, startX = 0, startY = 0) {
  if (!components.length) return 0;
  let dist = Math.hypot(components[0].x - startX, components[0].y - startY);
  for (let i = 1; i < components.length; i++) dist += Math.hypot(components[i].x - components[i - 1].x, components[i].y - components[i - 1].y);
  return dist;
}

export function Sparkline({ values, color = '#58a6ff', height = 36, width = '100%' }) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const W = 260, H = height;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - ((v - min) / range) * (H - 4) - 2).toFixed(1)}`).join(' ');
  const last = values[values.length - 1], lx = W, ly = H - ((last - min) / range) * (H - 4) - 2;
  return <svg viewBox={`0 0 ${W} ${H}`} style={{ width, height, display: 'block', overflow: 'visible' }}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" /><circle cx={lx} cy={ly} r="3" fill={color} /></svg>;
}
