/**
 * Automated Dispensing Sequence - Generate optimal pad dispensing order and G-code
 */

import { applyTransform } from '../utils/transform2d.js';

export class DispensingSequencer {
  constructor() {
    this.safeHeight = 5; // mm above PCB
    this.travelSpeed = 3000; // mm/min
    this.dispensingSpeed = 600; // mm/min
  }

  calculateOptimalSequence(referencePoint, pads, config = {}) {
    if (!pads || pads.length === 0) return [];

    let expandedPads = [];
    const { enableMultiDot = true, nozzleDia = 0.8 } = config;

    if (enableMultiDot) {
      pads.forEach(pad => {
        expandedPads.push(...this.generateSubDots(pad, nozzleDia));
      });
    } else {
      expandedPads = [...pads];
    }

    // Clone pads to avoid mutating original array
    const unvisited = [...expandedPads];
    const sequence = [];
    let currentPoint = referencePoint;

    // Nearest Neighbor Greedy Algorithm
    while (unvisited.length > 0) {
      let nearestIdx = -1;
      let minDistance = Infinity;

      for (let i = 0; i < unvisited.length; i++) {
        const dist = this.calculateDistance(currentPoint, unvisited[i]);
        if (dist < minDistance) {
          minDistance = dist;
          nearestIdx = i;
        }
      }

      if (nearestIdx !== -1) {
        const nearestPad = unvisited[nearestIdx];

        sequence.push({
          ...nearestPad,
          distanceFromPrevious: minDistance,
          sequenceOrder: sequence.length + 1
        });

        currentPoint = nearestPad;
        unvisited.splice(nearestIdx, 1);
      } else {
        break; // Should not happen
      }
    }

    // --- 2-Opt TSP Optimization (removes crossing paths) ---
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < sequence.length - 1; i++) {
        for (let k = i + 1; k < sequence.length; k++) {
          let distBefore = this.calculateDistance(i === 0 ? referencePoint : sequence[i - 1], sequence[i]);
          let distAfter = this.calculateDistance(i === 0 ? referencePoint : sequence[i - 1], sequence[k]);

          if (k < sequence.length - 1) {
            distBefore += this.calculateDistance(sequence[k], sequence[k + 1]);
            distAfter += this.calculateDistance(sequence[i], sequence[k + 1]);
          }

          // If swapping these edges reduces the total distance by more than float dust
          if (distAfter < distBefore - 0.001) {
            const reversed = sequence.slice(i, k + 1).reverse();
            sequence.splice(i, k - i + 1, ...reversed);
            improved = true;
          }
        }
      }
    }

    // Recalculate properties after 2-opt reordering
    sequence.forEach((pad, index) => {
      pad.sequenceOrder = index + 1;
      pad.distanceFromPrevious = this.calculateDistance(
        index === 0 ? referencePoint : sequence[index - 1],
        pad
      );
    });

    return sequence;
  }

  /**
   * Automatically generate multiple dispensing dots for pads larger than the nozzle
   */
  generateSubDots(pad, nozzleDia) {
    if (!pad || !pad.width || !pad.height || !nozzleDia) return [pad];

    // Standard pitch: step every 1.2x nozzle diameter for good overlap
    const pitch = nozzleDia * 1.2;

    const needsSplitX = pad.width > nozzleDia * 1.8;
    const needsSplitY = pad.height > nozzleDia * 1.8;

    if (!needsSplitX && !needsSplitY) {
      return [pad];
    }

    const subDots = [];
    const countX = needsSplitX ? Math.max(2, Math.floor(pad.width / pitch)) : 1;
    const countY = needsSplitY ? Math.max(2, Math.floor(pad.height / pitch)) : 1;

    // Calculate actual span and center it within the pad
    const spanX = (countX - 1) * pitch;
    const spanY = (countY - 1) * pitch;

    const startX = pad.x - (spanX / 2);
    const startY = pad.y - (spanY / 2);

    for (let i = 0; i < countX; i++) {
      for (let j = 0; j < countY; j++) {
        subDots.push({
          ...pad,
          x: startX + (i * pitch),
          y: startY + (j * pitch),
          isSubDot: true,
          width: pitch, // shrink pressure footprint for subdots
          height: pitch,
          _originalArea: pad.width * pad.height
        });
      }
    }
    return subDots;
  }

  /**
   * Generate complete G-code for automated dispensing sequence
   * @param {Object} referencePoint - Starting point
   * @param {Array} pads - Ordered pad sequence
   * @param {Object} settings - Dispensing settings
   * @returns {String} Complete G-code for dispensing job
   */
  generateDispensingGCode(referencePoint, pads, settings = {}) {
    const {
      safeHeight = this.safeHeight,
      travelSpeed = this.travelSpeed,
      dispensingSpeed = this.dispensingSpeed,
      pressureSettings = {},
      speedSettings = {},
      xf,
      applyXf,
      toolOffset = { dx: 0, dy: 0 },
      valveOnCmd = 'M106 S255', // Default Ender-3 Fan ON
      valveOffCmd = 'M107',     // Default Ender-3 Fan OFF
      dispenseHeight = 0.5,     // mm above board to dispense
      side = 'top',             // current board side
      boardWidth = 0            // for mirroring
    } = settings;

    // Helper to transform coordinates and APPLY PHYSICAL NOZZLE OFFSET
    const transform = (pt) => {
      let mapped = { ...pt };

      // Mirror X-axis for bottom side components
      if (side === 'bottom' && boardWidth > 0) {
        mapped.x = boardWidth - mapped.x;
      }

      if (applyXf && xf) {
        mapped = applyTransform(xf, mapped);
      }
      // The nozzle is physically offset from the camera's assumed position.
      // If camera is at X:0, and nozzle is at dx:-30 (30mm to the left), 
      // to put the NOZZLE on the target, we must tell the machine to move to target - (-30) = target + 30.
      // E.g., Move machine to X:30 so the nozzle (at X-30) lands perfectly at X:0.
      // Wait, let's trace this math. If Tool is at Camera + Offset.
      // Offset dx = -30 (Needle is at -30 when camera is at 0).
      // We want Needle to be at Target (T).
      // MachinePos + Offset = T 
      // MachinePos = T - Offset
      return {
        ...mapped,
        x: mapped.x - toolOffset.dx,
        y: mapped.y - toolOffset.dy
      };
    };

    const ref = transform(referencePoint);

    let gcode = [];

    // Header and initialization
    gcode.push('; --- Automated Glue Dispensing Job ---');
    gcode.push(`; Total pads: ${pads.length}`);
    gcode.push(`; Tool Offset Applied -> DX: ${toolOffset.dx.toFixed(2)}, DY: ${toolOffset.dy.toFixed(2)}`);
    gcode.push('');
    gcode.push('G21 ; Set units to millimeters');
    gcode.push('G90 ; Absolute positioning');
    gcode.push('G28 ; Home all axes');
    gcode.push(`G1 Z${safeHeight} F${travelSpeed} ; Lift to safe travel height`);
    gcode.push('');

    // Dispense on each pad in sequence
    pads.forEach((pad, index) => {
      const p = transform(pad);
      gcode.push(`; --- Pad ${index + 1}/${pads.length} ---`);

      // Travel to pad position (safe height)
      gcode.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z${safeHeight} F${travelSpeed}`);

      // Lower to dispensing height
      gcode.push(`G1 Z${dispenseHeight} F${dispensingSpeed} ; Lower nozzle to dispense`);

      // Apply pressure and dispense
      const dwellTime = this.calculateDwellTime(pad, pressureSettings);

      gcode.push(`${valveOnCmd} ; Valve ON`);
      gcode.push(`G4 P${dwellTime} ; Dwell (dispense) for ${dwellTime}ms`);
      gcode.push(`${valveOffCmd} ; Valve OFF`);

      // Lift to safe height
      gcode.push(`G1 Z${safeHeight} F${travelSpeed} ; Retract to safe height`);
      gcode.push('');
    });

    // Return to home completely
    gcode.push('; --- Job Finished ---');
    gcode.push(`G1 X0 Y0 F${travelSpeed} ; Return home`);
    gcode.push('M84 ; Disable steppers');


    return gcode.join('\n');
  }

  /**
   * Calculate distance between two points
   */
  calculateDistance(point1, point2) {
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Calculate total dispensing job statistics
   */
  calculateJobStatistics(referencePoint, sequence) {
    let totalDistance = 0;
    let totalTime = 0; // seconds
    let currentPoint = referencePoint;

    sequence.forEach(pad => {
      const distance = this.calculateDistance(currentPoint, pad);
      totalDistance += distance;

      // Travel time + dispensing time
      const travelTime = (distance / this.travelSpeed) * 60; // convert to seconds
      const dispensingTime = 2; // estimated 2 seconds per pad
      totalTime += travelTime + dispensingTime;

      currentPoint = pad;
    });

    return {
      totalPads: sequence.length,
      totalDistance: totalDistance.toFixed(2),
      estimatedTime: Math.ceil(totalTime / 60), // minutes
      averageDistance: (totalDistance / sequence.length).toFixed(2)
    };
  }

  /**
   * Calculate pressure for specific pad based on size
   */
  calculatePadPressure(pad, pressureSettings) {
    const area = (pad.width || 1) * (pad.height || 1);
    const basePressure = pressureSettings.customPressure || 25;

    // Adjust pressure based on pad area
    if (area < 0.5) return Math.max(15, basePressure - 5);
    if (area > 2.0) return Math.min(40, basePressure + 5);
    return basePressure;
  }

  /**
   * Calculate dwell time for specific pad
   */
  calculateDwellTime(pad, pressureSettings) {
    const area = (pad.width || 1) * (pad.height || 1);
    const baseDwell = pressureSettings.customDwellTime || 120;

    // Adjust dwell time based on pad area
    if (area < 0.5) return Math.max(80, baseDwell - 20);
    if (area > 2.0) return Math.min(200, baseDwell + 30);
    return baseDwell;
  }
}