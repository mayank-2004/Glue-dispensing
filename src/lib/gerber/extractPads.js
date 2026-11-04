const IN2MM = 25.4;

export function extractPadsWithPanel(gerberText) {
  const paramBlocks = [];
  gerberText.replace(/%(?!(?:TO|TA|TD))[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

  let units = 'mm';
  let zeroSupp = 'L';
  let xInt = 2, xDec = 4, yInt = 2, yDec = 4;
  const apertures = {};
  const macros = {};

  for (const block of paramBlocks) {
    const mo = block.match(/%MO(IN|MM)\*%/i);
    if (mo) units = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';
    const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
    if (fs) { zeroSupp = fs[1].toUpperCase(); xInt = +fs[3]; xDec = +fs[4]; yInt = +fs[5]; yDec = +fs[6]; }

    // Parse aperture macros (%AM...%)
    // Regex handles both single-line (*%) and multi-line (*\n%) endings
    const macro = block.match(/%AM([A-Z0-9_]+)\*([\s\S]*?)(?:\*\s*)?%/i);
    if (macro) {
      const macroName = macro[1].toUpperCase();
      const macroContent = macro[2];

      let maxWidth = 0, maxHeight = 0;

      // Each primitive is separated by * in the macro content
      const primLines = macroContent.split('*');
      for (const line of primLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Skip comment lines (start with 0,) and variable declarations ($N=...)
        if (trimmed.startsWith('$') || trimmed.startsWith('0 ')) continue;

        // Replace any variable references ($1, $2, etc.) with 0 so parseFloat gives NaN-safe results
        const cleaned = trimmed.replace(/\$\d+/g, '0');
        const parts = cleaned.split(',').map(s => parseFloat(s.trim()));
        if (!parts.length || isNaN(parts[0])) continue;

        const prim = parts[0];

        if (prim === 1 && parts.length >= 3) {
          // Circle: 1, exposure, diameter[, cx, cy, rot]
          const d = parts[2];
          if (!isNaN(d) && d > 0) { maxWidth = Math.max(maxWidth, d); maxHeight = Math.max(maxHeight, d); }

        } else if (prim === 21 && parts.length >= 4) {
          // Center line (rectangle): 21, exposure, width, height[, cx, cy, rot]
          const w = parts[2], h = parts[3];
          if (!isNaN(w) && w > 0) maxWidth = Math.max(maxWidth, w);
          if (!isNaN(h) && h > 0) maxHeight = Math.max(maxHeight, h);

        } else if ((prim === 20 || prim === 2) && parts.length >= 7) {
          // Vector line: 20, exposure, lineWidth, x1, y1, x2, y2[, rot]
          const lw = parts[2] || 0;
          const x1 = parts[3] || 0, y1 = parts[4] || 0;
          const x2 = parts[5] || 0, y2 = parts[6] || 0;
          maxWidth  = Math.max(maxWidth,  Math.abs(x2 - x1) + lw);
          maxHeight = Math.max(maxHeight, Math.abs(y2 - y1) + lw);

        } else if (prim === 4 && parts.length >= 5) {
          // Outline polygon: 4, exposure, n_vertices, x0, y0, x1, y1, ..., xn, yn, rot
          const n = Math.round(parts[2]);
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (let vi = 0; vi <= n; vi++) {
            const vx = parts[3 + vi * 2];
            const vy = parts[4 + vi * 2];
            if (!isNaN(vx)) { minX = Math.min(minX, vx); maxX = Math.max(maxX, vx); }
            if (!isNaN(vy)) { minY = Math.min(minY, vy); maxY = Math.max(maxY, vy); }
          }
          if (isFinite(maxX - minX)) maxWidth  = Math.max(maxWidth,  maxX - minX);
          if (isFinite(maxY - minY)) maxHeight = Math.max(maxHeight, maxY - minY);

        } else if (prim === 5 && parts.length >= 5) {
          // Regular polygon: 5, exposure, n_vertices, cx, cy, outerDiameter[, rot]
          const d = parts[5];
          if (!isNaN(d) && d > 0) { maxWidth = Math.max(maxWidth, d); maxHeight = Math.max(maxHeight, d); }
        }
      }

      macros[macroName] = {
        width:  maxWidth  > 0 ? maxWidth  : 1.0,
        height: maxHeight > 0 ? maxHeight : 1.0,
        shape: 'MACRO',
        // Flag: were dimensions actually extracted from primitives, or is this a fallback?
        computed: maxWidth > 0,
      };
    }

    // Parse aperture definitions (%ADD...)
    const adMatch = block.match(/%ADD(\d+)([A-Z0-9_]+)(?:,([\d.]+)(?:X([\d.]+))?(?:X([\d.]+))?)?\*%/i);
    if (adMatch) {
      const dCode = parseInt(adMatch[1]);
      const shapeOrMacro = adMatch[2].toUpperCase();
      const p1 = parseFloat(adMatch[3] || '0');
      const p2 = parseFloat(adMatch[4] || adMatch[3] || '0');

      let aperture;

      if (['C', 'R', 'O', 'P'].includes(shapeOrMacro)) {
        // Standard geometric apertures
        const shape = shapeOrMacro === 'C' ? 'Circle'
                    : shapeOrMacro === 'O' ? 'Obround'
                    : shapeOrMacro === 'P' ? 'Polygon'
                    : 'Rect';
        aperture = { shape, width: p1 || 1.0, height: p2 || p1 || 1.0 };

      } else if (macros[shapeOrMacro]) {
        aperture = { ...macros[shapeOrMacro] };
        // Only use ADD instantiation params as dimensions when the macro primitives
        // contained variable references ($n) and gave us no real bounding box.
        // If the macro has computed dimensions, keep them — the ADD params are
        // likely corner radii or other non-size parameters.
        if (!aperture.computed && p1 > 0) {
          aperture.width  = p1;
          aperture.height = p2 || p1;
        }
        delete aperture.computed;

      } else {
        // Unknown macro — no definition seen. Use ADD params if present.
        aperture = { width: p1 || 1.0, height: p2 || p1 || 1.0, shape: 'MACRO' };
      }

      apertures[dCode] = aperture;
    }
  }

  console.log('[Gerber] Parsed apertures:', apertures);

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

  let curX = 0, curY = 0, currentD = null, currentAperture = null;
  let currentRefDes = null, srState = null, detectedPanel = null;
  const basePads = [];
  const srPads = [];
  const textLen = gerberText.length;
  let cursor = 0;

  while (cursor < textLen) {
    if (gerberText.charCodeAt(cursor) === 37 /* '%' */) {
      // Check if it's a step-and-repeat or attribute block
      const nextP = gerberText.indexOf('%', cursor + 1);
      if (nextP !== -1) {
        const pBlock = gerberText.substring(cursor, nextP + 1);
        const sr = pBlock.match(/%SR(?:X(\d+))?(?:Y(\d+))?(?:I([\d.-]+))?(?:J([\d.-]+))?\*%/i);
        if (sr) {
          if (!sr[1] && !sr[2] && !sr[3] && !sr[4]) { srState = null; }
          else {
            const dimX = sr[1] ? parseInt(sr[1], 10) : 1, dimY = sr[2] ? parseInt(sr[2], 10) : 1;
            const stepX = sr[3] ? parseFloat(sr[3]) : 0, stepY = sr[4] ? parseFloat(sr[4]) : 0;
            srState = { dimX, dimY, stepX, stepY };
            if ((dimX > 1 || dimY > 1) && !detectedPanel) detectedPanel = { dimX, dimY, stepX, stepY };
          }
        }
        cursor = nextP + 1;
        continue;
      }
    }

    const starIdx = gerberText.indexOf('*', cursor);
    if (starIdx === -1) break;

    const raw = gerberText.substring(cursor, starIdx).trim();
    cursor = starIdx + 1;
    if (!raw || (raw.charCodeAt(0) === 71 && (raw.startsWith('G04') || raw.startsWith('G4')))) continue;
    if (raw.startsWith('TO.C')) { const parts = raw.split(','); if (parts.length >= 2) currentRefDes = parts[1]; continue; }
    if (raw.startsWith('TD')) { currentRefDes = null; continue; }

    // Standalone D-code
    if (raw.charCodeAt(0) === 68 || raw.charCodeAt(0) === 100) {
      const code = parseInt(raw.slice(1), 10);
      currentD = code;
      if (code >= 10 && apertures[code]) currentAperture = apertures[code];
      continue;
    }

    // D-code within token
    const di = raw.search(/D0?(\d+)/i);
    if (di !== -1) {
      const dCode = parseInt(raw.slice(di + 1), 10);
      currentD = dCode;
      if (dCode >= 10 && apertures[dCode]) currentAperture = apertures[dCode];
    }

    const newX = extractCoord(raw, 'X', xDivisor);
    if (newX !== null) curX = newX;
    const newY = extractCoord(raw, 'Y', yDivisor);
    if (newY !== null) curY = newY;

    if (currentD === 3 && (newX !== null || newY !== null)) {
      const ap = currentAperture || { width: 1.0, height: 1.0, shape: 'R' };
      const mkPad = (px, py, ref) => ({ x: px, y: py, width: ap.width, height: ap.height, shape: ap.shape, componentIdentifier: ref });
      basePads.push(mkPad(curX, curY, currentRefDes));
      if (srState) {
        const { dimX, dimY, stepX, stepY } = srState;
        for (let i = 0; i < dimX; i++) {
          for (let j = 0; j < dimY; j++) {
            if (i === 0 && j === 0) continue;
            srPads.push(mkPad(curX + i * stepX, curY + j * stepY, currentRefDes ? `${currentRefDes}_SR${i}_${j}` : null));
          }
        }
      }
    }
  }

  const conv = pads => units === 'in'
    ? pads.map(p => ({ ...p, x:p.x*IN2MM, y:p.y*IN2MM, width:p.width*IN2MM, height:p.height*IN2MM }))
    : pads;

  return { pads: conv(basePads), allPads: conv([...basePads, ...srPads]), panel: detectedPanel };
}

export function extractPadsMm(gerberText) {
  const res = extractPadsWithPanel(gerberText);
  return res.allPads || res.pads || [];
}
