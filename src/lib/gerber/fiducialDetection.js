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
        // console.log(`[FiducialParser] Aperture D${dCode}: CIRCLE diameter=${diameter}${units}${holeDia > 0 ? ` hole=${holeDia}` : ''}`);
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
          // console.log(`[FiducialParser] Aperture D${dCode}: SQUARE size=${width}${units}`);
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
    const candidates = [];

    for (const raw of tokens) {
      const t = raw.replace(/\s+/g, '');
      if (!t || /^G0?4/i.test(t)) continue;

      // Standalone aperture/operation code (no XY coords in same token)
      const dSelect = t.match(/^D(\d+)$/i);
      if (dSelect) {
        const dCode = parseInt(dSelect[1]);
        if (dCode >= 10) {
          currentAperture = apertures.get(dCode);
        } else {
          currentD = dCode; // D01, D02, D03
        }
        continue;
      }

      // Combined XY + operation token (e.g. X1234Y5678D03)
      const md = t.match(/D0?([123])$/i);
      if (md) currentD = +md[1];

      // Also handle aperture selection combined with movement (e.g. X0Y0D10)
      const mdAp = t.match(/D(\d{2,})$/i);
      if (mdAp && parseInt(mdAp[1]) >= 10) {
        currentAperture = apertures.get(parseInt(mdAp[1]));
      }

      if (/[XY]/i.test(t)) {
        const { x, y } = parseXY(t, { x: curX, y: curY });
        curX = x;
        curY = y;
      }

      if (currentD === 3 && currentAperture) { // FLASH operation
        // Skip through-hole apertures — SMD fiducials never have drill holes
        if (currentAperture.holeDiameter > 0) continue;

        const diameter = currentAperture.diameter;

        // Convert to mm if needed
        const xMm = units === 'in' ? curX * IN2MM : curX;
        const yMm = units === 'in' ? curY * IN2MM : curY;
        const diameterMm = units === 'in' ? diameter * IN2MM : diameter;

        // Fiducials are small SMD copper pads — cap at 2.5mm to avoid vias/mounting pads
        if (diameterMm >= 0.4 && diameterMm <= 2.5) {
          let fiducialScore = 1;

          // Must be circular
          if (currentAperture.type === 'circle') fiducialScore += 3;

          // Ideal fiducial size range (0.5–1.5mm copper pad)
          if (diameterMm >= 0.5 && diameterMm <= 1.5) fiducialScore += 4;
          else if (diameterMm > 1.5 && diameterMm <= 2.0) fiducialScore += 1;

          candidates.push({
            x: xMm,
            y: yMm,
            diameter: diameterMm,
            aperture: currentAperture,
            fiducialScore: fiducialScore
          });
        }
      }

    }

    // Sort candidates by fiducial score before filtering
    candidates.sort((a, b) => (b.fiducialScore || 1) - (a.fiducialScore || 1));

    if (candidates.length > 0) {
      console.log(`[FiducialParser] Flash candidates (SMD, no hole, 0.4–2.5mm): ${candidates.length}`);
      // console.table(candidates.map(c => ({
      //   x_mm: parseFloat(c.x.toFixed(3)),
      //   y_mm: parseFloat(c.y.toFixed(3)),
      //   diameter_mm: parseFloat(c.diameter.toFixed(3)),
      //   type: c.aperture?.type || '?',
      //   score: c.fiducialScore,
      // })));
    } else {
      console.warn('[FiducialParser] No SMD D03 flash operations (0.4–2.5mm, no hole) found in this layer');
    }

    return filterFiducialCandidates(candidates);
  } catch (error) {
    console.warn('Error detecting fiducials in Gerber file:', error);
    return { local: [], rail: [] };
  }
}

/**
 * Filters fiducial candidates based on typical fiducial characteristics
 */
