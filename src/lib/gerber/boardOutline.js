/**
 * Board Outline Detection - Extract PCB dimensions from board outline layer
 */

const IN2MM = 25.4;

export function extractBoardOutline(gerberText) {
  const paramBlocks = [];
  gerberText.replace(/%[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

  let units = 'mm';
  let zeroSupp = 'L';
  let xInt = 2, xDec = 4, yInt = 2, yDec = 4;

  for (const block of paramBlocks) {
    const mo = block.match(/%MO(IN|MM)\*%/i);
    if (mo) units = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';
    const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
    if (fs) { zeroSupp = fs[1].toUpperCase(); xInt=+fs[3]; xDec=+fs[4]; yInt=+fs[5]; yDec=+fs[6]; }
  }

  const opsText = gerberText.replace(/%[^%]*%/g, '');
  const tokens = opsText.split('*').map(s => s.trim()).filter(Boolean);

  const parseCoord = (val, i, d, z = zeroSupp) => {
    if (val.includes('.')) return parseFloat(val);
    let sign = 1;
    if (val.startsWith('+')) val = val.slice(1);
    if (val.startsWith('-')) { sign = -1; val = val.slice(1); }
    const total = i + d;
    let s = z === 'L' ? val.padStart(total, '0') : val.padEnd(total, '0');
    return sign * parseFloat(`${s.slice(0,i)}.${s.slice(i)}`);
  };

  const parseXY = (t, last) => {
    const m = {};
    t.replace(/([XY])([+\-]?\d+(?:\.\d+)?)?/gi, (_, k, v) => { m[k.toUpperCase()] = v || ''; return ''; });
    let x = last.x, y = last.y;
    if (m.X !== undefined) x = parseCoord(m.X, xInt, xDec);
    if (m.Y !== undefined) y = parseCoord(m.Y, yInt, yDec);
    return { x, y };
  };

  let curX = 0, curY = 0, currentD = null;
  const points = [];

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;

    const md = t.match(/D0?(\d+)$/i);
    if (md) currentD = +md[1];

    if (/[XY]/i.test(t)) {
      const { x, y } = parseXY(t, { x: curX, y: curY });
      if (currentD === 1 || currentD === 2) { // Move or draw
        points.push({ x, y });
      }
      curX = x; curY = y;
    }
  }

  if (points.length === 0) return null;

  // Calculate board dimensions
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const outline = {
    minX: units === 'in' ? minX * IN2MM : minX,
    maxX: units === 'in' ? maxX * IN2MM : maxX,
    minY: units === 'in' ? minY * IN2MM : minY,
    maxY: units === 'in' ? maxY * IN2MM : maxY,
    width: units === 'in' ? (maxX - minX) * IN2MM : (maxX - minX),
    height: units === 'in' ? (maxY - minY) * IN2MM : (maxY - minY),
    centerX: units === 'in' ? ((minX + maxX) / 2) * IN2MM : (minX + maxX) / 2,
    centerY: units === 'in' ? ((minY + maxY) / 2) * IN2MM : (minY + maxY) / 2,
    points: points.map(p => ({
      x: units === 'in' ? p.x * IN2MM : p.x,
      y: units === 'in' ? p.y * IN2MM : p.y
    }))
  };

  return outline;
}