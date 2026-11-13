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
      const code = parseInt(adC[1]);
      apertures.set(code, {
        code,
        type: 'circle',
        diameter: parseFloat(adC[2]),
        holeDiameter: adC[3] ? parseFloat(adC[3]) : 0
      });
    }

    // Rect/Oval aperture %ADDnnR,wxh or O,wxh
    const adRO = block.match(/%ADD(\d+)[RO],([^*,]+)X([^*,]+)(?:,([^*]+))?\*%/i);
    if (adRO) {
      const code = parseInt(adRO[1]);
      const w = parseFloat(adRO[2]), h = parseFloat(adRO[3]);
      apertures.set(code, { code, type: 'rect', diameter: Math.max(w, h), holeDiameter: 0 });
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
          apertures.set(dCode, { code: dCode, type: 'circle', diameter: dia, holeDiameter: 0, isMacro: true });
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

    // Standalone D-code (e.g. D03*, D3*, D10*)
    const dSel = t.match(/^D(\d+)$/i);
    if (dSel) {
      const code = parseInt(dSel[1]);
      if (code >= 10) {
        currentAperture = apertures.get(code) ?? null;
      } else {
        currentD = code;
        if (code === 3 && currentAperture) {
          const xMm = units === 'in' ? curX * IN2MM : curX;
          const yMm = units === 'in' ? curY * IN2MM : curY;
          const dMm = units === 'in' ? currentAperture.diameter * IN2MM : currentAperture.diameter;
          flashes.push({
            x: xMm, y: yMm,
            diameter: dMm,
            type: currentAperture.type,
            hasHole: (currentAperture.holeDiameter ?? 0) > 0,
            apCode: currentAperture.code
          });
          currentD = null;
        }
      }
      continue;
    }

    // Combined token: may have D-code at end (e.g. X100Y200D03*)
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
        hasHole: (currentAperture.holeDiameter ?? 0) > 0,
        apCode: currentAperture.code
      });
      currentD = null;
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
export function analyzeFiducialsWithRails(layers, side = 'top', fallbackPads = []) {
  const sideLayers = (layers || []).filter(l => (l.side === side || l.side === 'all' || !l.side) && l.text);
  const candidateLayers = sideLayers.length > 0 ? sideLayers : (layers || []).filter(l => l.text);
  console.log(`[FidAnalyze] ${side} layers (${candidateLayers.length}):`, candidateLayers.map(l => `${l.filename}(${l.type || '?'})`));

  // Find layers by type
  const copperLayers   = candidateLayers.filter(l => l.type === 'copper');
  const maskLayers     = candidateLayers.filter(l => l.type === 'soldermask');
  const pasteLayers    = candidateLayers.filter(l => l.type === 'solderpaste');
  const fabLayers      = candidateLayers.filter(l => ['fab', 'assembly', 'fiducial', 'mech'].some(p => l.filename.toLowerCase().includes(p)));
  const padLayers      = copperLayers.length > 0 ? copperLayers : pasteLayers;

  // ─── Strategy 0: Gerber X2 Attribute Detection ──────────────────────────────
  for (const layer of candidateLayers) {
    if (layer.text && /Fiducial/i.test(layer.text)) {
      const fidApCodes = new Set();
      const taMatches = layer.text.matchAll(/%TA\.AperFunction,[^%*]*Fiducial[^%*]*\*%(?:[\s\S]{0,300}?)%ADD(\d+)/gi);
      for (const m of taMatches) fidApCodes.add(parseInt(m[1]));

      const flashes = parseAllFlashes(layer.text);
      let x2Fids = [];
      if (fidApCodes.size > 0) {
        x2Fids = flashes.filter(f => fidApCodes.has(f.apCode));
      }
      if (x2Fids.length < 2) {
        x2Fids = flashes.filter(f => !f.hasHole && f.type === 'circle' && f.diameter >= 0.4 && f.diameter <= 3.5);
      }
      if (x2Fids.length >= 2) {
        console.log(`[FidAnalyze] Gerber X2 explicit fiducials found in ${layer.filename}: ${x2Fids.length}`);
        const res = buildResult(x2Fids, layer);
        if (res.localFiducials.length >= 2) return res;
      }
    }
  }

  // ─── Strategy 1: Soldermask cross-correlation ────────────────────────────────
  // Find copper pads that have a corresponding soldermask opening (1.15x-6x larger)
  if ((copperLayers.length > 0 || padLayers.length > 0) && maskLayers.length > 0) {
    // Collect all copper circular SMD pads
    const copperFlashes = (copperLayers.length > 0 ? copperLayers : padLayers).flatMap(l => parseAllFlashes(l.text))
      .filter(f => !f.hasHole && f.type === 'circle' && f.diameter >= 0.3 && f.diameter <= 3.0);

    // Collect all soldermask circular openings
    const maskFlashes = maskLayers.flatMap(l => parseAllFlashes(l.text))
      .filter(f => f.type === 'circle' && f.diameter >= 0.5);

    // For each copper pad, find corresponding mask opening
    const MATCH_DIST = 0.5; // mm position tolerance
    const fidCandidates = [];
    for (const cu of copperFlashes) {
      const matchingMask = maskFlashes.find(m =>
        Math.hypot(m.x - cu.x, m.y - cu.y) < MATCH_DIST &&
        m.diameter >= cu.diameter * 1.15 && // mask opening is larger than copper pad
        m.diameter <= cu.diameter * 6.0    // but not unreasonably larger
      );
      if (matchingMask) {
        fidCandidates.push({
          ...cu,
          maskDiameter: matchingMask.diameter,
          ratio: matchingMask.diameter / cu.diameter
        });
      }
    }

    const copperNearestDist = (candidate) => copperFlashes
      .filter(f => !(Math.abs(f.x - candidate.x) < 0.01 && Math.abs(f.y - candidate.y) < 0.01))
      .reduce((minD, f) => Math.min(minD, Math.hypot(f.x - candidate.x, f.y - candidate.y)), Infinity);

    let isolatedCandidates = fidCandidates.filter(c => copperNearestDist(c) >= 1.5);
    if (isolatedCandidates.length < 2) {
      isolatedCandidates = fidCandidates;
    }

    const diameterGroups = new Map();
    for (const candidate of isolatedCandidates) {
      const key = Math.round(candidate.diameter * 20) / 20;
      if (!diameterGroups.has(key)) diameterGroups.set(key, []);
      diameterGroups.get(key).push(candidate);
    }
    const repeatedGroup = [...diameterGroups.values()]
      .filter(group => group.length >= 2)
      .sort((a, b) => b.length - a.length)[0];

    if (repeatedGroup) {
      return buildResult(repeatedGroup, copperLayers[0]);
    } else {
      console.log('[FidAnalyze] Cross-correlation insufficient, falling back...');
    }
  }

  // ─── Strategy 2: Per-layer heuristic detection ────────────────────────────────
  console.log('[FidAnalyze] Using heuristic strategy...');

  const priorityOrder = ['fiducial', 'fid', 'fab', 'assembly', 'copper', 'paste'];
  const allCandidateLayers = [...fabLayers, ...copperLayers, ...pasteLayers]
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

  // ─── Strategy 3: Corner Pad Fallback ──────────────────────────────────────────
  if (localFiducials.length < 2 && fallbackPads && fallbackPads.length >= 2) {
    console.log('[FidAnalyze] No formal fiducials detected. Nominating corner pads as alignment fiducials...');
    const validPads = fallbackPads.filter(p => typeof p.x === 'number' && typeof p.y === 'number');
    if (validPads.length >= 2) {
      const xs = validPads.map(p => p.x);
      const ys = validPads.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);

      const bl = [...validPads].sort((a, b) => Math.hypot(a.x - minX, a.y - minY) - Math.hypot(b.x - minX, b.y - minY))[0];
      const tr = [...validPads].filter(p => p !== bl).sort((a, b) => Math.hypot(a.x - maxX, a.y - maxY) - Math.hypot(b.x - maxX, b.y - maxY))[0];

      if (bl && tr && Math.hypot(bl.x - tr.x, bl.y - tr.y) > 3.0) {
        const nominated = [
          { id: 'F1', x: parseFloat(bl.x.toFixed(4)), y: parseFloat(bl.y.toFixed(4)), diameter: bl.width || 1.0, confidence: 0.85 },
          { id: 'F2', x: parseFloat(tr.x.toFixed(4)), y: parseFloat(tr.y.toFixed(4)), diameter: tr.width || 1.0, confidence: 0.85 }
        ];
        console.log(`[FidAnalyze] Nominated corner pads as fiducials: F1(${bl.x}, ${bl.y}), F2(${tr.x}, ${tr.y})`);
        return { localFiducials: nominated, railFiducials };
      }
    }
  }

  // ─── Strategy 4: Fallback to circular/outer flashes across candidate layers ──
  if (localFiducials.length < 2 && candidateLayers.length > 0) {
    const allCircleFlashes = candidateLayers.flatMap(l => parseAllFlashes(l.text))
      .filter(f => !f.hasHole && f.type === 'circle' && f.diameter >= 0.4 && f.diameter <= 4.0);
    const candidateList = allCircleFlashes.length >= 2
      ? allCircleFlashes
      : candidateLayers.flatMap(l => parseAllFlashes(l.text)).filter(f => !f.hasHole && f.diameter >= 0.2);

    if (candidateList.length >= 2) {
      const xs = candidateList.map(p => p.x);
      const ys = candidateList.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);

      const bl = [...candidateList].sort((a, b) => Math.hypot(a.x - minX, a.y - minY) - Math.hypot(b.x - minX, b.y - minY))[0];
      const tr = [...candidateList].filter(p => p !== bl).sort((a, b) => Math.hypot(a.x - maxX, a.y - maxY) - Math.hypot(b.x - maxX, b.y - maxY))[0];

      if (bl && tr && Math.hypot(bl.x - tr.x, bl.y - tr.y) > 2.0) {
        const nominated = [
          { id: 'F1', x: parseFloat(bl.x.toFixed(4)), y: parseFloat(bl.y.toFixed(4)), diameter: bl.diameter || 1.0, confidence: 0.80 },
          { id: 'F2', x: parseFloat(tr.x.toFixed(4)), y: parseFloat(tr.y.toFixed(4)), diameter: tr.diameter || 1.0, confidence: 0.80 }
        ];
        console.log(`[FidAnalyze] Nominated outer flashes as fiducials: F1(${bl.x}, ${bl.y}), F2(${tr.x}, ${tr.y})`);
        return { localFiducials: nominated, railFiducials };
      }
    }
  }
  if (localFiducials.length < 2 && railFiducials.length >= 2) {
    console.log('[FidAnalyze] Local fiducials empty or single, promoting rail fiducials to local.');
    return {
      localFiducials: railFiducials.map((f, i) => ({ ...f, id: `F${i + 1}` })),
      railFiducials: []
    };
  }

  console.log(`[FidAnalyze] Final: ${localFiducials.length} local, ${railFiducials.length} rail`);
  return { localFiducials, railFiducials };
}

