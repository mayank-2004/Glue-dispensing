const IN2MM = 25.4;

/**
 * Detect potential origin points in PCB from Gerber layers
 */
export function detectPcbOrigins(layers) {
  // Only find bottom-left corner from board outline
  const outlineOrigins = findOutlineOrigins(layers);
  
  // Filter to only top-left corner with 90% confidence
  const topLeftOrigin = outlineOrigins.find(o => o.subtype === 'top_left');
  
  return topLeftOrigin ? [topLeftOrigin] : [];
}

/**
 * Find origins from board outline
 */
function findOutlineOrigins(layers) {
  const outlineLayers = layers.filter(l => 
    l.type === 'outline' || 
    l.filename.toLowerCase().includes('outline') ||
    l.filename.toLowerCase().includes('edge') ||
    l.filename.toLowerCase().includes('gm1')
  );
  
  const origins = [];
  
  for (const layer of outlineLayers) {
    const bounds = extractBounds(layer.text);
    if (bounds) {
      // Top-left corner (new PCB origin)
      // In SVG coordinate system, Y increases downward, so minY is top
      origins.push({
        x: bounds.minX,
        y: bounds.minY, // Use minY for top in SVG coordinates
        type: 'outline_corner',
        subtype: 'top_left',
        confidence: 0.9,
        description: 'Top-left corner of PCB outline'
      });
    }
  }
  
  return origins;
}

// Removed drill and geometric origin functions - only using outline origins

/**
 * Extract bounds from Gerber outline data
 */
function extractBounds(gerberText) {
  try {
    const coords = extractCoordinates(gerberText);
    if (coords.length === 0) return null;
    
    const xs = coords.map(c => c.x);
    const ys = coords.map(c => c.y);
    
    const bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys)
    };
    
    console.log('Origin detection - extracted bounds:', bounds, 'from', coords.length, 'coordinates');
    console.log('Sample coordinates:', coords.slice(0, 5));
    console.log('Origin will be set to:', { x: bounds.minX, y: bounds.minY });
    
    return bounds;
  } catch (error) {
    console.warn('Error extracting bounds:', error);
    return null;
  }
}

/**
 * Extract coordinates from Gerber text using EXACT same logic as extractPads
 */
function extractCoordinates(gerberText) {
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

  const coords = [];
  let curX = 0, curY = 0;

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;

    if (/[XY]/i.test(t)) {
      const { x, y } = parseXY(t, { x: curX, y: curY });
      curX = x; curY = y;
      coords.push({ x, y });
    }
  }

  // Apply unit conversion at the end, same as extractPads
  if (units === 'in') {
    return coords.map(c => ({ x: c.x * IN2MM, y: c.y * IN2MM }));
  }
  return coords;
}

/**
 * Extract drill holes from drill file
 */
function extractDrillHoles(drillText) {
  const holes = [];
  const lines = drillText.split('\n');
  
  let currentTool = null;
  let units = 'mm';
  const tools = new Map();
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Units
    if (trimmed === 'INCH') units = 'in';
    if (trimmed === 'METRIC') units = 'mm';
    
    // Tool definition
    const toolDef = trimmed.match(/T(\d+)C([0-9.]+)/);
    if (toolDef) {
      const toolNum = parseInt(toolDef[1]);
      let diameter = parseFloat(toolDef[2]);
      if (units === 'in') diameter *= IN2MM;
      tools.set(toolNum, diameter);
    }
    
    // Tool selection
    const toolSelect = trimmed.match(/T(\d+)/);
    if (toolSelect && !trimmed.includes('C')) {
      currentTool = parseInt(toolSelect[1]);
    }
    
    // Coordinates
    const coords = trimmed.match(/X([+\-]?[0-9.]+)Y([+\-]?[0-9.]+)/);
    if (coords && currentTool && tools.has(currentTool)) {
      let x = parseFloat(coords[1]);
      let y = parseFloat(coords[2]);
      
      if (units === 'in') {
        x *= IN2MM;
        y *= IN2MM;
      }
      
      holes.push({
        x,
        y,
        diameter: tools.get(currentTool),
        tool: currentTool
      });
    }
  }
  
  return holes;
}

/**
 * Extract pads from copper layer
 */
function extractPadsFromLayer(gerberText) {
  try {
    const paramBlocks = [];
    gerberText.replace(/%[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

    let units = 'mm';
    let zeroSupp = 'L';
    let xInt = 2, xDec = 4, yInt = 2, yDec = 4;

    for (const block of paramBlocks) {
      const mo = block.match(/%MO(IN|MM)\*%/i);
      if (mo) units = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';
      const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
      if (fs) { 
        zeroSupp = fs[1].toUpperCase(); 
        xInt = +fs[3]; xDec = +fs[4]; 
        yInt = +fs[5]; yDec = +fs[6]; 
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

    const pads = [];
    let curX = 0, curY = 0, currentD = null;

    for (const raw of tokens) {
      const t = raw.replace(/\s+/g, '');
      if (!t || /^G0?4/i.test(t)) continue;

      const md = t.match(/D0?([123])$/i);
      if (md) currentD = +md[1];

      if (/[XY]/i.test(t)) {
        const m = {};
        t.replace(/([XY])([+\-]?\d+(?:\.\d+)?)?/gi, (_, k, v) => { 
          m[k.toUpperCase()] = v || ''; 
          return ''; 
        });
        
        if (m.X !== undefined) curX = parseCoord(m.X, xInt, xDec);
        if (m.Y !== undefined) curY = parseCoord(m.Y, yInt, yDec);

        if (currentD === 3) { // FLASH
          const xMm = units === 'in' ? curX * IN2MM : curX;
          const yMm = units === 'in' ? curY * IN2MM : curY;
          pads.push({ x: xMm, y: yMm });
        }
      }
    }

    return pads;
  } catch (error) {
    console.warn('Error extracting pads:', error);
    return [];
  }
}

/**
 * Calculate bounds of pad array
 */
function calculatePadBounds(pads) {
  if (pads.length === 0) return null;
  
  const xs = pads.map(p => p.x);
  const ys = pads.map(p => p.y);
  
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

// Removed ranking function - only returning single bottom-left origin