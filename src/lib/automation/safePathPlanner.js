import { applyTransform } from '../utils/transform2d.js';

export class SafePathPlanner {
  constructor(options = {}) {
    this.safeHeight = options.safeHeight || 5;
  }

  calculateSafeSequence(referencePoint, pads) {
    if (!pads || pads.length === 0) return [];

    const sequence = [];
    let currentPoint = referencePoint;

    // Process pads in order (Linear Sequence)
    pads.forEach((pad) => {
      // Always generate a safe path (Lift -> Move -> Lower)
      // This guarantees no collisions with components between pads
      const safePath = this.generateSafePath(currentPoint, pad);

      sequence.push({
        ...pad,
        safePath,
        pathDistance: safePath.totalDistance,
        sequenceOrder: sequence.length + 1,
        requiresHighClearance: false // Default to standard safe height
      });

      currentPoint = pad;
    });

    return sequence;
  }

  /**
   * Generate safe 3D path with proper Z-movements
   * Logic: Lift -> Travel -> Lower (Safe Cartesian Linear Interpolation)
   */
  generateSafePath(start, end) {
    const requiredHeight = this.safeHeight;
    const segments = [];
    let totalDistance = 0;

    // 1. Lift to safe height at start
    // G1 Z<safeHeight>
    segments.push({
      type: 'lift',
      start: { x: start.x, y: start.y, z: 0 },
      end: { x: start.x, y: start.y, z: requiredHeight },
      distance: requiredHeight
    });
    totalDistance += requiredHeight;

    // 2. Travel at safe height
    // G1 X<target> Y<target>
    const travelDistance = this.calculateDistance(start, end);
    segments.push({
      type: 'travel',
      start: { x: start.x, y: start.y, z: requiredHeight },
      end: { x: end.x, y: end.y, z: requiredHeight },
      distance: travelDistance
    });
    totalDistance += travelDistance;

    // 3. Lower to dispensing height at target
    // G1 Z0.1
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
      pathType: 'normal'
    };
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
   * Generate G-code for safe path sequence
   */
  generateSafeGCode(referencePoint, safeSequence, settings = {}) {
    const { xf, applyXf } = settings;

    // Helper to transform coordinates
    const transform = (pt) => {
      if (applyXf && xf) {
        return applyTransform(xf, pt);
      }
      return pt;
    };

    const gcode = [];

    gcode.push('; Safe Path Dispensing Job');
    gcode.push(`; Total pads: ${safeSequence.length}`);
    gcode.push(`; Safe height: ${this.safeHeight}mm`);
    gcode.push('');
    gcode.push('G21 ; Set units to millimeters');
    gcode.push('G90 ; Absolute positioning');
    gcode.push('G28 ; Home all axes');
    gcode.push(`G1 Z${this.safeHeight} F3000 ; Move to safe height`);
    gcode.push('');

    // Process each pad in safe sequence
    safeSequence.forEach((pad, index) => {
      gcode.push(`; Pad ${pad.sequenceOrder}/${safeSequence.length} - ${pad.id || 'Unknown'}`);

      // Execute each path segment (Lift, Travel, Lower)
      pad.safePath.segments.forEach(segment => {
        const speed = segment.type === 'travel' ? 3000 : 1000;

        // Transform the end point (target) of the segment
        const target = transform(segment.end);

        // Optimization: Use G1 for all moves (Cartesian Linear Interpolation)
        gcode.push(`G1 X${target.x.toFixed(3)} Y${target.y.toFixed(3)} Z${target.z !== undefined ? target.z.toFixed(3) : segment.end.z.toFixed(3)} F${speed}`);
      });

      // Dispense
      gcode.push('M42 P4 S25 ; Start dispensing');
      gcode.push('G4 P120 ; Dwell 120ms');
      gcode.push('M42 P4 S0 ; Stop dispensing');
      gcode.push('');
    });

    gcode.push(`G1 Z${this.safeHeight} F3000 ; Lift before home`);
    gcode.push('G28 ; Return home');
    gcode.push('M84 ; Disable steppers');

    return gcode.join('\n');
  }

  /**
   * Calculate total dispensing job statistics
   */
  calculateJobStatistics(referencePoint, sequence) {
    if (!sequence || sequence.length === 0) return null;

    let totalDistance = 0;
    let totalTime = 0; // seconds
    let safePathsUsed = 0;
    let highClearancePaths = 0;

    // Initial move from reference to first pad (Lift + Travel + Lower) is already in sequence[0].safePath
    // But we need to account for it. 
    // In our calculateSafeSequence, we generated safePaths for every transition.

    sequence.forEach(pad => {
      // Use the pre-calculated path distance from the safe path
      const distance = pad.pathDistance || 0;
      totalDistance += distance;

      // Travel time (approximate based on feed rates)
      // Low Z Speed (Lift/Lower) ~ 1000mm/min
      // High XY Speed (Travel) ~ 3000mm/min
      // Simplified: average speed check

      let padTime = 0;
      pad.safePath.segments.forEach(seg => {
        const speed = seg.type === 'travel' ? 3000 : 1000;
        padTime += (seg.distance / speed) * 60;
      });

      // Dispensing time (dwell)
      padTime += 2; // 2 seconds dwell + overhead

      totalTime += padTime;

      // Count path types
      safePathsUsed++;
      if (pad.requiresHighClearance) highClearancePaths++;
    });

    // Return to home time (approx)
    // Lift + Travel back to origin + Home
    totalTime += 5;

    return {
      totalPads: sequence.length,
      totalDistance: totalDistance.toFixed(2),
      estimatedTime: Math.ceil(totalTime / 60), // minutes
      averageDistance: (totalDistance / sequence.length).toFixed(2),
      safePathsUsed,
      highClearancePaths
    };
  }
}