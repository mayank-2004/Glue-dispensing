import { useState, useEffect, useRef, useMemo } from 'react';
import { header, home, moveAbs, dispensePoint, jogRel } from "../lib/motion/gcode.js";
import { applyTransform, fitSimilarity } from "../lib/utils/transform2d.js";
import "./AutomatedDispensingPanel.css";
import { buildJobGlueSummary, GlueStore } from '../lib/glue/glueTracker.js';
import { getZOffsetForPoint } from './BedCalibrationPanel.jsx';
import GlueGauge from './GlueGauge.jsx';

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
  machinePosition = { x: 0, y: 0, z: 0 },
  panelBoards = [],
  toolOffset = { dx: 0, dy: 0 }
}) {
  const [isJobRunning, setIsJobRunning] = useState(false);
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

  // Machine Configuration State
  const [valveOnCmd, setValveOnCmd] = useState('M106 S255');
  const [valveOffCmd, setValveOffCmd] = useState('M107');
  const [dispenseHeight, setDispenseHeight] = useState(0.5);
  const [safeTravelHeight, setSafeTravelHeight] = useState(5.0);
  const [viscosity, setViscosity] = useState('medium'); // low, medium, high
  const [baseDwellTime, setBaseDwellTime] = useState(120);

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

  useEffect(() => { xfRef.current = xf; }, [xf]);
  useEffect(() => { fiducialsRef.current = fiducials; }, [fiducials]);
  useEffect(() => { localStorage.setItem('nozzleDia', String(nozzleDia)); }, [nozzleDia]);

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

      // 2. Handle ACKs (Marlin/GRBL sends 'ok')
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
      window.pauseSerialPolling = true;
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
    setJobStage('dispensing');
    runDispenseLoop();
  };

  const runDispenseLoop = async () => {
    setMachineStatus('busy');
    try {
      if (!panelBoards || panelBoards.length === 0) {
        throw new Error("No boards defined in panel configuration.");
      }

      await sendGcodeWait('G21'); // Set units to millimeters
      await sendGcodeWait('G90'); // Set to absolute positioning
      await sendGcodeWait(`G1 Z${safeTravelHeight} F3000`); // Move to safe height

      const seq = activeSequence;
      const totalPoints = seq.length * panelBoards.length;
      let globalPointCount = 0;

      setJobProgress({ current: 0, total: totalPoints });

      for (let bIdx = 0; bIdx < panelBoards.length; bIdx++) {
        const board = panelBoards[bIdx];
        let transform = applyXf ? board.xf : null;

        if (applyXf && !transform) {
          throw new Error(`Board "${board.name}" has no alignment transform (xf) calculated! Please solve its fiducials first.`);
        }

        // --- DYNAMIC PER-BOARD FIDUCIAL RE-SOLVE ---
        if (applyXf && dynamicPanelCorrection && board.fiducials?.length >= 2) {
          console.log(`[Dynamic Vision] Auto-correcting board: ${board.name}`);
          setJobStage('auto-aligning');
          
          let updatedMachineFiducials = [];
          let success = true;

          for (let f of board.fiducials) {
            if (!isJobRunning) throw new Error("Job Aborted");
            if (!f.design) continue;

            // 1. Where do we EXPECT this fiducial to be? (Design -> Machine via global/baseline xf)
            const expectedMachine = applyTransform(transform, f.design);
            
            // 2. We command the CAMERA to go look there. 
            // The G-code needs to go to (expectedMachine.x - toolOffset.dx) so the camera lens is centered on the fiducial.
            const camTargetX = expectedMachine.x - toolOffset.dx;
            const camTargetY = expectedMachine.y - toolOffset.dy;
            
            await sendGcodeWait(`G1 Z${safeTravelHeight} F3000`); // Lift Safe
            await sendGcodeWait(`G1 X${camTargetX.toFixed(3)} Y${camTargetY.toFixed(3)} F4000`); // Slower approach so it doesn't violently shake
            
            // 3. Let Camera Mechanics settle completely (give auto-focus time)
            await sendGcodeWait('M400');
            await new Promise(r => setTimeout(r, 800)); 
            
            // 4. Snap via vision API (with RETRY LOOP for auto-exposure/focus)
            if (window.__SNAP_FIDUCIAL_MACHINE_COORD__) {
              let snap = null;
              for (let attempt = 1; attempt <= 3; attempt++) {
                snap = await window.__SNAP_FIDUCIAL_MACHINE_COORD__();
                if (snap && snap.confidence > 0.4) {
                  break; // Successful snap!
                }
                if (attempt < 3) {
                  console.log(`[Dynamic Vision] Attempt ${attempt} failed, waiting 400ms for autofocus/autoexposure...`);
                  await new Promise(r => setTimeout(r, 400));
                }
              }

              if (snap) {
                if (snap.confidence > 0.4) {
                  console.log(`[Dynamic Vision] Fiducial ${f.id} snapped! Machine:`, snap);
                  updatedMachineFiducials.push({ design: f.design, machine: { x: snap.x, y: snap.y } });
                } else {
                  console.warn(`[Dynamic Vision] Fiducial ${f.id} found, but confidence was too low (${snap.confidence.toFixed(2)} <= 0.40). Falling back.`);
                  success = false;
                  break;
                }
              } else {
                console.warn(`[Dynamic Vision] Failed to detect any fiducial for ${f.id} at expected coords! Camera sees no circles. Falling back to baseline.`);
                success = false;
                break; // Break fiducial loop for this board, fallback completely
              }
            } else {
               console.warn(`[Dynamic Vision] Vision bridge unavailable.`);
               success = false;
               break;
            }
          }

          if (success && updatedMachineFiducials.length >= 2) {
            try {
              const freshXf = fitSimilarity(updatedMachineFiducials.map(f => f.design), updatedMachineFiducials.map(f => f.machine));
              if (freshXf) {
                console.log(`[Dynamic Vision] Board ${board.name} corrected successfully! New XF applied.`);
                transform = freshXf; 
              }
            } catch(e) {
              console.warn(`[Dynamic Vision] Mathematical failure solving fresh XF, falling back to baseline.`);
            }
          }
          setJobStage('dispensing');
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

          // Mirror X-axis for bottom side components BEFORE applying alignment transform
          if (side === 'bottom' && currentBoardSize?.width) {
            p = { ...p, x: currentBoardSize.width - p.x };
          }

          if (transform) {
            const tp = applyTransform(transform, p);
            p = { ...p, x: tp.x, y: tp.y };
          } else {
            // No transform: align manually using the effective origin
            const ox = selectedOrigin ? selectedOrigin.x : (boardOutline ? boardOutline.minX : 0);
            const oy = selectedOrigin ? selectedOrigin.y : (boardOutline ? boardOutline.minY : 0);
            p = { ...p, x: p.x - ox, y: p.y - oy };
          }

          const pressure = pressureSettings.customPressure || 25;
          const configDwell = pressureSettings.customDwellTime || baseDwellTime;
          const dwell = dispensingSequencer.calculateDwellTime(p, { customDwellTime: configDwell });

          const zCompensated = dispenseHeight + getZOffsetForPoint(p.x, p.y);
          const cmds = dispensePoint({
            x: p.x, y: p.y,
            zWork: dispenseHeight + getZOffsetForPoint(p.x, p.y),
            zSafe: safeTravelHeight,
            feedXY: speedSettings.travelSpeed || 6000,
            feedZ: speedSettings.dispenseSpeed || 300,
            pressure: pressure,
            dwellMs: dwell
          });
          for (const c of cmds) {
            await sendGcodeWait(c);
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
    } finally {
      window.pauseSerialPolling = false;
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
            <label>
              Base Dwell (ms):
              <input type="number" step="10" value={baseDwellTime} onChange={e => setBaseDwellTime(Number(e.target.value))} style={{ width: '100%', marginTop: '4px' }} />
            </label>
          </div>
          <div style={{ marginTop: 14 }}>
            <GlueGauge
              summary={glueSummary}
              nozzleDia={nozzleDia}
              onNozzleDia={setNozzleDia}
              onStockChange={(v) => { setGlueStock(v); }}
              onRefill={(v) => { setGlueStock(v); }}
            />
          </div>
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
                      </tr>
                    </thead>
                    <tbody>
                      {activeSequence.map((pad, idx) => {
                        const area = dispensingSequencer.calculatePadArea(pad);
                        const dwell = dispensingSequencer.calculateDwellTime(pad, { customDwellTime: baseDwellTime });
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

        {/* Flow UI */}
        <div className="flow-container">
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