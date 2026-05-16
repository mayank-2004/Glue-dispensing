const IN2MM = 25.4;

export function extractPadsMm(gerberText) {
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

  // Strip param blocks; process operation tokens
  const opsText = gerberText.replace(/%(?!(?:TO|TA|TD))[^%]*%/g, '').replace(/%/g, '');
  const tokens = opsText.split('*').map(s => s.trim()).filter(Boolean);

  const parseCoord = (val, i, d) => {
    if (val.includes('.')) return parseFloat(val);
    let sign = 1;
    if (val.startsWith('+')) val = val.slice(1);
    if (val.startsWith('-')) { sign = -1; val = val.slice(1); }
    const total = i + d;
    const s = zeroSupp === 'L' ? val.padStart(total, '0') : val.padEnd(total, '0');
    return sign * parseFloat(`${s.slice(0, i)}.${s.slice(i)}`);
  };

  const parseXY = (t, last) => {
    const m = {};
    t.replace(/([XY])([+\-]?\d+(?:\.\d+)?)?/gi, (_, k, v) => { m[k.toUpperCase()] = v || ''; return ''; });
    let x = last.x, y = last.y;
    if (m.X !== undefined) x = parseCoord(m.X, xInt, xDec);
    if (m.Y !== undefined) y = parseCoord(m.Y, yInt, yDec);
    return { x, y };
  };

  let curX = 0, curY = 0, currentD = null, currentAperture = null;
  let currentRefDes = null;
  let srState = null;
  const pads = [];

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;

    if (t.startsWith('TO.C')) {
      const parts = t.split(',');
      if (parts.length >= 2) currentRefDes = parts[1];
      continue;
    }
    if (t.startsWith('TD')) { currentRefDes = null; continue; }

    const sr = t.match(/%SR(?:X(\d+))?(?:Y(\d+))?(?:I([\d.-]+))?(?:J([\d.-]+))?\*%/i);
    if (sr) {
      if (!sr[1] && !sr[2] && !sr[3] && !sr[4]) {
        srState = null;
      } else {
        srState = {
          dimX: sr[1] ? parseInt(sr[1]) : 1,
          dimY: sr[2] ? parseInt(sr[2]) : 1,
          stepX: sr[3] ? parseFloat(sr[3]) : 0,
          stepY: sr[4] ? parseFloat(sr[4]) : 0,
        };
      }
      continue;
    }

    const md = t.match(/D0?(\d+)$/i);
    if (md) {
      currentD = +md[1];
      if (currentD >= 10 && apertures[currentD]) currentAperture = apertures[currentD];
    }

    if (/[XY]/i.test(t)) {
      const { x, y } = parseXY(t, { x: curX, y: curY });
      if (currentD === 2 || currentD == null) { curX = x; curY = y; continue; }
      if (currentD === 1) { curX = x; curY = y; continue; }
      if (currentD === 3) {
        const ap = currentAperture || { width: 1.0, height: 1.0, shape: 'R' };
        const pushPad = (px, py, refDes) => pads.push({
          x: px, y: py,
          width: ap.width, height: ap.height, shape: ap.shape,
          componentIdentifier: refDes,
        });
        pushPad(x, y, currentRefDes);
        if (srState) {
          const { dimX, dimY, stepX, stepY } = srState;
          for (let i = 0; i < dimX; i++) {
            for (let j = 0; j < dimY; j++) {
              if (i === 0 && j === 0) continue;
              pushPad(x + i * stepX, y + j * stepY,
                currentRefDes ? `${currentRefDes}_SR${i}_${j}` : null);
            }
          }
        }
        curX = x; curY = y; continue;
      }
    }
  }

  if (units === 'in') {
    return pads.map(p => ({
      x: p.x * IN2MM, y: p.y * IN2MM,
      width: p.width * IN2MM, height: p.height * IN2MM,
      shape: p.shape, componentIdentifier: p.componentIdentifier,
    }));
  }
  return pads;
}

