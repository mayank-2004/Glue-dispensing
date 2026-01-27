/**
 * Safe Path Planning - Collision-aware dispensing sequence with safe Z-height navigation
 */

export class SafePathPlanner {
  constructor(options = {}) {
    this.safeHeight = options.safeHeight || 5; // mm above highest component
    this.clearanceHeight = options.clearanceHeight || 2; // mm clearance above components
    this.boardBounds = options.boardBounds || null;
    this.componentHeights = options.componentHeights || new Map(); // pad_id -> height
  }

  /**
   * Calculate safe dispensing sequence with collision avoidance
   * @param {Object} referencePoint - Starting point {x, y}
   * @param {Array} pads - Array of pad objects
   * @param {Object} boardOutline - PCB dimensions
   * @param {Array} components - Component height data
   * @returns {Array} Safe dispensing sequence with path information
   */
  calculateSafeSequence(referencePoint, pads, boardOutline, components = []) {
    if (!pads || pads.length === 0) return [];
    
    this.boardBounds = boardOutline;
    this.updateComponentHeights(components);
    
    const unvisited = [...pads];
    const sequence = [];
    let currentPoint = referencePoint;

    while (unvisited.length > 0) {
      // Find nearest pad with safe path consideration
      const nextPad = this.findNearestSafePad(currentPoint, unvisited);
      
      if (!nextPad) {
        // If no safe path found, take nearest and use high clearance
        const nearestPad = this.findNearestPad(currentPoint, unvisited);
        const safePath = this.generateSafePath(currentPoint, nearestPad, true);
        
        sequence.push({
          ...nearestPad,
          safePath,
          pathDistance: safePath.totalDistance,
          sequenceOrder: sequence.length + 1,
          requiresHighClearance: true
        });
        
        unvisited.splice(unvisited.indexOf(nearestPad), 1);
        currentPoint = nearestPad;
      } else {
        const safePath = this.generateSafePath(currentPoint, nextPad.pad);
        
        sequence.push({
          ...nextPad.pad,
          safePath,
          pathDistance: safePath.totalDistance,
          sequenceOrder: sequence.length + 1,
          requiresHighClearance: false
        });
        
        unvisited.splice(unvisited.indexOf(nextPad.pad), 1);
        currentPoint = nextPad.pad;
      }
    }

    return sequence;
  }

  /**
   * Find nearest pad that has a safe path (no high components in between)
   */
  findNearestSafePad(currentPoint, unvisited) {
    let bestPad = null;
    let minSafeDistance = Infinity;

    for (const pad of unvisited) {
      const pathInfo = this.analyzePath(currentPoint, pad);
      
      if (pathInfo.isSafe) {
        const distance = pathInfo.distance;
        if (distance < minSafeDistance) {
          minSafeDistance = distance;
          bestPad = { pad, pathInfo };
        }
      }
    }

    return bestPad;
  }

  /**
   * Find nearest pad (fallback when no safe path available)
   */
  findNearestPad(currentPoint, unvisited) {
    let nearest = unvisited[0];
    let minDistance = this.calculateDistance(currentPoint, nearest);

    for (let i = 1; i < unvisited.length; i++) {
      const distance = this.calculateDistance(currentPoint, unvisited[i]);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = unvisited[i];
      }
    }

