import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fitAffine, fitSimilarity, fitTranslation, applyTransform } from "../lib/utils/transform2d.js";
import LensCalibration from "./LensCalibration.jsx";
import { FiducialVisionDetector } from "../lib/vision/fiducialVision.js";
import { PadDetector } from "../lib/vision/padDetection.js";
import { jogRel, moveAbs } from "../lib/motion/gcode";
import "./CameraPanel.css";

/**
 * Predict where a fiducial should be in machine coordinates.
 * Priority: full transform → translation from one solved point → origin offset → null.
 */
function predictFidMachinePos(fid, allFiducials, xf, effectiveOrigin) {
  if (!fid?.design) return null;
  if (xf) return applyTransform(xf, fid.design);
  const solved = (allFiducials || []).find(f => f.id !== fid.id && f.design && f.machine);
  if (solved) return { x: fid.design.x + (solved.machine.x - solved.design.x), y: fid.design.y + (solved.machine.y - solved.design.y) };
  if (effectiveOrigin) return { x: fid.design.x + effectiveOrigin.x, y: fid.design.y + effectiveOrigin.y };
  return null;
}

function LensDistortionCalibration() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const BASE = 'http://localhost:8000/api/calibration';

  const refreshStatus = async () => {
    try {
      const r = await fetch(`${BASE}/status`);
      if (r.ok) setStatus(await r.json());
    } catch { setStatus(null); }
  };

  const capture = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${BASE}/capture`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) { alert(`Frame ${d.captures} captured — pattern found!`); await refreshStatus(); }
      else alert(`Not captured: ${d.error}`);
    } catch { alert('Vision server offline'); }
    finally { setBusy(false); }
  };

  const compute = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${BASE}/compute`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) { alert(`Calibration done — RMS=${d.rms_error} using ${d.frames_used} frames`); await refreshStatus(); }
      else alert(`Compute failed: ${d.error}`);
    } catch { alert('Vision server offline'); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!confirm('Delete all calibration data?')) return;
    setBusy(true);
    try { await fetch(`${BASE}/reset`, { method: 'POST' }); await refreshStatus(); }
    catch { alert('Vision server offline'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid #444', borderRadius: 4, marginBottom: 12 }}>
      <div
        style={{ padding: '8px 12px', background: '#2c2e33', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => { setExpanded(e => !e); if (!expanded) refreshStatus(); }}
      >
        <strong style={{ color: '#4fc3f7', fontSize: '0.9em' }}>Lens Distortion Calibration</strong>
        <span style={{ color: '#888', fontSize: '0.8em' }}>{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <div style={{ padding: 12, background: '#1d1f24', fontSize: '0.82em' }}>
          <p style={{ color: '#9aa0a6', margin: '0 0 10px' }}>
            Print a 9×6 inner-corner chessboard. Hold it at various angles in front of the camera.
            Click <em>Capture</em> ≥10 times, then <em>Compute</em>.
          </p>
          {status && (
            <div style={{ marginBottom: 10, padding: '6px 10px', background: status.calibrated ? 'rgba(0,196,154,0.1)' : '#222', borderRadius: 4, borderLeft: `3px solid ${status.calibrated ? '#00c49a' : '#888'}` }}>
              {status.calibrated
                ? <span style={{ color: '#00c49a' }}>Active — RMS: {status.rms_error}  ({status.captures} frames)</span>
                : <span style={{ color: '#888' }}>Not calibrated — {status.captures} frame(s) captured</span>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={capture} disabled={busy}>Capture</button>
            <button className="btn sm primary" onClick={compute} disabled={busy}>Compute</button>
            <button className="btn sm danger" onClick={reset} disabled={busy}>Reset</button>
            <button className="btn sm" onClick={refreshStatus} disabled={busy}>Status</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CameraPanel({
  fiducials = [],
  xf,
  applyXf,
  selectedDesign,
  effectiveOrigin,
  toolOffset,
  setToolOffset,
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
  pads = [],
  gerberFiducials = [],
  fidActiveId = null,
  panelRailFiducials = [],
  setPanelRailFiducials,
  onAdvanceArmedFid,
  panelXf = null,
  side = 'top',
  isJobRunning = false,
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

  const [nozzleDia, setNozzleDia] = useState(() => {
    try { return JSON.parse(localStorage.getItem("nozzleDia") || "0.6"); }
    catch { return 0.6; }
  });
  useEffect(() => { localStorage.setItem("nozzleDia", JSON.stringify(nozzleDia)); }, [nozzleDia]);

  // Ref to hold latest props for stale-closure avoidance in setInterval
  const latestPropsRef = useRef({ fiducials, onUpdateFiducials, activeBoardName, panelBoards, setPanelBoards, pixelsPerMm, setPixelsPerMm, effectiveOrigin, pads, cameraOffset: { dx: 0, dy: 0 }, fidActiveId, panelRailFiducials, setPanelRailFiducials, onAdvanceArmedFid, xf, panelXf });
  useEffect(() => {
    latestPropsRef.current = { fiducials, onUpdateFiducials, activeBoardName, panelBoards, setPanelBoards, pixelsPerMm, setPixelsPerMm, effectiveOrigin, pads, cameraOffset, fidActiveId, panelRailFiducials, setPanelRailFiducials, onAdvanceArmedFid, xf, panelXf };
  }, [fiducials, onUpdateFiducials, activeBoardName, panelBoards, setPanelBoards, pixelsPerMm, setPixelsPerMm, effectiveOrigin, pads, cameraOffset, fidActiveId, panelRailFiducials, setPanelRailFiducials, onAdvanceArmedFid, xf, panelXf]);

  const [streamOn, setStreamOn] = useState(false);

  // ─── Option A: Camera exposure / gain / brightness (software, works now) ──
  // Controlled via POST /api/camera/settings on the Python vision server.
  // No additional hardware required — adjusts how the USB camera captures frames.
  const [camAutoExposure, setCamAutoExposure] = useState(true);
  const [camExposure,     setCamExposure]     = useState(-6);   // DirectShow log scale -13..−1
  const [camGain,         setCamGain]         = useState(0);    // 0–255
  const [camBrightness,   setCamBrightness]   = useState(128);  // 0–255

  const applyCameraSettings = async (patch) => {
    try {
      await fetch(`${PYTHON_URL}/api/camera/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch { /* vision server offline — ignore silently */ }
  };

  // ─── Python Vision Mode ────────────────────────────────────────────
  const [pythonMode, setPythonMode] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pythonVisionMode') || 'false'); } catch { return false; }
  });
  const [pythonServerOk, setPythonServerOk] = useState(false);
  const [pythonVisionData, setPythonVisionData] = useState(null);
  const pythonPollRef = useRef(null);  // setInterval handle for vision data polling
  const PYTHON_URL = 'http://localhost:8000';

  // Persist mode preference
  useEffect(() => { localStorage.setItem('pythonVisionMode', JSON.stringify(pythonMode)); }, [pythonMode]);

  // Sync pixelsPerMm to Python server whenever it changes
  useEffect(() => {
    if (pythonMode && pythonServerOk && pixelsPerMm) {
      fetch(`${PYTHON_URL}/api/set_px_per_mm/${pixelsPerMm}`, { method: 'POST' }).catch(() => { });
    }
  }, [pixelsPerMm, pythonMode, pythonServerOk]);

  // Ping the Python server every 3s to show live status in UI
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${PYTHON_URL}/api/status`, { signal: AbortSignal.timeout(1500) });
        const d = await r.json();
        setPythonServerOk(d.ok === true);
      } catch { setPythonServerOk(false); }
    };
    check();
    const id = setInterval(check, 3000);
    return () => clearInterval(id);
  }, []);

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
  const [lastClickPx, setLastClickPx] = useState(null);
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
  const detectionIntervalRef = useRef(null);
  useEffect(() => { detectionIntervalRef.current = detectionInterval; }, [detectionInterval]);

  // Stop auto-detect when a dispensing job starts
  useEffect(() => {
    if (!isJobRunning) return;
    const iv = detectionIntervalRef.current;
    if (!iv) return;
    clearInterval(iv);
    setDetectionInterval(null);
    setVisionResult(null);
    // Also stop Python-mode detection if active
    if (pythonPollRef.current) {
      clearInterval(pythonPollRef.current);
      pythonPollRef.current = null;
      fetch(`${PYTHON_URL}/api/stop_detect`, { method: 'POST' }).catch(() => {});
    }
  }, [isJobRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  const [jogStep, setJogStep] = useState(1);
  const [jogMultiplier, setJogMultiplier] = useState(1);
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
    if (pythonMode) {
      // Python mode: camera is managed by Python server. Just mark as streaming.
      if (!pythonServerOk) {
        alert('Python Vision Server is not running!\nRun: npm run install:python\nThen restart npm run dev');
        return;
      }
      setStreamOn(true);
      return;
    }
    // Browser mode: use getUserMedia
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      videoRef.current.srcObject = s;
      await videoRef.current.play();
      setStreamOn(true);
      tick();
    } catch (e) {
      console.error(e);
      alert('Could not start camera. Check permissions or device.');
    }
  }
  function stopCam() {
    if (pythonMode) {
      // Stop Python detection polling if running
      if (pythonPollRef.current) { clearInterval(pythonPollRef.current); pythonPollRef.current = null; }
      fetch(`${PYTHON_URL}/api/stop_detect`).catch(() => { });
      setStreamOn(false);
      return;
    }
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
      const pxDist = Math.hypot(dx, dy);
      ctx.fillText(`${mm.toFixed(3)} mm  (${pxDist.toFixed(1)} pixels)`,
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

    // jogMultiplier scales up the physical movement WITHOUT touching the calibrated px/mm value.
    // e.g. at 10× — clicking 2px off-center moves 2/106.6×10 = 0.19mm instead of 0.019mm.
    const dx = (pixelDx / pxmm) * jogMultiplier;
    const dy = (pixelDy / pxmm) * jogMultiplier;

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

  // --- DYNAMIC FIDUCIAL API FOR AUTOMATED JOBS ---
  useEffect(() => {
    window.__SNAP_FIDUCIAL_MACHINE_COORD__ = async () => {
      if (!streamOn || !machinePositionRef.current) {
        console.warn("[VisionBridge] Camera not ready or machine position unknown.");
        return null;
      }

      try {
        if (pythonMode) {
          // --- Python Vision Mode ---
          const r = await fetch(`${PYTHON_URL}/api/vision_data`);
          const data = await r.json();
          if (data && data.best_circle) {
            const dx = data.offset_dx;
            const dy = data.offset_dy;
            const realNozzleX = machinePositionRef.current.x + (cameraOffset?.dx || 0);
            const realNozzleY = machinePositionRef.current.y + (cameraOffset?.dy || 0);
            return {
              x: realNozzleX + dx,
              y: realNozzleY + dy,
              confidence: 1.0
            };
          }
          return null; // Not found in frame
        } else {
          // --- Browser OpenCV.js Mode ---
          if (!canvasRef.current || !videoRef.current) {
            console.warn("[VisionBridge] Browser video element not ready.");
            return null;
          }
          const pxmm = pixelsPerMm || 20;
          const result = await fiducialDetector.detectFiducialsInFrame(
            videoRef.current, [], { pxPerMm: pxmm }
          );

          if (result && result.fiducials && result.fiducials.length > 0) {
            const detected = result.fiducials[0];
            const vw = videoRef.current.videoWidth;
            const vh = videoRef.current.videoHeight;
            const crosshairCoord = getMachineCoordinateFromPixel(vw / 2, vh / 2, vw, vh);
            const detectedCoord = getMachineCoordinateFromPixel(detected.pixelPosition.x, detected.pixelPosition.y, vw, vh);

            if (crosshairCoord && detectedCoord) {
              const dx = detectedCoord.x - crosshairCoord.x;
              const dy = detectedCoord.y - crosshairCoord.y;

              const realNozzleX = machinePositionRef.current.x + (cameraOffset?.dx || 0);
              const realNozzleY = machinePositionRef.current.y + (cameraOffset?.dy || 0);

              return {
                x: realNozzleX + dx,
                y: realNozzleY + dy,
                confidence: detected.confidence
              };
            }
          }
          return null; // Not found in frame
        }
      } catch (err) {
        console.error("[VisionBridge] Snap failed:", err);
        return null;
      }
    };

    return () => delete window.__SNAP_FIDUCIAL_MACHINE_COORD__;
  }, [streamOn, pythonMode, cameraOffset, pixelsPerMm, fiducialDetector, getMachineCoordinateFromPixel]);

  // --- PAD OFFSET BRIDGE FOR VISUAL SERVO (browser fallback) ---
  // AutomatedDispensingPanel calls window.__DETECT_PAD_OFFSET__() when the
  // Python server is unreachable. Returns { found, offset_dx, offset_dy } in mm
  // so the servo loop can apply the same damped correction in browser-only mode.
  useEffect(() => {
    window.__DETECT_PAD_OFFSET__ = async () => {
      if (!streamOn || !videoRef.current) return { found: false };
      try {
        const pxmm = pixelsPerMm || 20;
        const result = await fiducialDetector.detectCenterFeature(videoRef.current);
        if (result && result.success && result.detected && result.pixelDelta) {
          return {
            found: true,
            offset_dx: result.pixelDelta.pixelDx / pxmm,
            offset_dy: result.pixelDelta.pixelDy / pxmm,
          };
        }
        return { found: false };
      } catch {
        return { found: false };
      }
    };
    return () => delete window.__DETECT_PAD_OFFSET__;
  }, [streamOn, pixelsPerMm, fiducialDetector]);

  // Blocks detection for N ms after any successful fiducial save, preventing the auto-advanced
  // arm (e.g. R2 after R1) from receiving the same machine position before the machine moves.
  const saveBlockRef = useRef(0);
  // Tracks the most recently auto-saved fiducial so snap corrections overwrite it instead of advancing.
  const lastAutoSavedRef = useRef(null);   // { id: string, position: {x,y} }
  // When snap detects a correction jog, it sets this so the next servo convergence routes to the right slot.
  const correctionTargetRef = useRef(null); // { id: string, position: {x,y} }

  // Clear all correction/servo state on side switch to prevent top-side refs contaminating bottom-side saves.
  useEffect(() => {
    lastAutoSavedRef.current = null;
    correctionTargetRef.current = null;
    hasJoggedInCycleRef.current = false;
    convergenceCountRef.current = 0;
    servoStateRef.current = { phase: 'idle', lockedAt: null };
  }, [side]);

  // ── Auto-fiducial search ──────────────────────────────────────────────────
  // When the armed fiducial changes AND detection is running, compute the
  // expected camera position from the transform (or a solved-point translation)
  // and send one absolute G1 move so the machine arrives near the fiducial.
  // The servo loop then centres it precisely without manual jogging.
  const [autoSearchStatus, setAutoSearchStatus] = useState('');

  useEffect(() => {
    if (!fidActiveId) { setAutoSearchStatus(''); return; }
    if (!detectionInterval) return; // only move when detection is active
    if (!window.serial?.writeLine) return;

    const cProps = latestPropsRef.current;

    // Find the armed fiducial in rail list first, then board list
    const isRail = (cProps.panelRailFiducials || []).some(f => f.id === fidActiveId);
    const allFids = [...(cProps.panelRailFiducials || []), ...(cProps.fiducials || [])];
    const fid = allFids.find(f => f.id === fidActiveId);
    if (!fid || !fid.design) { setAutoSearchStatus(''); return; }

    // Rail fiducials use panelXf; board fiducials use xf
    const transform = isRail ? cProps.panelXf : cProps.xf;
    const machPos = predictFidMachinePos(fid, cProps.fiducials, transform, cProps.effectiveOrigin);
    if (!machPos) { setAutoSearchStatus('No transform — jog manually'); return; }

    // Camera target = machine position minus camera-to-nozzle offset
    const camOff = cProps.cameraOffset || { dx: 0, dy: 0 };
    const camX = machPos.x - camOff.dx;
    const camY = machPos.y - camOff.dy;

    // Skip move if already within 2 mm (operator is already close enough)
    const curPos = machinePositionRef.current;
    if (curPos && Math.hypot(camX - curPos.x, camY - curPos.y) < 2.0) {
      setAutoSearchStatus('');
      return;
    }

    // Reset servo so it doesn't try to save the old position during transit
    servoStateRef.current = { phase: 'idle', lockedAt: null };
    convergenceCountRef.current = 0;
    hasJoggedInCycleRef.current = false;
    settleUntilRef.current = Date.now() + 2200; // ~2 s for machine to arrive and settle

    const cmds = moveAbs({ x: camX, y: camY, feed: 3000 });
    window.serial.writeLine('G90').catch(() => {});
    cmds.forEach(c => window.serial.writeLine(c).catch(() => {}));

    setAutoSearchStatus(`Moving to ${fidActiveId}…`);
    setTimeout(() => setAutoSearchStatus(''), 2500);
    console.log(`[AutoSearch] ${fidActiveId} → camera (${camX.toFixed(3)}, ${camY.toFixed(3)})`);
  }, [fidActiveId, detectionInterval]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- OVERWRITE HELPER: update a specific slot by ID without advancing the arm dropdown ---
  const overwriteFiducialById = (id, coord) => {
    const cProps = latestPropsRef.current;
    // Rail slots first
    const railFids = cProps.panelRailFiducials || [];
    const railIdx  = railFids.findIndex(f => f.id === id);
    if (railIdx >= 0 && cProps.setPanelRailFiducials) {
      cProps.setPanelRailFiducials(railFids.map((f, i) =>
        i === railIdx ? { ...f, machine: coord, autoDetected: true } : f
      ));
      console.log(`[SnapCorrect] Corrected rail ${id} ← (${coord.x.toFixed(3)}, ${coord.y.toFixed(3)})`);
      return;
    }
    // panelBoards local fiducials
    const pBoards    = cProps.panelBoards;
    const setPBoards = cProps.setPanelBoards;
    const boardName  = cProps.activeBoardName;
    if (pBoards && setPBoards) {
      const bIdx = Math.max(0, pBoards.findIndex(b => b.name === boardName));
      if (pBoards[bIdx]) {
        const newFids = pBoards[bIdx].fiducials.map(f =>
          f.id === id ? { ...f, machine: coord, autoDetected: true } : f
        );
        setPBoards(pBoards.map((b, i) => i === bIdx ? { ...b, fiducials: newFids } : b));
        console.log(`[SnapCorrect] Corrected local ${id} ← (${coord.x.toFixed(3)}, ${coord.y.toFixed(3)})`);
        return;
      }
    }
    // Legacy single-board fallback
    const updated = (cProps.fiducials || []).map(f =>
      f.id === id ? { ...f, machine: coord, autoDetected: true } : f
    );
    cProps.onUpdateFiducials?.(updated);
    console.log(`[SnapCorrect] Corrected fid ${id} ← (${coord.x.toFixed(3)}, ${coord.y.toFixed(3)})`);
  };

  // --- FIDUCIAL STORAGE HELPER ---
  // Takes a confirmed machine coordinate for a fiducial and saves it into the panelBoards state
  const saveFiducialCoordinate = (estimatedWorld, confidence = 1.0) => {
    const cProps = latestPropsRef.current;

    // Correction mode: snap triggered a jog toward a specific slot — route there, not the armed slot.
    const corrTarget = correctionTargetRef.current;
    if (corrTarget) {
      const CORR_DIST = 8; // mm — cancel if machine moved far from where correction was initiated
      if (Math.hypot(estimatedWorld.x - corrTarget.position.x, estimatedWorld.y - corrTarget.position.y) < CORR_DIST) {
        correctionTargetRef.current = null;
        overwriteFiducialById(corrTarget.id, estimatedWorld);
        lastAutoSavedRef.current = { id: corrTarget.id, position: { ...estimatedWorld } };
        saveBlockRef.current = Date.now() + 2000;
        return;
      }
      // Machine moved away — cancel correction mode and fall through to normal save
      correctionTargetRef.current = null;
    }

    // SAME-FIDUCIAL GUARD: machine hasn't physically moved to a new fiducial yet.
    // If the new position is within 3 mm of the last auto-save, overwrite that
    // same slot instead of advancing the arm — prevents the servo re-firing after
    // saveBlockRef expires and writing the same position into the next slot (R2/F2).
    const lastSaved = lastAutoSavedRef.current;
    if (lastSaved && Math.hypot(estimatedWorld.x - lastSaved.position.x, estimatedWorld.y - lastSaved.position.y) < 3.0) {
      overwriteFiducialById(lastSaved.id, estimatedWorld);
      lastAutoSavedRef.current = { id: lastSaved.id, position: { ...estimatedWorld } };
      saveBlockRef.current = Date.now() + 2000;
      console.log(`[FiducialDetect] Still near ${lastSaved.id} — overwriting same slot, arm stays.`);
      return;
    }

    // RAIL ROUTING: if the operator has armed a rail fiducial, save there and return.
    // This is the sole mechanism for routing camera-detected coords to the rail table vs
    // the local table — the operator selects R1/R2 from the arm dropdown before detection.
    const armedId = cProps.fidActiveId;
    const railFids = cProps.panelRailFiducials || [];
    const setRailFids = cProps.setPanelRailFiducials;
    if (armedId && setRailFids) {
      const armedRailIdx = railFids.findIndex(f => f.id === armedId);
      if (armedRailIdx >= 0) {
        setRailFids(railFids.map((f, i) =>
          i === armedRailIdx ? { ...f, machine: estimatedWorld, autoDetected: true } : f
        ));
        console.log(`[FiducialDetect] Rail ${armedId} ← Machine(${estimatedWorld.x.toFixed(3)}, ${estimatedWorld.y.toFixed(3)})`);
        saveBlockRef.current = Date.now() + 4000; // block detection 4s — operator must physically move to next fiducial
        lastAutoSavedRef.current = { id: armedId, position: { ...estimatedWorld } };
        cProps.onAdvanceArmedFid?.(armedId);
        return;
      }
    }

    const currentFids = cProps.fiducials || [];
    const updateCallback = cProps.onUpdateFiducials;
    const boardName = cProps.activeBoardName || 'Unknown Board';
    const pBoards = cProps.panelBoards;
    const setPBoards = cProps.setPanelBoards;

    const hasMultiBoards = pBoards && pBoards.length > 0 && setPBoards;
    let changedBoards = false;
    let nextBoards = hasMultiBoards ? [...pBoards] : [];
    let fidsChanged = false;
    let nextFids = [...currentFids];
    const activeBIdx = hasMultiBoards ? Math.max(0, pBoards.findIndex(b => b.name === boardName)) : -1;
    let savedFidId = null; // captured in each branch for auto-advance

    // Sort Gerber fiducials top-left first (ascending Y, then X within same row).
    // This gives a consistent 1-to-1 mapping: snap 1 → gerberFids[0], snap 2 → gerberFids[1], ...
    const sortedGerberFids = gerberFiducials && gerberFiducials.length > 0
      ? [...gerberFiducials].sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y)
      : [];

    // OVERWRITE RADIUS: if an already-saved slot has a machine coord within this
    // distance of estimatedWorld, update that slot rather than filling the next empty one.
    // This prevents multiple snap attempts from writing to different rows.
    const OVERWRITE_RADIUS_MM = 5.0;

    if (hasMultiBoards && nextBoards[activeBIdx]) {
      const newFiducials = [...nextBoards[activeBIdx].fiducials];

      // How many slots already have a machine coord from camera snapping?
      const snapCount = newFiducials.filter(f => f.machine && f.autoDetected).length;

      // Check if any filled slot is close enough to overwrite
      const nearbyIdx = newFiducials.findIndex(f =>
        f.machine && Math.hypot(f.machine.x - estimatedWorld.x, f.machine.y - estimatedWorld.y) < OVERWRITE_RADIUS_MM
      );

      // Use nearby slot if found, otherwise use the first empty slot
      const targetFidIdx = nearbyIdx >= 0 ? nearbyIdx : newFiducials.findIndex(f => !f.machine);
      const effectiveSnapCount = nearbyIdx >= 0 ? newFiducials.slice(0, nearbyIdx).filter(f => f.machine && f.autoDetected).length : snapCount;

      // Pick the Gerber design coordinate by sequential index — avoids cross-space distance comparisons
      let designCoord;
      if (sortedGerberFids.length > effectiveSnapCount) {
        const gf = sortedGerberFids[effectiveSnapCount];
        designCoord = { x: gf.x, y: gf.y };
        const action = nearbyIdx >= 0 ? 'Overwriting' : 'New snap';
        console.log(`[FiducialDetect] ${action} #${effectiveSnapCount + 1} → Gerber (${gf.x.toFixed(3)}, ${gf.y.toFixed(3)}), machine (${estimatedWorld.x.toFixed(3)}, ${estimatedWorld.y.toFixed(3)})`);
      } else {
        const existing = targetFidIdx >= 0 ? newFiducials[targetFidIdx].design : null;
        designCoord = existing || null;
        console.warn('[FiducialDetect] No Gerber fiducial for this snap — design coord not set');
      }

      const newFid = {
        id: targetFidIdx >= 0 ? newFiducials[targetFidIdx].id : `F${newFiducials.length + 1}`,
        color: targetFidIdx >= 0 ? newFiducials[targetFidIdx].color : '#2ea8ff',
        design: designCoord,
        machine: estimatedWorld,
        autoDetected: true,
        confidence
      };

      if (targetFidIdx >= 0) newFiducials[targetFidIdx] = newFid;
      else newFiducials.push(newFid);
      nextBoards[activeBIdx] = { ...nextBoards[activeBIdx], fiducials: newFiducials };
      changedBoards = true;
      savedFidId = newFid.id;
    } else {
      // Legacy single-board path
      // Check for a nearby already-saved slot to overwrite
      const nearbyIdx = nextFids.findIndex(f =>
        f.machine && Math.hypot(f.machine.x - estimatedWorld.x, f.machine.y - estimatedWorld.y) < OVERWRITE_RADIUS_MM
      );
      const emptyIdx  = nextFids.findIndex(f => !f.machine);
      const snapCount = nextFids.filter(f => f.machine && f.autoDetected).length;
      const pushIdx   = nearbyIdx >= 0 ? nearbyIdx : (emptyIdx !== -1 ? emptyIdx : nextFids.length);
      const effectiveSnapCount = nearbyIdx >= 0
        ? nextFids.slice(0, nearbyIdx).filter(f => f.machine && f.autoDetected).length
        : snapCount;

      let designCoord = null;
      if (sortedGerberFids.length > effectiveSnapCount) {
        const gf = sortedGerberFids[effectiveSnapCount];
        designCoord = { x: gf.x, y: gf.y };
      }

      const action = nearbyIdx >= 0 ? 'Overwrote' : 'New';
      nextFids[pushIdx] = {
        ...(nextFids[pushIdx] || { id: `F${pushIdx + 1}`, color: '#2ea8ff' }),
        machine: estimatedWorld,
        design: designCoord,
        autoDetected: true,
        confidence
      };
      fidsChanged = true;
      savedFidId = nextFids[pushIdx].id;
      console.log(`[FiducialDetect] ${action} slot #${pushIdx + 1} at Machine(${estimatedWorld.x.toFixed(3)}, ${estimatedWorld.y.toFixed(3)})`);
    }

    if (changedBoards && setPBoards) {
      setPBoards(nextBoards);
      console.log(`[FiducialStorage] Saved machine coord (${estimatedWorld.x.toFixed(3)}, ${estimatedWorld.y.toFixed(3)}) to board [${boardName}]`);
    } else if (fidsChanged && updateCallback) {
      updateCallback(nextFids);
    }
    if (savedFidId) {
      saveBlockRef.current = Date.now() + 4000; // block detection 4s — operator must physically move to next fiducial
      lastAutoSavedRef.current = { id: savedFidId, position: { ...estimatedWorld } };
      cProps.onAdvanceArmedFid?.(savedFidId);
    }
  };

  // ── Servo state ─────────────────────────────────────────────────────────
  // phase: 'idle' → jogging toward fiducial; 'fine' → sub-pixel snap; 'converged' → done.
  // lockedAt: machine position when converged, used to detect when user moves to new fiducial.
  const servoStateRef   = useRef({ phase: 'idle', lockedAt: null });
  const settleUntilRef  = useRef(0);     // suppress detection until this timestamp (ms)
  const SERVO_FEED      = 800;           // mm/min jog speed
  const SERVO_SETTLE_MS = 800;           // ms to wait after each jog before re-checking
  const CONVERGE_MM     = 0.05;          // crosshair within 0.05mm → declare converged & save
  const TRULY_CENTRED_MM = 0.008;        // sub-pixel threshold — safe to skip jog requirement
  const CONVERGE_STABLE_FRAMES = 3;      // fine-phase polls needed before saving (prevents Hough false-centre saves)
  const convergenceCountRef = useRef(0); // consecutive fine-phase frames within CONVERGE_MM
  // Guard: servo must have physically jogged at least once per convergence cycle before saving.
  // Prevents saving at a visually off-centre position when the Python API happens to report
  // a near-zero offset on the very first poll (e.g. bottom-side fiducials with different reflectance).
  const hasJoggedInCycleRef = useRef(false);

  // Motion guard: whenever the machine position changes significantly (manual jogging between
  // fiducials), extend the settle timer so the detection loop cannot false-trigger on
  // intermediate positions while the machine is in motion.
  const prevMachPosRef = useRef(null);
  useEffect(() => {
    if (!machinePosition) return;
    const prev = prevMachPosRef.current;
    if (prev) {
      const moved = Math.hypot(machinePosition.x - prev.x, machinePosition.y - prev.y);
      if (moved > 0.05) {
        // Machine is moving — block detection until 1.5 s after the last position change
        settleUntilRef.current = Date.now() + 1500;
      }
    }
    prevMachPosRef.current = { x: machinePosition.x, y: machinePosition.y };
  }, [machinePosition]);

  // hasJoggedRef: legacy ref kept for snapToFiducial lock (browser mode uses it too)
  const hasJoggedRef = useRef(false);

  // Start continuous fiducial detection — branches on pythonMode
  const startContinuousDetection = () => {
    if (pythonMode) {
      // ── Python Mode ─────────────────────────────────────────────────
      if (!streamOn) { alert('Start the camera first!'); return; }
      if (detectionInterval) {
        clearInterval(pythonPollRef.current); pythonPollRef.current = null;
        fetch(`${PYTHON_URL}/api/stop_detect`, { method: 'POST' }).catch(() => {});
        setDetectionInterval(null);
        servoStateRef.current = { phase: 'idle', lockedAt: null };
        return;
      }
      fetch(`${PYTHON_URL}/api/set_px_per_mm/${pixelsPerMm || 98.5}`, { method: 'POST' }).catch(() => {});
      fetch(`${PYTHON_URL}/api/start_detect`, { method: 'POST' }).catch(() => {});

      const pollId = setInterval(async () => {
        try {
          const r    = await fetch(`${PYTHON_URL}/api/vision_data`);
          const data = await r.json();
          setPythonVisionData(data);

          if (Date.now() < settleUntilRef.current) return;
          if (Date.now() < saveBlockRef.current) return; // wait until operator moves to next fiducial

          const machPos = machinePositionRef.current || { x: 0, y: 0 };

          // Reset servo if the user manually jogged to a new fiducial (> 5 mm away)
          if (servoStateRef.current.phase === 'converged') {
            const locked = servoStateRef.current.lockedAt;
            if (locked && Math.hypot(machPos.x - locked.x, machPos.y - locked.y) > 5.0) {
              servoStateRef.current = { phase: 'idle', lockedAt: null };
              convergenceCountRef.current = 0;
              hasJoggedInCycleRef.current = false;
            } else {
              return; // same slot — already converged, nothing to do
            }
          }

          const servoPhase = servoStateRef.current.phase; // 'idle' | 'fine'
          let dx, dy, dist;

          if (servoPhase === 'fine') {
            // Phase 2: sub-pixel centroid via fresh frame ROI — ±1px accuracy
            try {
              const sr   = await fetch(`${PYTHON_URL}/api/snap_offset`);
              const snap = await sr.json();
              if (!snap.found) { servoStateRef.current = { phase: 'idle', lockedAt: null }; convergenceCountRef.current = 0; return; }
              dx   = parseFloat(snap.offset_dx.toFixed(4));
              dy   = parseFloat(snap.offset_dy.toFixed(4));
              dist = Math.hypot(dx, dy);
              // Sanity: sudden large offset after coarse move = false positive, restart
              if (dist > 1.5) {
                servoStateRef.current = { phase: 'idle', lockedAt: null };
                convergenceCountRef.current = 0;
                return;
              }
            } catch { servoStateRef.current = { phase: 'idle', lockedAt: null }; convergenceCountRef.current = 0; return; }
          } else {
            // Phase 1: coarse positioning via Hough circle
            if (!data.best_circle) return;
            dx   = parseFloat(data.offset_dx.toFixed(4));
            dy   = parseFloat(data.offset_dy.toFixed(4));
            dist = Math.hypot(dx, dy);
            if (dist > 8.0) return; // no fiducial in view
          }

          // Allow convergence only if the servo has jogged at least once this cycle,
          // OR the offset is truly sub-pixel (< TRULY_CENTRED_MM). This prevents saving at
          // a visually off-centre position when Python reports near-zero offset on the first poll.
          const canConverge = hasJoggedInCycleRef.current || dist <= TRULY_CENTRED_MM;

          if (dist <= CONVERGE_MM && canConverge) {
            if (servoPhase !== 'fine') {
              // Coarse phase: Hough circle centre may be off by several pixels — do NOT save yet.
              // Upgrade to fine mode so the next poll uses the sub-pixel Otsu centroid.
              servoStateRef.current = { ...servoStateRef.current, phase: 'fine' };
              convergenceCountRef.current = 0;
              console.log('[PyServo] Within coarse threshold — switching to fine phase for sub-pixel confirmation');
            } else {
              convergenceCountRef.current++;
              if (convergenceCountRef.current >= CONVERGE_STABLE_FRAMES) {
                // ✅ Sub-pixel centroid stable for N consecutive frames — truly centred on fiducial
                servoStateRef.current = { phase: 'converged', lockedAt: { x: machPos.x, y: machPos.y } };
                convergenceCountRef.current = 0;
                hasJoggedInCycleRef.current = false; // reset for next fiducial
                const camOffset  = cameraOffset || { dx: 0, dy: 0 };
                const savedCoord = { x: machPos.x + camOffset.dx, y: machPos.y + camOffset.dy };
                saveFiducialCoordinate(savedCoord, 1.0);
                console.log(`[PyServo] ✅ Converged (${CONVERGE_STABLE_FRAMES} stable frames). Saved X${savedCoord.x.toFixed(3)} Y${savedCoord.y.toFixed(3)}`);
              } else {
                console.log(`[PyServo] Fine-phase stable ${convergenceCountRef.current}/${CONVERGE_STABLE_FRAMES} — holding...`);
              }
            }
            return;
          }
          convergenceCountRef.current = 0; // moved away from convergence zone — reset count

          // If dist > CONVERGE_MM, OR within CONVERGE_MM but haven't jogged yet → jog toward center
          if (dist <= CONVERGE_MM && !canConverge) {
            // First-poll near-zero offset: treat as a residual — do a micro-jog to physically verify
            console.log(`[PyServo] Near-zero offset (${dist.toFixed(4)}mm) but haven't jogged yet — micro-jogging to verify centring`);
          }

          // Jog toward fiducial center. Coarse: faster + longer settle; Fine: normal.
          const jogFeed  = servoPhase === 'idle' ? SERVO_FEED * 1.5 : SERVO_FEED;
          const settleMs = servoPhase === 'idle' ? SERVO_SETTLE_MS + 400 : SERVO_SETTLE_MS;
          settleUntilRef.current = Date.now() + settleMs;
          console.log(`[PyServo] ${servoPhase === 'idle' ? 'Coarse' : 'Fine  '} jog ΔX:${dx.toFixed(3)} ΔY:${dy.toFixed(3)} mm`);
          try {
            const cmds = jogRel({ dx, dy, feed: jogFeed });
            if (window.serial?.writeLine) for (const line of cmds) await window.serial.writeLine(line);
            hasJoggedInCycleRef.current = true; // servo has now physically moved this cycle
          } catch (err) { console.error('[PyServo] Jog failed:', err); }

          // After the coarse jog, switch to fine mode for sub-pixel correction
          if (servoPhase === 'idle') servoStateRef.current = { ...servoStateRef.current, phase: 'fine' };

        } catch (err) { console.warn('[PyServo] Poll error:', err); }
      }, 600);

      pythonPollRef.current = pollId;
      setDetectionInterval(pollId);
      servoStateRef.current = { phase: 'idle', lockedAt: null };
      convergenceCountRef.current = 0;
      settleUntilRef.current = 0;
      hasJoggedInCycleRef.current = false;
      return;
    }

    // ── Browser Mode (original OpenCV.js path) ───────────────────────
    if (!videoRef.current || !streamOn) {
      alert('Please start the camera first');
      return;
    }

    if (detectionInterval) {
      clearInterval(detectionInterval);
      setDetectionInterval(null);
      setVisionResult(null);
      hasJoggedRef.current = false;
      return;
    }

    // Reset jog flag for this new detection session
    hasJoggedRef.current = false;

    const pxmm = pixelsPerMm || 20;
    const intervalId = fiducialDetector.startContinuousDetection(
      videoRef.current,
      async (result) => {
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
            setVisionResult({
              detected: true,
              fiducials: finalFiducials,
              rejectedBlobs: finalRejected,
              confidence: finalFiducials.length > 0 ? finalFiducials[0].confidence : 0
            });
            return;
          }

          setVisionResult({
            detected: true,
            fiducials: finalFiducials,
            rejectedBlobs: finalRejected,
            confidence: finalFiducials.length > 0 ? finalFiducials[0].confidence : 0
          });

          // Calculate World Positions for visual feedback only — NOT auto-saved
          const incomingCandidates = finalFiducials.map(f => {
            const matchData = getMachineCoordinateFromPixel(f.pixelPosition.x, f.pixelPosition.y, videoWidth, videoHeight);
            if (!matchData) return f;
            return { ...f, estimatedWorld: { x: matchData.x, y: matchData.y } };
          });
          // Fiducial positions are ONLY saved when the user explicitly clicks "Snap to Fiducial".
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
              // Offset = (where fiducial IS) - (where camera crosshair IS)
              const dx = parseFloat((detectedFidCoord.x - crosshairCoord.x).toFixed(4));
              const dy = parseFloat((detectedFidCoord.y - crosshairCoord.y).toFixed(4));

              // Auto-jog ONCE per fiducial location
              // If we moved more than 5mm away from the last auto-jog spot, reset the flag so we can jog again for the next fiducial!
              if (hasJoggedRef.current && hasJoggedRef.current.x !== undefined) {
                const distMoved = Math.hypot(crosshairCoord.x - hasJoggedRef.current.x, crosshairCoord.y - hasJoggedRef.current.y);
                if (distMoved > 5.0) {
                  console.log(`[FiducialAlign] Machine moved ${distMoved.toFixed(2)}mm. Resetting auto-jog for new fiducial.`);
                  hasJoggedRef.current = false;
                }
              }

              if (!hasJoggedRef.current && (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005)) {
                hasJoggedRef.current = { x: crosshairCoord.x, y: crosshairCoord.y }; // Lock immediately

                console.log(`[FiducialAlign] --- Auto-Align Triggered ---`);
                console.log(`[FiducialAlign] Fiducial: X${detectedFidCoord.x.toFixed(4)} Y${detectedFidCoord.y.toFixed(4)}`);
                console.log(`[FiducialAlign] Crosshair: X${crosshairCoord.x.toFixed(4)} Y${crosshairCoord.y.toFixed(4)}`);
                console.log(`[FiducialAlign] Offset: ΔX=${dx} ΔY=${dy}`);
                console.log(`[FiducialAlign] Sending G-code relative move ΔX:${dx} ΔY:${dy}`);

                try {
                  // Step 1: Move camera crosshair to exactly center on the fiducial
                  const camCorrCmds = jogRel({ dx, dy, feed: 800 });
                  if (window.serial && window.serial.writeLine) {
                    for (const line of camCorrCmds) await window.serial.writeLine(line);
                    console.log(`[FiducialAlign] Camera is now perfectly centered on the fiducial.`);
                  } else {
                    console.warn('[FiducialAlign] Serial not available, skipping physical jog');
                  }
                } catch (err) {
                  console.error('[FiducialAlign] Jog failed:', err);
                }
              }
            }
          }
        }
      },
      1500,
      { pxPerMm: pxmm, debug: true }
    );

    setDetectionInterval(intervalId);
  };


  const clearAccumulatedFiducials = () => {
    // Clear machine coordinates from all fiducials
    const cleared = fiducials.map(f => ({ ...f, machine: null, autoDetected: false }));
    if (onUpdateFiducials) onUpdateFiducials(cleared);
  };

  // Single-shot snap using subpixel brightness centroid from Python.
  // Calls /api/snap_offset which grabs a FRESH camera frame, crops a tight ROI
  // around the detected circle, and returns the Otsu centroid — more accurate than
  // HoughCircles integer centre. One fetch → one jog → crosshair on fiducial centre.
  const snapToFiducial = async () => {
    if (!pythonVisionData?.best_circle) return;
    setIsBusy(true);

    const machPos = machinePositionRef.current || { x: 0, y: 0 };
    // Lock the servo loop while we run our own jog
    servoStateRef.current = { phase: 'converged', lockedAt: { x: machPos.x, y: machPos.y } };

    try {
      const r = await fetch(`${PYTHON_URL}/api/snap_offset`, { signal: AbortSignal.timeout(2000) });
      const data = await r.json();

      if (!data.found) {
        console.warn('[SnapToFiducial] No fiducial in fresh frame:', data.error);
        servoStateRef.current = { phase: 'idle', lockedAt: null };
        return;
      }

      const dx = parseFloat(data.offset_dx.toFixed(4));
      const dy = parseFloat(data.offset_dy.toFixed(4));
      console.log(`[SnapToFiducial] Centroid offset ΔX:${dx} ΔY:${dy} mm`);

      const camOffset = cameraOffset || { dx: 0, dy: 0 };
      const snapCoord = { x: machPos.x + camOffset.dx, y: machPos.y + camOffset.dy };
      const CORR_DIST = 8; // mm — within this radius of last auto-save = correction, not new slot

      if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) {
        const last = lastAutoSavedRef.current;
        if (last && Math.hypot(snapCoord.x - last.position.x, snapCoord.y - last.position.y) < CORR_DIST) {
          // Machine is still near the last auto-saved fiducial — user is correcting it.
          // Overwrite that slot directly without advancing the arm dropdown.
          console.log(`[SnapToFiducial] Correcting ${last.id} — overwriting same slot, arm stays.`);
          overwriteFiducialById(last.id, snapCoord);
          lastAutoSavedRef.current = null;
          return;
        }
        if (Date.now() < saveBlockRef.current) {
          console.log('[SnapToFiducial] Save blocked — move to next fiducial first.');
          return;
        }
        console.log('[SnapToFiducial] Already centred — saving coordinate.');
        saveFiducialCoordinate(snapCoord);
        return;
      }

      // Jog branch: check if this is a correction jog (machine still near last auto-save).
      // If so, set correctionTargetRef so the servo's final convergence save routes to the right slot.
      const lastJog = lastAutoSavedRef.current;
      if (lastJog && Math.hypot(snapCoord.x - lastJog.position.x, snapCoord.y - lastJog.position.y) < CORR_DIST) {
        correctionTargetRef.current = { id: lastJog.id, position: { ...snapCoord } };
        lastAutoSavedRef.current = null;
        console.log(`[SnapToFiducial] Correction jog for ${lastJog.id} — next convergence will overwrite same slot.`);
      }

      const cmds = jogRel({ dx, dy, feed: 800 });
      if (window.serial?.writeLine) {
        for (const line of cmds) await window.serial.writeLine(line);
        console.log('[SnapToFiducial] Jog sent — servo will re-check after settle.');
        settleUntilRef.current = Date.now() + 2000;
        servoStateRef.current = { phase: 'idle', lockedAt: null }; // let servo do the final save
      } else {
        console.warn('[SnapToFiducial] Serial not connected.');
        servoStateRef.current = { phase: 'idle', lockedAt: null };
      }

    } catch (err) {
      console.error('[SnapToFiducial] Failed:', err);
    } finally {
      setIsBusy(false);
    }
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
          <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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

          {/* Auto-search status — shows while machine is travelling to the predicted fiducial position */}
          {autoSearchStatus && (
            <div style={{ marginTop: 6, padding: '4px 10px', background: 'rgba(79,195,247,0.12)', border: '1px solid #4fc3f7', borderRadius: 4, fontSize: '0.82em', color: '#4fc3f7', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
              {autoSearchStatus}
            </div>
          )}

          {!pythonMode && (
            <small style={{ fontSize: '12px', color: '#6c757d' }}>
              Start the camera and click 'Start Auto-Detect'. As you jog the machine, any fiducials seen by the camera will be instantly logged and saved to the active board automatically!
            </small>
          )}
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
            {/* Jog Sensitivity Multiplier */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.85em' }}>
              <span style={{ color: '#6c757d', fontWeight: 'bold' }}>Jog Sensitivity</span>
              <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                <input
                  type="number" step="0.5" min="0.1" max="50"
                  value={jogMultiplier}
                  onChange={e => setJogMultiplier(parseFloat(e.target.value) || 1)}
                  style={{ width: 52, padding: '3px 5px', borderRadius: 4, border: '1px solid #ced4da', fontFamily: 'monospace', fontWeight: 'bold' }}
                />
                <span style={{ color: '#6c757d', fontSize: '0.85em' }}>×</span>
                {[1, 2, 5, 10].map(m => (
                  <button
                    key={m}
                    onClick={() => setJogMultiplier(m)}
                    style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: '0.8em', cursor: 'pointer',
                      border: jogMultiplier === m ? '1px solid #007bff' : '1px solid #ced4da',
                      background: jogMultiplier === m ? '#007bff' : '#f8f9fa',
                      color: jogMultiplier === m ? '#fff' : '#495057',
                      fontWeight: jogMultiplier === m ? 'bold' : 'normal',
                    }}
                  >{m}×</button>
                ))}
              </div>
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

      {/* Video Container */}
      <div style={{ position: 'relative', width: '100%', background: '#111', borderRadius: 8, overflow: 'hidden', pointerEvents: 'auto' }}>
        {pythonMode ? (
          streamOn ? (
            <img
              src={`${PYTHON_URL}/video_feed`}
              alt="Python MJPEG Stream"
              style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
              onError={(e) => {
                console.warn('[CameraPanel] MJPEG stream dropped, reconnecting in 2s...');
                setTimeout(() => {
                  if (e.target) {
                    e.target.src = `${PYTHON_URL}/video_feed?t=${Date.now()}`;
                  }
                }, 2000);
              }}
              onClick={async (e) => {
                if (isBusy) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const u = e.clientX - rect.left;
                const v = e.clientY - rect.top;
                const W = 1280;
                const Hh = 720;
                // Map DOM click → native frame pixel
                const clickU = (u / rect.width) * W;
                const clickV = (v / rect.height) * Hh;
                const centerX = W / 2;
                const centerY = Hh / 2;

                // Pixel → mm offset from crosshair
                const pxmm = pixelsPerMm || 98.5;
                const pixDx = clickU - centerX;
                const pixDy = centerY - clickV;   // Invert Y: screen down → machine up
                const dx = (pixDx / pxmm) * (jogMultiplier || 1);
                const dy = (pixDy / pxmm) * (jogMultiplier || 1);

                if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return;

                setIsBusy(true);
                try {
                  const cmds = jogRel({ dx, dy, feed: 1500 });
                  if (window.serial && window.serial.writeLine) {
                    for (const line of cmds) await window.serial.writeLine(line);
                    console.log(`[PythonClick] Jogged ΔX:${dx.toFixed(3)} ΔY:${dy.toFixed(3)} mm`);
                  } else {
                    console.warn('[PythonClick] Serial not connected');
                  }
                } catch (err) {
                  console.error('[PythonClick] Jog failed:', err);
                } finally {
                  setIsBusy(false);
                }
              }}
            />
          ) : (
            <div style={{ width: '100%', aspectRatio: '16/9', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#888' }}>
              <span style={{ fontSize: 40 }}>🐍</span>
              <span>Python Vision Server {pythonServerOk ? '🟢 Online' : '🔴 Offline'}</span>
              <small>Click Start Camera to begin streaming</small>
            </div>
          )
        ) : (
          // ── Browser OpenCV.js Mode ──
          <>
            <video ref={videoRef} style={{ width: '100%', height: 'auto', display: 'block' }} muted playsInline />
            <canvas ref={canvasRef}
              onClick={onCanvasClick}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', width: '100%', height: '100%' }} />
          </>
        )}
      </div>

      {/* Camera Controls */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {!streamOn ? (
          <button className="btn" onClick={startCam}>Start Camera</button>
        ) : (
          <button className="btn secondary" onClick={stopCam}>Stop Camera</button>
        )}
        {/* Python Mode Toggle */}
        <button
          onClick={() => { if (streamOn) stopCam(); setPythonMode(m => !m); }}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: '0.8em', cursor: 'pointer', fontWeight: 'bold',
            border: '1px solid ' + (pythonMode ? '#28a745' : '#6c757d'),
            background: pythonMode ? '#d4edda' : '#f8f9fa',
            color: pythonMode ? '#155724' : '#495057',
          }}
          title={pythonMode ? 'Switch to browser mode (OpenCV.js)' : 'Switch to Python mode (recommended)'}
        >
          {pythonMode ? '🐍 Python Mode' : '🌐 Browser Mode'}
          {pythonMode && <span style={{ marginLeft: 6, fontSize: '0.75em' }}>{pythonServerOk ? '🟢' : '🔴'}</span>}
        </button>
        {!pythonMode && (
          <>
            <label className="row" style={{ gap: 8, marginLeft: 8 }}>
              <input type="checkbox" checked={showOverlay} onChange={e => setShowOverlay(e.target.checked)} />
              Show overlay
            </label>
            <label className="row" style={{ gap: 8, marginLeft: 8 }}>
              <input type="checkbox" checked={measureMode} onChange={e => setMeasureMode(e.target.checked)} />
              Measure error
            </label>
          </>
        )}
        {pythonMode && pythonVisionData && (
          <small style={{ color: '#495057', marginLeft: 8 }}>
            Sharpness: <b>{pythonVisionData.sharpness}</b> | Circles found: <b>{pythonVisionData.circles?.length ?? 0}</b>
          </small>
        )}
        {machinePosition && (
          <small style={{ color: '#0056b3', marginLeft: 8 }}>
            Pos: <b>X: {machinePosition.x.toFixed(3)} Y: {machinePosition.y.toFixed(3)}</b>
          </small>
        )}

        {/* Python Mode: live offset readout + one-shot snap button */}
        {pythonMode && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Live offset display */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontFamily: 'monospace', fontSize: '0.9em' }}>
              <span style={{ color: '#6c757d' }}>Offset:</span>
              <span style={{
                color: pythonVisionData?.best_circle ? (Math.abs(pythonVisionData.offset_dx) < 0.05 && Math.abs(pythonVisionData.offset_dy) < 0.05 ? '#28a745' : '#dc3545') : '#aaa',
                fontWeight: 'bold'
              }}>
                {pythonVisionData?.best_circle
                  ? `ΔX: ${pythonVisionData.offset_dx >= 0 ? '+' : ''}${pythonVisionData.offset_dx.toFixed(3)} mm  ΔY: ${pythonVisionData.offset_dy >= 0 ? '+' : ''}${pythonVisionData.offset_dy.toFixed(3)} mm`
                  : 'No fiducial detected'}
              </span>
            </div>
            {/* Snap button */}
            <button
              onClick={snapToFiducial}
              disabled={!pythonVisionData?.best_circle || isBusy}
              style={{
                padding: '6px 14px', borderRadius: 6, fontWeight: 'bold', fontSize: '0.9em',
                cursor: pythonVisionData?.best_circle && !isBusy ? 'pointer' : 'not-allowed',
                border: '2px solid ' + (pythonVisionData?.best_circle ? '#28a745' : '#ccc'),
                background: pythonVisionData?.best_circle ? '#d4edda' : '#f8f9fa',
                color: pythonVisionData?.best_circle ? '#155724' : '#aaa',
                alignSelf: 'flex-start',
                transition: 'all 0.15s',
              }}
            >
              {isBusy ? '⏳ Moving...' : '⊕ Snap to Fiducial'}
            </button>
            <small style={{ fontSize: '11px', color: '#6c757d' }}>
              Jogs the machine by the detected offset so the yellow crosshair overlaps the green circle exactly.
            </small>
          </div>
        )}
      </div>

      <div className="camera-controls-row" style={{ marginTop: 12 }}>
        {/* Lens Distortion Calibration — checkerboard-based OpenCV calibration */}
        <LensDistortionCalibration />

        {/* ── Camera & Lighting Controls ─────────────────────────────────── */}
        <details style={{ border: '1px solid #444', borderRadius: 4, marginBottom: 12 }}>
          <summary style={{ padding: '8px 12px', background: '#2c2e33', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ color: '#4fc3f7', fontSize: '0.9em' }}>Camera &amp; Lighting Controls</strong>
          </summary>
          <div style={{ padding: 12, background: '#1d1f24', fontSize: '0.82em', display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* ── Option A: Software camera controls (active now) ── */}
            <div style={{ color: '#3fb950', fontWeight: 600, marginBottom: 2 }}>
              Option A — Camera Exposure / Gain (software, no hardware needed)
            </div>
            <p style={{ color: '#8b949e', margin: 0 }}>
              Adjust how the USB camera captures frames. Use these to compensate for
              ambient light changes and improve fiducial detection reliability.
            </p>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={camAutoExposure}
                onChange={e => {
                  setCamAutoExposure(e.target.checked);
                  applyCameraSettings({ auto_exposure: e.target.checked });
                }}
              />
              Auto Exposure
            </label>

            {!camAutoExposure && (
              <label>
                Exposure ({camExposure})
                <input type="range" min="-13" max="-1" step="1" value={camExposure}
                  style={{ width: '100%', marginTop: 4 }}
                  onChange={e => { setCamExposure(Number(e.target.value)); applyCameraSettings({ auto_exposure: false, exposure: Number(e.target.value) }); }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8b949e', fontSize: '0.78em' }}><span>Dark (-13)</span><span>Bright (-1)</span></div>
              </label>
            )}

            <label>
              Gain ({camGain})
              <input type="range" min="0" max="255" step="1" value={camGain}
                style={{ width: '100%', marginTop: 4 }}
                onChange={e => { setCamGain(Number(e.target.value)); applyCameraSettings({ gain: Number(e.target.value) }); }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8b949e', fontSize: '0.78em' }}><span>0</span><span>255</span></div>
            </label>

            <label>
              Brightness ({camBrightness})
              <input type="range" min="0" max="255" step="1" value={camBrightness}
                style={{ width: '100%', marginTop: 4 }}
                onChange={e => { setCamBrightness(Number(e.target.value)); applyCameraSettings({ brightness: Number(e.target.value) }); }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8b949e', fontSize: '0.78em' }}><span>0</span><span>255</span></div>
            </label>

            <button
              className="btn secondary"
              style={{ fontSize: '0.8em', marginTop: 2 }}
              onClick={() => {
                setCamAutoExposure(true); setCamGain(0); setCamBrightness(128);
                applyCameraSettings({ auto_exposure: true, gain: 0, brightness: 128 });
              }}
            >↺ Reset to Defaults</button>

            <hr style={{ borderColor: '#30363d', margin: '6px 0' }} />

            {/*
             * ── Option B: Ring Light PWM via G-code M42 (hardware required) ──
             *
             * WHEN TO USE: Uncomment this block when a physical ring light is wired
             * to a PWM-capable output pin on the motion controller (e.g. fan pin).
             *
             * WHERE THIS CODE IS: CameraPanel.jsx → "Camera & Lighting Controls"
             * section → Option B comment block (search "Option B" in CameraPanel.jsx).
             *
             * STEPS TO ENABLE:
             *  1. Wire ring light to a PWM pin on your controller (e.g. pin 4 for M42 P4).
             *  2. Update the M42_PIN constant below to match your wiring.
             *  3. Remove the opening and closing comment block markers (/* and * /) below.
             *
             * ─────────────────────────────────────────────────────────────────────
             *
             * const M42_PIN = 4;  // ← change to your actual PWM pin number
             *
             * <div style={{ color: '#ffa726', fontWeight: 600, marginBottom: 2 }}>
             *   Option B — Ring Light PWM (requires hardware wiring)
             * </div>
             * <p style={{ color: '#8b949e', margin: 0 }}>
             *   Controls ring light brightness via M42 G-code. Requires a ring light
             *   wired to a PWM pin on the motion controller.
             * </p>
             *
             * <label>
             *   Ring Light Brightness ({ringLightBrightness}/255)
             *   <input type="range" min="0" max="255" step="5"
             *     value={ringLightBrightness}
             *     style={{ width: '100%', marginTop: 4 }}
             *     onChange={async e => {
             *       const val = Number(e.target.value);
             *       setRingLightBrightness(val);
             *       if (window.serial?.writeLine) {
             *         await window.serial.writeLine(`M42 P${M42_PIN} S${val}`);
             *       }
             *     }}
             *   />
             *   <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8b949e', fontSize: '0.78em' }}>
             *     <span>Off (0)</span><span>Full (255)</span>
             *   </div>
             * </label>
             *
             * <div style={{ display: 'flex', gap: 6 }}>
             *   <button className="btn secondary" style={{ flex: 1, fontSize: '0.8em' }}
             *     onClick={() => { setRingLightBrightness(0); window.serial?.writeLine?.(`M42 P${M42_PIN} S0`); }}>
             *     Off
             *   </button>
             *   <button className="btn" style={{ flex: 1, fontSize: '0.8em' }}
             *     onClick={() => { setRingLightBrightness(255); window.serial?.writeLine?.(`M42 P${M42_PIN} S255`); }}>
             *     Full
             *   </button>
             * </div>
             *
             * NOTE: Also add this state variable near the top of the CameraPanel component:
             *   const [ringLightBrightness, setRingLightBrightness] = useState(128);
             */}

            <div style={{ color: '#8b949e', fontSize: '0.78em', fontStyle: 'italic' }}>
              Option B (ring light PWM via M42) is implemented but commented out — see CameraPanel.jsx → "Option B" comment block to enable it when hardware is wired.
            </div>

          </div>
        </details>

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
