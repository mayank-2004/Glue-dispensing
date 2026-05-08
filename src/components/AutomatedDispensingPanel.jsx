import { useState, useEffect, useRef, useMemo } from 'react';
import { header, home, moveAbs, dispensePoint, jogRel } from "../lib/motion/gcode.js";
import { applyTransform, fitSimilarity, fitAffine } from "../lib/utils/transform2d.js";
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
        // Only runs if board has fiducials with BOTH design AND machine coords solved
        const solvedFiducials = board.fiducials?.filter(f => f.design && f.machine) || [];
        if (applyXf && dynamicPanelCorrection && solvedFiducials.length >= 2) {
          console.log(`[Dynamic Vision] Auto-correcting board: ${board.name} using ${solvedFiducials.length} fiducials`);
          setJobStage('auto-aligning');
          
          let updatedMachineFiducials = [];
          let success = true;

          for (let f of solvedFiducials) {
            if (!isJobRunning) throw new Error("Job Aborted");

            // 1. Where do we EXPECT this fiducial to be in machine space?
            //    The transform maps design → camera machine coords directly.
            //    No toolOffset subtraction needed here — the transform already
            //    produces the position where the CAMERA crosshair should be.
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
            } catch(e) {
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

          // ─── APPLY CALIBRATION CORRECTION (same as "Move Camera Here") ──────
          const finalX = p.x + calibCorrection.x;
          const finalY = p.y + calibCorrection.y;

          const pressure = pressureSettings.customPressure || 25;
          const configDwell = pressureSettings.customDwellTime || baseDwellTime;
          const dwell = dispensingSequencer.calculateDwellTime(p, { customDwellTime: configDwell });

          const cmds = dispensePoint({
            x: finalX, y: finalY,
            zWork: dispenseHeight + getZOffsetForPoint(finalX, finalY),
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
              let previewP = { ...pad };
              if (side === 'bottom' && currentBoardSize?.width) {
                previewP.x = currentBoardSize.width - previewP.x;
              }
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