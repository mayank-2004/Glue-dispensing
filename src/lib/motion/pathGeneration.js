/**
 * Generate movement path from origin to target pad
 */
export function generatePath(origin, target, pads, options = {}) {
  const {
    avoidPads = true,
    safeHeight = 6, // mm above PCB
    pathType = 'direct' // 'direct', 'safe', 'optimized', 'zigzag'
  } = options;

  if (!origin || !target) return null;

  const path = {
    points: [],
    segments: [],
    totalDistance: 0,
    type: pathType
  };

  switch (pathType) {
    case 'direct':
      return generateDirectPath(origin, target);
    
    case 'safe':
      return generateSafePath(origin, target, pads, safeHeight);
    
    case 'optimized':
      return generateOptimizedPath(origin, target, pads, safeHeight);
    
    case 'zigzag':
      return generateZigzagPath(origin, target, options);
    
    default:
      return generateDirectPath(origin, target);
  }
}

/**
 * Direct straight line path
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
 * Safe path with lift-move-lower sequence
 */
function generateSafePath(origin, target, pads, safeHeight) {
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

/**
 * Optimized path avoiding obstacles
 */
function generateOptimizedPath(origin, target, pads, safeHeight) {
  // Check if direct path is clear
  if (isPathClear(origin, target, pads)) {
    return generateDirectPath(origin, target);
  }

  // Find waypoints to avoid obstacles
  const waypoints = findWaypoints(origin, target, pads);
  
  if (waypoints.length === 0) {
    // Fallback to safe path if no clear route found
    return generateSafePath(origin, target, pads, safeHeight);
  }

  // Build path through waypoints
  const points = [
    { x: origin.x, y: origin.y, z: 0, type: 'start' },
    ...waypoints.map(wp => ({ x: wp.x, y: wp.y, z: 0, type: 'waypoint' })),
    { x: target.x, y: target.y, z: 0, type: 'end' }
  ];

  const segments = [];
  let totalDistance = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    
    segments.push({ start, end, type: 'linear', distance });
    totalDistance += distance;
  }

  return {
    points,
    segments,
    totalDistance,
    type: 'optimized'
  };
}

/**
 * Check if direct path between two points is clear of obstacles
 */
function isPathClear(start, end, pads, clearance = 1) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  
  if (distance === 0) return true;

  const steps = Math.ceil(distance / 0.5); // Check every 0.5mm
  
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const checkPoint = {
      x: start.x + dx * t,
      y: start.y + dy * t
    };

    // Check if this point is too close to any pad
    for (const pad of pads) {
      const padDistance = Math.hypot(pad.x - checkPoint.x, pad.y - checkPoint.y);
      const padRadius = Math.max(pad.width || 1, pad.height || 1) / 2;
      
      if (padDistance < padRadius + clearance) {
        return false; // Path blocked
      }
    }
  }

  return true; // Path is clear
}

/**
 * Find waypoints to navigate around obstacles
 */
function findWaypoints(start, end, pads) {
  // Simple waypoint algorithm - can be enhanced with A* pathfinding
  const waypoints = [];
  
  // Try going around major obstacles
  const obstacles = pads.filter(pad => {
    const padRadius = Math.max(pad.width || 1, pad.height || 1) / 2;
    return isPointNearLine(start, end, pad, padRadius + 1);
  });

  if (obstacles.length === 0) return waypoints;

  // For now, use simple avoidance - go around the first major obstacle
  const obstacle = obstacles[0];
  const padRadius = Math.max(obstacle.width || 1, obstacle.height || 1) / 2;
  const avoidanceRadius = padRadius + 2; // 2mm clearance

  // Calculate waypoints around the obstacle
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  // Determine which side to go around
  const toObstacle = { x: obstacle.x - midX, y: obstacle.y - midY };
  const perpendicular = { x: -toObstacle.y, y: toObstacle.x };
  const perpLength = Math.hypot(perpendicular.x, perpendicular.y);
  
  if (perpLength > 0) {
    const perpUnit = { 
      x: perpendicular.x / perpLength, 
      y: perpendicular.y / perpLength 
    };
    
    waypoints.push({
      x: obstacle.x + perpUnit.x * avoidanceRadius,
      y: obstacle.y + perpUnit.y * avoidanceRadius
    });
  }

  return waypoints;
}

