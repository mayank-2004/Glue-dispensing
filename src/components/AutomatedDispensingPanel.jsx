import { useState, useEffect, useRef, useMemo } from 'react';
import { header, home, moveAbs, dispensePoint, dispenseBead, jogRel } from "../lib/motion/gcode.js";
import { applyTransform, fitSimilarity, fitAffine } from "../lib/utils/transform2d.js";
import "./AutomatedDispensingPanel.css";
import { buildJobGlueSummary, GlueStore } from '../lib/glue/glueTracker.js';
import { getZOffsetForPoint } from './BedCalibrationPanel.jsx';
import GlueGauge from './GlueGauge.jsx';
import MaintenanceManager from './MaintenanceManager.jsx';
import { NozzleMaintenanceManager } from '../lib/maintenance/nozzleMaintenance.js';

const nozzleMaintenance = new NozzleMaintenanceManager();

// IDW (Inverse Distance Weighting) interpolation for spatial correction map
function idwCorrect(x, y, vectors, power = 2) {
  if (!vectors || !vectors.length) return { dx: 0, dy: 0 };
  let wdx = 0, wdy = 0, wsum = 0;
  for (const v of vectors) {
    const d2 = (x - v.x) * (x - v.x) + (y - v.y) * (y - v.y);
    if (d2 < 1e-6) return { dx: v.dx, dy: v.dy };
    const w = 1 / Math.pow(d2, power);
    wdx += w * v.dx; wdy += w * v.dy; wsum += w;
  }
  return { dx: wdx / wsum, dy: wdy / wsum };
}

// ── SPC (Statistical Process Control) helpers ────────────────────────────────
const SPC_KEY     = 'spcDotQuality';
const SPC_MAX_JOBS = 60; // rolling window — oldest entries drop off

function spcLoad() {
  try { return JSON.parse(localStorage.getItem(SPC_KEY) || '{"jobs":[]}'); }
  catch { return { jobs: [] }; }
}

function spcAppend(dotResults, totalPads) {
  if (!dotResults || dotResults.length === 0) return;
  const data  = spcLoad();
  const passed = dotResults.filter(r => r.passed).length;
  const diams  = dotResults.filter(r => r.diameter_mm > 0).map(r => r.diameter_mm);
  data.jobs = [
    ...data.jobs,
    {
      jobId:       new Date().toISOString(),
      date:        new Date().toLocaleDateString(),
      totalPads,
      checked:     dotResults.length,
      passed,
      failed:      dotResults.length - passed,
      passRate:    passed / dotResults.length,
      avgDiameter: diams.length ? diams.reduce((a, b) => a + b, 0) / diams.length : null,
      minDiameter: diams.length ? Math.min(...diams) : null,
    },
  ].slice(-SPC_MAX_JOBS);
  localStorage.setItem(SPC_KEY, JSON.stringify(data));
}

// Minimal SVG sparkline — values[] is an array of numbers
function Sparkline({ values, color = '#58a6ff', height = 36, width = '100%' }) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const W = 260, H = height;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = values[values.length - 1];
  const lx   = W, ly = H - ((last - min) / range) * (H - 4) - 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width, height, display: 'block', overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="3" fill={color} />
    </svg>
  );
}