/**
 * Build final result from cross-correlated fiducial candidates.
 * Uses gap-based separation to distinguish rail (panel edge) fiducials from
 * local (on-board) fiducials. Works generically for any panel layout.
 */
function buildResult(candidates, copperLayer) {
  if (candidates.length < 2) {
    return {
      localFiducials: candidates.map((f, i) => ({ id: `F${i+1}`, x: f.x, y: f.y, diameter: f.diameter, confidence: 0.95 })),
      railFiducials: []
    };
  }

  // Gap-based separation: sort along Y and X, find large gaps that mark the
  // transition between the panel rail strip and the actual board area.
  const { local, rail } = gapBasedSeparation(candidates);

  // If there are too many rail candidates (> 4), trim to the most spread-out pair/quad.
  // This handles cases where a rail strip contains more than the expected 2-4 marks.
  const finalRail = trimRailToCorners(rail);
  const railSet = new Set(finalRail.map(c => `${c.x.toFixed(3)},${c.y.toFixed(3)}`));
  let finalLocal = candidates.filter(c => !railSet.has(`${c.x.toFixed(3)},${c.y.toFixed(3)}`));
  let finalRailArr = finalRail;

  // CRITICAL: A board cannot align with fewer than 2 local fiducials.
  // If separation left fewer than 2 local marks, keep ALL candidates as local fiducials!
  if (finalLocal.length < 2 && candidates.length >= 2) {
    finalLocal = candidates;
    finalRailArr = [];
  }

  console.log(`[FidAnalyze] gap-separation: ${finalLocal.length} local, ${finalRailArr.length} rail`);

  const toFid = (arr, prefix) => arr
    .sort((a, b) => (a.y * 10000 + a.x) - (b.y * 10000 + b.x))
    .map((f, i) => ({ id: `${prefix}${i + 1}`, x: f.x, y: f.y, diameter: f.diameter, confidence: 0.95 }));

  return {
    localFiducials: toFid(finalLocal, 'F'),
    railFiducials:  toFid(finalRailArr,  'R'),
  };
}

