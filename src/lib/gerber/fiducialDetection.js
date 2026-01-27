const IN2MM = 25.4;

export function detectFiducials(gerberText) {
  try {
  const paramBlocks = [];
  gerberText.replace(/%[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

  let units = 'mm';
  let zeroSupp = 'L';
  let xInt = 2, xDec = 4, yInt = 2, yDec = 4;
  const apertures = new Map();

  // Parse format and units
  for (const block of paramBlocks) {
    const mo = block.match(/%MO(IN|MM)\*%/i);
    if (mo) units = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';
    
    const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
    if (fs) { 
      zeroSupp = fs[1].toUpperCase(); 
      xInt = +fs[3]; xDec = +fs[4]; 
      yInt = +fs[5]; yDec = +fs[6]; 
    }

    // Parse aperture definitions - look for circular apertures that could be fiducials
    const ad = block.match(/%ADD(\d+)C,([^*,]+)(?:,([^*]+))?\*%/i);
    if (ad) {
      const dCode = parseInt(ad[1]);
      const diameter = parseFloat(ad[2]);
      // Some fiducials might have hole definitions (second parameter)
      const holeDia = ad[3] ? parseFloat(ad[3]) : 0;
      apertures.set(dCode, { type: 'circle', diameter, holeDiameter: holeDia });
    }
    
    // Also check for rectangular apertures that might be fiducial markers
    const adRect = block.match(/%ADD(\d+)R,([^*,]+)X([^*,]+)(?:,([^*]+))?\*%/i);
    if (adRect) {
      const dCode = parseInt(adRect[1]);
      const width = parseFloat(adRect[2]);
      const height = parseFloat(adRect[3]);
      // Square apertures might be fiducial markers
      if (Math.abs(width - height) < 0.1) {
        apertures.set(dCode, { type: 'square', diameter: width });
      }
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
  const candidates = [];

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;

    // Aperture selection
    const dSelect = t.match(/D(\d+)$/i);
    if (dSelect) {
      const dCode = parseInt(dSelect[1]);
      if (dCode >= 10) { // Aperture codes start from D10
        currentAperture = apertures.get(dCode);
      } else {
        currentD = dCode; // D01, D02, D03
      }
      continue;
    }

    // Movement with operation
    const md = t.match(/D0?([123])$/i);
    if (md) currentD = +md[1];

    if (/[XY]/i.test(t)) {
      const { x, y } = parseXY(t, { x: curX, y: curY });
      
      if (currentD === 3 && currentAperture) { // FLASH operation
        const diameter = currentAperture.diameter;
        
        // Convert to mm if needed
        const xMm = units === 'in' ? x * IN2MM : x;
        const yMm = units === 'in' ? y * IN2MM : y;
        const diameterMm = units === 'in' ? diameter * IN2MM : diameter;
        
        // Check if this could be a fiducial based on size
        // Fiducials are typically 0.5-5mm in diameter
        if (diameterMm >= 0.5 && diameterMm <= 5.0) {
          // Additional scoring for fiducial-like characteristics
          let fiducialScore = 1;
          
          // Circular apertures are more likely to be fiducials
          if (currentAperture.type === 'circle') fiducialScore += 2;
          
          // Apertures with holes (typical fiducial pattern)
          if (currentAperture.holeDiameter > 0) fiducialScore += 3;
          
          // Preferred fiducial sizes
          if (diameterMm >= 1.0 && diameterMm <= 3.0) fiducialScore += 2;
          
          candidates.push({ 
            x: xMm, 
            y: yMm, 
            diameter: diameterMm,
            aperture: currentAperture,
            fiducialScore: fiducialScore
          });
        }
      }
      
      curX = x; 
      curY = y;
    }
  }

    // Sort candidates by fiducial score before filtering
    candidates.sort((a, b) => (b.fiducialScore || 1) - (a.fiducialScore || 1));
    
    return filterFiducialCandidates(candidates);
  } catch (error) {
    console.warn('Error detecting fiducials in Gerber file:', error);
    return [];
  }
}

/**
 * Filters fiducial candidates based on typical fiducial characteristics
 */
function filterFiducialCandidates(candidates) {
  if (candidates.length === 0) return [];

  // Remove duplicates that are very close to each other
  const filtered = [];
  for (const candidate of candidates) {
    const isDuplicate = filtered.some(existing => 
      Math.hypot(existing.x - candidate.x, existing.y - candidate.y) < 0.1
    );
    if (!isDuplicate) {
      filtered.push(candidate);
    }
  }

  // Group candidates by diameter (fiducials usually have same size)
  const diameterGroups = new Map();
  filtered.forEach(c => {
    const key = Math.round(c.diameter * 100) / 100; // Round to 0.01mm
    if (!diameterGroups.has(key)) {
      diameterGroups.set(key, []);
    }
    diameterGroups.get(key).push(c);
  });

  // Find the most common diameter that could be fiducials
  let bestGroup = [];
  let bestScore = 0;

  for (const [diameter, group] of diameterGroups) {
    // Score based on:
    // 1. Typical fiducial size (1-2mm preferred)
    // 2. Number of instances (2-4 fiducials typical)
    // 3. Spatial distribution (should be spread out)
    
    let sizeScore = 0;
    if (diameter >= 1.0 && diameter <= 2.0) sizeScore = 15;
    else if (diameter >= 0.8 && diameter <= 3.0) sizeScore = 10;
    else if (diameter >= 0.5 && diameter <= 4.0) sizeScore = 5;
    else sizeScore = 1;

    let countScore = 0;
    if (group.length >= 2 && group.length <= 4) countScore = group.length * 3;
    else if (group.length >= 5 && group.length <= 6) countScore = group.length * 2;
    else if (group.length > 6) countScore = 6; // Too many, probably not fiducials
    else countScore = 1;

    let distributionScore = calculateDistributionScore(group);

    const totalScore = sizeScore + countScore + distributionScore;
    
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestGroup = group;
    }
  }

  // If we have a good group, verify it's likely fiducials
  if (bestGroup.length >= 2 && bestScore > 15) {
    // Sort by position for consistent ordering (top-left to bottom-right)
    bestGroup.sort((a, b) => {
      const aScore = a.y * 1000 + a.x; // Y has higher weight
      const bScore = b.y * 1000 + b.x;
      return aScore - bScore;
    });
    
    return bestGroup.map((fid, idx) => ({
      id: `F${idx + 1}`,
      x: fid.x,
      y: fid.y,
      diameter: fid.diameter,
      confidence: Math.min(bestScore / 30, 1.0) // Normalize to 0-1
    }));
  }

  return [];
}

/**
 * Calculate how well distributed the fiducials are (good fiducials are spread out)
 */
function calculateDistributionScore(candidates) {
  if (candidates.length < 2) return 0;

  let minDistance = Infinity;
  let maxDistance = 0;
  let totalDistance = 0;
  let pairCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const dist = Math.hypot(
        candidates[i].x - candidates[j].x,
        candidates[i].y - candidates[j].y
      );
      minDistance = Math.min(minDistance, dist);
      maxDistance = Math.max(maxDistance, dist);
      totalDistance += dist;
      pairCount++;
    }
  }

  const avgDistance = totalDistance / pairCount;

  // Good distribution scoring:
  let score = 0;
  
  // Minimum separation (fiducials shouldn't be too close)
  if (minDistance > 15) score += 8;
  else if (minDistance > 10) score += 5;
  else if (minDistance > 5) score += 2;
  
  // Maximum separation (should span a reasonable area)
  if (maxDistance > 30) score += 8;
  else if (maxDistance > 20) score += 5;
  else if (maxDistance > 10) score += 2;
  
  // Average separation (good overall spacing)
  if (avgDistance > 20) score += 5;
  else if (avgDistance > 15) score += 3;
  
  // Bonus for typical fiducial patterns (3 or 4 fiducials)
  if (candidates.length === 3 || candidates.length === 4) {
    score += 3;
  }

  return score;
}