/**
 * Check if a point is near a line segment
 */
function isPointNearLine(lineStart, lineEnd, point, threshold) {
  const A = lineEnd.x - lineStart.x;
  const B = lineEnd.y - lineStart.y;
  const C = point.x - lineStart.x;
  const D = point.y - lineStart.y;

  const dot = A * C + B * D;
  const lenSq = A * A + B * B;
  
  if (lenSq === 0) return Math.hypot(C, D) <= threshold;

  const param = dot / lenSq;
  
  let xx, yy;
  if (param < 0) {
    xx = lineStart.x;
    yy = lineStart.y;
  } else if (param > 1) {
    xx = lineEnd.x;
    yy = lineEnd.y;
  } else {
    xx = lineStart.x + param * A;
    yy = lineStart.y + param * B;
  }

  const distance = Math.hypot(point.x - xx, point.y - yy);
  return distance <= threshold;
}

/**
 * Generate zig-zag path with incremental X and Y movements
 */
function generateZigzagPath(origin, target, options = {}) {
  const {
    stepSize = 2, // mm per step
    pattern = 'xy' // 'xy', 'yx', 'alternating'
  } = options;

  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const points = [{ x: origin.x, y: origin.y, z: 0, type: 'start' }];
  
  let currentX = origin.x;
  let currentY = origin.y;
  
  if (pattern === 'xy') {
    // Move X first, then Y
    const xSteps = Math.ceil(Math.abs(dx) / stepSize);
    const ySteps = Math.ceil(Math.abs(dy) / stepSize);
    const xStepSize = dx / xSteps;
    const yStepSize = dy / ySteps;
    
    // X movement steps
    for (let i = 1; i <= xSteps; i++) {
      currentX = origin.x + (xStepSize * i);
      points.push({ x: currentX, y: currentY, z: 0, type: 'step' });
    }
    
    // Y movement steps
    for (let i = 1; i <= ySteps; i++) {
      currentY = origin.y + (yStepSize * i);
      points.push({ x: currentX, y: currentY, z: 0, type: 'step' });
    }
  } else if (pattern === 'yx') {
    // Move Y first, then X
    const xSteps = Math.ceil(Math.abs(dx) / stepSize);
    const ySteps = Math.ceil(Math.abs(dy) / stepSize);
    const xStepSize = dx / xSteps;
    const yStepSize = dy / ySteps;
    
    // Y movement steps
    for (let i = 1; i <= ySteps; i++) {
      currentY = origin.y + (yStepSize * i);
      points.push({ x: currentX, y: currentY, z: 0, type: 'step' });
    }
    
    // X movement steps
    for (let i = 1; i <= xSteps; i++) {
      currentX = origin.x + (xStepSize * i);
      points.push({ x: currentX, y: currentY, z: 0, type: 'step' });
    }
  } else if (pattern === 'alternating') {
    // Alternating X and Y steps (true zig-zag)
    const totalDistance = Math.hypot(dx, dy);
    const totalSteps = Math.ceil(totalDistance / stepSize);
    
    for (let i = 1; i <= totalSteps; i++) {
      const progress = i / totalSteps;
      
      if (i % 2 === 1) {
        // Odd steps: move in X direction
        const xProgress = Math.min(progress * 2, 1);
        currentX = origin.x + (dx * xProgress);
      } else {
        // Even steps: move in Y direction
        const yProgress = Math.min((progress - 0.5) * 2, 1);
        currentY = origin.y + (dy * yProgress);
      }
      
      points.push({ x: currentX, y: currentY, z: 0, type: 'step' });
    }
  }
  
  // Ensure we end at the exact target
  points.push({ x: target.x, y: target.y, z: 0, type: 'end' });
  
  // Generate segments
  const segments = [];
  let totalDistance = 0;
  
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    
    segments.push({ start, end, type: 'step', distance });
    totalDistance += distance;
  }
  
  return {
    points,
    segments,
    totalDistance,
    type: 'zigzag'
  };
}