export default function AutomatedDispensingPanel({
  side = 'top',
  dispensingSequencer,
  dispensingSequence,
  safeSequence,
  jobStatistics,
  referencePoint,
  selectedOrigin,
  pressureSettings,
  speedSettings,
  boardOutline,
  useSafePathPlanning = false,
  setUseSafePathPlanning,
  safePathPlanner,
  onStartJob,
  onDownloadGCode,
  batchProcessor,
  currentBatch,
  onStartBatch,
  onJobComplete,
  fiducials = [],
  onInputMachine,
  onAutoAlign,
  onSolve2,
  onSolve3,
  xf,
  applyXf,
  isConnected = false,
  isHomed = false,
  machinePosition = { x: 0, y: 0, z: 0 },
  panelBoards = [],
  panelInfo = null,
  panelXf = null,
  toolOffset = { dx: 0, dy: 0 }
}) {
  const [isJobRunning, setIsJobRunning] = useState(false);
  const isJobRunningRef = useRef(false);
  const [resumeFromPad, setResumeFromPad] = useState(() => parseInt(localStorage.getItem('resumeFromPad') || '0'));
  const globalPointCountRef = useRef(0);
  const [jobMode, setJobMode] = useState('single'); // 'single' or 'batch'
  const [dynamicPanelCorrection, setDynamicPanelCorrection] = useState(true); // Default to ON if panelized

  const [nozzleDia, setNozzleDia] = useState(() => parseFloat(localStorage.getItem('nozzleDia') || '0.6'));
  const [glueStock, setGlueStock] = useState(() => GlueStore.getStock());
  const [glueSummary, setGlueSummary] = useState(null);

  // Advanced Flow State
  const [jobStage, setJobStage] = useState('idle'); // idle, homing, loading, registering, dispensing, finished
  const [machineStatus, setMachineStatus] = useState('idle');
  const [jobProgress, setJobProgress] = useState({ current: 0, total: 0 });
  const [regIndex, setRegIndex] = useState(0);
  // const [currentPos, setCurrentPos] = useState({ x: 0, y: 0, z: 0 }); // Replaced by prop
  const [jogStep, setJogStep] = useState(1);

  // Fine-tune residual offset correction (applied on top of everything else)
  // const [fineTuneX, setFineTuneX] = useState(() => parseFloat(localStorage.getItem('fineTuneX') || '0'));
  // const [fineTuneY, setFineTuneY] = useState(() => parseFloat(localStorage.getItem('fineTuneY') || '0'));

  // Pad Alignment Preview state
  const [previewPadIdx, setPreviewPadIdx] = useState(0);

  // Live Calibration Correction — accumulated from user's 'Capture True Center' actions
  // Each entry: { predicted: {x,y}, actual: {x,y}, delta: {x,y} }
  const [calibCaptures, setCalibCaptures] = useState(() => {
    try { return JSON.parse(localStorage.getItem('calibCaptures') || '[]'); } catch { return []; }
  });
  // Averaged correction vector applied to every pad
  const calibCorrection = calibCaptures.length > 0
    ? {
      x: calibCaptures.reduce((s, c) => s + c.delta.x, 0) / calibCaptures.length,
      y: calibCaptures.reduce((s, c) => s + c.delta.y, 0) / calibCaptures.length,
    }
    : { x: 0, y: 0 };

  // Machine Configuration State
  const [valveOnCmd, setValveOnCmd] = useState('M106 S255');
  const [valveOffCmd, setValveOffCmd] = useState('M107');
  const [dispenseHeight, setDispenseHeight] = useState(0.5);
  const [safeTravelHeight, setSafeTravelHeight] = useState(5.0);
  const [viscosity, setViscosity] = useState('medium'); // low, medium, high
  const [baseDwellTime, setBaseDwellTime] = useState(120);
  const [beadAreaThreshold, setBeadAreaThreshold] = useState(2.0); // mm² — pads above this use bead mode
  const [beadFeedRate, setBeadFeedRate] = useState(500);           // mm/min while sweeping the bead
  const [localPressure, setLocalPressure] = useState(() => pressureSettings?.customPressure || 25);
  const [currentPadInfo, setCurrentPadInfo] = useState(null);
  const [jobReport, setJobReport] = useState(null);
  const jobStartTimeRef = useRef(null);

  // Tracks which sub-board within the panel is currently being dispensed (0-based)
  const [currentBoardIdx, setCurrentBoardIdx] = useState(0);

  // Z-axis surface probing
  const [enableSurfaceProbe, setEnableSurfaceProbe] = useState(false);
  const probedSurfaceZRef = useRef(null);
  const [probeResult, setProbeResult] = useState(null); // null | 'contact' | 'no-contact'

  // Board presence detection
  const [boardCheckResult, setBoardCheckResult] = useState(null); // null | {present, confidence, std_dev, reason}
  const [boardCheckBusy, setBoardCheckBusy] = useState(false);
  const [boardConfirmed, setBoardConfirmed] = useState(false);

  // Recipe save/load
  const [savedRecipes, setSavedRecipes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('glueRecipes') || '{}'); } catch { return {}; }
  });
  const [recipeName, setRecipeName] = useState('');
  const [activeRecipe, setActiveRecipe] = useState('');

  // Nozzle purge
  const [purgeEnabled, setPurgeEnabled] = useState(true);
  const [purgeDurationMs, setPurgeDurationMs] = useState(2000);
  const [isPurging, setIsPurging] = useState(false);

  // Dot verification
  const [enableDotVerification, setEnableDotVerification] = useState(false);
  const [dotCheckResults, setDotCheckResults] = useState([]); // {padIndex, passed, diameter_mm, confidence}

  // SPC trend data (persisted across jobs in localStorage)
  const [spcData, setSpcData] = useState(() => spcLoad());

  // Per-pad log accumulator (ref so it's readable inside async loop without stale closure)
  const padLogRef = useRef([]);
  // Spatial correction map: [{x, y, dx, dy}] vectors accumulated across jobs via find_pad
  const correctionVectorsRef = useRef([]);

  // Apply viscosity presets automatically when changed
  useEffect(() => {
    if (viscosity === 'low') {
      setBaseDwellTime(60);
      setDispenseHeight(0.3);
      setSafeTravelHeight(4.0);
    } else if (viscosity === 'high') {
      setBaseDwellTime(200);
      setDispenseHeight(0.6);
      setSafeTravelHeight(6.0);
    } else {
      setBaseDwellTime(120);
      setDispenseHeight(0.5);
      setSafeTravelHeight(5.0);
    }
  }, [viscosity]);

  const refPoint = referencePoint || selectedOrigin;
  const activeSequence = useSafePathPlanning ? safeSequence : dispensingSequence;

  // Refs for async access
  const xfRef = useRef(xf);
  const fiducialsRef = useRef(fiducials);

  // Queue for synchronous sending
  const ackQueue = useRef([]);

  // Soft axis limits — prevent moves outside machine travel envelope
  const [axisLimits, setAxisLimits] = useState(() => {
    try { return JSON.parse(localStorage.getItem('axisLimits') || 'null') || { maxX: 300, maxY: 300, maxZ: 50 }; }
    catch { return { maxX: 300, maxY: 300, maxZ: 50 }; }
  });

  useEffect(() => { xfRef.current = xf; }, [xf]);
  useEffect(() => { fiducialsRef.current = fiducials; }, [fiducials]);
  useEffect(() => { localStorage.setItem('nozzleDia', String(nozzleDia)); }, [nozzleDia]);
  useEffect(() => { localStorage.setItem('axisLimits', JSON.stringify(axisLimits)); }, [axisLimits]);
  // useEffect(() => { localStorage.setItem('fineTuneX', String(fineTuneX)); }, [fineTuneX]);
  // useEffect(() => { localStorage.setItem('fineTuneY', String(fineTuneY)); }, [fineTuneY]);
  useEffect(() => { localStorage.setItem('calibCaptures', JSON.stringify(calibCaptures)); }, [calibCaptures]);

  // Stabilize board dimension calculation
  const currentBoardSize = useMemo(() => {
    const validFids = fiducials.filter(f => f.machine && typeof f.machine.x === 'number' && typeof f.machine.y === 'number');
    if (validFids.length >= 2) {
      const xs = validFids.map(f => f.machine.x);
      const ys = validFids.map(f => f.machine.y);
      return {
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys)
      };
    }
    return boardOutline;
  }, [fiducials, boardOutline]);

  // Clamp previewPadIdx when the sequence shrinks
  useEffect(() => {
    if (activeSequence && activeSequence.length > 0 && previewPadIdx >= activeSequence.length) {
      setPreviewPadIdx(activeSequence.length - 1);
    }
  }, [activeSequence?.length]);

  useEffect(() => {
    if (!activeSequence || activeSequence.length === 0) {
      setGlueSummary(null);
      return;
    }
    const summary = buildJobGlueSummary(
      activeSequence,
      nozzleDia,
      GlueStore.getStock(),
      GlueStore.getUsed(),
    );
    setGlueSummary(summary);
  }, [activeSequence, nozzleDia, glueStock]);

  // Position & ACK listener
  useEffect(() => {
    const handleData = (line) => {
      // 1. Parse Position - HANDLED BY APP.JSX NOW
      // const match = line.match(/X:([-\d.]+)\s+Y:([-\d.]+)\s+Z:([-\d.]+)/);
      // if (match) {
      //   setCurrentPos({
      //     x: parseFloat(match[1]),
      //     y: parseFloat(match[2]),
      //     z: parseFloat(match[3])
      //   });
      // }

      // 2. Parse probe response [PRB:x,y,z:1] (contact=1 means probe triggered)
      const prbMatch = line.match(/\[PRB:([-\d.]+),([-\d.]+),([-\d.]+):(0|1)\]/);
      if (prbMatch && prbMatch[4] === '1') {
        probedSurfaceZRef.current = parseFloat(prbMatch[3]);
      }

      // 3. Handle ACKs (Marlin/GRBL sends 'ok')
      if (line.trim().startsWith('ok')) {
        const resolver = ackQueue.current.shift();
        if (resolver) resolver(true);
      }
    };
    if (window.serial && window.serial.onData) window.serial.onData(handleData);
  }, []);

  // Reliable Sender
  const sendGcodeWait = async (cmd) => {
    // Create a promise that waits for 'ok'
    const ackPromise = new Promise(resolve => {
      ackQueue.current.push(resolve);
    });

    try {
      console.log('SEND:', cmd);
      await window.serial.writeLine(cmd);
      await ackPromise;
      return true;
    } catch (e) {
      console.error("Send failed:", e);
      // If write failed, remove the waiter
      ackQueue.current.pop();
      throw e;
    }
  };

  // --- Pre-flight ---
  const computePreflightChecks = () => {
    const stock = GlueStore.getStock();
    const needed = glueSummary?.totalVolUl ?? 0;
    const checks = [
      {
        id: 'serial',
        label: 'Serial port connected',
        critical: true,
        passed: isConnected && !!window.serial?.writeLine,
        detail: isConnected ? 'Connected' : 'Not connected — open Serial panel first',
      },
      {
        id: 'homed',
        label: 'Machine homed',
        critical: true,
        passed: isHomed,
        detail: isHomed
          ? 'Homed — coordinate system is valid'
          : 'Not homed — connect and home the machine (Serial panel → G28)',
      },
      {
        id: 'sequence',
        label: 'Dispensing sequence loaded',
        critical: true,
        passed: (activeSequence?.length ?? 0) > 0,
        detail: (activeSequence?.length ?? 0) > 0
          ? `${activeSequence.length} pads ready`
          : 'No pads — select components and generate sequence first',
      },
      {
        id: 'boards',
        label: 'Panel boards configured',
        critical: true,
        passed: (panelBoards?.length ?? 0) > 0,
        detail: (panelBoards?.length ?? 0) > 0
          ? `${panelBoards.length} board(s) in panel`
          : 'No boards defined — configure panel first',
      },
      {
        id: 'transform',
        label: 'Fiducial alignment solved',
        critical: applyXf,
        passed: !applyXf || !!xf,
        detail: !applyXf
          ? 'Transform disabled — running in manual origin mode'
          : xf
            ? 'Transform computed (fiducials solved)'
            : 'Transform required but not solved — go to Fiducial panel',
      },
      {
        id: 'nozzle',
        label: 'Nozzle diameter set',
        critical: false,
        passed: nozzleDia > 0,
        detail: nozzleDia > 0 ? `${nozzleDia} mm` : 'Nozzle diameter is 0 — volume estimates will be wrong',
      },
      {
        id: 'stock',
        label: 'Glue stock sufficient',
        critical: false,
        passed: stock >= needed,
        detail: needed > 0
          ? `Need ${needed.toFixed(2)} µL, have ${stock.toFixed(2)} µL${stock < needed ? ' — refill or update stock' : ''}`
          : 'No volume estimate available',
      },
      ...(enableSurfaceProbe ? [{
        id: 'probe',
        label: 'Z surface probe',
        critical: false,
        passed: false, // always amber — we can't verify probe wiring from software
        detail: 'Surface probe enabled — ensure probe/BLTouch is wired to controller. If no contact is detected, the job will continue with your manually-set Z (no G92 Z0 applied). Disable this setting if no probe is connected.',
      }] : []),
      {
        id: 'board',
        label: 'PCB loaded',
        critical: false,
        passed: false, // always amber at preflight — confirmed in the LOADING stage
        detail: 'You will confirm board presence in the next step (Load PCB stage). Camera check is available there.',
      },
      (() => {
        // Check every transformed pad position against axis limits
        const { maxX, maxY } = axisLimits;
        let outCount = 0;
        let firstOut = null;
        if (activeSequence?.length > 0 && panelBoards?.length > 0) {
          for (const board of panelBoards) {
            const xfm = applyXf ? board.xf : null;
            for (const pad of activeSequence) {
              let tp = xfm ? applyTransform(xfm, pad) : pad;
              const px = tp.x - (toolOffset?.dx || 0);
              const py = tp.y - (toolOffset?.dy || 0);
              if (px < 0 || px > maxX || py < 0 || py > maxY) {
                outCount++;
                if (!firstOut) firstOut = `${pad.id || 'pad'} @ X${px.toFixed(1)}, Y${py.toFixed(1)}`;
              }
            }
          }
        }
        return {
          id: 'limits',
          label: 'Pad positions within travel limits',
          critical: outCount > 0,
          passed: outCount === 0,
          detail: outCount === 0
            ? `All pads within X[0–${maxX}] Y[0–${maxY}] mm`
            : `${outCount} pad(s) out of bounds — first: ${firstOut}. Check transform or increase axis limits in Settings.`,
        };
      })(),
    ];
    return checks;
  };

  // --- Flow Logic ---
  const startJobFlow = () => {
    setJobStage('preflight');
  };

  const proceedFromPreflight = async () => {
    setBoardCheckResult(null);
    setBoardConfirmed(false);
    setJobStage('homing');
    setMachineStatus('busy');
    setIsJobRunning(true);
    isJobRunningRef.current = true;
    if (onStartJob) onStartJob();

    try {
      window.pauseSerialPolling = true;
      await sendGcodeWait('M400');
      setJobStage('loading');
    } catch (e) {
      alert("Connection failed: " + e.message);
      setJobStage('idle');
      setMachineStatus('idle');
      isJobRunningRef.current = false;
      setIsJobRunning(false);
    }
  };

  // Returns true if contact detected and Z=0 was set, false if no contact (soft fail — job continues).
  const probeZSurface = async () => {
    probedSurfaceZRef.current = null;
    await sendGcodeWait('G38.2 Z-30 F50');
    // Brief settle: some firmware sends [PRB:...] a few ms after the 'ok'
    await new Promise(r => setTimeout(r, 250));
    if (probedSurfaceZRef.current === null) {
      console.log('[SurfaceProbe] No [PRB:x,y,z:1] response received — probe not wired, firmware does not support G38.2, or no contact within 30 mm travel. Continuing with current Z.');
      return false;
    }
    await sendGcodeWait('G92 Z0'); // Redefine Z=0 at the probed PCB surface
    console.log('[SurfaceProbe] PCB surface at machine Z:', probedSurfaceZRef.current.toFixed(3), '→ G92 Z0 applied');
    return true;
  };

  const proceedToRegistration = () => {
    setJobStage('dispensing');
    runDispenseLoop(resumeFromPad);
  };

  const runDispenseLoop = async (startFromPad = 0) => {
    setMachineStatus('busy');
    jobStartTimeRef.current = Date.now();
    globalPointCountRef.current = 0;
    setJobReport(null);
    setCurrentPadInfo(null);
    setDotCheckResults([]);
    setProbeResult(null);
    setCurrentBoardIdx(0);
    padLogRef.current = [];
    correctionVectorsRef.current = [];
    try {
      if (!panelBoards || panelBoards.length === 0) {
        throw new Error("No boards defined in panel configuration.");
      }

      await sendGcodeWait('G21'); // Set units to millimeters
      await sendGcodeWait('G90'); // Set to absolute positioning
      await sendGcodeWait(`G1 Z${safeTravelHeight} F3000`); // Move to safe height

      // ── Pre-job nozzle purge ────────────────────────────────────────
      if (purgeEnabled) {
        setJobStage('purging');
        await purgeNozzle(purgeDurationMs, localPressure);
        setJobStage('dispensing');
      }

      const seq = activeSequence;

      // ── Z-axis surface probe ─────────────────────────────────────────
      if (enableSurfaceProbe) {
        setJobStage('probing');
        // Move to first pad's machine position for a representative surface reading
        if (seq.length > 0 && panelBoards.length > 0) {
          const firstBoard = panelBoards[0];
          const firstXf = applyXf ? firstBoard.xf : null;
          const fp = seq[0];
          let probeTarget = null;
          if (panelXf && firstBoard.offsetX != null) {
            const ps = { x: fp.x + firstBoard.offsetX, y: fp.y + firstBoard.offsetY };
            probeTarget = applyTransform(panelXf, ps);
            if (firstXf && firstXf !== panelXf) probeTarget = applyTransform(firstXf, probeTarget);
          } else if (firstXf) {
            probeTarget = applyTransform(firstXf, fp);
          }
          if (probeTarget) {
            const cx = probeTarget.x - (toolOffset?.dx || 0) + calibCorrection.x;
            const cy = probeTarget.y - (toolOffset?.dy || 0) + calibCorrection.y;
            await sendGcodeWait(`G1 X${cx.toFixed(3)} Y${cy.toFixed(3)} F4000`);
            await sendGcodeWait('M400');
            await new Promise(r => setTimeout(r, 300));
          }
        }
        const probeOk = await probeZSurface();
        setProbeResult(probeOk ? 'contact' : 'no-contact');
        await sendGcodeWait(`G1 Z${safeTravelHeight} F3000`); // retract
        if (!probeOk) {
          console.log('[SurfaceProbe] Skipped — running with operator-set Z reference.');
        }
        setJobStage('dispensing');
      }
      const totalPoints = seq.length * panelBoards.length;
      let globalPointCount = 0;

      setJobProgress({ current: 0, total: totalPoints });

      for (let bIdx = 0; bIdx < panelBoards.length; bIdx++) {
        setCurrentBoardIdx(bIdx);
        const board = panelBoards[bIdx];
        let transform = applyXf ? board.xf : null;

        if (applyXf && !transform) {
          throw new Error(`Board "${board.name}" has no alignment transform (xf) calculated! Please solve its fiducials first.`);
        }

        // --- DYNAMIC PER-BOARD FIDUCIAL RE-SOLVE ---
        // Only runs if board has fiducials with BOTH design AND machine coords solved
        const solvedFiducials = board.fiducials?.filter(f => f.design && f.machine) || [];
        if (applyXf && dynamicPanelCorrection && solvedFiducials.length >= 2) {
          console.log(`[Dynamic Vision] Auto-correcting board: ${board.name} using ${solvedFiducials.length} fiducials`);
          setJobStage('auto-aligning');

          let updatedMachineFiducials = [];
          let success = true;

          for (let f of solvedFiducials) {
            if (!isJobRunningRef.current) throw new Error("Job Aborted");

            // 1. Where do we EXPECT this fiducial to be in machine space?
            //    The transform maps design → camera machine coords directly.
            const expectedMachine = applyTransform(transform, f.design);

            console.log(`[Dynamic Vision] Moving camera to expected fiducial ${f.id}: X${expectedMachine.x.toFixed(3)} Y${expectedMachine.y.toFixed(3)}`);
            await sendGcodeWait(`G1 Z${safeTravelHeight} F3000`);
            await sendGcodeWait(`G1 X${expectedMachine.x.toFixed(3)} Y${expectedMachine.y.toFixed(3)} F4000`);

            // 2. Wait for camera mechanics to settle
            await sendGcodeWait('M400');
            await new Promise(r => setTimeout(r, 800));

            // 3. Snap via vision API
            if (window.__SNAP_FIDUCIAL_MACHINE_COORD__) {
              let snap = null;
              for (let attempt = 1; attempt <= 3; attempt++) {
                snap = await window.__SNAP_FIDUCIAL_MACHINE_COORD__();
                if (snap && snap.confidence > 0.4) break;
                if (attempt < 3) {
                  console.log(`[Dynamic Vision] Attempt ${attempt} failed, retrying in 400ms...`);
                  await new Promise(r => setTimeout(r, 400));
                }
              }

              if (snap && snap.confidence > 0.4) {
                console.log(`[Dynamic Vision] Fiducial ${f.id} snapped at Machine(${snap.x.toFixed(3)}, ${snap.y.toFixed(3)}) confidence=${snap.confidence.toFixed(2)}`);
                updatedMachineFiducials.push({ design: f.design, machine: { x: snap.x, y: snap.y } });
              } else {
                console.warn(`[Dynamic Vision] Fiducial ${f.id}: ${snap ? `low confidence (${snap.confidence.toFixed(2)})` : 'not detected'}. Falling back to baseline.`);
                success = false;
                break;
              }
            } else {
              console.warn(`[Dynamic Vision] Vision bridge unavailable. Skipping dynamic correction.`);
              success = false;
              break;
            }
          }

          if (success && updatedMachineFiducials.length >= 2) {
            try {
              const freshXf = updatedMachineFiducials.length >= 3
                ? fitAffine(updatedMachineFiducials.map(f => f.design), updatedMachineFiducials.map(f => f.machine))
                : fitSimilarity(updatedMachineFiducials.map(f => f.design), updatedMachineFiducials.map(f => f.machine));
              if (freshXf) {
                console.log(`[Dynamic Vision] Board ${board.name} corrected. New XF applied.`);
                transform = freshXf;
              }
            } catch (e) {
              console.warn(`[Dynamic Vision] XF solve failed, falling back to baseline: ${e.message}`);
            }
          }
          setJobStage('dispensing');
        } else if (applyXf && dynamicPanelCorrection && solvedFiducials.length < 2) {
          console.log(`[Dynamic Vision] Skipping for board "${board.name}" — need ≥2 solved fiducials, got ${solvedFiducials.length}. Using baseline transform.`);
        }

        console.log(`--- DISPENSING ${board.name.toUpperCase()} ---`);
        console.log("Active Transform (XF):", transform);

        // Safety Check per board
        const startRef = transform ? applyTransform(transform, refPoint || { x: 0, y: 0 }) : (refPoint || { x: 0, y: 0 });
        if (startRef.x < 0 || startRef.y < 0) {
          if (!confirm(`WARNING: ${board.name} evaluates to negative machine coords (X${startRef.x.toFixed(2)}, Y${startRef.y.toFixed(2)}). Continue?`)) {
            throw new Error(`Job Aborted by User on ${board.name}`);
          }
        }

        for (let i = 0; i < seq.length; i++) {
          if (!isJobRunningRef.current) throw new Error("Job Aborted");

          globalPointCount++;
          globalPointCountRef.current = globalPointCount;
          setJobProgress({ current: globalPointCount, total: totalPoints });

          if (globalPointCount <= startFromPad) continue;

          let p = seq[i];

          let tp = null;
          if (panelXf && board.offsetX != null) {
            // Global panel transform: shift pad into panel space first, then apply T_panel
            const panelSpacePt = { x: p.x + board.offsetX, y: p.y + board.offsetY };
            tp = applyTransform(panelXf, panelSpacePt);
            // Optional per-board local correction on top (if transform != panelXf)
            if (transform && transform !== panelXf) tp = applyTransform(transform, tp);
            const camX = tp.x - (toolOffset?.dx || 0) + calibCorrection.x;
            const camY = tp.y - (toolOffset?.dy || 0) + calibCorrection.y;
            await sendGcodeWait(`G1 X${camX.toFixed(3)} Y${camY.toFixed(3)} F${speedSettings.travelSpeed || 6000}`);
            p = { ...p, x: tp.x, y: tp.y };
          } else if (transform) {
            tp = applyTransform(transform, p);
            const camX = tp.x - (toolOffset?.dx || 0) + calibCorrection.x;
            const camY = tp.y - (toolOffset?.dy || 0) + calibCorrection.y;
            await sendGcodeWait(`G1 X${camX.toFixed(3)} Y${camY.toFixed(3)} F${speedSettings.travelSpeed || 6000}`);
            p = { ...p, x: tp.x, y: tp.y };
          } else {
            // No transform: align manually using the effective origin
            const ox = selectedOrigin ? selectedOrigin.x : (boardOutline ? boardOutline.minX : 0);
            const oy = selectedOrigin ? selectedOrigin.y : (boardOutline ? boardOutline.minY : 0);
            p = { ...p, x: p.x - ox, y: p.y - oy };
          }

          // ─── APPLY CALIBRATION CORRECTION (same as "Move Camera Here") ──────
          const finalX = p.x + calibCorrection.x;
          const finalY = p.y + calibCorrection.y;

          // Soft axis limits guard — abort job if this pad is outside travel envelope
          const zWork = dispenseHeight + getZOffsetForPoint(finalX, finalY);
          assertInBounds(finalX, finalY, zWork, `pad ${globalPointCount}`);

          const pressure = dispensingSequencer.calculatePadPressure(p, { customPressure: localPressure });
          const configDwell = pressureSettings.customDwellTime || baseDwellTime;
          const dwell = dispensingSequencer.calculateDwellTime(p, { customDwellTime: configDwell });
          const dispenseMode = dispensingSequencer.selectDispenseMode(p, { beadAreaThreshold });

          const padVolUl = glueSummary?.annotated?.[globalPointCount - 1]?.glue?.volUl ?? 0;
          setCurrentPadInfo({
            padIndex: globalPointCount,
            total: totalPoints,
            pressure,
            dwellMs: dwell,
            volumeUl: padVolUl.toFixed ? padVolUl.toFixed(3) : '—',
            mode: dispenseMode.mode,
          });

          // Accumulate log entry for this pad
          padLogRef.current.push({
            padIndex: globalPointCount,
            padId: p.id || p.componentIdentifier || `P${globalPointCount}`,
            x: finalX.toFixed(3),
            y: finalY.toFixed(3),
            pressure,
            dwellMs: dwell,
            volumeUl: padVolUl.toFixed ? padVolUl.toFixed(4) : '0',
            dotPassed: null,
            dotDiameter_mm: '',
          });

          let cmds;
          if (dispenseMode.mode === 'bead') {
            cmds = dispenseBead({
              x: finalX, y: finalY,
              beadLength: dispenseMode.length,
              beadAxis: dispenseMode.axis,
              zWork,
              zSafe: safeTravelHeight,
              feedXY: speedSettings.travelSpeed || 6000,
              feedZ: speedSettings.dispenseSpeed || 300,
              feedBead: beadFeedRate,
              pressure,
            });
          } else {
            cmds = dispensePoint({
              x: finalX, y: finalY,
              zWork,
              zSafe: safeTravelHeight,
              feedXY: speedSettings.travelSpeed || 6000,
              feedZ: speedSettings.dispenseSpeed || 300,
              pressure,
              dwellMs: dwell,
            });
          }
          for (const c of cmds) {
            await sendGcodeWait(c);
          }

          nozzleMaintenance.recordDispense();

          // ── Post-dispense dot verification ─────────────────────────────
          if (enableDotVerification && tp) {
            // Move camera back over the just-dispensed pad (tp = transformed machine coord)
            const camX = tp.x - (toolOffset?.dx || 0) + calibCorrection.x;
            const camY = tp.y - (toolOffset?.dy || 0) + calibCorrection.y;
            await sendGcodeWait(`G1 X${camX.toFixed(3)} Y${camY.toFixed(3)} F${speedSettings.travelSpeed || 6000}`);
            await sendGcodeWait('M400');
            await new Promise(r => setTimeout(r, 400)); // settle
            try {
              const res = await fetch('http://localhost:8000/api/check_glue_dot');
              if (res.ok) {
                const dot = await res.json();
                const result = { padIndex: globalPointCount, passed: dot.found, diameter_mm: dot.diameter_mm ?? 0, confidence: dot.confidence ?? 0 };
                setDotCheckResults(prev => [...prev, result]);
                // Backfill dot result into the log entry for this pad
                const entry = padLogRef.current.find(e => e.padIndex === globalPointCount);
                if (entry) { entry.dotPassed = dot.found; entry.dotDiameter_mm = dot.diameter_mm ?? ''; }
              }
            } catch (_e) { /* vision server offline — skip silently */ }
          }
        }
        if (glueSummary) {
          GlueStore.addUsed(glueSummary.totalVolUl);
          setGlueStock(GlueStore.getStock()); // trigger GlueGauge re-read
        }
      }

      await sendGcodeWait(`G1 Z${safeTravelHeight} F3000`); // Move to safe height
      await sendGcodeWait('G1 X0 Y0 F5000'); // Move to home position
      await sendGcodeWait('M400'); // Wait for all moves to complete

      const jobDurationMs = Date.now() - (jobStartTimeRef.current || Date.now());
      setDotCheckResults(prev => {
        const failed = prev.filter(r => !r.passed).length;
        setJobReport({
          totalPads: totalPoints,
          totalVolUl: glueSummary?.totalVolUl != null ? glueSummary.totalVolUl.toFixed(2) : '—',
          jobDurationSec: (jobDurationMs / 1000).toFixed(1),
          avgDwellMs: baseDwellTime,
          basePressure: localPressure,
          dotsFailed: enableDotVerification ? failed : null,
          dotsChecked: enableDotVerification ? prev.length : null,
          probedSurfaceZ: probedSurfaceZRef.current,
        });
        // Persist dot quality to SPC store
        if (enableDotVerification && prev.length > 0) {
          spcAppend(prev, totalPoints);
          setSpcData(spcLoad());
        }
        return prev;
      });

      // ── Write job log CSV ──────────────────────────────────────────
      if (window.fs?.saveJobLog) {
        const now = new Date();
        // const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `glue-job.csv`;
        const header = [
          `# Glue Dispensing Job Log`,
          `# Date: ${now.toISOString()}`,
          `# Total Pads: ${totalPoints}`,
          `# Total Volume (µL): ${glueSummary?.totalVolUl != null ? glueSummary.totalVolUl.toFixed(4) : 'N/A'}`,
          `# Duration (s): ${(jobDurationMs / 1000).toFixed(1)}`,
          `# Base Pressure (PSI): ${localPressure}`,
          `# Avg Dwell (ms): ${baseDwellTime}`,
          `# Dot Verification: ${enableDotVerification ? 'ON' : 'OFF'}`,
          `#`,
          `Pad#,PadID,X_mm,Y_mm,Pressure_PSI,Dwell_ms,Volume_uL,DotPassed,DotDiameter_mm`,
        ].join('\n');
        const rows = padLogRef.current.map(e =>
          `${e.padIndex},${e.padId},${e.x},${e.y},${e.pressure},${e.dwellMs},${e.volumeUl},${e.dotPassed ?? ''},${e.dotDiameter_mm}`
        ).join('\n');
        window.fs.saveJobLog({ filename, content: header + '\n' + rows })
          .then(r => { if (r.ok) console.log(`[JobLog] Saved: ${r.path}`); });
      }

      localStorage.removeItem('resumeFromPad');
      setResumeFromPad(0);
      globalPointCountRef.current = 0;
      setCurrentPadInfo(null);
      if (onJobComplete) onJobComplete();
      setJobStage('finished');
      setMachineStatus('idle');
      isJobRunningRef.current = false;
      setIsJobRunning(false);

    } catch (e) {
      console.error(e);
      if (e.message !== "Job Aborted") alert("Error: " + e.message);
      setJobStage('idle');
      setMachineStatus('idle');
      isJobRunningRef.current = false;
      setIsJobRunning(false);
    } finally {
      window.pauseSerialPolling = false;
    }
  };

  const purgeNozzle = async (durationMs = purgeDurationMs, pressure = localPressure) => {
    setIsPurging(true);
    try {
      await sendGcodeWait(`M42 P4 S${Math.round(pressure)}`);
      await sendGcodeWait(`G4 P${Math.round(durationMs)}`);
      await sendGcodeWait('M42 P4 S0');
      await sendGcodeWait('M400');
    } finally {
      setIsPurging(false);
    }
  };

  const cancelJob = async () => {
    const padsDone = globalPointCountRef.current;
    isJobRunningRef.current = false;
    setIsJobRunning(false);
    ackQueue.current = []; // Unblock any pending sendGcodeWait
    if (padsDone > 0) {
      localStorage.setItem('resumeFromPad', String(padsDone));
      setResumeFromPad(padsDone);
    }
    // Emergency: bypass the queue — send directly so the machine stops immediately
    try {
      await window.serial.writeLine('M42 P4 S0');
      await window.serial.writeLine('G1 Z10 F3000');
    } catch (e) { }
    setJobStage('idle');
    setMachineStatus('idle');
    setCurrentPadInfo(null);
    if (onJobComplete) onJobComplete();
  };

  const jog = async (axis, dir) => {
    const dist = dir * jogStep;
    const cmds = jogRel(axis === 'X' ? { dx: dist, feed: 2000 } : { dy: dist, feed: 2000 });
    for (const c of cmds) await sendGcodeWait(c);
  };
  const jogZ = async (dir) => {
    const cmds = jogRel({ dz: dir * 0.5, feed: 500 });
    for (const c of cmds) await sendGcodeWait(c);
  };

  // Move CAMERA crosshair to a pad position (no tool offset — camera is the reference)
  // Applies the live calibration correction so the crosshair lands precisely on-center
  const moveCameraToMachineCoord = async (mx, my) => {
    if (!window.serial || !window.serial.writeLine) return alert('Serial not connected');
    const feed = speedSettings?.travelSpeed || 4000;
    const corrX = mx + calibCorrection.x;
    const corrY = my + calibCorrection.y;
    await window.serial.writeLine(`G1 Z${safeTravelHeight} F3000`);
    await window.serial.writeLine(`G1 X${corrX.toFixed(3)} Y${corrY.toFixed(3)} F${feed}`);
    console.log(`[AlignPreview] Camera → predicted(${mx.toFixed(3)},${my.toFixed(3)}) corrected(${corrX.toFixed(3)},${corrY.toFixed(3)}) correction(${calibCorrection.x.toFixed(3)},${calibCorrection.y.toFixed(3)})`);
  };

  const handleDownloadGCode = () => {
    if (!activeSequence.length) return;
    const gcode = dispensingSequencer.generateDispensingGCode(refPoint, activeSequence, {
      pressureSettings: { ...pressureSettings, customDwellTime: baseDwellTime },
      speedSettings,
      xf: xfRef.current,
      applyXf,
      valveOnCmd,
      valveOffCmd,
      dispenseHeight,
      safeHeight: safeTravelHeight,
      toolOffset,
      side,
      boardWidth: currentBoardSize?.width || 0
    });
    const blob = new Blob([gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dispensing_job.gcode';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Soft axis limits ─────────────────────────────────────────────────────
  const assertInBounds = (x, y, z, label = '') => {
    const { maxX, maxY, maxZ } = axisLimits;
    const errs = [];
    if (x != null && (x < 0 || x > maxX)) errs.push(`X${x.toFixed(3)} outside [0, ${maxX}]`);
    if (y != null && (y < 0 || y > maxY)) errs.push(`Y${y.toFixed(3)} outside [0, ${maxY}]`);
    if (z != null && (z < 0 || z > maxZ)) errs.push(`Z${z.toFixed(3)} outside [0, ${maxZ}]`);
    if (errs.length) throw new Error(`Move out of bounds${label ? ` [${label}]` : ''}: ${errs.join(', ')}`);
  };

  // ── Recipe helpers ────────────────────────────────────────────────────────
  const RECIPE_KEY = 'glueRecipes';

  const recipeSnapshot = () => ({
    localPressure, baseDwellTime, dispenseHeight, safeTravelHeight,
    viscosity, beadAreaThreshold, beadFeedRate,
    purgeEnabled, purgeDurationMs,
    valveOnCmd, valveOffCmd,
    enableDotVerification, enableSurfaceProbe,
    nozzleDia,
  });

  const persistRecipes = (obj) => {
    localStorage.setItem(RECIPE_KEY, JSON.stringify(obj));
    setSavedRecipes(obj);
  };

  const handleSaveRecipe = () => {
    const name = recipeName.trim();
    if (!name) return;
    persistRecipes({ ...savedRecipes, [name]: recipeSnapshot() });
    setActiveRecipe(name);
  };

  const handleLoadRecipe = (name) => {
    const r = savedRecipes[name];
    if (!r) return;
    if (r.localPressure     != null) setLocalPressure(r.localPressure);
    if (r.baseDwellTime     != null) setBaseDwellTime(r.baseDwellTime);
    if (r.dispenseHeight    != null) setDispenseHeight(r.dispenseHeight);
    if (r.safeTravelHeight  != null) setSafeTravelHeight(r.safeTravelHeight);
    if (r.viscosity         != null) setViscosity(r.viscosity);
    if (r.beadAreaThreshold != null) setBeadAreaThreshold(r.beadAreaThreshold);
    if (r.beadFeedRate      != null) setBeadFeedRate(r.beadFeedRate);
    if (r.purgeEnabled      != null) setPurgeEnabled(r.purgeEnabled);
    if (r.purgeDurationMs   != null) setPurgeDurationMs(r.purgeDurationMs);
    if (r.valveOnCmd        != null) setValveOnCmd(r.valveOnCmd);
    if (r.valveOffCmd       != null) setValveOffCmd(r.valveOffCmd);
    if (r.enableDotVerification != null) setEnableDotVerification(r.enableDotVerification);
    if (r.enableSurfaceProbe    != null) setEnableSurfaceProbe(r.enableSurfaceProbe);
    if (r.nozzleDia         != null) setNozzleDia(r.nozzleDia);
    setActiveRecipe(name);
    setRecipeName(name);
  };

  const handleDeleteRecipe = (name) => {
    if (!confirm(`Delete recipe "${name}"?`)) return;
    const updated = { ...savedRecipes };
    delete updated[name];
    persistRecipes(updated);
    if (activeRecipe === name) { setActiveRecipe(''); setRecipeName(''); }
  };

  const handleExportRecipes = () => {
    const blob = new Blob([JSON.stringify(savedRecipes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'glue-recipes.json'; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportRecipes = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error();
        const merged = { ...savedRecipes, ...imported };
        persistRecipes(merged);
        alert(`Imported ${Object.keys(imported).length} recipe(s).`);
      } catch { alert('Invalid recipe file — expected a JSON object of recipes.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="panel automated-panel">
      <h3 style={{ marginLeft: '10px' }}>🤖 Automated Dispensing</h3>
      <div className='panel-data'>
        <div className="box">
          <h4>Settings</h4>
          <label style={{ display: 'block', marginBottom: '8px' }}>
            <input type="checkbox" checked={useSafePathPlanning} onChange={e => setUseSafePathPlanning(e.target.checked)} />
            Safe Path Planning
          </label>
          <hr style={{ borderColor: '#444', margin: '12px 0' }} />
          <h5>G-Code Generation Config</h5>
          <div className="grid2" style={{ gap: '8px', fontSize: '0.9em' }}>
            <label style={{ gridColumn: '1 / -1' }}>
              Glue Viscosity (Presets):
              <select value={viscosity} onChange={e => setViscosity(e.target.value)} style={{ width: '100%', marginTop: '4px', padding: '4px' }}>
                <option value="low">Thin / Low (Superglue, UV)</option>
                <option value="medium">Medium (Standard Paste/Glue)</option>
                <option value="high">Thick / High (Solder Paste, Thermal)</option>
              </select>
            </label>
            <label>
              Valve ON Cmd:
              <input type="text" value={valveOnCmd} onChange={e => setValveOnCmd(e.target.value)} style={{ width: '100%', marginTop: '4px' }} />
            </label>
            <label>
              Valve OFF Cmd:
              <input type="text" value={valveOffCmd} onChange={e => setValveOffCmd(e.target.value)} style={{ width: '100%', marginTop: '4px' }} />
            </label>
            <label>
              Dispense Z (mm):
              <input type="number" step="0.1" value={dispenseHeight} onChange={e => setDispenseHeight(parseFloat(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
            </label>
            <label>
              Safe Travel Z (mm):
              <input type="number" step="1" value={safeTravelHeight} onChange={e => setSafeTravelHeight(parseFloat(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <span style={{ color: '#f85149', fontWeight: 600 }}>⬛ Axis Limits (mm)</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 4 }}>
                <label style={{ fontSize: '0.85em' }}>
                  Max X
                  <input type="number" step="10" min="10" value={axisLimits.maxX}
                    onChange={e => setAxisLimits(l => ({ ...l, maxX: Number(e.target.value) }))}
                    style={{ width: '100%', marginTop: 2 }} />
                </label>
                <label style={{ fontSize: '0.85em' }}>
                  Max Y
                  <input type="number" step="10" min="10" value={axisLimits.maxY}
                    onChange={e => setAxisLimits(l => ({ ...l, maxY: Number(e.target.value) }))}
                    style={{ width: '100%', marginTop: 2 }} />
                </label>
                <label style={{ fontSize: '0.85em' }}>
                  Max Z
                  <input type="number" step="5" min="5" value={axisLimits.maxZ}
                    onChange={e => setAxisLimits(l => ({ ...l, maxZ: Number(e.target.value) }))}
                    style={{ width: '100%', marginTop: 2 }} />
                </label>
              </div>
              <small style={{ color: '#8b949e' }}>Min is always 0. Pre-flight will fail if any pad exceeds these.</small>
            </label>
            <label>
              Base Dwell (ms):
              <input type="number" step="10" value={baseDwellTime} onChange={e => setBaseDwellTime(Number(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
            </label>
            <label>
              Dispense Pressure (PSI):
              <input type="number" step="1" min="5" max="100" value={localPressure} onChange={e => setLocalPressure(Number(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
            </label>
            <label>
              Bead Threshold (mm²):
              <input type="number" step="0.5" min="0.5" max="20" value={beadAreaThreshold} onChange={e => setBeadAreaThreshold(Number(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
              <small style={{ color: '#888' }}>Pads above this area → bead; below → single dot</small>
            </label>
            <label>
              Bead Speed (mm/min):
              <input type="number" step="50" min="50" max="3000" value={beadFeedRate} onChange={e => setBeadFeedRate(Number(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
            </label>
            {purgeEnabled && (
              <label>
                Purge Duration (ms):
                <input
                  type="number"
                  step="500"
                  min="500"
                  max="10000"
                  value={purgeDurationMs}
                  onChange={e => setPurgeDurationMs(Number(e.target.value))}
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
            )}
            <br />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', gridColumn: '1 / -1' }}>
              <input
                type="checkbox"
                checked={enableSurfaceProbe}
                onChange={e => setEnableSurfaceProbe(e.target.checked)}
                style={{ width: 'auto', marginTop: 0 }}
              />
              <span>Z-axis surface probe before dispensing</span>
            </label>
            {enableSurfaceProbe && (
              <div style={{ gridColumn: '1 / -1', fontSize: '0.78em', color: '#8b949e', paddingLeft: 22, marginTop: -4 }}>
                Sends <code>G38.2 Z-30 F50</code> after PCB load — detects actual PCB surface, sets Z=0 there. Dispense Z is then clearance above that surface. Requires a probe/BLTouch wired to the controller.
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enableDotVerification}
                onChange={e => setEnableDotVerification(e.target.checked)}
                style={{ width: 'auto', marginTop: 0 }}
              />
              <span>Verify glue dot after each pad</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={purgeEnabled}
                onChange={e => setPurgeEnabled(e.target.checked)}
                style={{ width: 'auto', marginTop: 0 }}
              />
              <span>Purge nozzle before job</span>
            </label>
          </div>

          {/* ── Recipe Manager ──────────────────────────────────────────── */}
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#58a6ff', fontSize: '0.9em', userSelect: 'none' }}>
              🗂 Recipe Manager
            </summary>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>

              {/* Save current settings */}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  placeholder="Recipe name…"
                  value={recipeName}
                  onChange={e => setRecipeName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSaveRecipe()}
                  style={{ flex: 1, padding: '4px 8px', fontSize: '0.85em', background: '#161b22', border: '1px solid #30363d', color: '#e6edf3', borderRadius: 4 }}
                />
                <button
                  className="btn"
                  style={{ fontSize: '0.82em', padding: '4px 12px', whiteSpace: 'nowrap' }}
                  disabled={!recipeName.trim()}
                  onClick={handleSaveRecipe}
                  title="Save current settings as a recipe"
                >💾 Save</button>
              </div>

              {/* Saved recipes list */}
              {Object.keys(savedRecipes).length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 190, overflowY: 'auto' }}>
                  {Object.keys(savedRecipes).map(name => (
                    <div key={name} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
                      background: activeRecipe === name ? 'rgba(88,166,255,0.1)' : '#161b22',
                      border: `1px solid ${activeRecipe === name ? '#58a6ff44' : '#30363d'}`,
                      borderRadius: 4, fontSize: '0.82em',
                    }}>
                      <span style={{ flex: 1, color: '#e6edf3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>
                        {activeRecipe === name && <span style={{ color: '#58a6ff', marginRight: 4 }}>▶</span>}
                        {name}
                      </span>
                      <button
                        style={{ fontSize: '0.75em', padding: '2px 8px', background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', flexShrink: 0 }}
                        onClick={() => handleLoadRecipe(name)}
                      >Load</button>
                      <button
                        style={{ fontSize: '0.75em', padding: '2px 6px', background: 'transparent', color: '#f85149', border: '1px solid #f8514966', borderRadius: 3, cursor: 'pointer', flexShrink: 0 }}
                        onClick={() => handleDeleteRecipe(name)}
                        title={`Delete "${name}"`}
                      >✕</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: '#8b949e', fontSize: '0.8em', fontStyle: 'italic', padding: '4px 0' }}>
                  No saved recipes. Enter a name above and click Save.
                </div>
              )}

              {/* Import / Export */}
              <div style={{ display: 'flex', gap: 6, borderTop: '1px solid #21262d', paddingTop: 8, marginTop: 2 }}>
                <button
                  className="btn secondary"
                  style={{ flex: 1, fontSize: '0.78em', padding: '4px 0' }}
                  disabled={Object.keys(savedRecipes).length === 0}
                  onClick={handleExportRecipes}
                  title="Download all recipes as a JSON file"
                >⬇ Export JSON</button>
                <label style={{ flex: 1 }}>
                  <span className="btn secondary" style={{ display: 'block', textAlign: 'center', fontSize: '0.78em', padding: '4px 0', cursor: 'pointer' }}>
                    ⬆ Import JSON
                  </span>
                  <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportRecipes} />
                </label>
              </div>

            </div>
          </details>

          {/* ── SPC / Dot Quality Trend  ── */}
          {(() => {
            const jobs = spcData.jobs;
            if (jobs.length === 0 && !enableDotVerification) return null;

            const recent   = jobs.slice(-10);
            const passRates = recent.map(j => j.passRate * 100);
            const diameters = recent.filter(j => j.avgDiameter != null).map(j => j.avgDiameter);

            const overallPass  = jobs.length > 0
              ? jobs.reduce((s, j) => s + j.passed, 0) / jobs.reduce((s, j) => s + j.checked, 0) * 100
              : null;
            const recentAvgPass = recent.length > 0
              ? recent.reduce((s, j) => s + j.passRate, 0) / recent.length * 100
              : null;

            // Nozzle wear: compare first-half vs second-half avg diameter
            const half = Math.floor(diameters.length / 2);
            const diamTrend = half >= 2
              ? (diameters.slice(half).reduce((a, b) => a + b, 0) / (diameters.length - half)) -
                (diameters.slice(0, half).reduce((a, b) => a + b, 0) / half)
              : 0;

            const qualityAlert = recentAvgPass !== null && recentAvgPass < 80;
            const wearAlert    = diamTrend < -0.05;

            return (
              <details style={{ marginTop: 14 }} open={qualityAlert || wearAlert}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, color: qualityAlert || wearAlert ? '#f85149' : '#58a6ff', fontSize: '0.9em', userSelect: 'none' }}>
                  📊 SPC — Dot Quality Trend {(qualityAlert || wearAlert) && '⚠'}
                </summary>
                <div style={{ marginTop: 10, fontSize: '0.82em', display: 'flex', flexDirection: 'column', gap: 8 }}>

                  {/* Alert banners */}
                  {qualityAlert && (
                    <div style={{ padding: '6px 10px', background: 'rgba(220,50,50,0.12)', border: '1px solid #f85149', borderRadius: 5, color: '#f85149' }}>
                      ⚠ Recent pass rate {recentAvgPass.toFixed(0)}% — below 80% threshold. Consider purging or replacing the nozzle.
                    </div>
                  )}
                  {wearAlert && !qualityAlert && (
                    <div style={{ padding: '6px 10px', background: 'rgba(227,179,65,0.12)', border: '1px solid #e3b341', borderRadius: 5, color: '#e3b341' }}>
                      ⚠ Dot diameter shrinking ({(diamTrend * 1000).toFixed(0)} µm/job trend) — possible nozzle clogging.
                    </div>
                  )}

                  {jobs.length === 0 ? (
                    <div style={{ color: '#8b949e', fontStyle: 'italic' }}>
                      No data yet. Enable "Verify glue dot after each pad" and run a job to start tracking.
                    </div>
                  ) : (
                    <>
                      {/* Summary stats */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                        <div style={{ background: '#161b22', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
                          <div style={{ color: '#8b949e', fontSize: '0.78em' }}>Jobs tracked</div>
                          <div style={{ color: '#e6edf3', fontWeight: 700, fontSize: '1.1em' }}>{jobs.length}</div>
                        </div>
                        <div style={{ background: '#161b22', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
                          <div style={{ color: '#8b949e', fontSize: '0.78em' }}>Overall pass</div>
                          <div style={{ color: overallPass >= 90 ? '#3fb950' : overallPass >= 75 ? '#e3b341' : '#f85149', fontWeight: 700, fontSize: '1.1em' }}>
                            {overallPass != null ? `${overallPass.toFixed(1)}%` : '—'}
                          </div>
                        </div>
                        <div style={{ background: '#161b22', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
                          <div style={{ color: '#8b949e', fontSize: '0.78em' }}>Avg diameter</div>
                          <div style={{ color: '#58a6ff', fontWeight: 700, fontSize: '1.1em' }}>
                            {diameters.length > 0 ? `${(diameters.reduce((a, b) => a + b, 0) / diameters.length).toFixed(2)} mm` : '—'}
                          </div>
                        </div>
                      </div>

                      {/* Pass rate sparkline */}
                      {passRates.length >= 2 && (
                        <div>
                          <div style={{ color: '#8b949e', marginBottom: 3 }}>Pass rate — last {recent.length} jobs</div>
                          <div style={{ background: '#161b22', borderRadius: 5, padding: '6px 8px' }}>
                            <Sparkline values={passRates} color={recentAvgPass >= 80 ? '#3fb950' : '#f85149'} height={40} />
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8b949e', fontSize: '0.76em', marginTop: 2 }}>
                              <span>← oldest</span>
                              <span>{passRates[passRates.length - 1].toFixed(0)}% latest</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Diameter sparkline */}
                      {diameters.length >= 2 && (
                        <div>
                          <div style={{ color: '#8b949e', marginBottom: 3 }}>Avg dot diameter (mm) — last {diameters.length} jobs</div>
                          <div style={{ background: '#161b22', borderRadius: 5, padding: '6px 8px' }}>
                            <Sparkline values={diameters} color={wearAlert ? '#e3b341' : '#58a6ff'} height={40} />
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8b949e', fontSize: '0.76em', marginTop: 2 }}>
                              <span>← oldest</span>
                              <span>{diameters[diameters.length - 1].toFixed(3)} mm latest</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Per-job history table */}
                      <details>
                        <summary style={{ cursor: 'pointer', color: '#8b949e', fontSize: '0.8em' }}>Show job history ({jobs.length} entries)</summary>
                        <div style={{ maxHeight: 160, overflowY: 'auto', marginTop: 6 }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78em' }}>
                            <thead>
                              <tr style={{ color: '#8b949e', textAlign: 'left' }}>
                                <th style={{ padding: '2px 6px' }}>Date</th>
                                <th style={{ padding: '2px 6px' }}>Pass</th>
                                <th style={{ padding: '2px 6px' }}>Fail</th>
                                <th style={{ padding: '2px 6px' }}>Rate</th>
                                <th style={{ padding: '2px 6px' }}>Avg ⌀</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...jobs].reverse().map((j, i) => (
                                <tr key={i} style={{ borderTop: '1px solid #21262d' }}>
                                  <td style={{ padding: '2px 6px', color: '#8b949e' }}>{j.date}</td>
                                  <td style={{ padding: '2px 6px', color: '#3fb950' }}>{j.passed}</td>
                                  <td style={{ padding: '2px 6px', color: j.failed > 0 ? '#f85149' : '#8b949e' }}>{j.failed}</td>
                                  <td style={{ padding: '2px 6px', color: j.passRate >= 0.9 ? '#3fb950' : j.passRate >= 0.75 ? '#e3b341' : '#f85149', fontWeight: 600 }}>
                                    {(j.passRate * 100).toFixed(0)}%
                                  </td>
                                  <td style={{ padding: '2px 6px', color: '#58a6ff' }}>
                                    {j.avgDiameter != null ? `${j.avgDiameter.toFixed(3)}` : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>

                      <button
                        className="btn secondary"
                        style={{ fontSize: '0.78em', padding: '4px 0', marginTop: 2 }}
                        onClick={() => { if (confirm('Clear all SPC data?')) { localStorage.removeItem(SPC_KEY); setSpcData({ jobs: [] }); } }}
                      >🗑 Clear SPC Data</button>
                    </>
                  )}
                </div>
              </details>
            );
          })()}

          {/* Fine-Tune XY Correction UI disabled — fineTuneX and fineTuneY state removed */}
          <div style={{ marginTop: 14 }}>
            <GlueGauge
              summary={glueSummary}
              nozzleDia={nozzleDia}
              onNozzleDia={setNozzleDia}
              onStockChange={(v) => { setGlueStock(v); }}
              onRefill={(v) => { setGlueStock(v); }}
            />
          </div>

          <MaintenanceManager
            manager={nozzleMaintenance}
            onPurge={purgeNozzle}
            isPurging={isPurging}
          />
        </div>

        {/* Dispense Sequence Preview & Board Info */}
        {(currentBoardSize || boardOutline) && (
          <div className="box" style={{ marginTop: '12px' }}>
            <div className="flex-row" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
              <span><strong>PCB Size:</strong> {(currentBoardSize?.width || 0).toFixed(1)} x {(currentBoardSize?.height || 0).toFixed(1)}mm </span>
              <span><strong>Total Glue Drops:</strong> {activeSequence.length}</span>
            </div>

            {activeSequence.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontWeight: 'bold', color: '#0056b3' }}>
                  👀 View Mathematical Volume Mapping & Timings
                </summary>
                <div style={{ maxHeight: '250px', overflowY: 'auto', marginTop: '8px', border: '1px solid #ddd' }}>
                  <table className="kv small" style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                    <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
                      <tr>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc' }}>#</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc' }}>Shape</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc' }}>Dimensions (mm)</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc' }}>Exact Area (mm²)</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc', color: '#d32f2f' }}>Dwell (ms)</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc', color: '#00c49a' }}>Dots</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc', color: '#00c49a' }}>Vol (µL)</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc', color: '#ffa726' }}>PSI</th>
                        <th style={{ padding: '4px 8px', borderBottom: '1px solid #ccc', color: '#ce93d8' }}>Mode</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeSequence.map((pad, idx) => {
                        const area = dispensingSequencer.calculatePadArea(pad);
                        const dwell = dispensingSequencer.calculateDwellTime(pad, { customDwellTime: baseDwellTime });
                        const dm = dispensingSequencer.selectDispenseMode(pad, { beadAreaThreshold });
                        return (
                          <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                            <td style={{ padding: '4px 8px' }}>{idx + 1}</td>
                            <td style={{ padding: '4px 8px' }}>{pad.isSubDot ? 'SubDot' : (pad.shape || 'Rect')}</td>
                            <td style={{ padding: '4px 8px' }}>{(pad.width || 0).toFixed(2)} × {(pad.height || 0).toFixed(2)}</td>
                            <td style={{ padding: '4px 8px' }}>{area.toFixed(3)}</td>
                            <td style={{ padding: '4px 8px', fontWeight: 'bold', color: '#d32f2f' }}>{dwell}</td>
                            <td style={{ padding: '4px 8px' }}>
                              {glueSummary?.perPad?.[idx]?.dots ?? '—'}
                            </td>
                            <td style={{ padding: '4px 8px', fontWeight: 'bold', color: '#00c49a' }}>
                              {glueSummary?.perPad?.[idx]?.volUl?.toFixed(3) ?? '—'}
                            </td>
                            <td style={{ padding: '4px 8px', color: '#ffa726' }}>
                              {dispensingSequencer.calculatePadPressure(pad, { customPressure: localPressure })}
                            </td>
                            <td style={{ padding: '4px 8px', color: '#ce93d8', fontWeight: 'bold' }}>
                              {dm.mode === 'bead' ? `bead-${dm.axis}` : 'dot'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        )}

        {!refPoint && <div className="warning">⚠️ No Reference Point Selected</div>}

        {applyXf && (
          <div style={{ marginTop: 12, padding: '10px', background: '#ffebee', color: '#b71c1c', borderRadius: 4, fontSize: '0.86rem', display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid #ffcdd2' }}>
            <label style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dynamicPanelCorrection}
                onChange={e => setDynamicPanelCorrection(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              Dynamic Panel Auto-Correction (Recommended)
            </label>
            <span style={{ fontSize: '0.82rem', marginLeft: 22, opacity: 0.9 }}>
              If enabled, the camera instantly re-solves the exact fiducials of each board inside the panel moments before dispensing it. This permanently fixes Y/X drift caused by warped or stretched FR4 panel margins!
            </span>
          </div>
        )}

        {/* ── Pad Alignment Preview ─────────────────────────── */}
        {activeSequence.length > 0 && fiducials.some(f => f.design && f.machine) && (
          <div style={{ marginTop: 14, padding: '12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontWeight: 'bold', color: '#58a6ff', fontSize: '0.9em' }}>🔍 Pad Alignment Preview</span>
              {calibCaptures.length > 0 && (
                <span style={{ fontSize: '0.75em', color: '#3fb950', background: '#0d2a0d', border: '1px solid #3fb950', borderRadius: 4, padding: '2px 6px' }}>
                  ✓ {calibCaptures.length} calibration point{calibCaptures.length > 1 ? 's' : ''} · correction: X{calibCorrection.x >= 0 ? '+' : ''}{calibCorrection.x.toFixed(3)} Y{calibCorrection.y >= 0 ? '+' : ''}{calibCorrection.y.toFixed(3)} mm
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.78em', color: '#8b949e', marginBottom: 10 }}>
              Move camera crosshair over each pad to verify alignment. Jog precisely onto a pad center, then click
              <strong style={{ color: '#f0a500' }}> 📌 Capture True Center</strong> to measure &amp; correct systematic offset.
            </div>

            {calibCaptures.length > 0 && (
              <div style={{ marginBottom: 10, padding: '6px 10px', background: '#161b22', borderRadius: 6, fontSize: '0.78em', border: '1px solid #3fb950' }}>
                <div style={{ color: '#3fb950', fontWeight: 'bold', marginBottom: 4 }}>📐 Active Correction (applied to camera preview moves)</div>
                <div style={{ color: '#e6edf3', fontFamily: 'monospace' }}>
                  ΔX = <span style={{ color: '#56d364' }}>{calibCorrection.x >= 0 ? '+' : ''}{calibCorrection.x.toFixed(4)} mm</span>
                  &nbsp;&nbsp;ΔY = <span style={{ color: '#56d364' }}>{calibCorrection.y >= 0 ? '+' : ''}{calibCorrection.y.toFixed(4)} mm</span>
                  &nbsp;&nbsp;<span style={{ color: '#8b949e' }}>(avg of {calibCaptures.length} captures)</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {/* Apply-to-Dispensing button disabled — fineTuneX/Y state removed */}
                  <button
                    style={{ fontSize: '0.75em', padding: '3px 8px', background: '#3a1111', color: '#f85149', border: '1px solid #f85149', borderRadius: 4, cursor: 'pointer' }}
                    onClick={() => setCalibCaptures([])}
                  >✕ Clear Calibration Points</button>
                </div>
                {/* Fine-tune sync warning disabled — fineTuneX/Y state removed */}
              </div>
            )}

            {(() => {
              const pad = activeSequence[previewPadIdx];
              if (!pad) return null;
              const previewP = { ...pad };
              const machineCoord = (applyXf && xf) ? applyTransform(xf, previewP) : null;
              // Apply calibration correction to show the corrected target
              const correctedCoord = machineCoord
                ? { x: machineCoord.x + calibCorrection.x, y: machineCoord.y + calibCorrection.y }
                : null;

              const captureCurrentAsCenter = () => {
                if (!machineCoord) return alert('No predicted machine coordinate for this pad.');
                if (!machinePosition || !isConnected) return alert('Machine position unknown. Connect machine first.');
                // delta = actual (current machine pos) - predicted
                // So correction = actual - predicted
                const deltaX = machinePosition.x - (machineCoord.x + calibCorrection.x);
                const deltaY = machinePosition.y - (machineCoord.y + calibCorrection.y);
                const newCapture = {
                  padIdx: previewPadIdx,
                  predicted: { x: machineCoord.x, y: machineCoord.y },
                  actual: { x: machinePosition.x, y: machinePosition.y },
                  delta: { x: deltaX + calibCorrection.x, y: deltaY + calibCorrection.y },
                  timestamp: Date.now()
                };
                setCalibCaptures(prev => {
                  // Replace any previous capture for this same pad index
                  const filtered = prev.filter(c => c.padIdx !== previewPadIdx);
                  return [...filtered, newCapture];
                });
                console.log(`[CalibCapture] Pad ${previewPadIdx + 1}: predicted=(${machineCoord.x.toFixed(3)},${machineCoord.y.toFixed(3)}) actual=(${machinePosition.x.toFixed(3)},${machinePosition.y.toFixed(3)}) correction=(${newCapture.delta.x.toFixed(3)},${newCapture.delta.y.toFixed(3)})`);
              };

              return (
                <>
                  <div style={{ background: '#161b22', borderRadius: 6, padding: '8px 12px', marginBottom: 10, fontFamily: 'monospace', fontSize: '0.82em' }}>
                    <div style={{ color: '#8b949e', marginBottom: 4 }}>Pad {previewPadIdx + 1} / {activeSequence.length}</div>
                    <div>Design: X<span style={{ color: '#79c0ff' }}>{pad.x.toFixed(3)}</span> Y<span style={{ color: '#79c0ff' }}>{pad.y.toFixed(3)}</span> mm</div>
                    {machineCoord ? (
                      <div style={{ marginTop: 4 }}>
                        <div>Predicted: X<span style={{ color: '#56d364' }}>{machineCoord.x.toFixed(3)}</span> Y<span style={{ color: '#56d364' }}>{machineCoord.y.toFixed(3)}</span> mm</div>
                        {calibCaptures.length > 0 && (
                          <div style={{ color: '#f0a500' }}>Corrected: X<span style={{ color: '#f0a500' }}>{correctedCoord.x.toFixed(3)}</span> Y<span style={{ color: '#f0a500' }}>{correctedCoord.y.toFixed(3)}</span> mm</div>
                        )}
                        <div style={{ color: '#6e7681', marginTop: 2 }}>Current machine: X{machinePosition.x.toFixed(3)} Y{machinePosition.y.toFixed(3)}</div>
                      </div>
                    ) : (
                      <div style={{ color: '#f85149', marginTop: 4 }}>⚠ No transform / fiducials available</div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                    <button
                      className="btn secondary" style={{ flex: 1, minWidth: 60 }}
                      disabled={previewPadIdx <= 0}
                      onClick={() => setPreviewPadIdx(i => i - 1)}
                    >◀ Prev</button>

                    <button
                      className="btn"
                      style={{ flex: 2, background: machineCoord ? '#1f6feb' : '#444', minWidth: 80 }}
                      disabled={!machineCoord || !isConnected}
                      onClick={() => correctedCoord && moveCameraToMachineCoord(machineCoord.x, machineCoord.y)}
                    >📷 Move Camera Here</button>

                    <button
                      className="btn secondary" style={{ flex: 1, minWidth: 60 }}
                      disabled={previewPadIdx >= activeSequence.length - 1}
                      onClick={() => setPreviewPadIdx(i => i + 1)}
                    >Next ▶</button>
                  </div>

                  {/* Live Calibration Capture */}
                  <div style={{ borderTop: '1px solid #21262d', paddingTop: 8, marginTop: 4 }}>
                    <div style={{ fontSize: '0.75em', color: '#8b949e', marginBottom: 6 }}>
                      <strong style={{ color: '#f0a500' }}>📌 Calibration:</strong> Click "Move Camera Here", then jog the machine until the crosshair is <em>exactly</em> on the pad center, then capture.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn"
                        style={{ flex: 1, background: isConnected && machineCoord ? '#4a3000' : '#333', border: '1px solid #f0a500', color: '#f0a500', fontWeight: 'bold' }}
                        disabled={!isConnected || !machineCoord}
                        onClick={captureCurrentAsCenter}
                        title="Record current machine position as true center of this pad. Computes systematic offset correction."
                      >📌 Capture True Center</button>
                    </div>
                    {calibCaptures.find(c => c.padIdx === previewPadIdx) && (
                      <div style={{ marginTop: 6, fontSize: '0.75em', color: '#3fb950', fontFamily: 'monospace' }}>
                        ✓ This pad captured: correction applied (ΔX={calibCaptures.find(c => c.padIdx === previewPadIdx).delta.x.toFixed(3)}, ΔY={calibCaptures.find(c => c.padIdx === previewPadIdx).delta.y.toFixed(3)} mm)
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* Flow UI */}
        <div className="flow-container">
          <div className="flow-header">
            <div className={`stage-indicator ${jobStage !== 'idle' ? 'active' : 'idle'}`}>
              <strong>Status:</strong> {jobStage.toUpperCase()}
              {machineStatus === 'busy' && ' (Busy)'}
              {panelBoards && panelBoards.length > 1 && jobStage === 'dispensing' && (
                <span style={{ marginLeft: 8, color: '#58a6ff', fontSize: '0.82em', fontFamily: 'monospace' }}>
                  Board {currentBoardIdx + 1}/{panelBoards.length}
                </span>
              )}
            </div>
            <div className="pos-readout">
              Pos: {machinePosition.x.toFixed(3)}, {machinePosition.y.toFixed(3)}, {machinePosition.z.toFixed(3)}
            </div>
          </div>

          {/* STAGE: IDLE */}
          {jobStage === 'idle' && (
            <div className="section">
              <h3>Processing Control</h3>

              {resumeFromPad > 0 && (
                <div style={{ marginBottom: 10, padding: '8px 12px', background: 'rgba(56,139,253,0.1)', border: '1px solid #388bfd', borderRadius: 6, fontSize: '0.83em' }}>
                  <div style={{ color: '#79c0ff', fontWeight: 600, marginBottom: 6 }}>
                    ↩ Job interrupted at pad {resumeFromPad} of {activeSequence.length * (panelBoards?.length || 1)}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn primary"
                      style={{ flex: 1, fontSize: '0.85em' }}
                      disabled={!isConnected}
                      onClick={startJobFlow}
                    >
                      Resume from pad {resumeFromPad + 1}
                    </button>
                    <button
                      className="btn secondary"
                      style={{ fontSize: '0.85em' }}
                      onClick={() => { localStorage.removeItem('resumeFromPad'); setResumeFromPad(0); }}
                    >
                      Start Fresh
                    </button>
                  </div>
                </div>
              )}

              <div className="row">
                <button
                  className={`btn ${isJobRunning ? 'danger' : 'primary'}`}
                  onClick={isJobRunning ? cancelJob : () => { if (resumeFromPad > 0) { localStorage.removeItem('resumeFromPad'); setResumeFromPad(0); } startJobFlow(); }}
                  disabled={!isConnected && !isJobRunning}
                >
                  {isJobRunning ? '⏹ ABORT JOB' : resumeFromPad > 0 ? '▶ Start From Beginning' : '▶ START JOB'}
                </button>

                <button
                  className="btn secondary"
                  onClick={handleDownloadGCode}
                  disabled={isJobRunning}
                >
                  💾 Download G-Code
                </button>
              </div>

              {jobMode === 'batch' && <p>Batch mode not supported in new flow yet</p>}
            </div>
          )}

          {/* STAGE: PREFLIGHT */}
          {jobStage === 'preflight' && (() => {
            const checks = computePreflightChecks();
            const criticalFailed = checks.some(c => c.critical && !c.passed);
            return (
              <div className="stage-box">
                <h4>Pre-flight Checklist</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                  {checks.map(c => {
                    const icon = c.passed ? '✓' : c.critical ? '✗' : '⚠';
                    const color = c.passed ? '#3fb950' : c.critical ? '#f85149' : '#e3b341';
                    return (
                      <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 5, border: `1px solid ${color}22` }}>
                        <span style={{ color, fontWeight: 700, fontSize: '1em', minWidth: 16, marginTop: 1 }}>{icon}</span>
                        <div>
                          <div style={{ color: c.passed ? '#e6edf3' : color, fontWeight: 500, fontSize: '0.85em' }}>{c.label}</div>
                          <div style={{ color: '#8b949e', fontSize: '0.76em', marginTop: 1 }}>{c.detail}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {criticalFailed && (
                  <div style={{ marginBottom: 10, padding: '6px 10px', background: 'rgba(220,50,50,0.1)', border: '1px solid #f85149', borderRadius: 5, fontSize: '0.8em', color: '#f85149' }}>
                    Fix the items marked ✗ before proceeding.
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn secondary full-width" onClick={() => setJobStage('idle')}>Cancel</button>
                  <button
                    className="btn primary full-width"
                    disabled={criticalFailed}
                    onClick={proceedFromPreflight}
                  >
                    {criticalFailed ? 'Fix Issues First' : 'Proceed ▶'}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* STAGE: HOMING */}
          {jobStage === 'homing' && (
            <div className="stage-box">
              <h4>Homing Machine...</h4>
              <div className="spinner"></div>
            </div>
          )}

          {/* STAGE: PURGING */}
          {jobStage === 'purging' && (
            <div className="stage-box">
              <h4>Purging Nozzle...</h4>
              <p style={{ color: '#8b949e', fontSize: '0.85em' }}>
                Priming nozzle for {(purgeDurationMs / 1000).toFixed(1)}s at {localPressure} PSI before first pad.
              </p>
              <div className="spinner"></div>
              <button className="btn danger full-width" style={{ marginTop: 10 }} onClick={cancelJob}>STOP</button>
            </div>
          )}

          {/* STAGE: LOADING */}
          {jobStage === 'loading' && (
            <div className="stage-box">
              <h4>Load PCB</h4>
              <p style={{ color: '#8b949e', fontSize: '0.85em', marginBottom: 10 }}>
                Place and secure the PCB on the bed, then verify it is present before proceeding.
              </p>

              {/* Camera board-presence check */}
              <button
                className="btn secondary full-width"
                style={{ marginBottom: 8 }}
                disabled={boardCheckBusy}
                onClick={async () => {
                  setBoardCheckBusy(true);
                  setBoardCheckResult(null);
                  try {
                    const r = await fetch('http://localhost:8000/api/check_board_present');
                    if (r.ok) {
                      const d = await r.json();
                      setBoardCheckResult(d);
                      if (d.present) setBoardConfirmed(true);
                    } else {
                      setBoardCheckResult({ present: null, reason: 'Vision server error — check manually.' });
                    }
                  } catch {
                    setBoardCheckResult({ present: null, reason: 'Vision server offline — confirm manually below.' });
                  } finally {
                    setBoardCheckBusy(false);
                  }
                }}
              >
                {boardCheckBusy ? 'Checking…' : '📷 Check Board Present'}
              </button>

              {boardCheckResult && (
                <div style={{
                  marginBottom: 10, padding: '6px 10px', borderRadius: 5, fontSize: '0.82em',
                  background: boardCheckResult.present === true ? 'rgba(0,180,100,0.12)' : boardCheckResult.present === false ? 'rgba(220,50,50,0.1)' : 'rgba(227,179,65,0.12)',
                  border: `1px solid ${boardCheckResult.present === true ? '#2da44e' : boardCheckResult.present === false ? '#f85149' : '#e3b341'}`,
                  color: boardCheckResult.present === true ? '#3fb950' : boardCheckResult.present === false ? '#f85149' : '#e3b341',
                }}>
                  {boardCheckResult.present === true && '✓ '}
                  {boardCheckResult.present === false && '✗ '}
                  {boardCheckResult.present === null && '⚠ '}
                  {boardCheckResult.reason}
                  {boardCheckResult.confidence != null && ` (${Math.round(boardCheckResult.confidence * 100)}% confidence)`}
                </div>
              )}

              {/* Manual override confirmation */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.85em', marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={boardConfirmed}
                  onChange={e => setBoardConfirmed(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                PCB is loaded and secured on the bed
              </label>

              <button
                className="btn primary lg full-width"
                disabled={!boardConfirmed}
                onClick={proceedToRegistration}
              >
                {boardConfirmed ? 'Next: Start Job ▶' : 'Confirm board loaded first'}
              </button>
            </div>
          )}

          {/* STAGE: PROBING */}
          {jobStage === 'probing' && (
            <div className="stage-box">
              <h4>Probing PCB Surface...</h4>
              <p style={{ color: '#8b949e', fontSize: '0.85em' }}>
                Sending <code>G38.2 Z-30 F50</code> — machine lowers slowly until probe contact, then sets Z=0 at PCB surface.
              </p>
              {probeResult === null && <div className="spinner"></div>}
              {probeResult === 'contact' && (
                <div style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(0,180,100,0.12)', border: '1px solid #2da44e', borderRadius: 5, color: '#3fb950', fontSize: '0.85em', fontFamily: 'monospace' }}>
                  ✓ Contact at Z={probedSurfaceZRef.current?.toFixed(3)} mm — G92 Z0 applied
                </div>
              )}
              {probeResult === 'no-contact' && (
                <div style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(220,50,50,0.1)', border: '1px solid #f85149', borderRadius: 5, color: '#f85149', fontSize: '0.82em' }}>
                  ⚠ No probe contact detected — continuing with current Z (no G92 Z0 applied). Check probe wiring or disable surface probe in settings.
                </div>
              )}
              <button className="btn danger full-width" style={{ marginTop: 10 }} onClick={cancelJob}>STOP</button>
            </div>
          )}

          {/* STAGE: AUTO-ALIGNING */}
          {jobStage === 'auto-aligning' && (
            <div className="stage-box">
              <h4>Vision Alignment</h4>
              <p>Camera is precisely scanning fiducials to eliminate stretch/rotation errors...</p>
              <div className="spinner"></div>
            </div>
          )}

          {/* STAGE: DISPENSING */}
          {jobStage === 'dispensing' && (
            <div className="stage-box">
              <h4>Dispensing...</h4>
              {panelBoards && panelBoards.length > 1 && (
                <div style={{ marginBottom: 6, padding: '4px 10px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 5, fontFamily: 'monospace', fontSize: '0.82em', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#8b949e' }}>Board</span>
                  <span style={{ color: '#58a6ff', fontWeight: 700 }}>
                    {currentBoardIdx + 1} / {panelBoards.length}
                    {panelBoards[currentBoardIdx]?.name ? ` — ${panelBoards[currentBoardIdx].name}` : ''}
                  </span>
                </div>
              )}
              <progress value={jobProgress.current} max={jobProgress.total}></progress>
              <p>{jobProgress.current} / {jobProgress.total}</p>
              {currentPadInfo && (
                <div style={{ marginTop: 10, padding: '8px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontFamily: 'monospace', fontSize: '0.82em', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <span style={{ color: '#ce93d8' }}>{currentPadInfo.mode === 'bead' ? '〰 bead' : '● dot'}</span>
                  <span style={{ color: '#ffa726' }}>⊕ {currentPadInfo.pressure} PSI</span>
                  {currentPadInfo.mode !== 'bead' && <span style={{ color: '#d32f2f' }}>⏱ {currentPadInfo.dwellMs} ms</span>}
                  <span style={{ color: '#00c49a' }}>💧 {currentPadInfo.volumeUl} µL</span>
                </div>
              )}
              {enableDotVerification && dotCheckResults.length > 0 && (() => {
                const last = dotCheckResults[dotCheckResults.length - 1];
                const failed = dotCheckResults.filter(r => !r.passed).length;
                return (
                  <div style={{ marginTop: 6, padding: '6px 10px', background: last.passed ? 'rgba(0,180,100,0.12)' : 'rgba(220,50,50,0.15)', border: `1px solid ${last.passed ? '#2da44e' : '#f85149'}`, borderRadius: 5, fontFamily: 'monospace', fontSize: '0.80em' }}>
                    <span style={{ color: last.passed ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                      {last.passed ? '✓ Dot OK' : '✗ Dot MISSING'} — pad #{last.padIndex}
                      {last.passed && last.diameter_mm > 0 ? ` (∅${last.diameter_mm}mm)` : ''}
                    </span>
                    {failed > 0 && <span style={{ color: '#f85149', marginLeft: 12 }}>{failed} failed so far</span>}
                  </div>
                );
              })()}
              <button className="btn danger full-width" onClick={cancelJob}>STOP</button>
            </div>
          )}

          {/* STAGE: FINISHED */}
          {jobStage === 'finished' && (
            <div className="stage-box">
              <h4>Job Complete!</h4>
              {jobReport && (
                <table style={{ width: '100%', fontSize: '0.85em', marginBottom: 10, borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr><td style={{ color: '#8b949e', padding: '2px 6px' }}>Pads dispensed</td><td style={{ color: '#e6edf3', textAlign: 'right' }}>{jobReport.totalPads}</td></tr>
                    <tr><td style={{ color: '#8b949e', padding: '2px 6px' }}>Total glue used</td><td style={{ color: '#00c49a', textAlign: 'right' }}>{jobReport.totalVolUl} µL</td></tr>
                    <tr><td style={{ color: '#8b949e', padding: '2px 6px' }}>Duration</td><td style={{ color: '#e6edf3', textAlign: 'right' }}>{jobReport.jobDurationSec} s</td></tr>
                    <tr><td style={{ color: '#8b949e', padding: '2px 6px' }}>Avg dwell</td><td style={{ color: '#d32f2f', textAlign: 'right' }}>{jobReport.avgDwellMs} ms</td></tr>
                    <tr><td style={{ color: '#8b949e', padding: '2px 6px' }}>Base pressure</td><td style={{ color: '#ffa726', textAlign: 'right' }}>{jobReport.basePressure} PSI</td></tr>
                    {enableSurfaceProbe && (
                      <tr>
                        <td style={{ color: '#8b949e', padding: '2px 6px' }}>PCB surface (Z probe)</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', color: jobReport.probedSurfaceZ != null ? '#58a6ff' : '#e3b341' }}>
                          {jobReport.probedSurfaceZ != null ? `${jobReport.probedSurfaceZ.toFixed(3)} mm` : '⚠ no contact'}
                        </td>
                      </tr>
                    )}
                    {jobReport.dotsChecked != null && (
                      <tr>
                        <td style={{ color: '#8b949e', padding: '2px 6px' }}>Dot verification</td>
                        <td style={{ textAlign: 'right', color: jobReport.dotsFailed === 0 ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                          {jobReport.dotsFailed === 0
                            ? `✓ All ${jobReport.dotsChecked} passed`
                            : `✗ ${jobReport.dotsFailed} / ${jobReport.dotsChecked} failed`}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
              {jobReport?.dotsFailed > 0 && dotCheckResults.length > 0 && (
                <div style={{ marginBottom: 10, padding: '6px 10px', background: 'rgba(220,50,50,0.1)', border: '1px solid #f85149', borderRadius: 5, fontSize: '0.78em', fontFamily: 'monospace' }}>
                  <div style={{ color: '#f85149', fontWeight: 600, marginBottom: 4 }}>Failed pads:</div>
                  {dotCheckResults.filter(r => !r.passed).map(r => (
                    <div key={r.padIndex} style={{ color: '#e6edf3' }}>Pad #{r.padIndex}</div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: '0.75em', color: '#8b949e', marginBottom: 8, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                Log saved to: Documents/GlueJobLogs/
              </div>
              <button className="btn full-width" onClick={() => setJobStage('idle')}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}