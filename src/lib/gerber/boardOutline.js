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

  const xDivisor = Math.pow(10, xDec);
  const yDivisor = Math.pow(10, yDec);

  const extractCoord = (t, char, divisor) => {
    let idx = t.indexOf(char);
    if (idx === -1) {
      char = char.toLowerCase();
      idx = t.indexOf(char);
    }
    if (idx === -1) return null;
    let end = idx + 1;
    const len = t.length;
    if (end < len && (t.charCodeAt(end) === 43 || t.charCodeAt(end) === 45)) end++;
    while (end < len) {
      const c = t.charCodeAt(end);
      if ((c >= 48 && c <= 57) || c === 46) end++;
      else break;
    }
    const str = t.substring(idx + 1, end);
    if (str.includes('.')) return parseFloat(str);
    const n = parseInt(str, 10);
    return isNaN(n) ? null : n / divisor;
  };

  let curX = 0, curY = 0, currentD = null;
  const points = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const textLen = gerberText.length;
  let cursor = 0;

  while (cursor < textLen) {
    if (gerberText.charCodeAt(cursor) === 37 /* '%' */) {
      const nextP = gerberText.indexOf('%', cursor + 1);
      cursor = nextP === -1 ? textLen : nextP + 1;
      continue;
    }

    const starIdx = gerberText.indexOf('*', cursor);
    if (starIdx === -1) break;

    const raw = gerberText.substring(cursor, starIdx).trim();
    cursor = starIdx + 1;
    if (!raw || (raw.charCodeAt(0) === 71 && (raw.startsWith('G04') || raw.startsWith('G4')))) continue;

    const di = raw.search(/D0?(\d+)/i);
    if (di !== -1) {
      currentD = parseInt(raw.slice(di + 1), 10);
    }

    const newX = extractCoord(raw, 'X', xDivisor);
    if (newX !== null) curX = newX;
    const newY = extractCoord(raw, 'Y', yDivisor);
    if (newY !== null) curY = newY;

    if (currentD === 1 || currentD === 2) {
      points.push({ x: curX, y: curY });
      if (curX < minX) minX = curX;
      if (curX > maxX) maxX = curX;
      if (curY < minY) minY = curY;
      if (curY > maxY) maxY = curY;
    }
  }

  if (points.length === 0 || !isFinite(minX)) return null;

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