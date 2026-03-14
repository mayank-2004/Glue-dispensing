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
      const canvas = document.createElement('canvas'); // Recycling could improve perf
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
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // 2. Process Image (Blob Detection + Feature Extraction)
      // Now returns { blobs, labels, gray } so we can do advanced post-processing
      const { blobs, labels, gray } = this.findBlobs(imageData, canvas.width, canvas.height);

      // 3. Filter Blobs based on Advanced Constraints
      const validFiducials = this.filterBlobs(blobs, labels, gray, imageData, canvas.width, canvas.height, pxPerMm);
      // console.log("pxPerMm value: ", pxPerMm);

      const mappedFiducials = validFiducials.map((blob, idx) => ({
        id: `F${idx + 1}`,
        pixelPosition: { x: blob.x, y: blob.y },
        radius: blob.radius,
        diameterMm: (blob.radius * 2) / pxPerMm,
        confidence: blob.confidence,
        machinePosition: this.pixelToMachine(blob.x, blob.y),
        autoDetected: true,
        stats: {
          circularity: blob.circularity,
          inertiaRatio: blob.inertiaRatio,
          convexity: blob.convexity,
          edgeStrength: blob.edgeStrength
        }
      }));

      return {
        success: true,
        fiducials: mappedFiducials,
        timestamp: Date.now(),
        frameSize: { width: canvas.width, height: canvas.height }
      };

    } catch (error) {
      console.error('Advanced fiducial detection failed:', error);
      return { success: false, error: error.message, fiducials: [] };
    } finally {
      this.isDetecting = false;
    }
  }

  findBlobs(imageData, width, height) {
    const { data } = imageData;
    const gray = new Uint8Array(width * height);
    const binarized = new Uint8Array(width * height);

    // 1. Convert to pure Grayscale
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
      gray[i >> 2] = lum; 
    }

    // 2. Determine an automatic threshold (Otsu's method) to separate distinct contrast zones
    const threshold = this.getOtsuThreshold(gray, width, height);
    
    // We assume the fiducial (the bare silver/copper pad) reflects light differently 
    // than the surrounding solder mask. Depending on lighting and oxidation, the copper 
    // might be BRIGHTER than the green mask, or DARKER than the green mask.
    // We will build TWO binarized maps and find blobs in both to guarantee we catch it.
    const binarizedDark = new Uint8Array(width * height);
    const binarizedBright = new Uint8Array(width * height);
    
    for (let i = 0; i < gray.length; i++) {
        binarizedDark[i] = gray[i] < threshold ? 1 : 0;
        binarizedBright[i] = gray[i] > threshold ? 1 : 0;
    }

    // Helper to find blobs in a specific binarized array
    const extractBlobsFromArray = (binArray) => {
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
            if (binArray[idx] === 0) continue;

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
              binArray[idx - 1] === 0 || binArray[idx + 1] === 0 ||
              binArray[idx - width] === 0 || binArray[idx + width] === 0
            ) {
              isBorder = true;
            }
            if (isBorder) blob.perimeter++;
          }
        }
        return { blobsMap, labels };
    };

    const darkData = extractBlobsFromArray(binarizedDark);
    const brightData = extractBlobsFromArray(binarizedBright);

    // Combine results
    const results = [];
    let combinedLabels = new Int32Array(width * height).fill(0); // We only use labels for contour/convexity mapping, so we'll merge them safely
    let blobCounter = 1;

    const processMap = (map, srcLabels) => {
        map.forEach(blob => {
          if (blob.m00 < 10) return; // filter noise

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

          // Re-map the labels for this specific valid blob so we can contour it later
          const newId = blobCounter++;
          for (let y = blob.minY; y <= blob.maxY; y++) {
            for (let x = blob.minX; x <= blob.maxX; x++) {
               const idx = y * width + x;
               if (srcLabels[idx] === blob.id) {
                   combinedLabels[idx] = newId;
               }
            }
          }

          results.push({
            id: newId,
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
    };

    processMap(darkData.blobsMap, darkData.labels);
    processMap(brightData.blobsMap, brightData.labels);

    return { blobs: results, labels: combinedLabels, gray };

  }

  filterBlobs(blobs, labels, gray, imageData, width, height, pxPerMm) {
    const MAX_DIAMETER_MM = 1.0; // 1mm max
    const MIN_ISOLATION_MM = 2.0; // 2mm isolation

    const maxRadiusPx = (MAX_DIAMETER_MM / 2) * pxPerMm;
    const limitRadiusPx = maxRadiusPx * 1.25;

    // Thresholds
    const MIN_CIRCULARITY = 0.6; // Increased to reject lines/traces
    const MIN_INERTIA_RATIO = 0.45; // Increased to enforce perfect circles
    const MIN_CONVEXITY = 0.80; // Increased to reject complex text like 'N'
    const MIN_EDGE_STRENGTH = 15; // Lowered because copper vs green mask in grayscale can have weak edges

    const validBlobs = [];

    for (const blob of blobs) {
      // 1. Cheap Geometric Filters
      if (blob.circularity < MIN_CIRCULARITY) continue;
      if (blob.inertiaRatio < MIN_INERTIA_RATIO) continue;
      if (blob.radius > limitRadiusPx) continue;

      // 2. Convexity Check (Medium cost)
      // Requires extracting contour points from labels
      const contour = this.extractContour(blob, labels, width);
      const hullArea = this.calculateConvexHullArea(contour);
      const convexity = hullArea > 0 ? blob.area / hullArea : 0;

      if (convexity < MIN_CONVEXITY) {
        console.log(`Rejected ${blob.id}: Low convexity ${convexity.toFixed(2)}`);
        continue;
      }

      // 3. Gradient / Edge Strength Check (Medium cost)
      // Sample radial points to ensure high contrast at the edge
      const edgeStrength = this.calculateEdgeStrength(blob, gray, width, height);
      if (edgeStrength < MIN_EDGE_STRENGTH) { 
        // Weak edges usually mean shadow artifacts or out-of-focus background
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
      }
    }

    return validBlobs;
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


  /**
   * Check for "Dark Center" enclosed in "Bright Ring" structure
   * Validates Contrast in Grayscale (Ignores Color completely)
   */
  checkStructureAndColor(blob, gray, width, height, pxPerMm) {
    const { x, y, radius } = blob;

    // Regions
    const rInner = radius * 0.5;  // Inside Blob
    const rRingInner = radius * 1.0; // Start of Ring
    const rRingOuter = radius + (2.0 * pxPerMm); // End of Ring (2mm isolation zone)

    let centerLumSum = 0, centerCount = 0;
    let ringLumSum = 0, ringCount = 0;

    // check Step
    const step = Math.max(1, Math.round(width / 200));

    // 1. Sample Center (Blob)
    for (let py = Math.floor(y - rInner); py <= Math.ceil(y + rInner); py += step) {
      for (let px = Math.floor(x - rInner); px <= Math.ceil(x + rInner); px += step) {
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const dist = Math.hypot(px - x, py - y);
        if (dist > rInner) continue;

        const val = gray[py * width + px];
        centerLumSum += val;
        centerCount++;
      }
    }

    // 2. Sample Ring (Isolation Zone)
    // We want to check if this zone is BRIGHTER than the center
    for (let py = Math.floor(y - rRingOuter); py <= Math.ceil(y + rRingOuter); py += step) {
      for (let px = Math.floor(x - rRingOuter); px <= Math.ceil(x + rRingOuter); px += step) {
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const dist = Math.hypot(px - x, py - y);
        if (dist < rRingInner || dist > rRingOuter) continue;

        const val = gray[py * width + px];
        ringLumSum += val;
        ringCount++;
      }
    }

    if (centerCount === 0 || ringCount === 0) return false;

    const avgCenterLum = centerLumSum / centerCount;
    const avgRingLum = ringLumSum / ringCount;

    // Criteria 1: Absolute Contrast
    // In grayscale, shiny copper fiducials might appear BRIGHTER than the green mask ring.
    // Or, oxidized copper might appear DARKER. We just need to know there is a distinct contrast boundary.
    const contrastDiff = Math.abs(avgRingLum - avgCenterLum);
    
    // Require a noticeable contrast to prevent picking up subtle board texture variations
    if (contrastDiff < 15) {
      return false; // Not enough contrast to be a distinct bare fiducial point
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
  startContinuousDetection(videoElement, callback, interval = 1000) {
    const detect = async () => {
      const result = await this.detectFiducialsInFrame(videoElement);
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