/**
 * Analyze all layers to find fiducials
 */
export function analyzeFiducialsInLayers(layers) {
  console.log('Analyzing', layers.length, 'layers for fiducials...');
  const allFiducials = [];
  
  // Check copper layers, soldermask, and drill files for fiducials
  // Also check any layer that might contain fiducials
  const relevantLayers = layers.filter(layer => 
    layer.type === 'copper' || 
    layer.type === 'soldermask' || 
    layer.type === 'drill' ||
    layer.type === 'outline' ||
    layer.filename.toLowerCase().includes('fiducial') ||
    layer.filename.toLowerCase().includes('fid') ||
    layer.filename.toLowerCase().includes('fab') ||
    layer.filename.toLowerCase().includes('assembly')
  );

  // Prioritize layers that are more likely to contain fiducials
  const priorityOrder = ['fiducial', 'fid', 'fab', 'assembly', 'copper', 'soldermask', 'drill', 'outline'];
  
  relevantLayers.sort((a, b) => {
    const aScore = priorityOrder.findIndex(p => a.filename.toLowerCase().includes(p));
    const bScore = priorityOrder.findIndex(p => b.filename.toLowerCase().includes(p));
    return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
  });

  for (const layer of relevantLayers) {
    console.log('Checking layer:', layer.filename, 'type:', layer.type);
    const fiducials = detectFiducials(layer.text);
    if (fiducials.length > 0) {
      console.log('Found', fiducials.length, 'fiducial candidates in', layer.filename);
      allFiducials.push({
        layer: layer.filename,
        fiducials: fiducials,
        priority: priorityOrder.findIndex(p => layer.filename.toLowerCase().includes(p))
      });
    }
  }

  // Merge fiducials from different layers (same position = same fiducial)
  const result = mergeFiducials(allFiducials);
  console.log('Final fiducial detection result:', result.length, 'fiducials found');
  return result;
}

