import { extractPadsMm } from './extractPads.js';

/**
 * Combines copper and solderpaste layers to get complete pad information
 * @param {Array} layers - Array of layer objects with type, side, and text properties
 * @param {string} side - 'top' or 'bottom'
 * @returns {Object} Combined pad data with positions from copper and dispensing info from solderpaste
 */
export function combinePadLayers(layers, side) {
  const copperLayer = layers.find(l => l.type === 'copper' && l.side === side);
  const solderpasteLayer = layers.find(l => l.type === 'solderpaste' && l.side === side);
  
  if (!copperLayer && !solderpasteLayer) {
    return { pads: [], hasGeometry: false, hasDispensing: false };
  }

  let copperPads = [];
  let pastePads = [];
  
  // Extract pad positions from copper layer (exact pad geometry)
  if (copperLayer) {
    copperPads = extractPadsMm(copperLayer.text);
  }
  
  // Extract dispensing targets from solderpaste
  if (solderpasteLayer) {
    pastePads = extractPadsMm(solderpasteLayer.text);
  }
  
  // If we have both layers, match pads by proximity
  if (copperPads.length > 0 && pastePads.length > 0) {
    return matchPadsByProximity(copperPads, pastePads);
  }
  
  // If only one layer available, use what we have
  if (copperPads.length > 0) {
    return {
      pads: copperPads.map((pad, idx) => ({
        ...pad,
        width: pad.width || 1.0,
        height: pad.height || 1.0,
        shape: pad.shape || 'C',
        id: `C${idx + 1}`,
        source: 'copper',
        needsPaste: false // Unknown without solderpaste layer
      })),
      hasGeometry: true,
      hasDispensing: false
    };
  }
  
  if (pastePads.length > 0) {
    return {
      pads: pastePads.map((pad, idx) => ({
        ...pad,
        width: pad.width || 1.0,
        height: pad.height || 1.0,
        shape: pad.shape || 'C',
        id: `P${idx + 1}`,
        source: 'solderpaste',
        needsPaste: true
      })),
      hasGeometry: false,
      hasDispensing: true
    };
  }
  
  return { pads: [], hasGeometry: false, hasDispensing: false };
}

/**
 * Matches copper pads with solderpaste pads by proximity
 * @param {Array} copperPads - Pads from copper layer (exact positions)
 * @param {Array} pastePads - Pads from solderpaste layer (dispensing targets)
 * @returns {Object} Combined pad data
 */
function matchPadsByProximity(copperPads, pastePads) {
  const MATCH_THRESHOLD = 0.5; // mm - maximum distance to consider pads as matching
  const combinedPads = [];
  const usedPasteIndices = new Set();
  
  // For each copper pad, find closest solderpaste pad
  copperPads.forEach((copperPad, copperIdx) => {
    let closestPasteIdx = -1;
    let minDistance = Infinity;
    
    pastePads.forEach((pastePad, pasteIdx) => {
      if (usedPasteIndices.has(pasteIdx)) return;
      
      const distance = Math.hypot(copperPad.x - pastePad.x, copperPad.y - pastePad.y);
      if (distance < minDistance && distance <= MATCH_THRESHOLD) {
        minDistance = distance;
        closestPasteIdx = pasteIdx;
      }
    });
    
    if (closestPasteIdx >= 0) {
      // Matched pad - use copper position (exact geometry) with solderpaste info
      usedPasteIndices.add(closestPasteIdx);
      combinedPads.push({
        x: copperPad.x,
        y: copperPad.y,
        width: copperPad.width || 1.0,
        height: copperPad.height || 1.0,
        shape: copperPad.shape || 'C',
        id: `C${combinedPads.length + 1}`,
        source: 'combined',
        needsPaste: true,
        pasteOrder: closestPasteIdx + 1,
        matchDistance: minDistance
      });
    } else {
      // Unmatched copper pad - no paste needed
      combinedPads.push({
        x: copperPad.x,
        y: copperPad.y,
        width: copperPad.width || 1.0,
        height: copperPad.height || 1.0,
        shape: copperPad.shape || 'C',
        id: `C${copperIdx + 1}`,
        source: 'copper',
        needsPaste: false
      });
    }
  });
  
  // Add any unmatched solderpaste pads
  pastePads.forEach((pastePad, pasteIdx) => {
    if (!usedPasteIndices.has(pasteIdx)) {
      combinedPads.push({
        x: pastePad.x,
        y: pastePad.y,
        width: pastePad.width || 1.0,
        height: pastePad.height || 1.0,
        shape: pastePad.shape || 'C',
        id: `P${pasteIdx + 1}`,
        source: 'solderpaste',
        needsPaste: true,
        pasteOrder: pasteIdx + 1,
        geometryMissing: true
      });
    }
  });
  
  return {
    pads: combinedPads,
    hasGeometry: true,
    hasDispensing: true,
    matchedCount: usedPasteIndices.size,
    totalCopperPads: copperPads.length,
    totalPastePads: pastePads.length
  };
}

/**
 * Gets available layer combinations for a given side
 * @param {Array} layers - Array of layer objects
 * @param {string} side - 'top' or 'bottom'
 * @returns {Object} Available layer information
 */
export function getAvailableLayerCombinations(layers, side) {
  const copper = layers.find(l => l.type === 'copper' && l.side === side);
  const solderpaste = layers.find(l => l.type === 'solderpaste' && l.side === side);
  
  return {
    hasCopper: !!copper,
    hasSolderpaste: !!solderpaste,
    copperFile: copper?.filename,
    solderpasteFile: solderpaste?.filename,
    canCombine: !!(copper && solderpaste)
  };
}