    return nearest;
  }

  /**
   * Analyze path between two points for obstacles
   */
  analyzePath(start, end) {
    const distance = this.calculateDistance(start, end);
    const pathSegments = this.discretizePath(start, end, 0.5); // 0.5mm segments
    
    let maxHeightOnPath = 0;
    let hasObstacles = false;

    // Check each segment for component heights
    for (const segment of pathSegments) {
      const heightAtPoint = this.getHeightAtPoint(segment);
      maxHeightOnPath = Math.max(maxHeightOnPath, heightAtPoint);
      
      if (heightAtPoint > this.clearanceHeight) {
        hasObstacles = true;
      }
    }

    return {
      distance,
      maxHeight: maxHeightOnPath,
      isSafe: !hasObstacles,
      requiresClearance: maxHeightOnPath + this.clearanceHeight
    };
  }

  /**
   * Generate safe 3D path with proper Z-movements
   */
  generateSafePath(start, end, forceHighClearance = false) {
    const pathAnalysis = this.analyzePath(start, end);
    const requiredHeight = forceHighClearance ? 
      this.safeHeight : 
      Math.max(this.clearanceHeight, pathAnalysis.requiresClearance);

    const segments = [];
    let totalDistance = 0;

    // 1. Lift to safe height at start
    segments.push({
      type: 'lift',
      start: { x: start.x, y: start.y, z: 0 },
      end: { x: start.x, y: start.y, z: requiredHeight },
      distance: requiredHeight
    });
    totalDistance += requiredHeight;

    // 2. Travel at safe height
    const travelDistance = this.calculateDistance(start, end);
    segments.push({
      type: 'travel',
      start: { x: start.x, y: start.y, z: requiredHeight },
      end: { x: end.x, y: end.y, z: requiredHeight },
      distance: travelDistance
    });
    totalDistance += travelDistance;

    // 3. Lower to dispensing height at target
    segments.push({
      type: 'lower',
      start: { x: end.x, y: end.y, z: requiredHeight },
      end: { x: end.x, y: end.y, z: 0.1 }, // 0.1mm dispensing height
      distance: requiredHeight - 0.1
    });
    totalDistance += (requiredHeight - 0.1);

    return {
      segments,
      totalDistance,
      safeHeight: requiredHeight,
      pathType: forceHighClearance ? 'high_clearance' : 'normal'
    };
  }

  /**
   * Break path into small segments for collision checking
   */
  discretizePath(start, end, stepSize = 0.5) {
    const segments = [];
    const distance = this.calculateDistance(start, end);
    const steps = Math.ceil(distance / stepSize);
    
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      segments.push({ x, y });
    }
    
    return segments;
  }

  /**
   * Get component height at specific point (simplified - assumes circular component areas)
   */
  getHeightAtPoint(point) {
    let maxHeight = 0;
    
    // Check against known component heights
    for (const [padId, height] of this.componentHeights) {
      // Simplified: assume 2mm radius around each pad has component height
      const pad = this.findPadById(padId);
      if (pad) {
        const distance = this.calculateDistance(point, pad);
        if (distance <= 2.0) { // 2mm component radius
          maxHeight = Math.max(maxHeight, height);
        }
      }
    }
    
    return maxHeight;
  }

  /**
   * Update component height database
   */
  updateComponentHeights(components) {
    this.componentHeights.clear();
    
    components.forEach(comp => {
      if (comp.height && comp.padId) {
        this.componentHeights.set(comp.padId, comp.height);
      }
    });
  }

  /**
   * Calculate Euclidean distance between two points
   */
  calculateDistance(point1, point2) {
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Find pad by ID (helper function)
   */
  findPadById(padId) {
    // This would need to be connected to the main pad array
    // For now, return null - should be implemented based on your pad structure
    return null;
  }

  /**
   * Generate G-code for safe path sequence
   */
  generateSafeGCode(referencePoint, safeSequence, settings = {}) {
    const gcode = [];
    
    gcode.push('; Safe Path Dispensing Job with Collision Avoidance');
    gcode.push(`; Total pads: ${safeSequence.length}`);
    gcode.push(`; Safe height: ${this.safeHeight}mm`);
    gcode.push('');
    gcode.push('G21 ; Set units to millimeters');
    gcode.push('G90 ; Absolute positioning');
    gcode.push('G28 ; Home all axes');
    gcode.push('');

    // Process each pad in safe sequence
    safeSequence.forEach((pad, index) => {
      gcode.push(`; Pad ${index + 1}/${safeSequence.length} - ${pad.id || 'Unknown'}`);
      gcode.push(`; Path type: ${pad.safePath.pathType}`);
      gcode.push(`; Safe height: ${pad.safePath.safeHeight}mm`);
      
      // Execute each path segment
      pad.safePath.segments.forEach(segment => {
        const speed = segment.type === 'travel' ? 3000 : 1000;
        gcode.push(`G1 X${segment.end.x.toFixed(3)} Y${segment.end.y.toFixed(3)} Z${segment.end.z.toFixed(3)} F${speed}`);
      });
      
      // Dispense
      gcode.push('M42 P4 S25 ; Start dispensing');
      gcode.push('G4 P120 ; Dwell 120ms');
      gcode.push('M42 P4 S0 ; Stop dispensing');
      gcode.push('');
    });

    gcode.push('G28 ; Return home');
    gcode.push('M84 ; Disable steppers');
    
    return gcode.join('\n');
  }
}