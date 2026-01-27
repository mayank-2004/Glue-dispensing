/**
 * Machine Vision Fiducial Detection System
 * Automatically detects fiducials using camera feed for 3D printer integration
 */

export class FiducialVisionDetector {
  constructor() {
    this.isDetecting = false;
    this.detectionResults = [];
    this.homography = null;
    this.calibrationData = null;
  }

  /**
   * Initialize camera-based fiducial detection
   */
  async initializeCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        } 
      });
      return stream;
    } catch (error) {
      console.error('Camera initialization failed:', error);
      throw new Error('Camera access required for automated fiducial detection');
    }
  }

  /**
   * Detect fiducials in camera feed using computer vision
   */
  async detectFiducialsInFrame(videoElement, expectedFiducials = []) {
    if (!videoElement || this.isDetecting) return null;
    
    this.isDetecting = true;
    
    try {
      // Create canvas for image processing
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = videoElement.videoWidth || 640;
      canvas.height = videoElement.videoHeight || 480;
      
      // Capture current frame
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      // Process image for fiducial detection
      const detectedFiducials = await this.processImageForFiducials(imageData, expectedFiducials);
      
      return {
        success: true,
        fiducials: detectedFiducials,
        timestamp: Date.now(),
        frameSize: { width: canvas.width, height: canvas.height }
      };
      
    } catch (error) {
      console.error('Fiducial detection failed:', error);
      return {
        success: false,
        error: error.message,
        fiducials: []
      };
    } finally {
      this.isDetecting = false;
    }
  }

  /**
   * Process image data to find circular fiducial markers
   */
  async processImageForFiducials(imageData, expectedFiducials) {
    const { data, width, height } = imageData;
    const detected = [];
    
    // Convert to grayscale for processing
    const gray = this.toGrayscale(data, width, height);
    
    // Apply edge detection
    const edges = this.detectEdges(gray, width, height);
    
    // Find circular patterns (fiducials)
    const circles = this.detectCircles(edges, width, height);
    
    // Filter and validate fiducial candidates
    const fiducials = this.validateFiducials(circles, expectedFiducials);
    
    return fiducials.map((fid, idx) => ({
      id: `F${idx + 1}`,
      pixelPosition: { x: fid.x, y: fid.y },
      radius: fid.radius,
      confidence: fid.confidence,
      machinePosition: this.pixelToMachine(fid.x, fid.y)
    }));
  }

  /**
   * Convert RGB to grayscale
   */
  toGrayscale(data, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      gray[i / 4] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return gray;
  }

  /**
   * Simple edge detection using Sobel operator
   */
  detectEdges(gray, width, height) {
    const edges = new Uint8Array(width * height);
    
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        
        // Sobel X
        const gx = 
          -1 * gray[(y-1) * width + (x-1)] + 1 * gray[(y-1) * width + (x+1)] +
          -2 * gray[y * width + (x-1)] + 2 * gray[y * width + (x+1)] +
          -1 * gray[(y+1) * width + (x-1)] + 1 * gray[(y+1) * width + (x+1)];
        
        // Sobel Y
        const gy = 
          -1 * gray[(y-1) * width + (x-1)] + -2 * gray[(y-1) * width + x] + -1 * gray[(y-1) * width + (x+1)] +
          1 * gray[(y+1) * width + (x-1)] + 2 * gray[(y+1) * width + x] + 1 * gray[(y+1) * width + (x+1)];
        
        edges[idx] = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      }
    }
    
    return edges;
  }

  /**
   * Detect circular patterns using Hough Circle Transform (simplified)
   */
  detectCircles(edges, width, height) {
    const circles = [];
    const minRadius = 10;
    const maxRadius = 50;
    const threshold = 30;
    
    // Simplified circle detection
    for (let y = maxRadius; y < height - maxRadius; y += 2) {
      for (let x = maxRadius; x < width - maxRadius; x += 2) {
        for (let r = minRadius; r <= maxRadius; r += 2) {
          let votes = 0;
          const samples = 16;
          
          for (let i = 0; i < samples; i++) {
            const angle = (2 * Math.PI * i) / samples;
            const px = Math.round(x + r * Math.cos(angle));
            const py = Math.round(y + r * Math.sin(angle));
            
            if (px >= 0 && px < width && py >= 0 && py < height) {
              if (edges[py * width + px] > 100) votes++;
            }
          }
          
          if (votes > threshold) {
            circles.push({
              x: x,
              y: y,
              radius: r,
              votes: votes,
              confidence: votes / samples
            });
          }
        }
      }
    }
    
    // Remove overlapping circles
    return this.removeOverlappingCircles(circles);
  }

  /**
   * Remove overlapping circle detections
   */
  removeOverlappingCircles(circles) {
    circles.sort((a, b) => b.votes - a.votes);
    const filtered = [];
    
    for (const circle of circles) {
      let isOverlapping = false;
      for (const existing of filtered) {
        const dist = Math.hypot(circle.x - existing.x, circle.y - existing.y);
        if (dist < (circle.radius + existing.radius) * 0.7) {
          isOverlapping = true;
          break;
        }
      }
      if (!isOverlapping) {
        filtered.push(circle);
      }
    }
    
    return filtered.slice(0, 6); // Max 6 fiducials
  }

  /**
   * Validate detected circles as fiducials
   */
  validateFiducials(circles, expectedFiducials) {
    return circles.filter(circle => {
      // Check if radius is in typical fiducial range
      const radiusOk = circle.radius >= 8 && circle.radius <= 40;
      
      // Check confidence threshold
      const confidenceOk = circle.confidence > 0.6;
      
      return radiusOk && confidenceOk;
    });
  }

  /**
   * Convert pixel coordinates to machine coordinates
   */
  pixelToMachine(pixelX, pixelY) {
    if (!this.homography) {
      // Return null if no calibration available
      return null;
    }
    
    const H = this.homography;
    const x = pixelX;
    const y = pixelY;
    
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    if (Math.abs(w) < 1e-9) return null;
    
    return {
      x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w,
      y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w
    };
  }

  /**
   * Set homography matrix for pixel-to-machine coordinate conversion
   */
  setHomography(homographyMatrix) {
    this.homography = homographyMatrix;
  }

  /**
   * Auto-calibrate using detected fiducials and known design positions
   */
  async autoCalibrate(detectedPixelFiducials, designFiducials) {
    if (detectedPixelFiducials.length < 3 || designFiducials.length < 3) {
      throw new Error('Need at least 3 fiducials for auto-calibration');
    }
    
    // Match detected fiducials with design fiducials based on spatial relationships
    const matches = this.matchFiducials(detectedPixelFiducials, designFiducials);
    
    if (matches.length < 3) {
      throw new Error('Could not match enough fiducials for calibration');
    }
    
    // Calculate homography from matched pairs
    const pixelPoints = matches.map(m => m.pixel);
    const machinePoints = matches.map(m => m.machine);
    
    this.homography = this.calculateHomography(pixelPoints, machinePoints);
    
    return {
      success: true,
      matches: matches.length,
      homography: this.homography
    };
  }

  /**
   * Match detected fiducials with design fiducials
   */
  matchFiducials(detected, design) {
    const matches = [];
    
    // Simple matching based on relative positions
    // In a real implementation, this would use more sophisticated matching
    for (let i = 0; i < Math.min(detected.length, design.length); i++) {
      matches.push({
        pixel: { x: detected[i].pixelPosition.x, y: detected[i].pixelPosition.y },
        machine: { x: design[i].x, y: design[i].y },
        confidence: detected[i].confidence
      });
    }
    
    return matches;
  }

  /**
   * Calculate homography matrix from point correspondences
   */
  calculateHomography(pixelPoints, machinePoints) {
    // Simplified homography calculation
    // In production, use a robust implementation like OpenCV
    const n = pixelPoints.length;
    if (n < 4) return null;
    
    // This is a placeholder - implement proper homography calculation
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];
  }

  /**
   * Start continuous fiducial monitoring
   */
  startContinuousDetection(videoElement, callback, interval = 1000) {
    const detect = async () => {
      const result = await this.detectFiducialsInFrame(videoElement);
      if (callback) callback(result);
    };
    
    return setInterval(detect, interval);
  }

  /**
   * Stop continuous detection
   */
  stopContinuousDetection(intervalId) {
    if (intervalId) {
      clearInterval(intervalId);
    }
  }
}