export class FiducialVisionDetector {
  constructor() {
    this.isDetecting = false;
    this.homography = null;
  }

  async detectFiducialsInFrame(videoElement, _expectedFiducials = [], options = {}) {
    if (!videoElement || this.isDetecting) return { success: false };

    this.isDetecting = true;
    const pxPerMm = options.pxPerMm || 20;

    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const cw = videoElement.clientWidth || videoElement.videoWidth || 640;
      const ch = videoElement.clientHeight || videoElement.videoHeight || 480;
      canvas.width = cw;
      canvas.height = ch;

      const vw = videoElement.videoWidth || cw;
      const vh = videoElement.videoHeight || ch;

      // Simulate CSS object-fit: cover so vision coordinates perfectly match UI CSS coordinates
      const videoRatio = vw / vh;
      const containerRatio = cw / ch;

      let drawW = vw;
      let drawH = vh;
      let startX = 0;
      let startY = 0;

      if (videoRatio > containerRatio) {
        // Video is proportionally wider than the container, crop sides
        drawH = vh;
        drawW = vh * containerRatio;
        startX = (vw - drawW) / 2;
      } else {
        // Video is proportionally taller, crop top/bottom
        drawW = vw;
        drawH = vw / containerRatio;
        startY = (vh - drawH) / 2;
      }

      ctx.drawImage(videoElement, startX, startY, drawW, drawH, 0, 0, cw, ch);
      
      // Check if OpenCV is loaded
      if (!window.cv || typeof window.cv.Mat !== 'function') {
        console.warn('OpenCV.js is not loaded yet');
        return { success: false, error: 'OpenCV not loaded' };
      }

      // --- CENTER ROI EXTRACTION ---
      // Instead of scanning the full frame (which detects circles anywhere including corners),
      // we extract only a center crop to ensure HoughCircles can only find features
      // that are directly under the camera crosshair.
      const roiSize = Math.floor(Math.min(cw, ch) * 0.5); // 50% of shortest dimension
      const roiX = Math.floor((cw - roiSize) / 2);
      const roiY = Math.floor((ch - roiSize) / 2);

      const fullSrc = window.cv.imread(canvas);
      const fullGray = new window.cv.Mat();
      window.cv.cvtColor(fullSrc, fullGray, window.cv.COLOR_RGBA2GRAY, 0);

      // Crop to center ROI only
      const roiRect = new window.cv.Rect(roiX, roiY, roiSize, roiSize);
      const roiGray = fullGray.roi(roiRect);

      const blurred = new window.cv.Mat();
      window.cv.medianBlur(roiGray, blurred, 5);

      const circles = new window.cv.Mat();

      const MIN_DIAMETER_MM = 0.3;
      const MAX_DIAMETER_MM = 3.0;

      const minRadiusPx = Math.floor((MIN_DIAMETER_MM / 2) * pxPerMm * 0.8);
      const maxRadiusPx = Math.ceil((MAX_DIAMETER_MM / 2) * pxPerMm * 1.5);
      const minDist = Math.max(maxRadiusPx * 1.5, 10);

      window.cv.HoughCircles(
        blurred,
        circles,
        window.cv.HOUGH_GRADIENT,
        1,
        minDist,
        100, // Canny high threshold
        18,  // Accumulator threshold (lowered; zone filters handle false positives)
        Math.max(3, minRadiusPx),
        Math.min(minRadiusPx * 10, maxRadiusPx)
      );

      // Collect ALL raw candidates first
      const allCandidates = [];

      if (circles.cols > 0) {
        for (let i = 0; i < circles.cols; ++i) {
          // x,y are in ROI-local coordinates
          const xRoi = circles.data32F[i * 3];
          const yRoi = circles.data32F[i * 3 + 1];
          const radius = circles.data32F[i * 3 + 2];

          // Convert to full-canvas pixel coordinates
          const x = xRoi + roiX;
          const y = yRoi + roiY;

          // Extract center brightness from the blurred ROI image
          let centerLum = 0;
          if (xRoi >= 0 && xRoi < roiSize && yRoi >= 0 && yRoi < roiSize) {
            centerLum = blurred.ucharPtr(Math.round(yRoi), Math.round(xRoi))[0];
          }

          // Distance from the dead center of the ROI (= crosshair center in full-canvas)
          const distFromCenter = Math.hypot(xRoi - roiSize / 2, yRoi - roiSize / 2);

          allCandidates.push({
            x, y, xRoi, yRoi, radius,
            circularity: 1.0,
            area: Math.PI * radius * radius,
            centerLum,
            distFromCenter,
            confidence: 0.90 + (Math.min(centerLum, 255) / 2550)
          });
        }
      }

      // Cleanup ROI mats
      fullSrc.delete();
      fullGray.delete();
      roiGray.delete();

      // *** KEY FIX: Only keep the single candidate closest to the crosshair center ***
      // All other candidates (even if bright) are false positives from the ROI edges.
      allCandidates.sort((a, b) => a.distFromCenter - b.distFromCenter);

      const validBlobs = [];
      const rejectedBlobs = [];

      if (allCandidates.length > 0) {
        const best = allCandidates[0]; // Closest to center

        // ─── ZONE BRIGHTNESS ANALYSIS ────────────────────────────────────────
        // 4 zones sampled from the blurred ROI mat:
        //   innerCore  (0 – 0.40r) : drill hole vs solid pad centre
        //   core       (0 – r)     : entire detected circle
        //   boundary   (r – 1.4r)  : clearance ring / solder mask edge
        //   outer      (1.4r – 2.5r): extended PCB area
        const r = best.radius;
        const cx = Math.round(best.xRoi);
        const cy = Math.round(best.yRoi);

        // Coarse grid for boundary + outer zones
        let coreSum = 0, coreCount = 0;
        let boundarySum = 0, boundaryCount = 0;
        let outerSum = 0, outerCount = 0;
        let fillCount = 0;

        const sampleStep = Math.max(1, Math.floor(r / 6));
        const outerLimit = Math.round(r * 2.5);

        for (let dy = -outerLimit; dy <= outerLimit; dy += sampleStep) {
          for (let dx = -outerLimit; dx <= outerLimit; dx += sampleStep) {
            const px = cx + dx;
            const py = cy + dy;
            if (px < 0 || py < 0 || px >= roiSize || py >= roiSize) continue;
            const dist = Math.hypot(dx, dy);
            const lum = blurred.ucharPtr(py, px)[0];
            if (dist <= r) {
              coreSum += lum; coreCount++;
              if (lum > 110) fillCount++;
            } else if (dist <= r * 1.4) {
              boundarySum += lum; boundaryCount++;
            } else if (dist <= r * 2.5) {
              outerSum += lum; outerCount++;
            }
          }
        }

        // Fine-grained inner-core scan (step=1 always) — primary through-hole discriminator.
        // A through-hole has a dark drill hole at the very centre; a fiducial pad is
        // uniformly bright from centre to edge. Even a 6px inner radius gets ~100 samples.
        let innerCoreSum = 0, innerCoreCount = 0;
        const innerR = Math.max(2, Math.round(r * 0.40));
        for (let idy = -innerR; idy <= innerR; idy++) {
          for (let idx2 = -innerR; idx2 <= innerR; idx2++) {
            const ipx = cx + idx2;
            const ipy = cy + idy;
            if (ipx < 0 || ipy < 0 || ipx >= roiSize || ipy >= roiSize) continue;
            if (Math.hypot(idx2, idy) > innerR) continue;
            innerCoreSum += blurred.ucharPtr(ipy, ipx)[0];
            innerCoreCount++;
          }
        }

        const coreMean      = coreCount      > 0 ? coreSum      / coreCount      : 0;
        const innerCoreMean = innerCoreCount  > 0 ? innerCoreSum / innerCoreCount : coreMean;
        const boundaryMean  = boundaryCount   > 0 ? boundarySum  / boundaryCount  : 0;
        const outerMean     = outerCount      > 0 ? outerSum     / outerCount     : 0;
        const fillRatio     = coreCount       > 0 ? fillCount    / coreCount      : 0;

        best.coreMean      = coreMean;
        best.innerCoreMean = innerCoreMean;
        best.boundaryMean  = boundaryMean;
        best.outerMean     = outerMean;
        best.fillRatio     = fillRatio;

        let rejectReason = null;

        // Rule 1: overall core must be bright enough to be metallic copper
        // (lowered from 90 → 75 to accept fiducials dimmed by auto-exposure bias)
        if (coreMean < 75) {
          rejectReason = 'Dark Center (Not Copper)';
        }
        // Rule 2: ring/donut pattern — the primary through-hole signature.
        // Through-hole: innerCore (drill hole) significantly darker than overall core (annular rim).
        // Solid fiducial: innerCoreMean ≈ coreMean (uniform bright pad, no dip at centre).
        else if (innerCoreMean < coreMean - 22 && innerCoreMean < 115) {
          rejectReason = 'Ring Pattern (Through-Hole: Dark Drill Centre)';
        }
        // Rule 3: viewed from above, through-hole barrel wall reflects — dark core, bright ring
        else if (coreMean < boundaryMean - 12) {
          rejectReason = 'Through-Hole (Dark Core / Bright Ring)';
        }
        // Rule 4: outer zone must be darker than core (solder mask surrounding the pad is dark)
        else if (outerMean > coreMean + 20) {
          rejectReason = 'Via/Hole (Bright Outer Halo)';
        }
        // Rule 5: fill ratio — solid pad vs hollow hole
        // (lowered from 0.55 → 0.48 to be less aggressive with real fiducials near edges)
        else if (fillRatio < 0.48) {
          rejectReason = 'Low Fill (Hollow — Likely Via)';
        }
        // Rule 6: outer zone must not be bright copper flood (not on solder mask)
        else if (outerMean > 165) {
          rejectReason = 'No Mask Isolation (Copper Flood)';
        }

        if (rejectReason) {
          best.rejectReason = rejectReason;
          rejectedBlobs.push(best);
        } else {
          const brightness = Math.min(coreMean / 200, 1.0);
          const isolation  = Math.min(Math.max(coreMean - outerMean, 0) / 80, 1.0);
          best.confidence  = 0.5 + brightness * 0.3 + isolation * 0.2;
          validBlobs.push(best);
        }

        // All remaining candidates rejected (off-center false positives from ROI edges)
        for (let i = 1; i < allCandidates.length; i++) {
          allCandidates[i].rejectReason = 'Off-Center';
          rejectedBlobs.push(allCandidates[i]);
        }
      }

      // Sort by confidence (trivially — only one valid blob max)
      validBlobs.sort((a, b) => b.confidence - a.confidence);

      // const debug = options?.debug === true;
      // if (debug) {
      //   console.log(`[OpenCV DEBUG] HoughCircles found: ${circles.cols}`);
      //   console.log(`[OpenCV DEBUG] Valid: ${validBlobs.length}, Rejected: ${rejectedBlobs.length}`);
      // }

      // Format for CameraPanel
      const mappedFiducials = validBlobs.map((blob, idx) => ({
        id: `F${idx + 1}`,
        pixelPosition: { x: blob.x, y: blob.y },
        radius: blob.radius,
        diameterMm: (blob.radius * 2) / pxPerMm,
        confidence: blob.confidence,  
        machinePosition: this.pixelToMachine(blob.x, blob.y),
        autoDetected: true,
        stats: { circularity: blob.circularity }
      }));

      const mappedRejected = rejectedBlobs.map((blob) => ({
        pixelPosition: { x: blob.x, y: blob.y },
        radius: blob.radius,
        reason: blob.rejectReason,
        circularity: blob.circularity,
        diameterMm: (blob.radius * 2) / pxPerMm
      }));

      // Cleanup remaining OpenCV memory (fullSrc, fullGray, roiGray already deleted above)
      blurred.delete();
      circles.delete();

      return {
        success: true,
        fiducials: mappedFiducials,
        rejectedBlobs: mappedRejected,
        timestamp: Date.now(),
        frameSize: { width: canvas.width, height: canvas.height }
      };

    } catch (error) {
      console.error('OpenCV fiducial detection failed:', error);
      return { success: false, error: error.message, fiducials: [] };
    } finally {
      this.isDetecting = false;
    }
  }

  // Detects the centroid of a bright generic shaped pad (square, oval, round) near the dead center of the camera.
  // Used for micro-jog visual servoing after a primary G0 move.
  async detectCenterFeature(videoElement, _options = {}) {
    if (this.isDetecting || !window.cv) return { success: false };
    this.isDetecting = true;
    
    try {
      const canvas = document.createElement('canvas');
      const cw = videoElement.clientWidth || videoElement.videoWidth;
      const ch = videoElement.clientHeight || videoElement.videoHeight;
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(videoElement, 0, 0, cw, ch);

      const src = window.cv.imread(canvas);
      const gray = new window.cv.Mat();
      window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY, 0);

      // Blur to remove surface texture/noise
      const blurred = new window.cv.Mat();
      window.cv.medianBlur(gray, blurred, 5);

      // Adaptive threshold to isolate metallic surfaces from dark mask
      const binary = new window.cv.Mat();
      window.cv.adaptiveThreshold(
        blurred, 
        binary, 
        255, 
        window.cv.ADAPTIVE_THRESH_GAUSSIAN_C, 
        window.cv.THRESH_BINARY, 
        61, // Block size
        -3   // C constant
      );

      // Morphological Close to fill in glare holes inside the bright copper pad
      const M = window.cv.Mat.ones(5, 5, window.cv.CV_8U);
      window.cv.morphologyEx(binary, binary, window.cv.MORPH_CLOSE, M);
      M.delete();

      const contours = new window.cv.MatVector();
      const hierarchy = new window.cv.Mat();
      window.cv.findContours(binary, contours, hierarchy, window.cv.RETR_EXTERNAL, window.cv.CHAIN_APPROX_SIMPLE);

      const centerX = cw / 2;
      const centerY = ch / 2;
      
      let bestScore = Infinity; // Lower is better (closest to center)
      let bestCentroid = null;

      for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const area = window.cv.contourArea(cnt);
        
        // Ignore tiny noise specs and massive background blobs
        if (area < 100 || area > (cw * ch) / 4) continue;

        // Calculate image moments to find the centroid of the shape
        const moments = window.cv.moments(cnt, false);
        if (moments.m00 === 0) continue;
        
        const cx = moments.m10 / moments.m00;
        const cy = moments.m01 / moments.m00;

        // Score is pure Euclidean distance from the true center of the camera
        const dist = Math.hypot(cx - centerX, cy - centerY);
        
        // Only consider the contour if its centroid is within ~60 pixels of the crosshair
        if (dist < 60 && dist < bestScore) {
          bestScore = dist;
          bestCentroid = { x: cx, y: cy };
        }
      }

      let resultDelta = null;
      if (bestCentroid) {
        resultDelta = {
          pixelDx: bestCentroid.x - centerX,
          pixelDy: centerY - bestCentroid.y // Y flipped: Canvas down is +Y, Machine up is +Y
        };
      }

      src.delete();
      gray.delete();
      blurred.delete();
      binary.delete();
      contours.delete();
      hierarchy.delete();

      return {
        success: true,
        detected: bestCentroid !== null,
        centroid: bestCentroid,
        pixelDelta: resultDelta
      };

    } catch (error) {
      console.error('Pad centroid detection failed:', error);
      return { success: false, error: error.message };
    } finally {
      this.isDetecting = false;
    }
  }
  pixelToMachine(pixelX, pixelY) {
    if (!this.homography) return null;
    const H = this.homography;
    const w = H[2][0] * pixelX + H[2][1] * pixelY + H[2][2];
    if (Math.abs(w) < 1e-9) return null;

    return {
      x: (H[0][0] * pixelX + H[0][1] * pixelY + H[0][2]) / w,
      y: (H[1][0] * pixelX + H[1][1] * pixelY + H[1][2]) / w
    };
  }

  setHomography(homographyMatrix) {
    this.homography = homographyMatrix;
  }

  /**
   * Start continuous fiducial monitoring
   */
  startContinuousDetection(videoElement, callback, interval = 1000, options = {}) {
    const detect = async () => {
      const result = await this.detectFiducialsInFrame(videoElement, [], options);
      if (callback) callback(result);
    };

    // Run immediately then on interval
    detect();
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