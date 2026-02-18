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
      // console.log(`✅ Parsed macro ${macroName}:`, macros[macroName]);
    }

    // Parse standard aperture definitions
    let ad = block.match(/%ADD(\d+)([CR]),([\.\d]+)(?:X([\d\.]+))?\*%/i);
    if (!ad) ad = block.match(/%ADD(\d+)([CR])([\.\d]+)(?:X([\d\.]+))?\*%/i);
    if (!ad) ad = block.match(/%ADD(\d+)([A-Z0-9]+)\*%/i); // Macro reference

    if (ad) {
      const dCode = parseInt(ad[1]);
      const shapeOrMacro = ad[2].toUpperCase();

      let aperture;
      if (macros[shapeOrMacro]) {
        // Use macro dimensions
        aperture = { ...macros[shapeOrMacro] };
      } else if (shapeOrMacro === 'C' || shapeOrMacro === 'R') {
        // Standard circle/rectangle
        const size1 = parseFloat(ad[3] || '1');
        const size2 = ad[4] ? parseFloat(ad[4]) : size1;
        aperture = {
          shape: shapeOrMacro,
          width: shapeOrMacro === 'C' ? size1 : size1,
          height: shapeOrMacro === 'C' ? size1 : size2
        };
      } else {
        // Unknown macro, use reasonable defaults
        aperture = { width: 1.5, height: 1.7, shape: 'MACRO' };
      }

      apertures[dCode] = aperture;
      // console.log(`✅ Parsed aperture D${dCode}:`, aperture, 'from:', block);
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
      // Delete Attribute - Reset state
      // console.log('TD command: Resetting RefDes from', currentRefDes);
      currentRefDes = null;
      continue;
    }

    // SR (Step and Repeat) Handling
    // Format: %SRX<R>Y<R>I<d>J<d>*%
    // Example: %SRX2Y3I5.0J6.0*%  -> Repeat 2 times in X (dist 5.0), 3 times in Y (dist 6.0)
    // The "Repeat" count usually means "Total number of copies" or "Number of additional copies". 
    // Standard Gerber spec says: 
    // X, Y = number of repeats along axis. 1 means no repeat (just the original).
    // I, J = Step distance in X, Y.
    // An empty %SR*% cancels the step and repeat.

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

        // Adjust step for units if needed? 
        // In Gerber, coordinates in SR parameters are usually in the same unit/format as G-codes?
        // Actually, SR parameters are decimal numbers in the file units (mm or inch).
        // But our main parsing uses 'units' var to convert at the END.
        // If we duplicate points HERE, we must do it in the "current" coordinate system (which is raw from file).
        // parseCoord handles the raw integer scaling. But SR I/J values are explicitly decimal in the % command?
        // Check Spec: "The I and J modifiers specify the distance... expressed in the unit of the file."

        // Critical: I/J are DECIMAL numbers, not integer-scaled like coordinates.
        // So if units='mm', stepX is in mm. If units='in', stepX is in inches.
        // BUT, our `curX`/`curY` and `pads` are stored in RAW integer format until the very end return!!!
        // Wait, look at line 87: parseCoord returns a FLOAT (e.g. 10.5 mm).
        // Wait, line 166: if units === 'in', we multiply by IN2MM.
        // So `pads` currently stores values in FILE UNITS (mm or in).

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
        // Use current active aperture or fallback
        let aperture = currentAperture || { width: 1.0, height: 1.0, shape: 'R' };

        // console.log(`Flash at (${x}, ${y}) with aperture:`, aperture, 'RefDes:', currentRefDes);

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
          // Loop starts at 0, but (0,0) is the primary flash we just pushed.
          // SR implies a grid. If X=2, we have the original + 1 copy at +stepX.
          // Proper loops: x=0..dimX-1, y=0..dimY-1.
          // (0,0) is the original. Skip it to avoid double pads!

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

  // console.log('Total pads extracted:', pads.length);
  // const namedPads = pads.filter(p => p.componentIdentifier);
  // console.log('Pads with component names:', namedPads.length);
  // if (namedPads.length > 0) console.log('Sample names:', namedPads.slice(0, 5).map(p => p.componentIdentifier));

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
