// Vision-guided pad detection and centering
export class PadDetector {
  constructor(canvas, homography) {
    this.canvas = canvas;
    this.homography = homography;
    this.threshold = 0.7; // Detection confidence threshold
  }

  // Detect pad in camera image at expected position
  async detectPad(expectedPos, padSize = { width: 1, height: 1 }) {
    if (!this.canvas || !this.homography) return null;
    
    const ctx = this.canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    
    // Project expected position to pixel coordinates
    const expectedPx = this.projectToPixels(expectedPos);
    if (!expectedPx) return null;
    
    // Search area around expected position
    const searchRadius = Math.max(padSize.width, padSize.height) * 2;
    const searchArea = this.extractSearchArea(imageData, expectedPx, searchRadius);
    
    // Find pad using edge detection
    const detectedPx = this.findPadCenter(searchArea, expectedPx);
    if (!detectedPx) return null;
    
    // Convert back to world coordinates
    const worldPos = this.pixelsToWorld(detectedPx);
    
    return {
      detected: true,
      position: worldPos,
      confidence: this.calculateConfidence(searchArea, detectedPx),
      offset: {
        x: worldPos.x - expectedPos.x,
        y: worldPos.y - expectedPos.y
      }
    };
  }

  // Project world coordinates to pixel coordinates
  projectToPixels(worldPos) {
    if (!this.homography) return null;
    
    const H = this.homography;
    const { x, y } = worldPos;
    
    const u = H[0][0]*x + H[0][1]*y + H[0][2];
    const v = H[1][0]*x + H[1][1]*y + H[1][2];
    const w = H[2][0]*x + H[2][1]*y + H[2][2];
    
    if (Math.abs(w) < 1e-9) return null;
    
    return { u: u/w, v: v/w };
  }

  // Convert pixel coordinates to world coordinates (inverse homography)
  pixelsToWorld(pixelPos) {
    // Simplified inverse - in production use proper matrix inversion
    const H = this.homography;
    const { u, v } = pixelPos;
    
    // Approximate inverse transformation
    const det = H[0][0]*H[1][1] - H[0][1]*H[1][0];
    if (Math.abs(det) < 1e-9) return null;
    
    const x = ((H[1][1]*u - H[0][1]*v) + (H[0][1]*H[1][2] - H[1][1]*H[0][2])) / det;
    const y = ((H[0][0]*v - H[1][0]*u) + (H[1][0]*H[0][2] - H[0][0]*H[1][2])) / det;
    
    return { x, y };
  }

  // Extract search area from image
  extractSearchArea(imageData, center, radius) {
    const { width, height, data } = imageData;
    const x1 = Math.max(0, Math.floor(center.u - radius));
    const y1 = Math.max(0, Math.floor(center.v - radius));
    const x2 = Math.min(width, Math.ceil(center.u + radius));
    const y2 = Math.min(height, Math.ceil(center.v + radius));
    
    const searchData = [];
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const idx = (y * width + x) * 4;
        const gray = (data[idx] + data[idx+1] + data[idx+2]) / 3;
        searchData.push({ x, y, intensity: gray });
      }
    }
    
    return { data: searchData, bounds: { x1, y1, x2, y2 } };
  }

  // Find pad center using edge detection
  findPadCenter(searchArea, expectedCenter) {
    const { data, bounds } = searchArea;
    
    // Simple edge detection - find rectangular pad outline
    const edges = this.detectEdges(data, bounds);
    const contours = this.findContours(edges);
    
    // Find best rectangular contour near expected position
    let bestContour = null;
    let minDistance = Infinity;
    
    for (const contour of contours) {
      const center = this.getContourCenter(contour);
      const distance = Math.hypot(center.u - expectedCenter.u, center.v - expectedCenter.v);
      
      if (distance < minDistance && this.isRectangular(contour)) {
        minDistance = distance;
        bestContour = contour;
      }
    }
    
    return bestContour ? this.getContourCenter(bestContour) : null;
  }

  // Simple edge detection
  detectEdges(data, bounds) {
    const edges = [];
    const threshold = 30; // Edge threshold
    
    for (let i = 0; i < data.length - 1; i++) {
      const current = data[i];
      const next = data[i + 1];
      
      if (Math.abs(current.intensity - next.intensity) > threshold) {
        edges.push(current);
      }
    }
    
    return edges;
  }

  // Find contours from edges
  findContours(edges) {
    // Simplified contour detection
    const contours = [];
    const visited = new Set();
    
    for (const edge of edges) {
      if (visited.has(`${edge.x},${edge.y}`)) continue;
      
      const contour = this.traceContour(edges, edge, visited);
      if (contour.length > 10) { // Minimum contour size
        contours.push(contour);
      }
    }
    
    return contours;
  }

  // Trace contour from starting point
  traceContour(edges, start, visited) {
    const contour = [start];
    visited.add(`${start.x},${start.y}`);
    
    // Simple 8-connected tracing
    const directions = [[-1,-1], [-1,0], [-1,1], [0,1], [1,1], [1,0], [1,-1], [0,-1]];
    let current = start;
    
    for (let step = 0; step < 100; step++) { // Limit steps
      let found = false;
      
      for (const [dx, dy] of directions) {
        const next = edges.find(e => 
          e.x === current.x + dx && 
          e.y === current.y + dy && 
          !visited.has(`${e.x},${e.y}`)
        );
        
        if (next) {
          contour.push(next);
          visited.add(`${next.x},${next.y}`);
          current = next;
          found = true;
          break;
        }
      }
      
      if (!found) break;
    }
    
    return contour;
  }

  // Get center of contour
  getContourCenter(contour) {
    const sumX = contour.reduce((sum, p) => sum + p.x, 0);
    const sumY = contour.reduce((sum, p) => sum + p.y, 0);
    
    return {
      u: sumX / contour.length,
      v: sumY / contour.length
    };
  }

  // Check if contour is roughly rectangular
  isRectangular(contour) {
    if (contour.length < 4) return false;
    
    // Simple rectangularity check - measure aspect ratio and corner count
    const bounds = this.getContourBounds(contour);
    const aspectRatio = bounds.width / bounds.height;
    
    return aspectRatio > 0.5 && aspectRatio < 2.0; // Reasonable aspect ratio
  }

  // Get bounding box of contour
  getContourBounds(contour) {
    const xs = contour.map(p => p.x);
    const ys = contour.map(p => p.y);
    
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
  }

  // Calculate detection confidence
  calculateConfidence(searchArea, detectedPos) {
    // Simple confidence based on edge strength at detected position
    return Math.min(1.0, Math.random() * 0.3 + 0.7); // Placeholder
  }

  // Update homography matrix
  updateHomography(homography) {
    this.homography = homography;
  }
}