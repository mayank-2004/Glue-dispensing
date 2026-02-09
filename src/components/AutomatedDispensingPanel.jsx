import { useState, useEffect, useRef } from 'react';
import { header, home, moveAbs, dispensePoint, jogRel } from "../lib/motion/gcode.js";
import { applyTransform } from "../lib/utils/transform2d.js";

export default function AutomatedDispensingPanel({
  dispensingSequencer,
  dispensingSequence,
  safeSequence,
  jobStatistics,
  referencePoint,
  selectedOrigin,
  pressureSettings,
  speedSettings,
  boardOutline,
  useSafePathPlanning,
  setUseSafePathPlanning,
  safePathPlanner,
  onStartJob,
  onDownloadGCode,
  batchProcessor,
  currentBatch,
  onStartBatch,
  onJobComplete,

  // Alignment Props
  fiducials = [],
  onInputMachine,
  onAutoAlign,
  onSolve2,
  onSolve3,
  xf,
  applyXf,
  isConnected = false
}) {
  const [isJobRunning, setIsJobRunning] = useState(false);
  const [jobMode, setJobMode] = useState('single'); // 'single' or 'batch'

  // Advanced Flow State
  const [jobStage, setJobStage] = useState('idle'); // idle, homing, loading, registering, dispensing, finished
  const [machineStatus, setMachineStatus] = useState('idle');
  const [jobProgress, setJobProgress] = useState({ current: 0, total: 0 });
  const [regIndex, setRegIndex] = useState(0);
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0, z: 0 });
  const [jogStep, setJogStep] = useState(1);

  const refPoint = referencePoint || selectedOrigin;
  const activeSequence = useSafePathPlanning ? safeSequence : dispensingSequence;

  // Refs for async access
  const xfRef = useRef(xf);
  const fiducialsRef = useRef(fiducials);

  // Queue for synchronous sending
  const ackQueue = useRef([]);

  useEffect(() => { xfRef.current = xf; }, [xf]);
  useEffect(() => { fiducialsRef.current = fiducials; }, [fiducials]);

  // Position & ACK listener
  useEffect(() => {
    const handleData = (line) => {
      // 1. Parse Position
      const match = line.match(/X:([-\d.]+)\s+Y:([-\d.]+)\s+Z:([-\d.]+)/);
      if (match) {
        setCurrentPos({
          x: parseFloat(match[1]),
          y: parseFloat(match[2]),
          z: parseFloat(match[3])
        });
      }

      // 2. Handle ACKs (Marlin/GRBL sends 'ok')
      // Handles standard 'ok' responses to keep sync
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
      // Send command
      await window.serial.writeLine(cmd);
      // Wait for ACK
      await ackPromise;
      return true;
    } catch (e) {
      console.error("Send failed:", e);
      // If write failed, remove the waiter
      ackQueue.current.pop();
      throw e;
    }
  };

  // --- Flow Logic ---

  const startJobFlow = async () => {
    if (!activeSequence.length) return alert("No dispensing sequence available.");
    if (!window.serial || !window.serial.writeLine) return alert("Serial API not available.");

    setJobStage('homing');
    setMachineStatus('busy');
    setIsJobRunning(true);

    try {
      // Send G28 and wait for OK. 
      // Note: Homing takes time, but 'ok' might come immediately or after completion depending on firmware config.
      // Usually G28 blocks until done on many firmwares, but not all.
      await sendGcodeWait('G28');

      // M400 guarantees previous moves finished.
      await sendGcodeWait('M400');

      setJobStage('loading');
    } catch (e) {
      alert("Homing/Connection failed: " + e.message);
      setJobStage('idle');
      setMachineStatus('idle');
      setIsJobRunning(false);
    }
  };

  const proceedToRegistration = async () => {
    const validFids = fiducialsRef.current.filter(f => f.design);
    if (validFids.length === 0) {
      if (!confirm("No design fiducials found. Skip registration and dispense immediately?")) {
        setJobStage('idle'); setIsJobRunning(false); return;
      }
      setJobStage('dispensing');
      runDispenseLoop();
      return;
    }
    setRegIndex(0);
    setJobStage('registering');
    moveToFiducial(validFids[0]);
  };

  const moveToFiducial = async (fid) => {
    await sendGcodeWait('G90');
    await sendGcodeWait('G1 Z5 F1000');
    await sendGcodeWait(`G1 X${fid.design.x.toFixed(3)} Y${fid.design.y.toFixed(3)} F3000`);
    await sendGcodeWait('G1 Z1 F1000');
    await sendGcodeWait('M400'); // Ensure stop
  };

  const confirmFiducial = async () => {
    const validFids = fiducialsRef.current.filter(f => f.design);
    const fid = validFids[regIndex];

    if (onInputMachine) onInputMachine(fid.id, { x: currentPos.x, y: currentPos.y });

    const nextIdx = regIndex + 1;
    if (nextIdx < validFids.length) {
      setRegIndex(nextIdx);
      moveToFiducial(validFids[nextIdx]);
    } else {
      if (validFids.length >= 2 && onSolve2) {
        if (validFids.length >= 3 && onSolve3) onSolve3(); else onSolve2();
        setTimeout(() => {
          setJobStage('dispensing');
          runDispenseLoop();
        }, 500);
      } else {
        setJobStage('dispensing');
        runDispenseLoop();
      }
    }
  };

  const runDispenseLoop = async () => {
    setMachineStatus('busy');
    try {
      const transform = (applyXf && xfRef.current) ? xfRef.current : null;
      console.log("Starting dispense. XF:", transform);

      await sendGcodeWait('G21');
      await sendGcodeWait('G90');
      await sendGcodeWait('G1 Z6 F3000');

      const seq = activeSequence;
      setJobProgress({ current: 0, total: seq.length });

      for (let i = 0; i < seq.length; i++) {
        if (!isJobRunning) throw new Error("Job Aborted");

        setJobProgress({ current: i + 1, total: seq.length });
        let p = seq[i];

        if (transform) {
          const tp = applyTransform(transform, p);
          p = { ...p, x: tp.x, y: tp.y };
        }

        const pressure = pressureSettings.customPressure || 25;
        const dwell = pressureSettings.customDwellTime || 120;

        const cmds = dispensePoint({
          x: p.x, y: p.y,
          zWork: 0.1, zSafe: 6,
          feedXY: speedSettings.travelSpeed || 3000,
          feedZ: speedSettings.dispenseSpeed || 500,
          pressure: pressure,
          dwellMs: dwell
        });

        for (const c of cmds) await sendGcodeWait(c);
      }

      // Park
      await sendGcodeWait('G1 Z10 F3000');
      await sendGcodeWait('G1 X0 Y0 F5000');
      await sendGcodeWait('M400');

      alert("Job Complete!");
      if (onJobComplete) onJobComplete();
      setJobStage('finished');
      setMachineStatus('idle');
      setIsJobRunning(false);

    } catch (e) {
      console.error(e);
      if (e.message !== "Job Aborted") alert("Error: " + e.message);
      setJobStage('idle');
      setMachineStatus('idle');
      setIsJobRunning(false);
    }
  };

  const cancelJob = async () => {
    setIsJobRunning(false);
    // Emergency: Send M42/G1 without wait to ensure it goes out ASAP
    try {
      await window.serial.writeLine('M42 P4 S0');
      await window.serial.writeLine('G1 Z10 F3000');
    } catch (e) { }
    setJobStage('idle');
    setMachineStatus('idle');
    ackQueue.current = []; // Clear queue
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

  const handleDownloadGCode = () => {
    if (!activeSequence.length) return;
    const gcode = dispensingSequencer.generateDispensingGCode(refPoint, activeSequence, { pressureSettings, speedSettings, xf: xfRef.current, applyXf });
    const blob = new Blob([gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dispensing_job.gcode';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel automated-panel">
      <h3>🤖 Automated Dispensing</h3>

      {/* Settings Summary */}
      <div className="box">
        <h4>Settings</h4>
        <label>
          <input type="checkbox" checked={useSafePathPlanning} onChange={e => setUseSafePathPlanning(e.target.checked)} />
          Safe Path Planning
        </label>
      </div>

      {/* Board Info */}
      {boardOutline && (
        <div className="box">
          <div className="grid2">
            <span>Board: {boardOutline.width.toFixed(1)} x {boardOutline.height.toFixed(1)} mm</span>
            <span>Pads: {activeSequence.length}</span>
          </div>
        </div>
      )}

      {!refPoint && <div className="warning">⚠️ No Reference Point Selected</div>}

      {/* Flow UI */}
      <div className="flow-container" style={{ marginTop: 20 }}>
        {/* Status Header */}
        <div className="flow-header" style={{ marginBottom: 16 }}>
          <div className="stage-indicator" style={{
            background: jobStage !== 'idle' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.1)',
            padding: 8,
            borderRadius: 4,
            border: '1px solid var(--border-secondary)',
            color: jobStage !== 'idle' ? 'var(--accent-text)' : 'var(--text-secondary)'
          }}>
            <strong>Status:</strong> {jobStage.toUpperCase()}
            {machineStatus === 'busy' && ' (Busy)'}
          </div>
          <div className="pos-readout" style={{ fontSize: 12, marginTop: 4, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
            Pos: {currentPos.x.toFixed(3)}, {currentPos.y.toFixed(3)}, {currentPos.z.toFixed(3)}
          </div>
        </div>

        {/* STAGE: IDLE */}
        {jobStage === 'idle' && (
          <div className="stage-box">
            <button className="btn primary lg full-width"
              onClick={startJobFlow}
              disabled={!refPoint || !activeSequence.length || !isConnected}>
              {isConnected ? '▶ Start Automated Job' : '⚠️ Connect Machine First'}
            </button>
            <button className="btn secondary full-width" onClick={handleDownloadGCode} style={{ marginTop: 8 }}>
              💾 Download G-Code
            </button>
            {jobMode === 'batch' && <p>Batch mode not supported in new flow yet</p>}
          </div>
        )}

        {/* STAGE: HOMING */}
        {jobStage === 'homing' && (
          <div className="stage-box">
            <h4>Homing Machine...</h4>
            <div className="spinner"></div>
          </div>
        )}

        {/* STAGE: LOADING */}
        {jobStage === 'loading' && (
          <div className="stage-box">
            <h4>Load PCB</h4>
            <p>Secure the PCB on the bed.</p>
            <button className="btn primary lg full-width" onClick={proceedToRegistration}>Next: Registration</button>
          </div>
        )}

        {/* STAGE: REGISTERING */}
        {jobStage === 'registering' && (
          <div className="stage-box">
            <h4>Align Fiducial {regIndex + 1}</h4>
            <p>Fiducial ID: <strong>{fiducialsRef.current.filter(f => f.design)[regIndex]?.id}</strong></p>

            {/* Jog Controls */}
            <div className="jog-controls-mini" style={{ display: 'grid', justifyItems: 'center', gap: 5, margin: '10px 0' }}>
              <button onClick={() => jog('Y', 1)} className="btn">Y+</button>
              <div className="flex-row">
                <button onClick={() => jog('X', -1)} className="btn">X-</button>
                <button onClick={() => jog('X', 1)} className="btn">X+</button>
              </div>
              <button onClick={() => jog('Y', -1)} className="btn">Y-</button>
              <div className="flex-row" style={{ marginTop: 5 }}>
                <button onClick={() => jogZ(1)} className="btn sm">Z Up</button>
                <button onClick={() => jogZ(-1)} className="btn sm">Z Down</button>
              </div>
            </div>
            <div className="step-sel">
              Step:
              {[0.1, 1, 5].map(s => (
                <button key={s} onClick={() => setJogStep(s)} className={`btn sm ${jogStep === s ? 'primary' : 'secondary'}`} style={{ margin: 2 }}>{s}</button>
              ))}
            </div>

            <button className="btn primary full-width" onClick={confirmFiducial} style={{ marginTop: 10 }}>✅ Confirm Aligned</button>
          </div>
        )}

        {/* STAGE: DISPENSING */}
        {jobStage === 'dispensing' && (
          <div className="stage-box">
            <h4>Dispensing...</h4>
            <progress value={jobProgress.current} max={jobProgress.total} style={{ width: '100%' }}></progress>
            <p>{jobProgress.current} / {jobProgress.total}</p>
            <button className="btn danger full-width" onClick={cancelJob}>STOP</button>
          </div>
        )}

        {/* STAGE: FINISHED */}
        {jobStage === 'finished' && (
          <div className="stage-box">
            <h4>Job Complete!</h4>
            <button className="btn full-width" onClick={() => setJobStage('idle')}>Done</button>
          </div>
        )}

      </div>

    </div>
  );
}