function filterFiducialCandidates(candidates) {
  if (candidates.length === 0) return [];

  // Remove exact duplicates (< 0.1 mm apart)
  const deduped = [];
  for (const candidate of candidates) {
    const isDuplicate = deduped.some(existing =>
      Math.hypot(existing.x - candidate.x, existing.y - candidate.y) < 0.1
    );
    if (!isDuplicate) deduped.push(candidate);
  }

  // Isolation filter: SMD fiducials are always isolated copper islands — no other pad
  // within 2.5 mm by PCB design rules.  Clustered pads (component pads, test points,
  // multi-pad connectors) all fail this check and are removed here.
  const ISOLATION_RADIUS = 2.5; // mm
  const isolated = deduped.filter(c =>
    !deduped.some(other => other !== c && Math.hypot(other.x - c.x, other.y - c.y) < ISOLATION_RADIUS)
  );
  const filtered = isolated.length >= 2 ? isolated : deduped; // fallback if over-filtered
  if (isolated.length !== deduped.length) {
    console.log(`[FiducialFilter] Isolation filter (${ISOLATION_RADIUS} mm): ${deduped.length} → ${isolated.length} (removed ${deduped.length - isolated.length} clustered pads)`);
  }

  // Group candidates by diameter (fiducials usually have same size)
  const diameterGroups = new Map();
  filtered.forEach(c => {
    const key = Math.round(c.diameter * 100) / 100;
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
    if (diameter >= 0.5 && diameter <= 1.5) sizeScore = 15;   // ideal SMD fiducial
    else if (diameter > 1.5 && diameter <= 2.0) sizeScore = 8;
    else if (diameter > 2.0 && diameter <= 2.5) sizeScore = 3;
    else sizeScore = 1;

    // Panelized boards have 6–12 fiducials (2 per sub-board × N boards + panel rail marks).
    // Reward proportionally up to 12; above 12 is likely component/test pads — penalise.
    let countScore = 0;
    if (group.length >= 2 && group.length <= 12) {
      countScore = Math.min(group.length * 2, 22); // 2→4 … 11→22 (capped at 22)
    } else if (group.length > 12) {
      countScore = Math.max(2, 22 - (group.length - 12) * 2);
    } else {
      countScore = 1;
    }

    let distributionScore = calculateDistributionScore(group);

    const totalScore = sizeScore + countScore + distributionScore;
    const pass = group.length >= 2 && totalScore > 15;
    console.log(
      `[FiducialFilter] ⌀${diameter.toFixed(2)}mm × ${group.length} pads → ` +
      `sizeScore=${sizeScore} countScore=${countScore} distScore=${distributionScore} ` +
      `TOTAL=${totalScore} → ${pass ? '✅ candidate' : '❌ below threshold (need >15 with ≥2 pads)'}`
    );

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestGroup = group;
    }
  }

  // If we have a good group, separate local board fiducials from panel rail marks
  if (bestGroup.length >= 2 && bestScore > 15) {
    let localGroup = bestGroup;
    let railGroup = [];

    // Panel-rail separation: board-local fiducials repeat N times (once per sub-board)
    // so they always have a companion in the same X-column. Panel rail marks are
    // isolated in X — no other fiducial within 10 mm horizontally.
    if (bestGroup.length > 4) {
      const X_TOLERANCE = 10; // mm
      const local = bestGroup.filter(c =>
        bestGroup.some(other => other !== c && Math.abs(other.x - c.x) < X_TOLERANCE)
      );
      const rail = bestGroup.filter(c =>
        !bestGroup.some(other => other !== c && Math.abs(other.x - c.x) < X_TOLERANCE)
      );
      if (local.length >= 4) {
        console.log(`[FiducialFilter] Panel-rail separation: ${local.length} local + ${rail.length} rail fiducials`);
        localGroup = local;
        railGroup = rail;
      }
    }

    const toFid = (fid, idx, prefix = 'F') => ({
      id: `${prefix}${idx + 1}`,
      x: fid.x, y: fid.y,
      diameter: fid.diameter,
      confidence: Math.min(bestScore / 30, 1.0),
    });

    localGroup.sort((a, b) => (a.y * 1000 + a.x) - (b.y * 1000 + b.x));
    railGroup.sort((a, b) => (a.y * 1000 + a.x) - (b.y * 1000 + b.x));

    return {
      local: localGroup.map((f, i) => toFid(f, i, 'F')),
      rail:  railGroup.map((f, i) => toFid(f, i, 'R')),
    };
  }

  return { local: [], rail: [] };
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

  // Bonus for typical fiducial counts (2–12 covers single boards and panelized boards)
  if (candidates.length >= 2 && candidates.length <= 12) {
    score += 3;
  }

  return score;
}

