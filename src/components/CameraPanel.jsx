import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fitAffine, fitSimilarity, fitTranslation, applyTransform } from "../lib/utils/transform2d.js";
import LensCalibration from "./LensCalibration.jsx";
import { FiducialVisionDetector } from "../lib/vision/fiducialVision.js";
import { PadDetector } from "../lib/vision/padDetection.js";
import { jogRel } from "../lib/motion/gcode";
import "./CameraPanel.css";

export default function CameraPanel({
  fiducials = [],
  xf,
  applyXf,
  selectedDesign,
  effectiveOrigin,
  toolOffset,
  setToolOffset,
  nozzleDia,
  setNozzleDia,
  qualityController,
  onCaptureAlignment,
  alignmentInfo,
  machinePosition,
  onUpdateFiducials,
  activeBoardName,
  panelBoards = [],
  setPanelBoards,
  pixelsPerMm,
  setPixelsPerMm,
  fiducialVisionDetector,
  pads = []
}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const machinePositionRef = useRef(machinePosition);

  // Formula: ΔX = machine − crosshair,  ΔY = machine − crosshair
  const [cameraOffset, setCameraOffset] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cameraOffset") || "null") || { dx: 0, dy: 0 }; }
    catch { return { dx: 0, dy: 0 }; }
  });
  useEffect(() => { localStorage.setItem("cameraOffset", JSON.stringify(cameraOffset)); }, [cameraOffset]);

  // Ref to hold latest props for stale-closure avoidance in setInterval
  const latestPropsRef = useRef({ fiducials, onUpdateFiducials, activeBoardName, panelBoards, setPanelBoards, pixelsPerMm, setPixelsPerMm, effectiveOrigin, pads, cameraOffset: { dx: 0, dy: 0 } });
  useEffect(() => {
    latestPropsRef.current = { fiducials, onUpdateFiducials, activeBoardName, panelBoards, setPanelBoards, pixelsPerMm, setPixelsPerMm, effectiveOrigin, pads, cameraOffset };
  }, [fiducials, onUpdateFiducials, activeBoardName, panelBoards, setPanelBoards, pixelsPerMm, setPixelsPerMm, effectiveOrigin, pads, cameraOffset]);

  const [streamOn, setStreamOn] = useState(false);

  useEffect(() => { machinePositionRef.current = machinePosition; }, [machinePosition]);

  const [pairs, setPairs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("camPairs") || "[]"); } catch { return []; }
  });
  const [H, setH] = useState(() => {
    try { return JSON.parse(localStorage.getItem("camH") || "null"); } catch { return null; }
  });

  const [pendingPick, setPendingPick] = useState(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [measureMode, setMeasureMode] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const visionResultRef = useRef(null);

  const [visionResult, setVisionResultState] = useState(null);
  const setVisionResult = (val) => {
    // Both update React state (for UI) and the ref (for the 60fps Canvas Loop)
    let finalVal = typeof val === 'function' ? val(visionResultRef.current) : val;
    visionResultRef.current = finalVal;
    setVisionResultState(finalVal);
  };

  const [qualityResult, setQualityResult] = useState(null);
  const [autoDetecting, setAutoDetecting] = useState(false);

  const [visionEnabled, setVisionEnabled] = useState(false);
  const [qualityEnabled, setQualityEnabled] = useState(false);
  const [fiducialDetector] = useState(() => new FiducialVisionDetector());
  const [padDetector, setPadDetector] = useState(null);

  useEffect(() => {
    if (canvasRef.current && !padDetector) {
      setPadDetector(new PadDetector(canvasRef.current, H));
    } else if (padDetector && H) {
      padDetector.updateHomography(H);
    }
  }, [canvasRef.current, H, padDetector]);

  const [detectionInterval, setDetectionInterval] = useState(null);

  const [jogStep, setJogStep] = useState(1);
  const [isBusy, setIsBusy] = useState(false);

  // Single canonical Auto-Align Window Event Listener
  // A ref guard ensures only ONE jog fires per event dispatch.
  const isAligningRef = useRef(false);

  useEffect(() => {
    const handleAutoAlign = async (e) => {
      // Guard: if a jog is already in progress from a previous event, ignore this one
      if (isAligningRef.current) {
        console.warn('[Auto-Align] Already jogging, ignoring duplicate event.');
        return;
      }

      isAligningRef.current = true;

      const { padCenter } = e.detail;

      await new Promise(r => setTimeout(r, 1200));

      if (!padDetector || !streamOn) {
        isAligningRef.current = false;
        return;
      }
      setAutoDetecting(true);
      try {
        const pxmm = pixelsPerMm || 20;
        const result = await padDetector.detectPad(padCenter, { width: 1, height: 1 }, pxmm);
        setVisionResult(result);

        if (result && result.detected && result.offset) {
          console.log('[Auto-Align] Pad detected at offset:', result.offset);

          const dxMm = result.offset.x;
          const distMm = Math.hypot(dxMm, result.offset.y);
          // Only jog if offset is meaningful (> 20µm) and not a false positive (< 3mm)
          if (distMm > 0.02 && distMm < 3.0) {
            const cmds = jogRel({ dx: dxMm, dy: result.offset.y, feed: 500 });
            if (window.serial && window.serial.writeLine) {
              for (const line of cmds) await window.serial.writeLine(line);
              console.log('[Auto-Align] Jogged once by:', dxMm.toFixed(3), result.offset.y.toFixed(3));
            }
          } else {
            console.warn('[Auto-Align] Pad correction rejected — distance out of bounds:', distMm);
          }
        } else {
          console.warn('[Auto-Align] No valid rectangular pad contours detected near crosshair.');
        }
      } catch (err) {
        console.error('[Auto-Align] Vision failed:', err);
      } finally {
        setAutoDetecting(false);
        isAligningRef.current = false; // Release guard so next explicit trigger can run
      }
    };

    window.addEventListener('camera-auto-align-pad', handleAutoAlign);
    return () => window.removeEventListener('camera-auto-align-pad', handleAutoAlign);
  }, [padDetector, streamOn, pixelsPerMm]);

  // helpers for safe formatting
  const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : "—");
  const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");

  useEffect(() => { localStorage.setItem("camPairs", JSON.stringify(pairs)); }, [pairs]);
  useEffect(() => { if (H) localStorage.setItem("camH", JSON.stringify(H)); }, [H]);

  const fidRows = useMemo(() => {
    return (fiducials || []).map(f => {
      // try design→machine via xf; if no design, use f.machine if present
      let world = null;
      if (f.machine && Number.isFinite(f.machine.x) && Number.isFinite(f.machine.y)) {
        world = { x: f.machine.x, y: f.machine.y };
      } else if (f.design && Number.isFinite(f.design.x) && Number.isFinite(f.design.y)) {
        world = (applyXf && xf) ? applyTransform(xf, f.design) : { ...f.design };
      }
      return { id: f.id, world, color: f.color || "#ff5555" };
    });
  }, [fiducials, xf, applyXf]);

  const solveHomography = useCallback((wp, pp) => {
    const n = wp.length;
    if (n < 4) return null;
    const A = new Array(2 * n).fill(0).map(() => new Array(8).fill(0));
    const b = new Array(2 * n).fill(0);
    for (let i = 0; i < n; i++) {
      const { x, y } = wp[i]; const { u, v } = pp[i];
      const r = 2 * i;
      A[r][0] = x; A[r][1] = y; A[r][2] = 1; A[r][3] = 0; A[r][4] = 0; A[r][5] = 0; A[r][6] = -u * x; A[r][7] = -u * y; b[r] = u;
      A[r + 1][0] = 0; A[r + 1][1] = 0; A[r + 1][2] = 0; A[r + 1][3] = x; A[r + 1][4] = y; A[r + 1][5] = 1; A[r + 1][6] = -v * x; A[r + 1][7] = -v * y; b[r + 1] = v;
    }
    const AT = transpose(A);
    const ATA = matMul(AT, A);
    const ATb = vecMul(AT, b);
    const h = solveSymmetric(ATA, ATb);
    if (!h) return null;
    return [
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1],
    ];
  }, []);

  function transpose(M) { const r = M.length, c = M[0].length, T = Array.from({ length: c }, () => new Array(r)); for (let i = 0; i < r; i++)for (let j = 0; j < c; j++)T[j][i] = M[i][j]; return T; }
  function matMul(A, B) { const r = A.length, k = A[0].length, c = B[0].length, M = Array.from({ length: r }, () => new Array(c).fill(0)); for (let i = 0; i < r; i++) { for (let j = 0; j < c; j++) { let s = 0; for (let t = 0; t < k; t++)s += A[i][t] * B[t][j]; M[i][j] = s; } } return M; }
  function vecMul(A, v) { const r = A.length, c = A[0].length, out = new Array(r).fill(0); for (let i = 0; i < r; i++) { let s = 0; for (let j = 0; j < c; j++)s += A[i][j] * v[j]; out[i] = s; return out; } }
  function solveSymmetric(M, b) { const n = M.length; const A = Array.from({ length: n }, (_, i) => [...M[i], b[i]]); for (let i = 0; i < n; i++) { let piv = A[i][i]; if (Math.abs(piv) < 1e-12) return null; const inv = 1 / piv; for (let j = i; j <= n; j++)A[i][j] *= inv; for (let r = 0; r < n; r++) { if (r === i) continue; const f = A[r][i]; for (let j = i; j <= n; j++)A[r][j] -= f * A[i][j]; } } return A.map(row => row[n]); }

  const projectPx = useCallback((pt) => {
    if (!H || !pt) return null;
    const { x, y } = pt;
    const u = H[0][0] * x + H[0][1] * y + H[0][2];
    const v = H[1][0] * x + H[1][1] * y + H[1][2];
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null;
    return { u: u / w, v: v / w };
  }, [H]);

  const pxPerMmAt = useCallback((pt) => {
    if (!H || !pt) return null;
    const p0 = projectPx(pt), p1 = projectPx({ x: pt.x + 1, y: pt.y });
    if (!p0 || !p1) return null;
    return Math.hypot(p1.u - p0.u, p1.v - p0.v);
  }, [H, projectPx]);

  const predictedPx = useMemo(() => {
    // console.log("selected design: ", selectedDesign);
    if (!selectedDesign) return null;
    let m;
    if (applyXf && xf) {
      m = applyTransform(xf, selectedDesign);
    } else if (latestPropsRef.current.effectiveOrigin) {
      // Convert standard gerber directly to machine coordinate representation mathematically
      m = {
        x: selectedDesign.x - latestPropsRef.current.effectiveOrigin.x,
        y: selectedDesign.y - latestPropsRef.current.effectiveOrigin.y
      };
    } else {
      m = { ...selectedDesign };
    }
    const withTool = { x: m.x + (toolOffset?.dx || 0), y: m.y + (toolOffset?.dy || 0) };
    return projectPx(withTool);
  }, [selectedDesign, xf, applyXf, toolOffset, projectPx]); // effectiveOrigin state is accessible via latestPropsRef without triggering loops

  const rms = useMemo(() => {
    if (!H || !pairs.length) return null;
    let s2 = 0, n = 0;
    for (const p of pairs) {
      if (!p.pixel || !p.world) continue;
      const q = projectPx(p.world);
      if (!q) continue;
      const dx = q.u - p.pixel.u, dy = q.v - p.pixel.v;
      s2 += dx * dx + dy * dy; n++;
    }
    if (!n) return null;
    return Math.sqrt(s2 / n);
  }, [H, pairs, projectPx]);

  async function startCam() {
    if (streamOn) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      videoRef.current.srcObject = s;
      await videoRef.current.play();
      setStreamOn(true);
      tick();
    } catch (e) {
      console.error(e);
      alert("Could not start camera. Check permissions or device.");
    }
  }
  function stopCam() {
    const v = videoRef.current;
    if (v?.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; }
    setStreamOn(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }

  function tick() { drawOverlay(); rafRef.current = requestAnimationFrame(tick); }

  function drawOverlay() {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    // CRITICAL: Always use the raw internal video dimensions for canvas coordinate space!
    // This ensures OpenCV coordinates map exactly 1:1 with canvas overlay drawings.
    const W = v.videoWidth || 640;
    const Hh = v.videoHeight || 480; 
    c.width = W; c.height = Hh;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, W, Hh);

    if (!showOverlay) return;

    // --- CROSSHAIR REMAINS FIXED AT CENTER OF RAW FRAME ---
    let crosshairX = W / 2;
    let crosshairY = Hh / 2;

    // (Visual magnetic snapping removed per user request: The target crosshair must always represent the true center of the camera view)
    // if (visionResult && visionResult.detected && visionResult.fiducials && visionResult.fiducials.length > 0) { ... }


    // Draw Auto-Adjusting Center Crosshair (User requested 4 sections)
    ctx.strokeStyle = "rgba(0, 255, 255, 0.5)"; // Cyan transparent
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(crosshairX, 0);
    ctx.lineTo(crosshairX, Hh);
    ctx.moveTo(0, crosshairY);
    ctx.lineTo(W, crosshairY);
    ctx.stroke();

    // Calculate & Display the live Machine Coordinate of the Crosshair center
    const cProps = latestPropsRef.current;

    // We pass the canvas boundaries (W, Hh) to ensure the center point matches exactly what the user sees
    const matchData = getMachineCoordinateFromPixel(crosshairX, crosshairY, W, Hh);

    if (matchData) {
      const { x: mX, y: mY } = matchData;
      const originOffset = latestPropsRef.current.effectiveOrigin || { x: 0, y: 0 };
      const displayX = mX - originOffset.x;
      const displayY = mY - originOffset.y;

      // Draw a white halo behind the black text so it remains visible over dark traces
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";

      ctx.font = "bold 14px monospace";
      ctx.strokeText(`+ TARGET`, crosshairX + 12, crosshairY - 16);
      ctx.font = "12px monospace";
      ctx.strokeText(`X: ${displayX.toFixed(3)} mm`, crosshairX + 12, crosshairY + 0);
      ctx.strokeText(`Y: ${displayY.toFixed(3)} mm`, crosshairX + 12, crosshairY + 14);

      // Draw the crisp black text over the white halo
      ctx.fillStyle = "#000000"; // Changed to pure black as requested
      ctx.font = "bold 14px monospace";
      ctx.fillText(`+ TARGET`, crosshairX + 12, crosshairY - 16);
      ctx.font = "12px monospace";
      ctx.fillText(`X: ${displayX.toFixed(3)} mm`, crosshairX + 12, crosshairY + 0);
      ctx.fillText(`Y: ${displayY.toFixed(3)} mm`, crosshairX + 12, crosshairY + 14);
    }

    // Vision detection overlay removed — the cyan crosshair already marks the fiducial center accurately.

    // Draw quality analysis result
    if (qualityEnabled && qualityResult) {
      const color = qualityResult.passed ? '#00ff00' : '#ff0000';
      ctx.fillStyle = color;
      ctx.font = '14px Arial';
      ctx.fillText(`Quality: ${(qualityResult.qualityScore * 100).toFixed(0)}%`, 10, 30);
      ctx.fillText(`Coverage: ${(qualityResult.coverage * 100).toFixed(0)}%`, 10, 50);
    }

    if (predictedPx) {
      const baseWorld = (applyXf && xf && selectedDesign) ? applyTransform(xf, selectedDesign) : (selectedDesign || { x: 0, y: 0 });
      const pxmm = pxPerMmAt(baseWorld) || pixelsPerMm;
      const r = Math.max(2, (nozzleDia || 0.6) * 0.5 * pxmm);

      ctx.beginPath();
      ctx.arc(predictedPx.u, predictedPx.v, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 215, 0, 0.18)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffd400";
      ctx.stroke();

      ctx.strokeStyle = "#00e0ff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(predictedPx.u - r * 1.6, predictedPx.v);
      ctx.lineTo(predictedPx.u + r * 1.6, predictedPx.v);
      ctx.moveTo(predictedPx.u, predictedPx.v - r * 1.6);
      ctx.lineTo(predictedPx.u, predictedPx.v + r * 1.6);
      ctx.stroke();
    }

    if (measureMode && predictedPx && lastClickPx) {
      const dx = lastClickPx.u - predictedPx.u;
      const dy = lastClickPx.v - predictedPx.v;
      ctx.strokeStyle = "#ff4d4f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(predictedPx.u, predictedPx.v);
      ctx.lineTo(lastClickPx.u, lastClickPx.v);
      ctx.stroke();
      ctx.fillStyle = "#ff4d4f";
      ctx.font = "12px ui-monospace, monospace";
      const baseWorld = (applyXf && xf && selectedDesign) ? applyTransform(xf, selectedDesign) : (selectedDesign || { x: 0, y: 0 });
      const pxmm = pxPerMmAt(baseWorld) || pixelsPerMm;
      const mm = Math.hypot(dx, dy) / pxmm;
      ctx.fillText(`${mm.toFixed(3)} mm (${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`,
        predictedPx.u + 8, predictedPx.v - 8);
    }
  }

  async function onCanvasClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const u = e.clientX - rect.left;
    const v = e.clientY - rect.top;

    if (measureMode) {
      setLastClickPx({ u, v });
      return;
    }

    // --- STEP 1: Compute Target Pixel ---
    // User clicked purely on the stretched DOM element, must map back to native video coords
    const W = videoRef.current.videoWidth || 640;
    const Hh = videoRef.current.videoHeight || 480;
    const clickU = (u / rect.width) * W;
    const clickV = (v / rect.height) * Hh;

    const centerX = W / 2;
    const centerY = Hh / 2;

    const baseWorld = (applyXf && xf && selectedDesign) ? applyTransform(xf, selectedDesign) : (selectedDesign || { x: 0, y: 0 });
    const pxmm = pixelsPerMm;

    let targetU = clickU;
    let targetV = clickV;

    // Optional Vision Snap
    if (videoRef.current && streamOn && !isBusy) {
      try {
        const result = await fiducialDetector.detectFiducialsInFrame(videoRef.current, fiducials, { pxPerMm: pxmm });
        if (result.success && result.fiducials.length > 0) {
          let closestDist = Infinity;
          let closestFid = null;

          result.fiducials.forEach(f => {
            const dist = Math.hypot(f.pixelPosition.x - clickU, f.pixelPosition.y - clickV);
            if (dist < closestDist) {
              closestDist = dist;
              closestFid = f;
            }
          });

          // Snap radius of 60px in native space
          if (closestDist < 60 && closestFid) {
            targetU = closestFid.pixelPosition.x;
            targetV = closestFid.pixelPosition.y;
          }
        }
      } catch (err) {
        console.warn("Snap-to-center vision failed:", err);
      }
    }

    // --- STEP 2: Calculate Delta from Crosshair ---
    // X is positive right, Y is positive down on screen, but machine is UP
    const pixelDx = targetU - centerX;
    const pixelDy = centerY - targetV;

    const dx = pixelDx / pxmm;
    const dy = pixelDy / pxmm;

    // --- STEP 3: Handle Action (Map Fiducial & Jog Machine) ---
    const needsJog = (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01);

    // 3A: Map Fiducial Mathematically FIRST (So UI updates instantly)
    if (pendingPick) {
      if (!machinePositionRef.current) {
        alert("Machine position unknown. Cannot map physical coordinates.");
        setPendingPick(null);
        return;
      }

      const newX = machinePositionRef.current.x + (toolOffset?.dx || 0) + dx;
      const newY = machinePositionRef.current.y + (toolOffset?.dy || 0) + dy;

      // ✅ FIX: read latest fiducials + callback from ref (not stale closure)
      const latestFids = latestPropsRef.current.fiducials;
      const latestCb = latestPropsRef.current.onUpdateFiducials;

      const newFids = latestFids.map(f =>
        f.id === pendingPick
          ? { ...f, machine: { x: newX, y: newY }, autoDetected: false, confidence: 1.0 }
          : f
      );

      if (latestCb) latestCb(newFids);
      console.log(`Mapped ${pendingPick} to absolute Machine Pos: X${newX.toFixed(3)}, Y${newY.toFixed(3)}`);
      setPendingPick(null);
    }

    // 3B: Physically Jog the Machine so crosshair aligns perfectly
    if (needsJog) {
      if (isBusy) return;
      setIsBusy(true);
      try {
        const cmds = jogRel({ dx, dy, feed: 2000 });
        if (window.serial && window.serial.writeLine) {
          for (const line of cmds) await window.serial.writeLine(line);
          setIsBusy(false);
        } else {
          setIsBusy(false);
          console.warn("Serial mock jog: ", { dx, dy });
        }
      } catch (err) {
        setIsBusy(false);
        console.error("Jog err:", err);
      }
    }
  }

  function addOrPick(fidId) {
    // ✅ FIX: always read from the ref so this picks up the latest fiducials
    const fr = latestPropsRef.current.fiducials.find(f => f.id === fidId);
    if (!fr || !fr.design || !Number.isFinite(fr.design.x) || !Number.isFinite(fr.design.y)) {
      alert("This fiducial has no Design coordinates mapped yet. Please mark it on the SVG Viewer first.");
      return;
    }
    setPendingPick(fidId);
  }
  function clearPairs() {
    // Legacy support cleanup
    setPairs([]);
    setH(null);
    setLastClickPx(null);
    localStorage.removeItem("camPairs"); localStorage.removeItem("camH");
  }

  // Vision-guided pad detection
  const detectPadAtPosition = async () => {
    if (!padDetector || !selectedDesign || !H) return;

    setAutoDetecting(true);
    try {
      padDetector.updateHomography(H);
      const result = await padDetector.detectPad(selectedDesign, { width: 1, height: 1 });
      setVisionResult(result);

      if (result && result.detected) {
        console.log('Pad detected at:', result.position, 'Offset:', result.offset);
      }
    } catch (error) {
      console.error('Pad detection failed:', error);
    } finally {
      setAutoDetecting(false);
    }
  };

  // Helper to get scale (px/mm)
  const getScale = () => {
    // 1. Try from Homography at center
    if (H) {
      const center = { x: 100, y: 100 }; // Arbitrary world point
      const p1 = projectPx(center);
      const p2 = projectPx({ x: center.x + 1, y: center.y });
      if (p1 && p2) {
        return Math.hypot(p2.u - p1.u, p2.v - p1.v);
      }
    }
    // 2. Fallback or Manual Input (todo)
    return pixelsPerMm; // Default fallback (approx 20px/mm)
  };

  // Helper to standardise all coordinate math in one place so the Crosshair, Auto-Detect console log, and physical jog command never disagree
  const getMachineCoordinateFromPixel = (pxX, pxY, width, height) => {
    if (!machinePositionRef.current) return null;

    const centerX = width / 2;
    const centerY = height / 2;

    const baseWorld = (applyXf && xf && selectedDesign) ? applyTransform(xf, selectedDesign) : (selectedDesign || { x: 0, y: 0 });
    let pxmm = pixelsPerMm;
    if (H) {
      const center = { x: 100, y: 100 };
      const p1 = projectPx(center);
      const p2 = projectPx({ x: center.x + 1, y: center.y });
      if (p1 && p2) pxmm = Math.hypot(p2.u - p1.u, p2.v - p1.v);
    } else {
      const measured = pxPerMmAt(baseWorld);
      if (measured) pxmm = measured;
    }

    const pixelDx = pxX - centerX;
    const pixelDy = centerY - pxY; // Machine Y is up, Canvas Y is down
    // const dxMm = (invertCameraX ? -1 : 1) * (pixelDx / pxmm);
    // const dyMm = (invertCameraY ? -1 : 1) * (pixelDy / pxmm);
    const dxMm = pixelDx / pxmm;
    const dyMm = pixelDy / pxmm;

    return {
      x: machinePositionRef.current.x + (toolOffset?.dx || 0) + dxMm,
      y: machinePositionRef.current.y + (toolOffset?.dy || 0) + dyMm,
      pxmm, dxMm, dyMm
    };
  };

  // Automated fiducial detection using camera
  const detectFiducialsWithCamera = async () => {
    if (!videoRef.current || !streamOn) {
      alert('Please start the camera first');
      return;
    }

    setAutoDetecting(true);
    try {
      fiducialDetector.setHomography(H);

      const pxPerMm = getScale();
      console.log('Detecting with scale:', pxPerMm, 'px/mm');

      const result = await fiducialDetector.detectFiducialsInFrame(videoRef.current, fiducials, { pxPerMm, debug: true });
      console.log("result is: ", result);

      if (result.success && result.fiducials.length > 0) {

        // --- ONLY ACCEPT THE FIDUCIAL UNDER THE CROSSHAIRS ---
        // MUST use native video coords so it aligns perfectly with OpenCV output
        const videoWidth = videoRef.current.videoWidth || 640;
        const videoHeight = videoRef.current.videoHeight || 480;
        const centerX = videoWidth / 2;
        const centerY = videoHeight / 2;

        let closestDist = Infinity;
        let selectedFiducial = null;
        const newlyRejected = [];

        result.fiducials.forEach(fid => {
          const dist = Math.hypot(fid.pixelPosition.x - centerX, fid.pixelPosition.y - centerY);
          if (dist < closestDist) {
            // Move previous champion to rejected pile (if any)
            if (selectedFiducial) {
              newlyRejected.push({ ...selectedFiducial, reason: 'Off-Center' });
            }
            closestDist = dist;
            selectedFiducial = fid;
          } else {
            // Too far away from the new champion, reject it
            newlyRejected.push({ ...fid, reason: 'Off-Center' });
          }
        });

        // Enforce a strict "must be near crosshairs" radius limit (e.g. within 60-80 pixels)
        const SNAP_RADIUS_PX = 80;

        let finalFiducials = [];
        let finalRejected = [...(result.rejectedBlobs || []), ...newlyRejected];

        if (selectedFiducial && closestDist <= SNAP_RADIUS_PX) {
          finalFiducials = [selectedFiducial]; // Lock onto the single, centered pad
        } else if (selectedFiducial) {
          // It was the closest, but still too far away from the physical crosshairs
          finalRejected.push({ ...selectedFiducial, reason: 'Too Far from Crosshair' });
        }

        console.log('Auto-detected fiducial:', finalFiducials);
        console.log('Rejected shapes:', finalRejected);

        setVisionResult({
          detected: true,
          fiducials: finalFiducials,
          rejectedBlobs: finalRejected,
          confidence: finalFiducials.length > 0 ? finalFiducials[0].confidence : 0
        });

        const cProps = latestPropsRef.current;
        const pBoards = cProps.panelBoards;
        const setPBoards = cProps.setPanelBoards;
        const hasMultiBoards = pBoards && pBoards.length > 0 && setPBoards;

        // Gather all fiducials across all boards
        let allFids = [];
        if (hasMultiBoards) {
          pBoards.forEach((b, bIdx) => {
            b.fiducials.forEach((f, fIdx) => {
              if (f.design) allFids.push({ ...f, bIdx, fIdx, boardName: b.name });
            });
          });
        }

        let changedBoards = false;
        let nextBoards = hasMultiBoards ? [...pBoards] : [];

        // 1. Convert pixel coordinates to exact machine coordinates relative to current toolhead position.
        const currentMPos = machinePositionRef.current;
        // MUST use clientWidth to match the physical UI canvas rendering
        // const videoWidth = videoRef.current.clientWidth || videoRef.current.videoWidth || 640;
        // const videoHeight = videoRef.current.clientHeight || videoRef.current.videoHeight || 480;
        // const centerX = videoWidth / 2;
        // const centerY = videoHeight / 2;

        const correctedFiducials = finalFiducials.map(detected => {
          let actualMachinePosition = detected.machinePosition;
          console.log("actualMachinePosition", actualMachinePosition);
          if (currentMPos) {
            // We use the same VideoWidth/Height as the canvas fallback array so it aligns perfectly with the visual overlay
            const matchData = getMachineCoordinateFromPixel(detected.pixelPosition.x, detected.pixelPosition.y, videoWidth, videoHeight);
            console.log("matchData", matchData);
            if (matchData) {
              actualMachinePosition = { x: matchData.x, y: matchData.y };
            }
          }
          return { ...detected, actualMachinePosition };
        });

        const { effectiveOrigin, panelBoards, activeBoardName, cameraOffset } = latestPropsRef.current;
        const pOrigin = effectiveOrigin || { x: 0, y: 0 };
        const camOffset = cameraOffset || { dx: 0, dy: 0 };
        
        changedBoards = false;
        nextBoards = [...(panelBoards || [])];
        const activeBIdx = Math.max(0, nextBoards.findIndex(b => b.name === activeBoardName));

        correctedFiducials.forEach(detected => {
          if (!detected.actualMachinePosition) return;

          // Per user request:
          // 1. Convert physical machine coordinate back to nozzle machine coordinate by subtracting camera toolOffset
          // 2. Add the PCB origin (which is stored as inverted offset) to get the final CAD Design coordinate
          const rawDesignX = (detected.actualMachinePosition.x + pOrigin.x) - camOffset.dx;
          const rawDesignY = (detected.actualMachinePosition.y + pOrigin.y) - camOffset.dy;

          // Match against EXISTING fiducials OR create a NEW one
          if (nextBoards[activeBIdx]) {
             let targetFidIdx = -1;
             
             // First check if this corresponds to an already marked fiducial (within 5mm) to update it 
             nextBoards[activeBIdx].fiducials.forEach((f, fIdx) => {
                if (!f.design) return;
                const dist = Math.hypot(f.design.x - rawDesignX, f.design.y - rawDesignY);
                if (dist < 5.0) targetFidIdx = fIdx; 
             });

             const newFiducials = [...nextBoards[activeBIdx].fiducials];

             if (targetFidIdx >= 0) {
                // Update existing fiducial
                newFiducials[targetFidIdx] = {
                   ...newFiducials[targetFidIdx],
                   machine: detected.actualMachinePosition,
                   design: { x: parseFloat(rawDesignX.toFixed(3)), y: parseFloat(rawDesignY.toFixed(3)) },
                   pixelPosition: detected.pixelPosition,
                   autoDetected: true,
                   confidence: detected.confidence
                };
             } else {
                // Completely new fiducial discovered by camera! Create it dynamically!
                targetFidIdx = newFiducials.findIndex(f => !f.design);
                
                const newFid = {
                   id: targetFidIdx >= 0 ? newFiducials[targetFidIdx].id : `F${newFiducials.length + 1}`,
                   color: targetFidIdx >= 0 ? newFiducials[targetFidIdx].color : `#${Math.floor(Math.random() * 16777215).toString(16)}`,
                   design: { x: parseFloat(rawDesignX.toFixed(3)), y: parseFloat(rawDesignY.toFixed(3)) }, // Use direct math value
                   machine: detected.actualMachinePosition,
                   pixelPosition: detected.pixelPosition,
                   autoDetected: true,
                   confidence: detected.confidence
                };
                
                if (targetFidIdx >= 0) {
                   newFiducials[targetFidIdx] = newFid;
                } else {
                   newFiducials.push(newFid);
                }
             }

             nextBoards[activeBIdx] = { ...nextBoards[activeBIdx], fiducials: newFiducials };
             changedBoards = true;
          }
        });

        if (changedBoards && latestPropsRef.current.setPanelBoards) {
          latestPropsRef.current.setPanelBoards(nextBoards);
        }
        // --- DYNAMIC OFFSET EVALUATION ---
        let autoDx = 0;
        let autoDy = 0;

        if (correctedFiducials.length > 0) {
          const detected = correctedFiducials[0];

          // 1. Where the camera crosshair points on screen, stored in a variable
          const crosshairCoord = getMachineCoordinateFromPixel(videoWidth / 2, videoHeight / 2, videoWidth, videoHeight);

          // 2. Detected fiducial coordinate value via camera vision stored in another variable
          const detectedFidCoord = getMachineCoordinateFromPixel(detected.pixelPosition.x, detected.pixelPosition.y, videoWidth, videoHeight);

          if (crosshairCoord && detectedFidCoord) {
            // 3. "camera crosshair coordinate value" subtracted from "detected fiducial coordinate value"
            autoDx = detectedFidCoord.x - crosshairCoord.x;
            autoDy = detectedFidCoord.y - crosshairCoord.y;

            autoDx = parseFloat((autoDx / 2.0).toFixed(3));
            autoDy = parseFloat((autoDy / 2.0).toFixed(3));
          }
        }

        // 1. Automatically put the evaluated value into the UI container ΔX and ΔY
        setCameraOffset({ dx: autoDx, dy: autoDy });

        // 2. Evaluate the value and move the nozzle by that distance
        await jogCameraToNozzle({ dx: autoDx, dy: autoDy });

        // // AUTO-CENTER: Jog machine so camera crosshair aligns perfectly with fiducial center
        // if (selectedFiducial) {
        //   const dx = (selectedFiducial.pixelPosition.x - centerX) / pxPerMm;
        //   const dy = (centerY - selectedFiducial.pixelPosition.y) / pxPerMm; // Y flipped

        //   if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        //     const cmds = jogRel({ dx, dy, feed: 3000 });
        //     console.log('[AutoCenter] Sending jog commands:', cmds);
        //     if (window.serial && window.serial.writeLine) {
        //       for (const line of cmds) {
        //         console.log('  > ', line);
        //         window.serial.writeLine(line);
        //       }
        //     } else {
        //       console.warn('[AutoCenter] window.serial.writeLine not available — machine not connected?');
        //     }
        //   } else {
        //     console.log('[AutoCenter] Already centered, no jog needed');
        //   }
        // }

        // alert(`Successfully detected ${result.fiducials.length} fiducials!`);
      } else {
        alert('No fiducials found matching constraints (Max 1.0mm dia, 2mm isolation).');
      }
    } catch (error) {
      console.error('Camera fiducial detection failed:', error);
      alert('Fiducial detection failed: ' + error.message);
    } finally {
      setAutoDetecting(false);
    }
  };

  // hasJoggedRef: resets when user starts a new detection session.
  // Ensures jog fires exactly once per session, automatically.
  const hasJoggedRef = useRef(false);

  // Start continuous fiducial monitoring
  const startContinuousDetection = () => {
    if (!videoRef.current || !streamOn) {
      alert('Please start the camera first');
      return;
    }

    if (detectionInterval) {
      clearInterval(detectionInterval);
      setDetectionInterval(null);
      setVisionResult(null);
      hasJoggedRef.current = false; // Reset so next session can jog again
      return;
    }

    // Reset jog flag for this new detection session
    hasJoggedRef.current = false;

    const pxmm = pixelsPerMm || 20;
    const intervalId = fiducialDetector.startContinuousDetection(
      videoRef.current,
      (result) => {
        if (result.success && result.fiducials.length > 0) {
          const videoWidth = videoRef.current.videoWidth || 640;
          const videoHeight = videoRef.current.videoHeight || 480;
          const centerX = videoWidth / 2;
          const centerY = videoHeight / 2;

          // --- ONLY ACCEPT THE FIDUCIAL UNDER THE CROSSHAIRS ---
          let closestDist = Infinity;
          let selectedFiducial = null;
          const newlyRejected = [];

          result.fiducials.forEach(fid => {
            const dist = Math.hypot(fid.pixelPosition.x - centerX, fid.pixelPosition.y - centerY);
            if (dist < closestDist) {
              if (selectedFiducial) {
                newlyRejected.push({ ...selectedFiducial, reason: 'Off-Center' });
              }
              closestDist = dist;
              selectedFiducial = fid;
            } else {
              newlyRejected.push({ ...fid, reason: 'Off-Center' });
            }
          });

          // Enforce 80px radius limit
          const SNAP_RADIUS_PX = 80;
          let finalFiducials = [];
          let finalRejected = [...(result.rejectedBlobs || []), ...newlyRejected];

          if (selectedFiducial && closestDist <= SNAP_RADIUS_PX) {
            finalFiducials = [selectedFiducial];
          } else if (selectedFiducial) {
            finalRejected.push({ ...selectedFiducial, reason: 'Too Far from Crosshair' });
          }

          // Accumulation Logic
          const currentMPos = machinePositionRef.current;
          if (!currentMPos) {
            // Just show visual feedback if no MPos involved
            setVisionResult(prev => ({
              detected: true,
              fiducials: finalFiducials,
              rejectedBlobs: finalRejected,
              confidence: finalFiducials.length > 0 ? finalFiducials[0].confidence : 0
            }));
            return;
          }

          setVisionResult(prev => ({
            detected: true,
            fiducials: finalFiducials,
            rejectedBlobs: finalRejected,
            confidence: finalFiducials.length > 0 ? finalFiducials[0].confidence : 0
          }));

          // 1. Calculate World Positions for new potential fiducials
          // MUST use clientWidth to match the physical UI canvas rendering
          const pxPerMm = getScale(); // Approximate

          const incomingCandidates = finalFiducials.map(f => {
            const matchData = getMachineCoordinateFromPixel(f.pixelPosition.x, f.pixelPosition.y, videoWidth, videoHeight);
            if (!matchData) return f;

            return {
              ...f,
              estimatedWorld: {
                x: matchData.x,
                y: matchData.y
              }
            };
          });

          const cProps = latestPropsRef.current;
          const currentFids = cProps.fiducials;
          const updateCallback = cProps.onUpdateFiducials;
          const boardName = cProps.activeBoardName || 'Unknown Board';
          const pBoards = cProps.panelBoards;
          const setPBoards = cProps.setPanelBoards;

          const hasMultiBoards = pBoards && pBoards.length > 0 && setPBoards;

          // Gather all defined design fiducials across all boards
          let allFids = [];
          if (hasMultiBoards) {
            pBoards.forEach((b, bIdx) => {
              b.fiducials.forEach((f, fIdx) => {
                if (f.design) allFids.push({ ...f, bIdx, fIdx, boardName: b.name });
              });
            });
          }

          let changedBoards = false;
          let nextBoards = hasMultiBoards ? [...pBoards] : [];
          let fidsChanged = false;
          let nextFids = [...currentFids];

          const pOrigin = cProps.effectiveOrigin || { x: 0, y: 0 };
          const camOffset = cProps.cameraOffset || { dx: 0, dy: 0 };
          const activeBIdx = hasMultiBoards ? Math.max(0, pBoards.findIndex(b => b.name === boardName)) : -1;

          incomingCandidates.forEach(cand => {
            const rawDesignX = (cand.estimatedWorld.x + pOrigin.x) - camOffset.dx;
            const rawDesignY = (cand.estimatedWorld.y + pOrigin.y) - camOffset.dy;

            if (hasMultiBoards && nextBoards[activeBIdx]) {
              let targetFidIdx = -1;

              // Check if it's updating an already active fiducial (Proximity search)
              nextBoards[activeBIdx].fiducials.forEach((f, fIdx) => {
                 if (!f.design) return;
                 const dist = Math.hypot(f.design.x - rawDesignX, f.design.y - rawDesignY);
                 if (dist < 5.0) targetFidIdx = fIdx; 
              });

              const newFiducials = [...nextBoards[activeBIdx].fiducials];

              if (targetFidIdx >= 0) {
                 const existingMachine = newFiducials[targetFidIdx].machine;
                 const distChange = existingMachine ? Math.hypot(existingMachine.x - cand.estimatedWorld.x, existingMachine.y - cand.estimatedWorld.y) : Infinity;
                 
                 // Only update if it moved significantly to avoid continuous jitter override logs
                 if (distChange > 0.1) {
                    newFiducials[targetFidIdx] = {
                       ...newFiducials[targetFidIdx],
                       machine: cand.estimatedWorld,
                       design: { x: parseFloat(rawDesignX.toFixed(3)), y: parseFloat(rawDesignY.toFixed(3)) },
                       pixelPosition: cand.pixelPosition,
                       autoDetected: true,
                       confidence: cand.confidence
                    };
                    nextBoards[activeBIdx] = { ...nextBoards[activeBIdx], fiducials: newFiducials };
                    changedBoards = true;
                 }
              } else {
                 // Create totally new fiducial dynamically using explicit math!
                 targetFidIdx = newFiducials.findIndex(f => !f.design);
                 
                 const newFid = {
                    id: targetFidIdx >= 0 ? newFiducials[targetFidIdx].id : `F${newFiducials.length + 1}`,
                    color: targetFidIdx >= 0 ? newFiducials[targetFidIdx].color : `#${Math.floor(Math.random() * 16777215).toString(16)}`,
                    design: { x: parseFloat(rawDesignX.toFixed(3)), y: parseFloat(rawDesignY.toFixed(3)) },
                    machine: cand.estimatedWorld,
                    pixelPosition: cand.pixelPosition,
                    autoDetected: true,
                    confidence: cand.confidence
                 };
                 
                 if (targetFidIdx >= 0) {
                    newFiducials[targetFidIdx] = newFid;
                 } else {
                    newFiducials.push(newFid);
                 }
                 nextBoards[activeBIdx] = { ...nextBoards[activeBIdx], fiducials: newFiducials };
                 changedBoards = true;
              }
            } else {
              // Legacy non-multi-board mode
              const emptyIdx = nextFids.findIndex(f => !f.design);
              let pushIdx = emptyIdx !== -1 ? emptyIdx : nextFids.length;
              
              nextFids[pushIdx] = {
                 ...(nextFids[pushIdx] || { id: `F${pushIdx + 1}`, color: '#2ea8ff' }),
                 machine: cand.estimatedWorld,
                 design: { x: parseFloat(rawDesignX.toFixed(3)), y: parseFloat(rawDesignY.toFixed(3)) },
                 autoDetected: true,
                 confidence: cand.confidence
              };
              fidsChanged = true;
            }
          });

          if (changedBoards && setPBoards) {
            console.log("Global Panel State Updated:", nextBoards.map(b => ({ name: b.name, fiducials: b.fiducials })));
            setPBoards(nextBoards);
          } else if (fidsChanged && updateCallback) {
            console.log(`[${boardName}] Fallback Local Update:`, nextFids);
            updateCallback(nextFids);
          }

          // Visual Feedback: Show current frame results
          setVisionResult({
            detected: true,
            fiducials: result.fiducials,
            confidence: result.fiducials.length > 0 ? result.fiducials[0].confidence : 0
          });

          // --- LIVE OFFSET TRACKING + one-shot auto-jog ---
          if (result.fiducials.length > 0) {
            const detected = result.fiducials[0];

            const crosshairCoord = getMachineCoordinateFromPixel(videoWidth / 2, videoHeight / 2, videoWidth, videoHeight);
            const detectedFidCoord = getMachineCoordinateFromPixel(detected.pixelPosition.x, detected.pixelPosition.y, videoWidth, videoHeight);

            if (crosshairCoord && detectedFidCoord) {
              let autoDx = detectedFidCoord.x - crosshairCoord.x;
              let autoDy = detectedFidCoord.y - crosshairCoord.y;

              // Halve the offset to avoid overshoot
              autoDx = parseFloat((autoDx / 2.0).toFixed(3));
              autoDy = parseFloat((autoDy / 2.0).toFixed(3));

              // Update display state only when meaningfully changed
              setCameraOffset(prev => {
                if (Math.abs(prev.dx - autoDx) > 0.005 || Math.abs(prev.dy - autoDy) > 0.005) {
                  return { dx: autoDx, dy: autoDy };
                }
                return prev;
              });

              // Auto-jog ONCE per detection session — flag prevents repeat firing
              if (!hasJoggedRef.current && (Math.abs(autoDx) > 0.005 || Math.abs(autoDy) > 0.005)) {
                hasJoggedRef.current = true; // Lock immediately before async jog
                console.log(`[FiducialAlign] Auto-jogging once by ΔX:${autoDx} ΔY:${autoDy}`);
                jogCameraToNozzle({ dx: autoDx, dy: autoDy });
              }
            }
          }
        }
      },
      1000,
      { pxPerMm: pxmm, debug: true }
    );

    setDetectionInterval(intervalId);
  };

  const clearAccumulatedFiducials = () => {
    // Clear machine coordinates from all fiducials
    const cleared = fiducials.map(f => ({ ...f, machine: null, autoDetected: false }));
    if (onUpdateFiducials) onUpdateFiducials(cleared);
  };

  const analyzeQuality = async () => {
    if (!qualityController || !selectedDesign || !H) return;

    try {
      const canvas = canvasRef.current;
      const padInfo = {
        id: 'current',
        position: selectedDesign,
        size: { width: 1, height: 1 }
      };

      const result = await qualityController.analyzePasteQuality(canvas, padInfo, H);
      setQualityResult(result);

      if (result) {
        console.log('Quality analysis:', result);
      }
    } catch (error) {
      console.error('Quality analysis failed:', error);
    }
  };

  // Jog nozzle by the camera-to-nozzle offset so it aligns over the fiducial center.
  // Called once after a successful one-shot fiducial detection.
  // const jogCameraToNozzle = async (offset) => {
  //   if (!offset || (offset.dx === 0 && offset.dy === 0)) return;
  //   // console.log("Offset:", offset);
  //   const cmds = jogRel({ dx: offset.dx, dy: offset.dy, feed: 1000 });
  //   if (window.serial && window.serial.writeLine) {
  //     for (const cmd of cmds) await window.serial.writeLine(cmd);
  //     console.log(`[FiducialOffset] Nozzle jogged ΔX:${offset.dx.toFixed(3)} ΔY:${offset.dy.toFixed(3)} mm → nozzle now over fiducial center`);
  //   } else {
  //     console.warn('[FiducialOffset] Serial not connected — offset jog skipped. Would have jogged:', offset);
  //   }
  // };

  const jogCameraToNozzle = async (offset) => {
    if (!offset || (offset.dx === 0 && offset.dy === 0)) return;

    const cmds = jogRel({ dx: offset.dx, dy: offset.dy, feed: 1000 });

    if (window.serial && window.serial.writeLine) {
      for (const cmd of cmds) {
        await window.serial.writeLine(cmd);
      }
      console.log(
        `[FiducialOffset] Nozzle jogged ΔX:${offset.dx.toFixed(3)} ΔY:${offset.dy.toFixed(3)} mm`
      );
    } else {
      console.warn(
        '[FiducialOffset] Serial not connected — offset jog skipped. Would have jogged:',
        offset
      );
    }
  };

  function solveNow() {
    const wp = [], pp = [];
    pairs.forEach(p => { if (p.world && p.pixel) { wp.push(p.world); pp.push(p.pixel); } });
    const Hm = solveHomography(wp, pp);
    if (!Hm) return alert("Need at least 4 valid pairs to solve.");
    setH(Hm);
  }

  const jog = async (axis, dir) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const dist = dir * jogStep;
      const cmds = jogRel(axis === 'X' ? { dx: dist, feed: 2000 } : { dy: dist, feed: 2000 });
      if (window.serial && window.serial.writeLine) {
        for (const line of cmds) await window.serial.writeLine(line);
      }
    } catch (e) {
      console.error("Jog failed", e);
    } finally {
      setIsBusy(false);
    }
  };

  const jogZ = async (dir) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const cmds = jogRel({ dz: dir * 0.5, feed: 500 });
      if (window.serial && window.serial.writeLine) {
        for (const line of cmds) await window.serial.writeLine(line);
      }
    } catch (e) {
      console.error("Jog Z failed", e);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="panel camera-panel">
      <h3>Camera / Overlay Verification</h3>

      <div className="box advanced-features-box">
        <legend>Advanced Features</legend>
        <div className="advanced-features-checkboxes">
          <label>
            <input
              type="checkbox"
              checked={visionEnabled}
              onChange={(e) => setVisionEnabled(e.target.checked)}
            />
            Vision Guidance
          </label>
          {visionEnabled && (
            <button className="btn sm" onClick={detectPadAtPosition} disabled={!selectedDesign || autoDetecting}>
              {autoDetecting ? 'Detecting...' : 'Detect Pad'}
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={qualityEnabled}
              onChange={(e) => setQualityEnabled(e.target.checked)}
            />
            Quality Control
          </label>
          {qualityEnabled && (
            <button className="btn sm" onClick={analyzeQuality} disabled={!selectedDesign}>
              Analyze Quality
            </button>
          )}
        </div>
        {/* <div className="advanced-features-checkboxes" style={{ marginTop: 8 }}>
          <label>
            <input type="checkbox" checked={invertCameraX} onChange={e => setInvertCameraX(e.target.checked)} />
            Invert Camera X Axis
          </label>
          <label>
            <input type="checkbox" checked={invertCameraY} onChange={e => setInvertCameraY(e.target.checked)} />
            Invert Camera Y Axis
          </label>
        </div> */}

        <div className="fiducial-detection-section">
          <h4>Automated Fiducial Detection</h4>
          <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className={`btn ${detectionInterval ? 'primary' : ''}`}
              onClick={startContinuousDetection}
              disabled={!streamOn}
            >
              {detectionInterval ? 'Stop Auto-Detect' : '📷 Start Auto-Detect'}
            </button>
            <button className="btn sm secondary" onClick={clearAccumulatedFiducials} disabled={!fiducials.some(f => f.machine)}>
              Clear
            </button>
          </div>
          <small style={{ fontSize: '12px', color: '#6c757d' }}>
            Start the camera and click 'Start Auto-Detect'. As you jog the machine, any fiducials seen by the camera will be instantly logged and saved to the active board automatically!
          </small>
        </div>

        {/* Camera → Nozzle Offset */}
        <div className="box" style={{ marginTop: 12, padding: 10, borderRadius: 8, border: '1px solid #dee2e6', background: '#f8f9fa' }}>
          <legend style={{ fontSize: '0.85em', fontWeight: 'bold', color: '#495057', marginBottom: 6 }}>📐 Camera → Nozzle Offset</legend>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.85em' }}>
              <span style={{ color: '#6c757d', fontWeight: 'bold' }}>Camera Scale (px/mm)</span>
              <input
                type="number" step="0.1"
                defaultValue={pixelsPerMm || 20}
                onBlur={e => setPixelsPerMm(parseFloat(e.target.value) || 20)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    setPixelsPerMm(parseFloat(e.target.value) || 20);
                    e.target.blur();
                  }
                }}
                style={{ width: 100, padding: '3px 6px', borderRadius: 4, border: '1px solid #007bff', background: '#e9ecef', fontFamily: 'monospace', fontWeight: 'bold' }}
              />
            </label>
            <div style={{ width: '1px', height: '30px', background: '#dee2e6', margin: '0 4px' }}></div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.85em' }}>
              <span style={{ color: '#6c757d' }}>ΔX (mm)</span>
              <input
                type="number" step="0.001"
                value={cameraOffset.dx}
                onChange={e => setCameraOffset(o => ({ ...o, dx: parseFloat(e.target.value) || 0 }))}
                style={{ width: 80, padding: '3px 6px', borderRadius: 4, border: '1px solid #ced4da', fontFamily: 'monospace' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.85em' }}>
              <span style={{ color: '#6c757d' }}>ΔY (mm)</span>
              <input
                type="number" step="0.001"
                value={cameraOffset.dy}
                onChange={e => setCameraOffset(o => ({ ...o, dy: parseFloat(e.target.value) || 0 }))}
                style={{ width: 80, padding: '3px 6px', borderRadius: 4, border: '1px solid #ced4da', fontFamily: 'monospace' }}
              />
            </label>
            <button
              className="btn sm secondary"
              style={{ alignSelf: 'flex-end', marginBottom: 2 }}
              onClick={() => setCameraOffset({ dx: 0, dy: 0 })}
            >
              Reset
            </button>
          </div>
          <small style={{ fontSize: '11px', color: '#6c757d', display: 'block', marginTop: 5 }}>
            Run <b>Start Auto-Detect</b> — when a fiducial is found, the nozzle automatically jogs once by the detected offset to center over it.
          </small>
        </div>
      </div>

      {/* Video Container - No more Object-Fit Cover! Preserves mathematical alignment */}
      <div style={{ position: "relative", width: "100%", background: "#111", borderRadius: 8, overflow: "hidden", pointerEvents: "auto" }}>
        <video ref={videoRef} style={{ width: "100%", height: "auto", display: "block" }} muted playsInline />
        <canvas ref={canvasRef}
          onClick={onCanvasClick}
          style={{ position: "absolute", inset: 0, pointerEvents: "auto", width: "100%", height: "100%" }} />
      </div>

      {/* Camera Controls */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {!streamOn ? (
          <button className="btn" onClick={startCam}>Start Camera</button>
        ) : (
          <button className="btn secondary" onClick={stopCam}>Stop Camera</button>
        )}
        <label className="row" style={{ gap: 8, marginLeft: 8 }}>
          <input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} />
          Show overlay
        </label>
        <label className="row" style={{ gap: 8, marginLeft: 8 }}>
          <input type="checkbox" checked={measureMode} onChange={e => setMeasureMode(e.target.checked)} />
          Measure error
        </label>
      </div>

      <div className="camera-controls-row" style={{ marginTop: 12 }}>
        {/* Added Lens Calibration Wizard to the sidebar */}
        {/* <LensCalibration
          pixelsPerMm={pixelsPerMm}
          setPixelsPerMm={setPixelsPerMm}
          machinePosition={machinePosition}
          visionResult={visionResult}
        /> */}

        {/* <div className="section" style={{ border: '1px solid #444', borderRadius: '4px', marginBottom: '12px', padding: '12px', background: '#2c2e33' }}>
          <legend style={{ color: '#007bff', fontWeight: 'bold', marginBottom: 8 }}>Mini Jog Controls</legend>
          <div className="flex-row" style={{ gap: 16, alignItems: 'center', justifyContent: 'center' }}>
            <div className="jog-controls-mini" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 40px)', gridTemplateRows: 'repeat(3, 40px)', gap: 4, textAlign: 'center' }}>
              <div></div>
              <button onClick={() => jog('Y', -1)} disabled={isBusy} className="btn" style={{ padding: 0, width: '100%', height: '100%' }}>Y+</button>
              <div></div>
              <button onClick={() => jog('X', -1)} disabled={isBusy} className="btn" style={{ padding: 0, width: '100%', height: '100%' }}>X-</button>
              <button disabled className="btn secondary" style={{ opacity: 0.5, padding: 0, width: '100%', height: '100%' }}>{"\u25ef"}</button>
              <button onClick={() => jog('X', 1)} disabled={isBusy} className="btn" style={{ padding: 0, width: '100%', height: '100%' }}>X+</button>
              <div></div>
              <button onClick={() => jog('Y', 1)} disabled={isBusy} className="btn" style={{ padding: 0, width: '100%', height: '100%' }}>Y-</button>
              <div></div>
            </div>
            <div className="flex-col" style={{ gap: 4 }}>
              <button onClick={() => jogZ(1)} disabled={isBusy} className="btn sm" style={{ height: 40, width: 50 }}>Z Up</button>
              <button onClick={() => jogZ(-1)} disabled={isBusy} className="btn sm" style={{ height: 40, width: 50 }}>Z Down</button>
            </div>
            <div className="flex-col" style={{ gap: 8, marginLeft: 16 }}>
              <small>Step (mm):</small>
              <div className="flex-row" style={{ gap: 4 }}>
                {[0.1, 1, 5, 10].map(s => (
                  <button key={s} onClick={() => setJogStep(s)} className={`btn sm ${jogStep === s ? 'primary' : 'secondary'} `}>{s}</button>
                ))}
              </div>
            </div>
          </div>
        </div> */}
      </div>

      {/* Settings Row - Nozzle & Tool Offset */}
      {/* <div className="camera-controls-row" style={{ marginTop: 12 }}> */}
      {/* Nozzle & Dispensing */}
      {/* <div className="box nozzle-section">
          <legend>Nozzle & Dispensing</legend>
          <div className="settings-grid">
            <div className="settings-field">
              <label>Diameter (mm)</label>
              <input type="number" step="0.05" value={nozzleDia ?? 0.6}
                onChange={e => setNozzleDia(Math.max(0.05, +e.target.value || 0.6))} />
            </div>
            <div className="settings-field">
              <label>Pressure (bar)</label>
              <input type="number" step="0.1" defaultValue="2.0" />
            </div>
            <div className="settings-field">
              <label>Flow Rate (%)</label>
              <input type="number" step="5" defaultValue="50" />
            </div>
            <div className="settings-field">
              <label>Duration (ms)</label>
              <input type="number" step="10" defaultValue="100" />
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" disabled={!selectedDesign}>Test Dispense</button>
            <button className="btn secondary">Prime Nozzle</button>
          </div>
        </div> */}

      {/* Tool Offset */}
      {/* <div className="box tool-offset-section">
          <legend>Tool Offset</legend>
          <div className="offset-inputs">
            <div className="offset-field">
              <span>ΔX (mm)</span>
              <input type="number" step="0.01" value={toolOffset?.dx ?? 0}
                onChange={e => setToolOffset({ dx: +e.target.value || 0, dy: toolOffset?.dy || 0 })} />
            </div>
            <div className="offset-field">
              <span>ΔY (mm)</span>
              <input type="number" step="0.01" value={toolOffset?.dy ?? 0}
                onChange={e => setToolOffset({ dx: toolOffset?.dx || 0, dy: +e.target.value || 0 })} />
            </div>
          </div>
          <small style={{ fontSize: '12px', color: '#6c757d' }}>
            Offsets are added to machine XY before projecting to camera. Saved in your browser.
          </small>
        </div> */}
      {/* </div> */}
    </div>
  );
}
