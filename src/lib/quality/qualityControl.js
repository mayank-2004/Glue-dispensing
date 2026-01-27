export class QualityController {
  constructor() {
    this.dispensingHistory = [];
    this.qualityThresholds = {
      minVolume: 0.8, // Minimum relative volume
      maxVolume: 1.2, // Maximum relative volume
      positionTolerance: 0.1, // mm
      minCoverage: 0.7 // Minimum pad coverage
    };
  }

  // Analyze dispensed paste quality
  async analyzePasteQuality(canvas, padInfo, homography) {
    if (!canvas || !padInfo || !homography) return null;

    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Project pad position to pixels
    const padPx = this.projectToPixels(padInfo.position, homography);
    if (!padPx) return null;

    // Extract pad area
    const padArea = this.extractPadArea(imageData, padPx, padInfo.size);
    
    // Analyze paste properties
    const analysis = {
      volume: this.estimateVolume(padArea),
      coverage: this.calculateCoverage(padArea, padInfo.size),
      position: this.findPasteCenter(padArea),
      uniformity: this.checkUniformity(padArea),
      timestamp: Date.now()
    };

    // Calculate quality score
    analysis.qualityScore = this.calculateQualityScore(analysis, padInfo);
    analysis.passed = analysis.qualityScore >= 0.7;

    // Store in history
    this.dispensingHistory.push({
      padId: padInfo.id,
      analysis,
      padInfo
    });

    return analysis;
  }

  // Project world coordinates to pixels
  projectToPixels(worldPos, homography) {
    const H = homography;
    const { x, y } = worldPos;
    
    const u = H[0][0]*x + H[0][1]*y + H[0][2];
    const v = H[1][0]*x + H[1][1]*y + H[1][2];
    const w = H[2][0]*x + H[2][1]*y + H[2][2];
    
    if (Math.abs(w) < 1e-9) return null;
    
    return { u: u/w, v: v/w };
  }

  // Extract pad area from image
  extractPadArea(imageData, center, padSize) {
    const { width, height, data } = imageData;
    const radiusX = (padSize.width || 1) * 10; // Approximate pixels per mm
    const radiusY = (padSize.height || 1) * 10;
    
    const x1 = Math.max(0, Math.floor(center.u - radiusX));
    const y1 = Math.max(0, Math.floor(center.v - radiusY));
    const x2 = Math.min(width, Math.ceil(center.u + radiusX));
    const y2 = Math.min(height, Math.ceil(center.v + radiusY));
    
    const areaData = [];
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        
        // Detect paste (assuming it's lighter/metallic)
        const isPaste = this.detectPaste(r, g, b);
        
        areaData.push({
          x: x - x1,
          y: y - y1,
          isPaste,
          intensity: (r + g + b) / 3
        });
      }
    }
    
    return {
      data: areaData,
      width: x2 - x1,
      height: y2 - y1,
      bounds: { x1, y1, x2, y2 }
    };
  }

  // Detect paste in pixel (simple color-based detection)
  detectPaste(r, g, b) {
    // Paste is typically metallic/silver - high intensity, low color variation
    const intensity = (r + g + b) / 3;
    const colorVariation = Math.max(Math.abs(r - intensity), Math.abs(g - intensity), Math.abs(b - intensity));
    
    return intensity > 150 && colorVariation < 30;
  }

  // Estimate paste volume
  estimateVolume(padArea) {
    const pastePixels = padArea.data.filter(p => p.isPaste).length;
    const totalPixels = padArea.data.length;
    
    // Simple volume estimation based on coverage
    const coverage = pastePixels / totalPixels;
    return coverage; // Normalized volume (0-1)
  }

  // Calculate pad coverage
  calculateCoverage(padArea, padSize) {
    const pastePixels = padArea.data.filter(p => p.isPaste);
    const totalPadPixels = padArea.width * padArea.height;
    
    return pastePixels.length / totalPadPixels;
  }

  // Find center of paste blob
  findPasteCenter(padArea) {
    const pastePixels = padArea.data.filter(p => p.isPaste);
    
    if (pastePixels.length === 0) return null;
    
    const sumX = pastePixels.reduce((sum, p) => sum + p.x, 0);
    const sumY = pastePixels.reduce((sum, p) => sum + p.y, 0);
    
    return {
      x: sumX / pastePixels.length,
      y: sumY / pastePixels.length
    };
  }

  // Check paste uniformity
  checkUniformity(padArea) {
    const pastePixels = padArea.data.filter(p => p.isPaste);
    
    if (pastePixels.length === 0) return 0;
    
    const intensities = pastePixels.map(p => p.intensity);
    const mean = intensities.reduce((sum, i) => sum + i, 0) / intensities.length;
    const variance = intensities.reduce((sum, i) => sum + Math.pow(i - mean, 2), 0) / intensities.length;
    const stdDev = Math.sqrt(variance);
    
    // Uniformity score (lower std dev = more uniform)
    return Math.max(0, 1 - (stdDev / mean));
  }

  // Calculate overall quality score
  calculateQualityScore(analysis, padInfo) {
    let score = 0;
    let weights = 0;
    
    // Volume score
    if (analysis.volume >= this.qualityThresholds.minVolume && 
        analysis.volume <= this.qualityThresholds.maxVolume) {
      score += 0.3;
    }
    weights += 0.3;
    
    // Coverage score
    if (analysis.coverage >= this.qualityThresholds.minCoverage) {
      score += 0.3;
    }
    weights += 0.3;
    
    // Uniformity score
    score += analysis.uniformity * 0.2;
    weights += 0.2;
    
    // Position accuracy (if paste center detected)
    if (analysis.position) {
      const centerX = padInfo.size.width / 2;
      const centerY = padInfo.size.height / 2;
      const posError = Math.hypot(
        analysis.position.x - centerX,
        analysis.position.y - centerY
      );
      
      if (posError <= this.qualityThresholds.positionTolerance * 10) { // Convert to pixels
        score += 0.2;
      }
      weights += 0.2;
    }
    
    return weights > 0 ? score / weights : 0;
  }

  // Get quality statistics
  getQualityStats() {
    if (this.dispensingHistory.length === 0) return null;
    
    const recent = this.dispensingHistory.slice(-50); // Last 50 dispenses
    const passed = recent.filter(h => h.analysis.passed).length;
    const avgScore = recent.reduce((sum, h) => sum + h.analysis.qualityScore, 0) / recent.length;
    
    return {
      totalDispenses: this.dispensingHistory.length,
      recentDispenses: recent.length,
      passRate: passed / recent.length,
      averageScore: avgScore,
      lastUpdate: Date.now()
    };
  }

  // Clear history
  clearHistory() {
    this.dispensingHistory = [];
  }

  // Update quality thresholds
  updateThresholds(newThresholds) {
    this.qualityThresholds = { ...this.qualityThresholds, ...newThresholds };
  }
}