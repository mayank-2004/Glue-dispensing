/**
 * Generate movement path from origin to target pad
 * Uses strict Cartesian Linear Interpolation (G1)
 */
export function generatePath(origin, target, pads, options = {}) {
  const {
    safeHeight = 5, // mm above PCB
    pathType = 'safe' // 'direct' or 'safe'
  } = options;

  if (!origin || !target) return null;

  // Default to safe path (Lift -> Move -> Lower) if not specified as direct
  if (pathType === 'direct') {
    return generateDirectPath(origin, target);
  } else {
    // 'safe', 'optimized', 'zigzag' all map to Safe Linear Interpolation
    // to ensure predictable point-to-point motion without heuristics
    return generateSafePath(origin, target, safeHeight);
  }
}

/**
 * Direct straight line path (G1 X Y)
 */
function generateDirectPath(origin, target) {
  const points = [
    { x: origin.x, y: origin.y, z: 0, type: 'start' },
    { x: target.x, y: target.y, z: 0, type: 'end' }
  ];

  const distance = Math.hypot(target.x - origin.x, target.y - origin.y);

  return {
    points,
    segments: [{ start: points[0], end: points[1], type: 'linear' }],
    totalDistance: distance,
    type: 'direct'
  };
}

/**
 * Safe path with lift-move-lower sequence (G1 Z -> G1 X Y -> G1 Z)
 */
function generateSafePath(origin, target, safeHeight) {
  const points = [
    { x: origin.x, y: origin.y, z: 0, type: 'start' },
    { x: origin.x, y: origin.y, z: safeHeight, type: 'lift' },
    { x: target.x, y: target.y, z: safeHeight, type: 'travel' },
    { x: target.x, y: target.y, z: 0, type: 'end' }
  ];

  const xyDistance = Math.hypot(target.x - origin.x, target.y - origin.y);
  const totalDistance = (safeHeight * 2) + xyDistance; // Up + travel + down

  return {
    points,
    segments: [
      { start: points[0], end: points[1], type: 'lift' },
      { start: points[1], end: points[2], type: 'travel' },
      { start: points[2], end: points[3], type: 'lower' }
    ],
    totalDistance,
    type: 'safe'
  };
}
