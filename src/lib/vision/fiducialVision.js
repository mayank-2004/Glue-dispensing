export class FiducialVisionDetector {
  constructor() {
    this.isDetecting = false;
    this.homography = null;
  }

  async detectFiducialsInFrame(videoElement, expectedFiducials = [], options = {}) {
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

      // OpenCV Processing
      const src = window.cv.imread(canvas);
      const gray = new window.cv.Mat();
      window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY, 0);

      // Median blur is mathematically ideal for HoughCircles, 
      // as it obliterates salt-and-pepper noise and specular glares without blurring edges
      const blurred = new window.cv.Mat();
      window.cv.medianBlur(gray, blurred, 5);

      const circles = new window.cv.Mat();

      const MIN_DIAMETER_MM = 0.3;
      const MAX_DIAMETER_MM = 3.0;
      
      // Calculate dynamic radius limits based on zoom level calibration
      const minRadiusPx = Math.floor((MIN_DIAMETER_MM / 2) * pxPerMm * 0.8);
      const maxRadiusPx = Math.ceil((MAX_DIAMETER_MM / 2) * pxPerMm * 1.5);
      
      // Minimum distance between circle centers (stops overlapping duplicates)
      const minDist = maxRadiusPx * 1.5;

      // param1: Canny edge detection high threshold
      // param2: Accumulator threshold for circle centers (lower = more false circles). 
      // 20 is a highly tuned strict threshold for small/sharp holes
      window.cv.HoughCircles(
        blurred, 
        circles, 
        window.cv.HOUGH_GRADIENT, 
        1, // dp (inverse ratio of accumulator resolution)
        minDist, 
        100, // Canny high threshold
        22,  // Accumulator threshold
        Math.max(3, minRadiusPx), 
        Math.min(minRadiusPx * 10, maxRadiusPx)
      );

      const validBlobs = [];
      const rejectedBlobs = [];

      if (circles.cols > 0) {
        for (let i = 0; i < circles.cols; ++i) {
          const x = circles.data32F[i * 3];
          const y = circles.data32F[i * 3 + 1];
          const radius = circles.data32F[i * 3 + 2];
          
          const diameterMm = (radius * 2) / pxPerMm;

          // Only accept if strictly inside dimensions (avoid border noise circles)
          if (x >= radius && x <= cw - radius && y >= radius && y <= ch - radius) {
            
            // Extract the center pixel brightness from the blurred image
            // Fiducial pads MUST be somewhat bright (copper/HASL).
            // Reject dark circles which might just be shadows or green mask patterns.
            let centerLum = 0;
            if (x >= 0 && x < cw && y >= 0 && y < ch) {
               centerLum = blurred.ucharPtr(Math.round(y), Math.round(x))[0];
            }

            const blob = { 
              x, y, radius, 
              circularity: 1.0, // Hough circles are perfect
              area: Math.PI * radius * radius,
              confidence: 0.90 + (Math.min(centerLum, 255) / 2550) // Bonus confidence for bright centers
            };

            if (centerLum > 60) {
              validBlobs.push(blob);
            } else {
              blob.rejectReason = 'Too Dark (Not Copper)';
              rejectedBlobs.push(blob);
            }
          }
        }
      }

      // Sort by confidence
      validBlobs.sort((a, b) => b.confidence - a.confidence);

      const debug = options?.debug === true;
      if (debug) {
        console.log(`[OpenCV DEBUG] HoughCircles found: ${circles.cols}`);
        console.log(`[OpenCV DEBUG] Valid: ${validBlobs.length}, Rejected: ${rejectedBlobs.length}`);
      }

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

      // Cleanup OpenCV memory
      src.delete();
      gray.delete();
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

  /* =========================================================================
   * LEGACY VANILLA JS DETECTION CODE
   * =========================================================================

  findBlobs(imageData, width, height) {
    const { data } = imageData;
    const gray = new Uint8Array(width * height);

    // 1. Convert to Grayscale
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      gray[i >> 2] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    }

    // 2. ADAPTIVE BINARIZATION - works regardless of camera white balance or lighting
    // Compute mean brightness of the entire frame
    let lumSum = 0;
    for (let i = 0; i < gray.length; i++) lumSum += gray[i];
    const avgLum = lumSum / gray.length;

    // A fiducial pad (copper/HASL) is:
    //   - Noticeably BRIGHTER than the average background (green mask is usually dark)
    //   - Not dominated by a single strong color (still eliminates vivid red/blue lights)
    //   - NOT pure specular white (camera blown-out highlights)
    const brightnessThreshold = Math.min(avgLum + 20, 180); // at least 20 above average

    const binarizedSilver = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = gray[i >> 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;

      // Allow pad pixels that are:
      // 1. Bright enough (above adaptive threshold) 
      // 2. Not blown-out specular (< 250)
      // 3. Not over-saturated / vivid color (sat < 0.75)
      // 4. NOT white background: white table/paper has ALL channels high (minC > 180).
      //    Copper/HASL metallic has warm tone: R > B, so minC (usually B) stays below ~180.
      const isNotWhiteBackground = minC < 180;
      binarizedSilver[i >> 2] = (lum >= brightnessThreshold && lum < 250 && saturation < 0.75 && isNotWhiteBackground) ? 1 : 0;
    }

    // --- Connected Components ---
    const labels = new Int32Array(width * height).fill(0);
    const parent = [];
    let nextLabel = 1;

    const findRoot = (i) => {
      while (parent[i] !== i) i = parent[i];
      return i;
    };
    const union = (i, j) => {
      const rootI = findRoot(i);
      const rootJ = findRoot(j);
      if (rootI !== rootJ) parent[rootJ] = rootI;
    };

    // First Pass
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (binarizedSilver[idx] === 0) continue;

        const left = (x > 0) ? labels[idx - 1] : 0;
        const top = (y > 0) ? labels[idx - width] : 0;

        if (left === 0 && top === 0) {
          labels[idx] = nextLabel;
          parent[nextLabel] = nextLabel;
          nextLabel++;
        } else if (left !== 0 && top === 0) {
          labels[idx] = left;
        } else if (left === 0 && top !== 0) {
          labels[idx] = top;
        } else {
          labels[idx] = Math.min(left, top);
          union(left, top);
        }
      }
    }

    // Second Pass
    const blobsMap = new Map();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (labels[idx] === 0) continue;

        const root = findRoot(labels[idx]);
        labels[idx] = root; // Normalize label

        if (!blobsMap.has(root)) {
          blobsMap.set(root, {
            id: root,
            minX: x, maxX: x, minY: y, maxY: y,
            m00: 0, m10: 0, m01: 0, m20: 0, m02: 0, m11: 0,
            perimeter: 0
          });
        }
        const blob = blobsMap.get(root);

        blob.m00++;
        blob.m10 += x;
        blob.m01 += y;
        blob.m20 += x * x;
        blob.m02 += y * y;
        blob.m11 += x * y;

        if (x < blob.minX) blob.minX = x;
        if (x > blob.maxX) blob.maxX = x;
        if (y < blob.minY) blob.minY = y;
        if (y > blob.maxY) blob.maxY = y;

        let isBorder = false;
        if (x === 0 || x === width - 1 || y === 0 || y === height - 1) isBorder = true;
        else if (
          binarizedSilver[idx - 1] === 0 || binarizedSilver[idx + 1] === 0 ||
          binarizedSilver[idx - width] === 0 || binarizedSilver[idx + width] === 0
        ) {
          isBorder = true;
        }
        if (isBorder) blob.perimeter++;
      }
    }

    const results = [];
    blobsMap.forEach(blob => {
      if (blob.m00 < 4) return; // lower noise floor for small low-res webcams

      const area = blob.m00;
      const cx = blob.m10 / area;
      const cy = blob.m01 / area;

      const mu20 = blob.m20 - (blob.m10 * blob.m10 / area);
      const mu02 = blob.m02 - (blob.m01 * blob.m01 / area);
      const mu11 = blob.m11 - (blob.m10 * blob.m01 / area);

      const circularity = (4 * Math.PI * area) / (blob.perimeter * blob.perimeter);

      const common = Math.sqrt(4 * mu11 * mu11 + (mu20 - mu02) * (mu20 - mu02));
      const lambda1 = (mu20 + mu02 + common) / 2;
      const lambda2 = (mu20 + mu02 - common) / 2;
      const inertiaRatio = lambda2 / lambda1;

      results.push({
        id: blob.id,
        x: cx,
        y: cy,
        w: blob.maxX - blob.minX + 1,
        h: blob.maxY - blob.minY + 1,
        minX: blob.minX, maxX: blob.maxX, minY: blob.minY, maxY: blob.maxY,
        area: area,
        radius: Math.sqrt(area / Math.PI),
        circularity: circularity,
        inertiaRatio: inertiaRatio || 0,
        perimeter: blob.perimeter
      });
    });

    return { blobs: results, labels, gray };
  }

  filterBlobs(blobs, labels, gray, imageData, width, height, pxPerMm) {
    const MAX_DIAMETER_MM = 3.0; // Fiducials are 0.5–2mm. Rejects large mounting holes/rings.
    const MIN_DIAMETER_MM = 0.3; // Slightly raised to reject noise dots

    const maxRadiusPx = (MAX_DIAMETER_MM / 2) * pxPerMm;
    const minRadiusPx = (MIN_DIAMETER_MM / 2) * pxPerMm;

    // Thresholds - original working values
    const MIN_CIRCULARITY = 0.60;
    const MIN_INERTIA_RATIO = 0.50;
    const MIN_CONVEXITY = 0.70;
    const MIN_EDGE_STRENGTH = 8;
    const MAX_ASPECT_RATIO = 1.8;

    const validBlobs = [];
    const rejectedBlobs = [];

    const reject = (blob, reason) => {
        blob.rejectReason = reason;
        rejectedBlobs.push(blob);
    };

    for (const blob of blobs) {
      if (blob.radius > maxRadiusPx) { reject(blob, 'Too Large'); continue; }
      if (blob.radius < minRadiusPx) { reject(blob, 'Too Small'); continue; }

      // 0. Aspect Ratio check (very cheap, catches text immediately)
      const blobW = blob.maxX - blob.minX + 1;
      const blobH = blob.maxY - blob.minY + 1;
      const aspectRatio = blobW > blobH ? blobW / blobH : blobH / blobW;
      if (aspectRatio > MAX_ASPECT_RATIO) {
        reject(blob, `Elongated (AR=${aspectRatio.toFixed(2)})`);
        continue;
      }

      // 1. Circularity and Inertia (catches remaining irregular shapes)
      if (blob.circularity < MIN_CIRCULARITY) { reject(blob, 'Not Round (Circularity)'); continue; }
      if (blob.inertiaRatio < MIN_INERTIA_RATIO) { reject(blob, 'Not Round (Inertia)'); continue; }

      // 2. Convexity Check (Medium cost)
      // Requires extracting contour points from labels
      const contour = this.extractContour(blob, labels, width);
      const hullArea = this.calculateConvexHullArea(contour);
      const convexity = hullArea > 0 ? blob.area / hullArea : 0;

      if (convexity < MIN_CONVEXITY) {
        reject(blob, `Low Convexity (${convexity.toFixed(2)})`);
        continue;
      }

      // 3. Gradient / Edge Strength Check (Medium cost)
      // Sample radial points to ensure high contrast at the edge
      const edgeStrength = this.calculateEdgeStrength(blob, gray, width, height);
      if (edgeStrength < MIN_EDGE_STRENGTH) { 
        reject(blob, `Weak Edge (${edgeStrength.toFixed(1)})`);
        continue;
      }

      // 4. Structure Check (Critical: 'Dark Center' + 'Bright Ring')
      // This verifies isolation and contrast
      const isStructured = this.checkStructureAndColor(blob, gray, width, height, pxPerMm);

      if (isStructured) {
        validBlobs.push({
          ...blob,
          convexity,
          edgeStrength,
          // Boost confidence if structure is perfect
          confidence: (blob.circularity + blob.inertiaRatio + convexity + Math.min(1, edgeStrength / 100) + 0.2) / 4.2
        });
      } else {
        reject(blob, 'Failed Contrast/Isolation');
      }
    }

    // Sort by confidence
    validBlobs.sort((a, b) => b.confidence - a.confidence);

    return { validBlobs, rejectedBlobs };
  }
  extractContour(blob, labels, width) {
    // Scan the bounding box to find border pixels
    const points = [];
    const id = blob.id;
    for (let y = blob.minY; y <= blob.maxY; y++) {
      for (let x = blob.minX; x <= blob.maxX; x++) {
        const idx = y * width + x;
        if (labels[idx] === id) {
          // Check if it's on the border (has a non-id neighbor)
          if (
            labels[idx - 1] !== id || labels[idx + 1] !== id ||
            labels[idx - width] !== id || labels[idx + width] !== id
          ) {
            points.push({ x, y });
          }
        }
      }
    }
    return points;
  }

  // Monotone Chain algorithm for Convex Hull
  calculateConvexHullArea(points) {
    if (points.length < 3) return 0;

    // Sort by X then Y
    points.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);

    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

    const lower = [];
    for (const p of points) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
        lower.pop();
      }
      lower.push(p);
    }

    const upper = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
        upper.pop();
      }
      upper.push(p);
    }

    const hull = lower.slice(0, lower.length - 1).concat(upper.slice(0, upper.length - 1));

    // Shoelace formula for Area
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      const j = (i + 1) % hull.length;
      area += hull[i].x * hull[j].y;
      area -= hull[j].x * hull[i].y;
    }
    return Math.abs(area) / 2;
  }

  calculateEdgeStrength(blob, gray, width, height) {
    // Sample pairs of points inside and outside the estimated radius
    const r = blob.radius;
    const rIn = Math.max(1, r * 0.7);
    const rOut = r * 1.3;

    let sumDiff = 0;
    let count = 0;
    const step = Math.PI / 8; // 16 samples

    for (let theta = 0; theta < Math.PI * 2; theta += step) {
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);

      const xIn = Math.round(blob.x + rIn * cos);
      const yIn = Math.round(blob.y + rIn * sin);
      const xOut = Math.round(blob.x + rOut * cos);
      const yOut = Math.round(blob.y + rOut * sin);

      if (xIn >= 0 && xIn < width && yIn >= 0 && yIn < height &&
        xOut >= 0 && xOut < width && yOut >= 0 && yOut < height) {

        const valIn = gray[yIn * width + xIn];
        const valOut = gray[yOut * width + xOut];

        sumDiff += Math.abs(valIn - valOut);
        count++;
      }
    }

    return count > 0 ? sumDiff / count : 0;
  }

  // checkStructureAndColor documentation
  // Check for "Dark Center" enclosed in "Bright Ring" structure
  // Validates Contrast in Grayscale (Ignores Color completely)
  checkStructureAndColor(blob, gray, width, height, pxPerMm) {
    const { x, y, radius } = blob;

    // Sample regions:
    // 1. Inner circle: the detected blob (should be bright copper/silver)
    // 2. Annular ring: just outside the blob edge (should be dark green soldermask)
    const rInner = radius * 0.6; // Slightly inside the blob
    const rRingInner = radius * 1.1; // Just outside the blob
    const rRingOuter = radius + (2.5 * pxPerMm); // 2.5mm isolation check

    let centerLumSum = 0, centerCount = 0;
    let ringLumSum = 0, ringCount = 0;

    const step = Math.max(1, Math.round(width / 300));

    // 1. Sample Center (Blob interior)
    for (let py = Math.floor(y - rInner); py <= Math.ceil(y + rInner); py += step) {
      for (let px = Math.floor(x - rInner); px <= Math.ceil(x + rInner); px += step) {
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        if (Math.hypot(px - x, py - y) > rInner) continue;
        centerLumSum += gray[py * width + px];
        centerCount++;
      }
    }

    // 2. Sample annular ring (isolation zone outside pad)
    for (let py = Math.floor(y - rRingOuter); py <= Math.ceil(y + rRingOuter); py += step) {
      for (let px = Math.floor(x - rRingOuter); px <= Math.ceil(x + rRingOuter); px += step) {
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const dist = Math.hypot(px - x, py - y);
        if (dist < rRingInner || dist > rRingOuter) continue;
        ringLumSum += gray[py * width + px];
        ringCount++;
      }
    }

    if (centerCount === 0 || ringCount === 0) return false;

    const avgCenterLum = centerLumSum / centerCount;
    const avgRingLum = ringLumSum / ringCount;

    // REJECT DRILL HOLES: Holes appear dark in center and bright at edges.
    if (avgCenterLum < avgRingLum - 15) {
      return false; // This is a hole, not a fiducial pad
    }

    // REQUIRE BRIGHT CENTER: The center MUST be noticeably brighter than surrounding soldermask.
    if (avgCenterLum <= avgRingLum + 8) {
      return false; // Center is not clearly brighter - not a fiducial
    }

    return true;
  }

  getOtsuThreshold(gray, width, height) {
    const hist = new Int32Array(256).fill(0);
    const total = width * height;

    for (let i = 0; i < total; i++) hist[gray[i]]++;

    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];

    let sumB = 0, wB = 0, wF = 0;
    let maxVar = 0, threshold = 0;

    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;

      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;

      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > maxVar) {
        maxVar = varBetween;
        threshold = t;
      }
    }
    // Try to find the optimal threshold to separate the image into foreground/background.
    // Note: If the image is mostly green mask and bright copper, Otsu might pick a high number,
    // so we don't cap it anymore since the copper might be the bright element.
    return threshold;
  }
  
  ========================================================================= */

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