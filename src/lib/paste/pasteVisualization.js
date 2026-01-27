/**
 * PasteVisualizer - Calculates optimal paste dispensing dot patterns within pad boundaries
 */
export class PasteVisualizer {
  constructor(nozzleDiameter = 0.6) {
    this.nozzleDiameter = nozzleDiameter;
  }

  /**
   * Calculate optimal dot pattern for a pad
   * @param {Object} pad - Pad with x, y, width, height properties
   * @param {number} nozzleDiameter - Nozzle diameter in mm
   * @returns {Array} Array of dot positions with x, y coordinates
   */
  calculateDotPattern(pad, nozzleDiameter = this.nozzleDiameter) {
    const padWidth = pad.width || 1.0;
    const padHeight = pad.height || 1.0;
    
    // Keep dots smaller than pad with safety margin
    const safetyMargin = nozzleDiameter * 0.2;
    const safeWidth = Math.max(0.1, padWidth - safetyMargin);
    const safeHeight = Math.max(0.1, padHeight - safetyMargin);
    
    // For small pads, use single center dot
    if (padWidth < nozzleDiameter || padHeight < nozzleDiameter) {
      return [{ x: pad.x, y: pad.y, type: 'center' }];
    }
    
    // Calculate dots with proper spacing
    const dotSpacing = nozzleDiameter * 0.7;
    const dotsX = Math.max(1, Math.floor(safeWidth / dotSpacing) + 1);
    const dotsY = Math.max(1, Math.floor(safeHeight / dotSpacing) + 1);
    
    const dots = [];
    
    // Single dot for very small areas
    if (dotsX === 1 && dotsY === 1) {
      return [{ x: pad.x, y: pad.y, type: 'center' }];
    }
    
    // Calculate spacing to fit within safe area
    const spacingX = dotsX > 1 ? safeWidth / (dotsX - 1) : 0;
    const spacingY = dotsY > 1 ? safeHeight / (dotsY - 1) : 0;
    
    // Generate centered dot grid
    for (let i = 0; i < dotsX; i++) {
      for (let j = 0; j < dotsY; j++) {
        const dotX = pad.x - safeWidth/2 + (dotsX > 1 ? i * spacingX : 0);
        const dotY = pad.y - safeHeight/2 + (dotsY > 1 ? j * spacingY : 0);
        
        dots.push({
          x: dotX,
          y: dotY,
          type: 'paste',
          order: dots.length + 1
        });
      }
    }
    
    return dots;
  }

  /**
   * Get paste coverage percentage for a pad
   * @param {Object} pad - Pad object
   * @param {number} nozzleDiameter - Nozzle diameter
   * @returns {number} Coverage percentage (0-100)
   */
  getCoverage(pad, nozzleDiameter = this.nozzleDiameter) {
    const dots = this.calculateDotPattern(pad, nozzleDiameter);
    const dotArea = Math.PI * Math.pow(nozzleDiameter / 2, 2);
    const totalDotArea = dots.length * dotArea;
    const padArea = (pad.width || 1.0) * (pad.height || 1.0);
    
    return Math.min(100, (totalDotArea / padArea) * 100);
  }
}