/**
 * Merge fiducials found in multiple layers at similar positions
 */
function mergeFiducials(layerFiducials) {
  if (layerFiducials.length === 0) return [];

  const merged = [];
  const MERGE_THRESHOLD = 0.5; // mm

  // Sort layers by priority (fiducial-specific layers first)
  layerFiducials.sort((a, b) => (a.priority || 999) - (b.priority || 999));

  // Start with fiducials from highest priority layer
  if (layerFiducials[0]) {
    merged.push(...layerFiducials[0].fiducials.map(f => ({
      ...f,
      sourceLayer: layerFiducials[0].layer
    })));
  }

  // Merge fiducials from other layers
  for (let i = 1; i < layerFiducials.length; i++) {
    const currentFiducials = layerFiducials[i].fiducials;
    
    for (const fid of currentFiducials) {
      // Check if this fiducial is close to any existing one
      let found = false;
      for (const existing of merged) {
        const dist = Math.hypot(existing.x - fid.x, existing.y - fid.y);
        if (dist < MERGE_THRESHOLD) {
          // Update confidence if this detection is better or from higher priority layer
          const currentPriority = layerFiducials[i].priority || 999;
          const existingPriority = layerFiducials.find(l => l.layer === existing.sourceLayer)?.priority || 999;
          
          if (fid.confidence > existing.confidence || currentPriority < existingPriority) {
            existing.confidence = Math.max(existing.confidence, fid.confidence);
            existing.diameter = fid.diameter; // Use the better detection
            existing.sourceLayer = layerFiducials[i].layer;
          }
          found = true;
          break;
        }
      }
      
      if (!found) {
        merged.push({
          ...fid,
          id: `F${merged.length + 1}`,
          sourceLayer: layerFiducials[i].layer
        });
      }
    }
  }

  // Sort by confidence and limit to reasonable number
  return merged
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6) // Max 6 fiducials
    .map((fid, idx) => ({
      ...fid,
      id: `F${idx + 1}`
    }));
}