/**
 * Like extractPadsMm but also returns SR panel grid info and separates base pads
 * from SR-replicated instances so each board's pad sequence stays independent.
 * Returns { pads: basePads, allPads, panel: { dimX, dimY, stepX, stepY } | null }
 */
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

    const macro = block.match(/%AM([A-Z0-9_]+)\*([\s\S]*?)(?:\*\s*)?%/i);
    if (macro) {
      const macroName = macro[1].toUpperCase();
      const macroContent = macro[2];
      let maxWidth = 0, maxHeight = 0;
      const primLines = macroContent.split('*');
      for (const line of primLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('$') || trimmed.startsWith('0 ')) continue;
        const cleaned = trimmed.replace(/\$\d+/g, '0');
        const parts = cleaned.split(',').map(s => parseFloat(s.trim()));
        if (!parts.length || isNaN(parts[0])) continue;
        const prim = parts[0];
        if (prim === 1 && parts.length >= 3) { const d = parts[2]; if (!isNaN(d) && d > 0) { maxWidth = Math.max(maxWidth, d); maxHeight = Math.max(maxHeight, d); } }
        else if (prim === 21 && parts.length >= 4) { const w = parts[2], h = parts[3]; if (!isNaN(w) && w > 0) maxWidth = Math.max(maxWidth, w); if (!isNaN(h) && h > 0) maxHeight = Math.max(maxHeight, h); }
        else if ((prim === 20 || prim === 2) && parts.length >= 7) { const lw = parts[2]||0,x1=parts[3]||0,y1=parts[4]||0,x2=parts[5]||0,y2=parts[6]||0; maxWidth=Math.max(maxWidth,Math.abs(x2-x1)+lw); maxHeight=Math.max(maxHeight,Math.abs(y2-y1)+lw); }
        else if (prim === 4 && parts.length >= 5) { const n=Math.round(parts[2]); let mnX=Infinity,mxX=-Infinity,mnY=Infinity,mxY=-Infinity; for(let vi=0;vi<=n;vi++){const vx=parts[3+vi*2],vy=parts[4+vi*2];if(!isNaN(vx)){mnX=Math.min(mnX,vx);mxX=Math.max(mxX,vx);}if(!isNaN(vy)){mnY=Math.min(mnY,vy);mxY=Math.max(mxY,vy);}} if(isFinite(mxX-mnX))maxWidth=Math.max(maxWidth,mxX-mnX); if(isFinite(mxY-mnY))maxHeight=Math.max(maxHeight,mxY-mnY); }
        else if (prim === 5 && parts.length >= 5) { const d=parts[5]; if(!isNaN(d)&&d>0){maxWidth=Math.max(maxWidth,d);maxHeight=Math.max(maxHeight,d);} }
      }
      macros[macroName] = { width: maxWidth>0?maxWidth:1.0, height: maxHeight>0?maxHeight:1.0, shape:'MACRO', computed: maxWidth>0 };
    }

    const adMatch = block.match(/%ADD(\d+)([A-Z0-9_]+)(?:,([\d.]+)(?:X([\d.]+))?(?:X([\d.]+))?)?\*%/i);
    if (adMatch) {
      const dCode = parseInt(adMatch[1]);
      const shapeOrMacro = adMatch[2].toUpperCase();
      const p1 = parseFloat(adMatch[3] || '0');
      const p2 = parseFloat(adMatch[4] || adMatch[3] || '0');
      let aperture;
      if (['C','R','O','P'].includes(shapeOrMacro)) {
        const shape = shapeOrMacro==='C'?'Circle':shapeOrMacro==='O'?'Obround':shapeOrMacro==='P'?'Polygon':'Rect';
        aperture = { shape, width: p1||1.0, height: p2||p1||1.0 };
      } else if (macros[shapeOrMacro]) {
        aperture = { ...macros[shapeOrMacro] };
        if (!aperture.computed && p1>0) { aperture.width=p1; aperture.height=p2||p1; }
        delete aperture.computed;
      } else {
        aperture = { width: p1||1.0, height: p2||p1||1.0, shape:'MACRO' };
      }
      apertures[dCode] = aperture;
    }
  }

  const opsText = gerberText.replace(/%(?!(?:TO|TA|TD))[^%]*%/g, '').replace(/%/g, '');
  const tokens = opsText.split('*').map(s => s.trim()).filter(Boolean);

  const parseCoord = (val, i, d) => {
    if (val.includes('.')) return parseFloat(val);
    let sign = 1;
    if (val.startsWith('+')) val = val.slice(1);
    if (val.startsWith('-')) { sign = -1; val = val.slice(1); }
    const total = i + d;
    const s = zeroSupp === 'L' ? val.padStart(total, '0') : val.padEnd(total, '0');
    return sign * parseFloat(`${s.slice(0, i)}.${s.slice(i)}`);
  };

  const parseXY = (t, last) => {
    const m = {};
    t.replace(/([XY])([+\-]?\d+(?:\.\d+)?)?/gi, (_, k, v) => { m[k.toUpperCase()] = v || ''; return ''; });
    let x = last.x, y = last.y;
    if (m.X !== undefined) x = parseCoord(m.X, xInt, xDec);
    if (m.Y !== undefined) y = parseCoord(m.Y, yInt, yDec);
    return { x, y };
  };

  let curX = 0, curY = 0, currentD = null, currentAperture = null;
  let currentRefDes = null, srState = null, detectedPanel = null;
  const basePads = [];
  const srPads = [];

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;
    if (t.startsWith('TO.C')) { const parts = t.split(','); if (parts.length >= 2) currentRefDes = parts[1]; continue; }
    if (t.startsWith('TD')) { currentRefDes = null; continue; }

    const sr = t.match(/%SR(?:X(\d+))?(?:Y(\d+))?(?:I([\d.-]+))?(?:J([\d.-]+))?\*%/i);
    if (sr) {
      if (!sr[1] && !sr[2] && !sr[3] && !sr[4]) { srState = null; }
      else {
        const dimX = sr[1]?parseInt(sr[1]):1, dimY = sr[2]?parseInt(sr[2]):1;
        const stepX = sr[3]?parseFloat(sr[3]):0, stepY = sr[4]?parseFloat(sr[4]):0;
        srState = { dimX, dimY, stepX, stepY };
        if ((dimX > 1 || dimY > 1) && !detectedPanel) detectedPanel = { dimX, dimY, stepX, stepY };
      }
      continue;
    }

    const md = t.match(/D0?(\d+)$/i);
    if (md) { currentD = +md[1]; if (currentD >= 10 && apertures[currentD]) currentAperture = apertures[currentD]; }

    if (/[XY]/i.test(t)) {
      const { x, y } = parseXY(t, { x: curX, y: curY });
      if (currentD === 2 || currentD == null) { curX = x; curY = y; continue; }
      if (currentD === 1) { curX = x; curY = y; continue; }
      if (currentD === 3) {
        const ap = currentAperture || { width:1.0, height:1.0, shape:'R' };
        const mkPad = (px, py, ref) => ({ x:px, y:py, width:ap.width, height:ap.height, shape:ap.shape, componentIdentifier:ref });
        basePads.push(mkPad(x, y, currentRefDes));
        if (srState) {
          const { dimX, dimY, stepX, stepY } = srState;
          for (let i = 0; i < dimX; i++) {
            for (let j = 0; j < dimY; j++) {
              if (i === 0 && j === 0) continue;
              srPads.push(mkPad(x+i*stepX, y+j*stepY, currentRefDes ? `${currentRefDes}_SR${i}_${j}` : null));
            }
          }
        }
        curX = x; curY = y; continue;
      }
    }
  }

  const conv = pads => units === 'in'
    ? pads.map(p => ({ ...p, x:p.x*IN2MM, y:p.y*IN2MM, width:p.width*IN2MM, height:p.height*IN2MM }))
    : pads;

  return { pads: conv(basePads), allPads: conv([...basePads, ...srPads]), panel: detectedPanel };
}
