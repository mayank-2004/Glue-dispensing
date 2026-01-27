const IN2MM = 25.4;

export function extractPadsMm(gerberText) {
  const paramBlocks = [];
  gerberText.replace(/%[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

  let units = 'mm';
  let zeroSupp = 'L';
  let xInt = 2, xDec = 4, yInt = 2, yDec = 4;
  const apertures = {};

  const macros = {}; // Store aperture macros
  
  for (const block of paramBlocks) {
    const mo = block.match(/%MO(IN|MM)\*%/i);
    if (mo) units = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';
    const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
    if (fs) { zeroSupp = fs[1].toUpperCase(); xInt=+fs[3]; xDec=+fs[4]; yInt=+fs[5]; yDec=+fs[6]; }
    
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
      console.log(`✅ Parsed macro ${macroName}:`, macros[macroName]);
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
      console.log(`✅ Parsed aperture D${dCode}:`, aperture, 'from:', block);
    }
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

  let curX = 0, curY = 0, currentD = null, currentAperture = null;
  const pads = [];

  console.log('Available apertures:', apertures);

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;

    const md = t.match(/D0?(\d+)$/i);
    if (md) {
      currentD = +md[1];
      // Update current aperture when D-code changes
      if (currentD >= 10 && apertures[currentD]) {
        currentAperture = apertures[currentD];
        console.log(`Switched to aperture D${currentD}:`, currentAperture);
      }
    }

    if (/[XY]/i.test(t)) {
      const { x, y } = parseXY(t, { x: curX, y: curY });
      if (currentD === 2 || currentD == null) { curX=x; curY=y; continue; }
      if (currentD === 1) { curX=x; curY=y; continue; }
      if (currentD === 3) { // FLASH
        // Use current active aperture or fallback
        let aperture = currentAperture || { width: 1.0, height: 1.0, shape: 'R' };
        
        console.log(`Flash at (${x}, ${y}) with aperture:`, aperture);
        
        pads.push({ 
          x, 
          y, 
          width: aperture.width, 
          height: aperture.height,
          shape: aperture.shape
        });
        curX=x; curY=y; continue;
      }
    }
  }

  if (units === 'in') {
    return pads.map(p => ({ 
      x: p.x * IN2MM, 
      y: p.y * IN2MM,
      width: p.width * IN2MM,
      height: p.height * IN2MM,
      shape: p.shape
    }));
  }
  return pads;
}