/**
 * Separate a set of fiducial candidates into local (on-board) and rail (panel edge) groups
 * by finding large gaps in the Y or X distribution.
 *
 * Rail fiducials are characteristically located in the narrow strips at the panel edges,
 * well separated from the cluster of local board fiducials by a significant spatial gap.
 */
function gapBasedSeparation(candidates) {
  if (candidates.length < 4) return { local: candidates, rail: [] };

  // Helper: find gap indices and return separation quality for one axis
  const axisScore = (sorted, axis) => {
    const vals = sorted.map(c => c[axis]);
    const span = vals[vals.length - 1] - vals[0];
    if (span < 5) return { score: 0, gaps: [] };

    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push({ gap: vals[i] - vals[i - 1], before: i });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    const maxGap = gaps[0]?.gap || 0;
    return { score: maxGap / span, gaps, sorted };
  };

  const sortedY = [...candidates].sort((a, b) => a.y - b.y);
  const sortedX = [...candidates].sort((a, b) => a.x - b.x);
  const resY = axisScore(sortedY, 'y');
  const resX = axisScore(sortedX, 'x');

  // Choose the axis with the more pronounced gap
  const useY = resY.score >= resX.score;
  const { gaps, sorted } = useY ? resY : resX;

  // Minimum gap ratio to consider a separation significant.
  // 0.12 means the gap must be >= 12% of the full span (e.g. 25mm gap in 200mm panel).
  const MIN_SCORE = 0.12;
  if ((useY ? resY.score : resX.score) < MIN_SCORE) {
    return { local: candidates, rail: [] };
  }

  // Find the 1 or 2 largest gaps that are at least 40% as large as the biggest gap.
  // These mark the boundaries between rail strips and the board area.
  const maxGapSize = gaps[0]?.gap || 0;
  const significantGaps = gaps
    .filter(g => g.gap >= maxGapSize * 0.4)
    .slice(0, 2)
    .map(g => g.before)
    .sort((a, b) => a - b);

  let rail = [], local = [];

  if (significantGaps.length >= 2) {
    // Two large gaps → top rail | local | bottom rail
    const [g1, g2] = significantGaps;
    const topRail    = sorted.slice(0, g1);
    const middleLocal = sorted.slice(g1, g2);
    const bottomRail = sorted.slice(g2);

    // Only use as rail if the extreme group is smaller than the local group
    // (prevents classifying half the board as rail for irregular layouts)
    const MAX_RAIL_FRACTION = 0.35;
    const useTop    = topRail.length / candidates.length <= MAX_RAIL_FRACTION;
    const useBottom = bottomRail.length / candidates.length <= MAX_RAIL_FRACTION;

    rail  = [...(useTop ? topRail : []), ...(useBottom ? bottomRail : [])];
    local = [
      ...(useTop    ? [] : topRail),
      ...middleLocal,
      ...(useBottom ? [] : bottomRail),
    ];
  } else if (significantGaps.length === 1) {
    const [g] = significantGaps;
    const before = sorted.slice(0, g);
    const after  = sorted.slice(g);
    // The smaller group is rail (rail strips are narrower than the board area)
    if (before.length <= after.length && before.length > 0 && before.length <= Math.ceil(candidates.length * 0.35)) {
      rail = before; local = after;
    } else if (after.length < before.length && after.length > 0 && after.length <= Math.ceil(candidates.length * 0.35)) {
      rail = after; local = before;
    } else {
      // Gap exists but neither side is clearly smaller → no rail
      local = candidates; rail = [];
    }
  } else {
    local = candidates; rail = [];
  }

  return { local, rail };
}

/**
 * If there are more rail candidates than expected (>4), trim to the pair/quad that
 * spans the greatest distance — these are the true corner alignment marks.
 */
function trimRailToCorners(rail) {
  if (rail.length <= 4) return rail;

  // Find the 2 points with the maximum pairwise distance (widest spread = true corner marks)
  let bestPair = null, bestDist = -1;
  for (let i = 0; i < rail.length; i++) {
    for (let j = i + 1; j < rail.length; j++) {
      const d = Math.hypot(rail[i].x - rail[j].x, rail[i].y - rail[j].y);
      if (d > bestDist) { bestDist = d; bestPair = [rail[i], rail[j]]; }
    }
  }
  return bestPair ?? rail.slice(0, 2);
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