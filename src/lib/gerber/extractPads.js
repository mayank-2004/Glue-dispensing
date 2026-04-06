const IN2MM = 25.4;

export function extractPadsMm(gerberText) {
  const paramBlocks = [];
  // Strip standard parameters but KEEP attributes (TO, TA, TD) for processing in stream
  // We use a negative lookahead to exclude TO, TA, TD from being stripped
  gerberText.replace(/%(?!(?:TO|TA|TD))[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

  let units = 'mm';
  let zeroSupp = 'L';
  let xInt = 2, xDec = 4, yInt = 2, yDec = 4;
  const apertures = {};

  const macros = {}; // Store aperture macros

  for (const block of paramBlocks) {
    const mo = block.match(/%MO(IN|MM)\*%/i);
    if (mo) units = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';
    const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
    if (fs) { zeroSupp = fs[1].toUpperCase(); xInt = +fs[3]; xDec = +fs[4]; yInt = +fs[5]; yDec = +fs[6]; }

    // Parse aperture macros (like OUTLINE2, OUTLINE5)
    const macro = block.match(/%AM([A-Z0-9]+)\*([\s\S]*?)\*%/i);
    if (macro) {
      const macroName = macro[1];
      const macroContent = macro[2];
      // Extract approximate dimensions from macro content
      const coords = macroContent.match(/([+-]?\d*\.?\d+)/g) || [];
      const numbers = coords.map(parseFloat).filter(n => !isNaN(n) && n !== 0);

      let width = 1.5, height = 1.7; // Default sizes
      if (numbers.length >= 4) {
        const xCoords = numbers.filter((_, i) => i % 2 === 0);
        const yCoords = numbers.filter((_, i) => i % 2 === 1);
        width = Math.max(...xCoords) - Math.min(...xCoords);
        height = Math.max(...yCoords) - Math.min(...yCoords);
      }

      macros[macroName] = { width, height, shape: 'MACRO' };
    }

    // Parse ALL Aperture Definitions (Standard: C, R, O, P | Macros: CustomName)
    const adMatch = block.match(/%ADD(\d+)([A-Z0-9_]+)(?:,([\.\d]+)(?:X([\.\d]+))?(?:X([\.\d]+))?)?\*%/i);

    if (adMatch) {
      const dCode = parseInt(adMatch[1]);
      const shapeOrMacro = adMatch[2].toUpperCase();
      
      const p1 = parseFloat(adMatch[3] || '0');
      const p2 = parseFloat(adMatch[4] || adMatch[3] || '0');
      const p3 = parseFloat(adMatch[5] || '0');

      let aperture;

      // Ensure standard CAD geometric templates are correctly recognized
      if (['C', 'R', 'O', 'P' || 'c', 'r', 'o', 'p'].includes(shapeOrMacro)) {
        aperture = {
          shape: shapeOrMacro === 'C' ? 'Circle' : shapeOrMacro === 'O' ? 'Obround' : shapeOrMacro === 'P' ? 'Polygon' : 'Rect',
          width: p1,
          height: p2
        };
      } 
      else if (macros[shapeOrMacro]) {
        aperture = { ...macros[shapeOrMacro] }; // Start with default guess
        
        if (p1 > 0) {
          aperture.width = p1;
          aperture.height = p2 || p1; // Fallback to square/circle if only 1 param
        }
      } 
      else {
        // Unknown macro or missing definition, use instantiation parameters if they exist
        aperture = { width: p1 || 1.0, height: p2 || p1 || 1.0, shape: 'MACRO' };
      }

      apertures[dCode] = aperture;
    }
  }

  // Remove the stripped parameters, but keep TO/TA/TD which were skipped by the regex
  // Also remove the % delimiters from the remaining attributes for cleaner tokenizing
  const opsText = gerberText.replace(/%(?!(?:TO|TA|TD))[^%]*%/g, '').replace(/%/g, '');
  const tokens = opsText.split('*').map(s => s.trim()).filter(Boolean);

  const parseCoord = (val, i, d, z = zeroSupp) => {
    if (val.includes('.')) return parseFloat(val);
    let sign = 1;
    if (val.startsWith('+')) val = val.slice(1);
    if (val.startsWith('-')) { sign = -1; val = val.slice(1); }
    const total = i + d;
    let s = z === 'L' ? val.padStart(total, '0') : val.padEnd(total, '0');
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
  let currentRefDes = null; // State for Object Attribute RefDes
  let srState = null; // State for Step and Repeat
  const pads = [];

  console.log('Available apertures:', apertures);

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;

    // Attribute Parsing (TO/TA/TD)
    // Format: TO.C,R1 or TA.P,RefDes,R1
    if (t.startsWith('TO.C')) {
      // Object Attribute .C (Component)
      const parts = t.split(',');
      if (parts.length >= 2) {
        currentRefDes = parts[1];
        // console.log('Found Component RefDes:', currentRefDes);
      }
      continue;
    }
    if (t.startsWith('TD')) {
      currentRefDes = null;
      continue;
    }

    const sr = t.match(/%SR(?:X(\d+))?(?:Y(\d+))?(?:I([\d.-]+))?(?:J([\d.-]+))?\*%/i);
    if (sr) {
      // If empty %SR*%, reset to single mode
      if (!sr[1] && !sr[2] && !sr[3] && !sr[4]) {
        // console.log("SR End - Resetting");
        srState = null;
      } else {
        // Parse parameters
        const dimX = sr[1] ? parseInt(sr[1]) : 1;
        const dimY = sr[2] ? parseInt(sr[2]) : 1;
        const stepX = sr[3] ? parseFloat(sr[3]) : 0.0; // Distance in current units
        const stepY = sr[4] ? parseFloat(sr[4]) : 0.0;

        console.log(`SR Start: X=${dimX} Y=${dimY} dX=${stepX} dY=${stepY} (Units: ${units})`);
        srState = { dimX, dimY, stepX, stepY };
      }
      continue;
    }


    const md = t.match(/D0?(\d+)$/i);
    if (md) {
      currentD = +md[1];
      // Update current aperture when D-code changes
      if (currentD >= 10 && apertures[currentD]) {
        currentAperture = apertures[currentD];
        // console.log(`Switched to aperture D${currentD}:`, currentAperture);
      }
    }

    if (/[XY]/i.test(t)) {
      const { x, y } = parseXY(t, { x: curX, y: curY });
      if (currentD === 2 || currentD == null) { curX = x; curY = y; continue; }
      if (currentD === 1) { curX = x; curY = y; continue; }
      if (currentD === 3) { // FLASH
        let aperture = currentAperture || { width: 1.0, height: 1.0, shape: 'R' };

        // Push the PRIMARY pad
        pads.push({
          x,
          y,
          width: aperture.width,
          height: aperture.height,
          shape: aperture.shape,
          componentIdentifier: currentRefDes // Attach found RefDes
        });

        // Loop for SR repeats
        if (srState) {
          const { dimX, dimY, stepX, stepY } = srState;
          for (let i = 0; i < dimX; i++) {
            for (let j = 0; j < dimY; j++) {
              if (i === 0 && j === 0) continue; // Original already added

              const offsetX = i * stepX;
              const offsetY = j * stepY;

              pads.push({
                x: x + offsetX,
                y: y + offsetY,
                width: aperture.width,
                height: aperture.height,
                shape: aperture.shape,
                componentIdentifier: currentRefDes ? `${currentRefDes}_SR${i}_${j}` : null
              });
            }
          }
        }

        curX = x; curY = y; continue;
      }
    }
  }

  if (units === 'in') {
    return pads.map(p => ({
      x: p.x * IN2MM,
      y: p.y * IN2MM,
      width: p.width * IN2MM,
      height: p.height * IN2MM,
      shape: p.shape,
      componentIdentifier: p.componentIdentifier
    }));
  }
  return pads;
}