/**
 * Analyze all layers to find fiducials — returns { localFiducials, railFiducials }
 */
export function analyzeFiducialsWithRails(layers, side = 'top') {
  const allLocal = [];
  const allRail = [];

  // Layers to search for local board fiducials (tight size/score criteria)
  const localLayers = layers.filter(layer => {
    if (layer.side !== side) return false;
    if (layer.type === 'copper') return true;
    const name = layer.filename.toLowerCase();
    return name.includes('fiducial') || name.includes('fid') ||
           name.includes('fab') || name.includes('assembly');
  });

  // All layers on the current side — searched for rail marks too
  const allSideLayers = layers.filter(layer => layer.side === side);

  const priorityOrder = ['fiducial', 'fid', 'fab', 'assembly', 'copper'];
  localLayers.sort((a, b) => {
    const aScore = priorityOrder.findIndex(p => a.filename.toLowerCase().includes(p));
    const bScore = priorityOrder.findIndex(p => b.filename.toLowerCase().includes(p));
    return (aScore === -1 ? 999 : aScore) - (bScore === -1 ? 999 : bScore);
  });

  const searchedNames = new Set();
  for (const layer of localLayers) {
    if (!layer.text) continue;
    searchedNames.add(layer.filename);
    const result = detectFiducials(layer.text);
    const local = result?.local ?? [];
    const rail  = result?.rail  ?? [];
    const pri = priorityOrder.findIndex(p => layer.filename.toLowerCase().includes(p));
    if (local.length > 0) {
      console.log('Found', local.length, 'local +', rail.length, 'rail fiducials in', layer.filename);
      allLocal.push({ layer: layer.filename, fiducials: local, priority: pri });
    }
    if (rail.length > 0) {
      console.log('Found', rail.length, 'rail fiducials in', layer.filename);
      allRail.push({ layer: layer.filename, fiducials: rail, priority: pri });
    }
  }

  // Also search remaining current-side layers for rail marks only
  for (const layer of allSideLayers) {
    if (!layer.text || searchedNames.has(layer.filename)) continue;
    const result = detectFiducials(layer.text);
    const rail = result?.rail ?? [];
    if (rail.length > 0) {
      console.log('Found', rail.length, 'rail fiducials in extra layer', layer.filename);
      allRail.push({ layer: layer.filename, fiducials: rail, priority: 999 });
    }
  }

  const localFiducials = mergeFiducials(allLocal);
  const railFiducials  = mergeFiducials(allRail).map((f, i) => ({ ...f, id: `R${i + 1}` }));

  console.log(`Final fiducial detection: ${localFiducials.length} local, ${railFiducials.length} rail`);
  return { localFiducials, railFiducials };
}

/** Backward-compatible wrapper — returns only local fiducials as a flat array */
export function analyzeFiducialsInLayers(layers, side = 'top') {
  return analyzeFiducialsWithRails(layers, side).localFiducials;
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

  // Sort by confidence — allow up to 20 (3-board panel: 6 board fids, well within limit)
  return merged
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20)
    .map((fid, idx) => ({
      ...fid,
      id: `F${idx + 1}`
    }));
}