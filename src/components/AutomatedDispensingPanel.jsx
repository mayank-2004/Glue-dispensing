import { useState, useEffect, useRef, useMemo } from 'react';
import { header, home, moveAbs, dispensePoint, jogRel } from "../lib/motion/gcode.js";
import { applyTransform } from "../lib/utils/transform2d.js";
import "./AutomatedDispensingPanel.css";

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
  isConnected = false,
  machinePosition = { x: 0, y: 0, z: 0 },
  panelBoards = [],
  toolOffset = { dx: 0, dy: 0 }
}) {
  const [isJobRunning, setIsJobRunning] = useState(false);
  const [jobMode, setJobMode] = useState('single'); // 'single' or 'batch'

  // Advanced Flow State
  const [jobStage, setJobStage] = useState('idle'); // idle, homing, loading, registering, dispensing, finished
  const [machineStatus, setMachineStatus] = useState('idle');
  const [jobProgress, setJobProgress] = useState({ current: 0, total: 0 });
  const [regIndex, setRegIndex] = useState(0);
  // const [currentPos, setCurrentPos] = useState({ x: 0, y: 0, z: 0 }); // Replaced by prop
  const [jogStep, setJogStep] = useState(1);

  // Machine Configuration State
  const [valveOnCmd, setValveOnCmd] = useState('M106 S255');
  const [valveOffCmd, setValveOffCmd] = useState('M107');
  const [dispenseHeight, setDispenseHeight] = useState(0.5);
  const [safeTravelHeight, setSafeTravelHeight] = useState(5.0);
  const [baseDwellTime, setBaseDwellTime] = useState(120);

  const refPoint = referencePoint || selectedOrigin;
  const activeSequence = useSafePathPlanning ? safeSequence : dispensingSequence;



  // Refs for async access
  const xfRef = useRef(xf);
  const fiducialsRef = useRef(fiducials);

  // Queue for synchronous sending
  const ackQueue = useRef([]);

  useEffect(() => { xfRef.current = xf; }, [xf]);
  useEffect(() => { fiducialsRef.current = fiducials; }, [fiducials]);

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

  // --- Flow Logic ---

  const startJobFlow = async () => {
    if (!activeSequence.length) return alert("No dispensing sequence available.");
    if (!window.serial || !window.serial.writeLine) return alert("Serial API not available.");

    setJobStage('homing');
    setMachineStatus('busy');
    setIsJobRunning(true);

    try {
      // User explicitly requested to remove G28 automatic homing on job start.
      // The machine will simply start executing moves from its current registered position/origin.

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
    // With multi-board support, alignment is now handled upfront in FiducialPanel/CameraPanel.
    // Proceed directly to dispensing loop.
    setJobStage('dispensing');
    runDispenseLoop();
  };

  const runDispenseLoop = async () => {
    setMachineStatus('busy');
    try {
      if (!panelBoards || panelBoards.length === 0) {
        throw new Error("No boards defined in panel configuration.");
      }

      await sendGcodeWait('G21');
      await sendGcodeWait('G90');
      await sendGcodeWait('G1 Z6 F3000');

      const seq = activeSequence;
      const totalPoints = seq.length * panelBoards.length;
      let globalPointCount = 0;

      setJobProgress({ current: 0, total: totalPoints });

      for (let bIdx = 0; bIdx < panelBoards.length; bIdx++) {
        const board = panelBoards[bIdx];
        const transform = applyXf ? board.xf : null;

        if (applyXf && !transform) {
          throw new Error(`Board "${board.name}" has no alignment transform (xf) calculated! Please solve its fiducials first.`);
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
          if (!isJobRunning) throw new Error("Job Aborted");

          globalPointCount++;
          setJobProgress({ current: globalPointCount, total: totalPoints });

          let p = seq[i];
          if (transform) {
            const tp = applyTransform(transform, p);
            p = { ...p, x: tp.x, y: tp.y };
          }

          const pressure = pressureSettings.customPressure || 25;
          const configDwell = pressureSettings.customDwellTime || baseDwellTime;
          const dwell = dispensingSequencer.calculateDwellTime(p, { customDwellTime: configDwell });

          const cmds = dispensePoint({
            x: p.x, y: p.y,
            zWork: 0.1, zSafe: 6,
            feedXY: speedSettings.travelSpeed || 6000,
            feedZ: speedSettings.dispenseSpeed || 300,
            pressure: pressure,
            dwellMs: dwell
          });

          for (const c of cmds) {
            await sendGcodeWait(c);
          }
        }
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
    const gcode = dispensingSequencer.generateDispensingGCode(refPoint, activeSequence, {
      pressureSettings: { ...pressureSettings, customDwellTime: baseDwellTime },
      speedSettings,
      xf: xfRef.current,
      applyXf,
      valveOnCmd,
      valveOffCmd,
      dispenseHeight,
      safeHeight: safeTravelHeight,
      toolOffset
    });
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
            <label>
              Base Dwell (ms):
              <input type="number" step="10" value={baseDwellTime} onChange={e => setBaseDwellTime(Number(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
            </label>
          </div>
        </div>

        {/* Board Info */}
        {(currentBoardSize || boardOutline) && (
          <div className="box">
            <div className="grid2">
              <span>Board: {(currentBoardSize?.width || 0).toFixed(1)} x {(currentBoardSize?.height || 0).toFixed(1)}mm </span> <br />
              <span>Pads: {activeSequence.length}</span>
            </div>
          </div>
        )}

        {!refPoint && <div className="warning">⚠️ No Reference Point Selected</div>}

        {/* Flow UI */}
        <div className="flow-container">
          {/* Status Header */}
          <div className="flow-header">
            <div className={`stage-indicator ${jobStage !== 'idle' ? 'active' : 'idle'}`}>
              <strong>Status:</strong> {jobStage.toUpperCase()}
              {machineStatus === 'busy' && ' (Busy)'}
            </div>
            <div className="pos-readout">
              Pos: {machinePosition.x.toFixed(3)}, {machinePosition.y.toFixed(3)}, {machinePosition.z.toFixed(3)}
            </div>
          </div>

          {/* STAGE: IDLE */}
          {jobStage === 'idle' && (
            <div className="section">
              <h3>Processing Control</h3>

              <div className="row">
                <button
                  className={`btn ${isJobRunning ? 'danger' : 'primary'}`}
                  onClick={isJobRunning ? () => setIsJobRunning(false) : startJobFlow}
                  disabled={!isConnected && !isJobRunning}
                >
                  {isJobRunning ? '⏹ ABORT JOB' : '▶ START JOB'}
                </button>

                <button
                  className="btn secondary"
                  onClick={handleDownloadGCode}
                  disabled={isJobRunning}
                >
                  💾 Download G-Code
                </button>
              </div>      {jobMode === 'batch' && <p>Batch mode not supported in new flow yet</p>}
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
              <div className="jog-controls-mini">
                <button onClick={() => jog('Y', -1)} className="btn">Y+</button>
                <div className="flex-row">
                  <button onClick={() => jog('X', -1)} className="btn">X-</button>
                  <button onClick={() => jog('X', 1)} className="btn">X+</button>
                </div>
                <button onClick={() => jog('Y', 1)} className="btn">Y-</button>
                <div className="flex-row mt-1">
                  <button onClick={() => jogZ(1)} className="btn sm">Z Up</button>
                  <button onClick={() => jogZ(-1)} className="btn sm">Z Down</button>
                </div>
              </div>
              <div className="step-sel">
                Step:
                {[0.1, 1, 5, 10].map(s => (
                  <button key={s} onClick={() => setJogStep(s)} className={`btn sm ${jogStep === s ? 'primary' : 'secondary'}`}>{s}</button>
                ))}
              </div>

              <button className="btn primary full-width mt-2" onClick={confirmFiducial}>✅ Confirm Aligned</button>
            </div>
          )}

          {/* STAGE: DISPENSING */}
          {jobStage === 'dispensing' && (
            <div className="stage-box">
              <h4>Dispensing...</h4>
              <progress value={jobProgress.current} max={jobProgress.total}></progress>
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
    </div>
  );
}