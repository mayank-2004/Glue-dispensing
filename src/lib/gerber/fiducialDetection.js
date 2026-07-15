const IN2MM = 25.4;

/**
 * Parse all D03 (flash) operations from a Gerber text.
 * Returns an array of { x, y, diameter, type, hasHole } in mm.
 */
function parseAllFlashes(gerberText) {
  const paramBlocks = [];
  gerberText.replace(/%[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

  let units = 'mm';
  let zeroSupp = 'L';
  let xInt = 2, xDec = 4, yInt = 2, yDec = 4;
  const apertures = new Map();
  const macros = new Map();

  for (const block of paramBlocks) {
    const mo = block.match(/%MO(IN|MM)\*%/i);
    if (mo) units = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';

    const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
    if (fs) {
      zeroSupp = fs[1].toUpperCase();
      xInt = +fs[3]; xDec = +fs[4];
      yInt = +fs[5]; yDec = +fs[6];
    }

    // Circle aperture %ADDnnC,dia[,holeDia]*%
    const adC = block.match(/%ADD(\d+)C,([^*,]+)(?:,([^*]+))?\*%/i);
    if (adC) {
      apertures.set(parseInt(adC[1]), {
        type: 'circle',
        diameter: parseFloat(adC[2]),
        holeDiameter: adC[3] ? parseFloat(adC[3]) : 0
      });
    }

    // Rect/Oval aperture %ADDnnR,wxh or O,wxh
    const adRO = block.match(/%ADD(\d+)[RO],([^*,]+)X([^*,]+)(?:,([^*]+))?\*%/i);
    if (adRO) {
      const w = parseFloat(adRO[2]), h = parseFloat(adRO[3]);
      apertures.set(parseInt(adRO[1]), { type: 'rect', diameter: Math.max(w, h), holeDiameter: 0 });
    }

    // Aperture Macro definition: collect the entire body
    const amDef = block.match(/%AM([A-Za-z0-9_]+)\*([\s\S]*?)%/);
    if (amDef) {
      macros.set(amDef[1], amDef[2]);
    }

    // ADD using macro: %ADDnnMacroName[,params]*%
    const adMacro = block.match(/%ADD(\d+)([A-Za-z][A-Za-z0-9_]*)(?:,([^*]*))?\*%/i);
    if (adMacro && !['C','R','O','P'].includes(adMacro[2])) {
      const dCode = parseInt(adMacro[1]);
      const macroName = adMacro[2];
      const macroBody = macros.get(macroName) || '';
      // Try to find circle primitive (code 1): 1,exposure,diameter,x,y
      const circlePrim = macroBody.match(/1\s*,\s*1\s*,\s*([\d.]+(?:[eE][+\-]?\d+)?)\s*,\s*[\d.\-]+\s*,\s*[\d.\-]+/);
      if (circlePrim) {
        let dia = parseFloat(circlePrim[1]);
        // If dia looks like a variable ($1), try to use the first ADD param
        if (isNaN(dia) || dia === 0) {
          const params = adMacro[3] ? adMacro[3].split(',').map(parseFloat) : [];
          if (params.length > 0 && !isNaN(params[0])) dia = params[0];
        }
        if (dia > 0) {
          apertures.set(dCode, { type: 'circle', diameter: dia, holeDiameter: 0, isMacro: true });
        }
      }
    }
  }

  const opsText = gerberText.replace(/%[^%]*%/g, '');
  const tokens = opsText.split('*').map(s => s.trim()).filter(Boolean);

  const parseCoord = (val, iDigits, dDigits) => {
    if (!val) return 0;
    if (val.includes('.')) return parseFloat(val);
    let sign = 1;
    if (val.startsWith('+')) val = val.slice(1);
    if (val.startsWith('-')) { sign = -1; val = val.slice(1); }
    const total = iDigits + dDigits;
    const s = zeroSupp === 'L' ? val.padStart(total, '0') : val.padEnd(total, '0');
    return sign * parseFloat(`${s.slice(0, iDigits)}.${s.slice(iDigits)}`);
  };

  const parseXY = (t, lastX, lastY) => {
    const m = {};
    t.replace(/([XY])([+\-]?\d+(?:\.\d+)?)/gi, (_, k, v) => { m[k.toUpperCase()] = v; });
    return {
      x: m.X !== undefined ? parseCoord(m.X, xInt, xDec) : lastX,
      y: m.Y !== undefined ? parseCoord(m.Y, yInt, yDec) : lastY
    };
  };

  let curX = 0, curY = 0, currentD = null, currentAperture = null;
  const flashes = [];

  for (const raw of tokens) {
    const t = raw.replace(/\s+/g, '');
    if (!t || /^G0?4/i.test(t)) continue;

    // Standalone D-code
    const dSel = t.match(/^D(\d+)$/i);
    if (dSel) {
      const code = parseInt(dSel[1]);
      if (code >= 10) currentAperture = apertures.get(code) ?? null;
      else currentD = code;
      continue;
    }

    // Combined token: may have D-code at end
    const md = t.match(/D0?([123])$/i);
    if (md) currentD = +md[1];

    const mdAp = t.match(/D(\d{2,})$/i);
    if (mdAp && parseInt(mdAp[1]) >= 10) {
      currentAperture = apertures.get(parseInt(mdAp[1])) ?? null;
    }

    if (/[XY]/i.test(t)) {
      const pos = parseXY(t, curX, curY);
      curX = pos.x; curY = pos.y;
    }

    if (currentD === 3 && currentAperture) {
      const xMm = units === 'in' ? curX * IN2MM : curX;
      const yMm = units === 'in' ? curY * IN2MM : curY;
      const dMm = units === 'in' ? currentAperture.diameter * IN2MM : currentAperture.diameter;
      flashes.push({
        x: xMm, y: yMm,
        diameter: dMm,
        type: currentAperture.type,
        hasHole: (currentAperture.holeDiameter ?? 0) > 0
      });
    }
  }

  return flashes;
}

/**
 * Detect fiducials in a single Gerber layer.
 * Returns { local: [...], rail: [...] }
 */
export function detectFiducials(gerberText, layerType = 'copper') {
  try {
    const allFlashes = parseAllFlashes(gerberText);

    // For soldermask layer, just return all circular openings as potential positions
    // (used for cross-correlation in analyzeFiducialsWithRails)
    if (layerType === 'soldermask') {
      const maskOpenings = allFlashes.filter(f =>
        f.type === 'circle' && !f.hasHole && f.diameter >= 1.5 && f.diameter <= 6.0
      );
      console.log(`[Fid] soldermask: ${maskOpenings.length} circular openings (1.5-6mm)`);
      return { local: maskOpenings, rail: [] };
    }

    // For copper layer: find isolated circular SMD pads
    const maxDia = 2.5; // copper fiducial pads are small

    const candidates = allFlashes.filter(f =>
      !f.hasHole &&
      f.type === 'circle' &&
      f.diameter >= 0.3 &&
      f.diameter <= maxDia
    );

    console.log(`[Fid] ${layerType}: ${allFlashes.length} total flashes, ${candidates.length} circular SMD pads (0.3-${maxDia}mm)`);

    // Log all candidates for debugging (up to 50)
    candidates.slice(0, 50).forEach(c =>
      console.log(`  pad: x=${c.x.toFixed(3)} y=${c.y.toFixed(3)} dia=${c.diameter.toFixed(3)}`)
    );

    // Isolation filter: true fiducials have 2.5mm clearance from any other flash
    const computeNearestDist = (c) =>
      allFlashes
        .filter(f => !(Math.abs(f.x - c.x) < 0.01 && Math.abs(f.y - c.y) < 0.01))
        .reduce((minD, f) => Math.min(minD, Math.hypot(f.x - c.x, f.y - c.y)), Infinity);

    const isolated25 = candidates.filter(c => computeNearestDist(c) >= 2.5);
    const isolated15 = candidates.filter(c => computeNearestDist(c) >= 1.5);
    const isolated10 = candidates.filter(c => computeNearestDist(c) >= 1.0);

    console.log(`[Fid] ${layerType}: isolated >= 2.5mm: ${isolated25.length}, >= 1.5mm: ${isolated15.length}, >= 1.0mm: ${isolated10.length}`);

    // Pick the tightest isolation threshold that gives us >=2 candidates
    let workingSet = isolated25.length >= 2 ? isolated25
                   : isolated15.length >= 2 ? isolated15
                   : isolated10.length >= 2 ? isolated10
                   : candidates;

    console.log(`[Fid] ${layerType}: workingSet size=${workingSet.length}`);
    workingSet.forEach(c =>
      console.log(`  kept: x=${c.x.toFixed(3)} y=${c.y.toFixed(3)} dia=${c.diameter.toFixed(3)} nearest=${computeNearestDist(c).toFixed(2)}mm`)
    );

    if (workingSet.length < 2) {
      console.log(`[Fid] ${layerType}: not enough candidates`);
      return { local: [], rail: [] };
    }

    // Deduplicate
    const deduped = [];
    for (const c of workingSet) {
      if (!deduped.some(e => Math.hypot(e.x - c.x, e.y - c.y) < 0.1)) deduped.push(c);
    }

    // Group by diameter (within 0.05mm bins)
    const groups = new Map();
    for (const c of deduped) {
      const key = Math.round(c.diameter * 20) / 20;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    // Pick best group: most members * widest spread
    let bestGroup = null, bestScore = -1;
    for (const [, grp] of groups) {
      if (grp.length < 2) continue;
      const xs = grp.map(c => c.x), ys = grp.map(c => c.y);
      const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      const score = grp.length * span;
      if (score > bestScore) { bestScore = score; bestGroup = grp; }
    }

    if (!bestGroup) return { local: [], rail: [] };

    console.log(`[Fid] ${layerType}: bestGroup size=${bestGroup.length}`);
    bestGroup.forEach(c => console.log(`  fid: x=${c.x.toFixed(3)} y=${c.y.toFixed(3)} dia=${c.diameter.toFixed(3)}`));

    // Rail vs local based on ALL flash bounding box
    const allXs = allFlashes.map(f => f.x), allYs = allFlashes.map(f => f.y);
    const panelMinX = Math.min(...allXs), panelMaxX = Math.max(...allXs);
    const panelMinY = Math.min(...allYs), panelMaxY = Math.max(...allYs);
    const RAIL_MARGIN = 12;

    const isRail = c =>
      (c.x - panelMinX < RAIL_MARGIN) || (panelMaxX - c.x < RAIL_MARGIN) ||
      (c.y - panelMinY < RAIL_MARGIN) || (panelMaxY - c.y < RAIL_MARGIN);

    const railGroup = bestGroup.filter(isRail);
    const localGroup = bestGroup.filter(c => !isRail(c));

    const finalLocal = localGroup.length >= 2 ? localGroup : bestGroup;
    const finalRail  = localGroup.length >= 2 ? railGroup : [];

    const conf = Math.min(1.0, bestScore / 200);
    const toFid = (arr, prefix) => arr
      .sort((a, b) => (a.y * 1000 + a.x) - (b.y * 1000 + b.x))
      .map((f, i) => ({ id: `${prefix}${i + 1}`, x: f.x, y: f.y, diameter: f.diameter, confidence: conf }));

    return { local: toFid(finalLocal, 'F'), rail: toFid(finalRail, 'R') };

  } catch (err) {
    console.warn('[FiducialDetect] Error:', err);
    return { local: [], rail: [] };
  }
}

/**
 * Analyze all layers to find fiducials using SOLDERMASK CROSS-CORRELATION.
 * The most reliable method: fiducials have a soldermask opening 1.5-3x larger than their copper pad.
 * Returns { localFiducials, railFiducials }
 */
export function analyzeFiducialsWithRails(layers, side = 'top') {
  const sideLayers = layers.filter(l => l.side === side && l.text);
  console.log(`[FidAnalyze] ${side} layers:`, sideLayers.map(l => `${l.filename}(${l.type})`));

  // Find layers by type
  const copperLayers   = sideLayers.filter(l => l.type === 'copper');
  const maskLayers     = sideLayers.filter(l => l.type === 'soldermask');
  const fabLayers      = sideLayers.filter(l => ['fab', 'assembly', 'fiducial'].some(p => l.filename.toLowerCase().includes(p)));

  // ─── Strategy 1: Soldermask cross-correlation ────────────────────────────────
  // Find copper pads that have a corresponding soldermask opening (1.3x-4x larger)
  if (copperLayers.length > 0 && maskLayers.length > 0) {
    console.log('[FidAnalyze] Trying soldermask cross-correlation strategy...');

    // Collect all copper circular SMD pads
    const copperFlashes = copperLayers.flatMap(l => parseAllFlashes(l.text))
      .filter(f => !f.hasHole && f.type === 'circle' && f.diameter >= 0.3 && f.diameter <= 3.0);

    // Collect all soldermask circular openings
    const maskFlashes = maskLayers.flatMap(l => parseAllFlashes(l.text))
      .filter(f => f.type === 'circle' && f.diameter >= 0.8);

    console.log(`[FidAnalyze] Copper SMD circles: ${copperFlashes.length}, Mask circles: ${maskFlashes.length}`);

    // For each copper pad, find corresponding mask opening
    const MATCH_DIST = 0.5; // mm position tolerance
    const fidCandidates = [];
    for (const cu of copperFlashes) {
      const matchingMask = maskFlashes.find(m =>
        Math.hypot(m.x - cu.x, m.y - cu.y) < MATCH_DIST &&
        m.diameter >= cu.diameter * 1.3 && // mask opening must be significantly larger
        m.diameter <= cu.diameter * 5.0    // but not unreasonably larger
      );
      if (matchingMask) {
        fidCandidates.push({
          ...cu,
          maskDiameter: matchingMask.diameter,
          ratio: matchingMask.diameter / cu.diameter
        });
        console.log(`  cross-match: cu=(${cu.x.toFixed(2)},${cu.y.toFixed(2)}) dia=${cu.diameter.toFixed(2)}, mask dia=${matchingMask.diameter.toFixed(2)}, ratio=${matchingMask.diameter/cu.diameter.toFixed(1)}`);
      }
    }

    if (fidCandidates.length >= 2) {
      console.log(`[FidAnalyze] Cross-correlation found ${fidCandidates.length} fiducial matches!`);
      return buildResult(fidCandidates, copperLayers[0]);
    } else {
      console.log('[FidAnalyze] Cross-correlation insufficient, falling back...');
    }
  }

  // ─── Strategy 2: Per-layer heuristic detection ────────────────────────────────
  console.log('[FidAnalyze] Using heuristic strategy...');

  const priorityOrder = ['fiducial', 'fid', 'fab', 'assembly', 'copper'];
  const allCandidateLayers = [...fabLayers, ...copperLayers]
    .filter((l, i, arr) => arr.indexOf(l) === i) // deduplicate
    .sort((a, b) => {
      const ai = priorityOrder.findIndex(p => a.filename.toLowerCase().includes(p));
      const bi = priorityOrder.findIndex(p => b.filename.toLowerCase().includes(p));
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

  const allLocal = [], allRail = [];
  const searched = new Set();

  for (const layer of allCandidateLayers) {
    if (searched.has(layer.filename)) continue;
    searched.add(layer.filename);

    const result = detectFiducials(layer.text, layer.type);
    const local = result?.local ?? [], rail = result?.rail ?? [];
    const pri = priorityOrder.findIndex(p => layer.filename.toLowerCase().includes(p));

    if (local.length > 0) {
      console.log(`[FidAnalyze] ${local.length} local from ${layer.filename}`);
      allLocal.push({ layer: layer.filename, fiducials: local, priority: pri === -1 ? 999 : pri });
    }
    if (rail.length > 0) {
      allRail.push({ layer: layer.filename, fiducials: rail, priority: pri === -1 ? 999 : pri });
    }
  }

  const localFiducials = mergeFiducials(allLocal);
  const railFiducials  = mergeFiducials(allRail).map((f, i) => ({ ...f, id: `R${i + 1}` }));
  console.log(`[FidAnalyze] Final: ${localFiducials.length} local, ${railFiducials.length} rail`);
  return { localFiducials, railFiducials };
}

/**
 * Build final result from cross-correlated fiducial candidates.
 */
function buildResult(candidates, copperLayer) {
  // Compute panel bounding box from the copper layer's all flashes
  const allFlashes = copperLayer ? parseAllFlashes(copperLayer.text) : candidates;
  const allXs = allFlashes.map(f => f.x), allYs = allFlashes.map(f => f.y);
  const panelMinX = Math.min(...allXs), panelMaxX = Math.max(...allXs);
  const panelMinY = Math.min(...allYs), panelMaxY = Math.max(...allYs);
  const RAIL_MARGIN = 12;

  const isRail = c =>
    (c.x - panelMinX < RAIL_MARGIN) || (panelMaxX - c.x < RAIL_MARGIN) ||
    (c.y - panelMinY < RAIL_MARGIN) || (panelMaxY - c.y < RAIL_MARGIN);

  const railGroup  = candidates.filter(isRail);
  const localGroup = candidates.filter(c => !isRail(c));

  const finalLocal = localGroup.length >= 2 ? localGroup : candidates;
  const finalRail  = localGroup.length >= 2 ? railGroup : [];

  const toFid = (arr, prefix) => arr
    .sort((a, b) => (a.y * 1000 + a.x) - (b.y * 1000 + b.x))
    .map((f, i) => ({ id: `${prefix}${i + 1}`, x: f.x, y: f.y, diameter: f.diameter, confidence: 0.95 }));

  const localFiducials = toFid(finalLocal, 'F');
  const railFiducials  = toFid(finalRail,  'R');
  console.log(`[FidAnalyze] Cross-correlation result: ${localFiducials.length} local, ${railFiducials.length} rail`);
  return { localFiducials, railFiducials };
}

/** Backward-compatible wrapper */
export function analyzeFiducialsInLayers(layers, side = 'top') {
  return analyzeFiducialsWithRails(layers, side).localFiducials;
}

/** Merge fiducials from multiple layers */
function mergeFiducials(layerFiducials) {
  if (layerFiducials.length === 0) return [];
  layerFiducials.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  const merged = [];
  for (const { fiducials } of layerFiducials) {
    for (const fid of fiducials) {
      const e = merged.find(x => Math.hypot(x.x - fid.x, x.y - fid.y) < 0.5);
      if (e) {
        if (fid.confidence > e.confidence) { e.confidence = fid.confidence; e.diameter = fid.diameter; }
      } else {
        merged.push({ ...fid });
      }
    }
  }
  merged.sort((a, b) => b.confidence - a.confidence);
  return merged.map((f, i) => ({ ...f, id: `F${i + 1}` }));
}