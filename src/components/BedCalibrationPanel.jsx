import React, { useState, useEffect, useRef } from 'react';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

export default function BedCalibrationPanel({ nozzleDia, machinePosition }) {
  const [mesh, setMesh] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('bedLevelMesh')) || [
        { id: 'BL', name: 'Bottom-Left',  x: 20,    y: 20,    zParam: 0 },
        { id: 'BR', name: 'Bottom-Right', x: 220,   y: 20,    zParam: 0 },
        { id: 'TR', name: 'Top-Right',    x: 220,   y: 220,   zParam: 0 },
        { id: 'TL', name: 'Top-Left',     x: 20,    y: 220,   zParam: 0 },
        { id: 'C',  name: 'Center',       x: 117.5, y: 117.5, zParam: 0 }
      ];
    } catch (e) { return []; }
  });

  const [mode, setMode] = useState('auto'); // 'auto' | 'manual'
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [currentCornerIndex, setCurrentCornerIndex] = useState(-1);
  const [statusMsg, setStatusMsg] = useState('Ready. Connect machine then press Start.');
  const [progress, setProgress] = useState(0); // 0-100

  // Auto-probe settings
  const [probeStartZ, setProbeStartZ] = useState(() => parseFloat(localStorage.getItem('probeStartZ') || '3'));
  const [stepSize,    setStepSize]    = useState(() => parseFloat(localStorage.getItem('probeStepSize') || '0.1'));
  const [probeSpeed,  setProbeSpeed]  = useState(() => parseFloat(localStorage.getItem('probeSpeed') || '60'));
  const [maxDepth,    setMaxDepth]    = useState(() => parseFloat(localStorage.getItem('probeMaxDepth') || '-5'));
  const [dispensingGap, setDispensingGap] = useState(() => parseFloat(localStorage.getItem('dispensingGap') || '0.1'));
  const [liftHeight,    setLiftHeight]    = useState(() => parseFloat(localStorage.getItem('liftHeight') || '5'));

  const abortRef = useRef(false);

  useEffect(() => { localStorage.setItem('bedLevelMesh', JSON.stringify(mesh)); }, [mesh]);
  useEffect(() => { localStorage.setItem('probeStartZ',   String(probeStartZ)); }, [probeStartZ]);
  useEffect(() => { localStorage.setItem('probeStepSize', String(stepSize)); }, [stepSize]);
  useEffect(() => { localStorage.setItem('probeSpeed',    String(probeSpeed)); }, [probeSpeed]);
  useEffect(() => { localStorage.setItem('probeMaxDepth', String(maxDepth)); }, [maxDepth]);
  useEffect(() => { localStorage.setItem('dispensingGap', String(dispensingGap)); }, [dispensingGap]);
  useEffect(() => { localStorage.setItem('liftHeight',    String(liftHeight)); }, [liftHeight]);

  // ──────────────────────────────────────────────────
  // Core: wait for next M119 probe result (with timeout)
  // Returns true if TRIGGERED, false if open/timeout
  // ──────────────────────────────────────────────────
  const pollM119 = (timeoutMs = 600) => {
    return new Promise((resolve) => {
      const onTriggered = () => {
        cleanup();
        resolve(true);
      };
      const onOpen = () => {
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false); // timeout = not triggered
      }, timeoutMs);

      const cleanup = () => {
        window.removeEventListener('endstop-z-probe-triggered', onTriggered);
        window.removeEventListener('endstop-z-probe-open', onOpen);
        clearTimeout(timer);
      };

      window.addEventListener('endstop-z-probe-triggered', onTriggered, { once: true });
      window.addEventListener('endstop-z-probe-open', onOpen, { once: true });
    });
  };

  // ──────────────────────────────────────────────────
  // Probe a single point: step down until triggered
  // Returns probed Z or null if failed
  // ──────────────────────────────────────────────────
  const probeOnePoint = async (serial, cornerName) => {
    const msPerStep = Math.ceil((stepSize / probeSpeed) * 60 * 1000) + 150;
    let currentZ = probeStartZ;

    // ── Pre-probe check: confirm z_min is OPEN at start height ──
    setStatusMsg(`Checking start state for ${cornerName}...`);
    await serial.writeLine('M119');
    const alreadyTriggered = await new Promise(resolve => {
      const onT = () => { cleanup(); resolve(true); };
      const onO = () => { cleanup(); resolve(false); };
      const t = setTimeout(() => { cleanup(); resolve(false); }, 700);
      const cleanup = () => {
        window.removeEventListener('endstop-z-probe-triggered', onT);
        window.removeEventListener('endstop-z-probe-open', onO);
        clearTimeout(t);
      };
      window.addEventListener('endstop-z-probe-triggered', onT, { once: true });
      window.addEventListener('endstop-z-probe-open', onO, { once: true });
    });

    if (alreadyTriggered) {
      console.warn(`⚠️ z_min already TRIGGERED at start Z=${currentZ} for ${cornerName}. Probe start Z may be too low.`);
      setStatusMsg(`⚠️ ${cornerName}: z_min triggered at start height — increase Start Z and retry.`);
      return null;
    }

    setStatusMsg(`Probing ${cornerName} — stepping down from Z=${probeStartZ}...`);

    while (currentZ > maxDepth) {
      if (abortRef.current) return null;

      currentZ = parseFloat((currentZ - stepSize).toFixed(3));
      await serial.writeLine(`G1 Z${currentZ} F${probeSpeed}`);
      await delay(msPerStep);
      await serial.writeLine('M119');

      const triggered = await pollM119(500);
      if (triggered) {
        console.log(`✅ Probe hit at Z=${currentZ} for ${cornerName}`);
        return currentZ;
      }

      setStatusMsg(`Probing ${cornerName} — Z=${currentZ.toFixed(3)} (step ${Math.round((probeStartZ - currentZ) / stepSize)})`);
    }

    return null;
  };

  // ──────────────────────────────────────────────────
  // Full auto-calibration routine
  // ──────────────────────────────────────────────────
  const startAutoCalibration = async () => {
    const serial = window.serial;
    if (!serial || !serial.writeLine) { alert('Machine not connected!'); return; }
    if (!confirm(`Auto-Leveling will:\n1. Move to each of ${mesh.length} points\n2. Step down until pressure sensor triggers\n3. Save Z heights automatically\n\nEnsure nozzle is clear of obstructions. Proceed?`)) return;

    abortRef.current = false;
    setIsCalibrating(true);
    setProgress(0);

    const updatedMesh = mesh.map(p => ({ ...p, zParam: 0 }));

    try {
      await serial.writeLine('G90');      // absolute mode
      await serial.writeLine('M211 S0'); // disable soft endstops

      for (let i = 0; i < mesh.length; i++) {
        if (abortRef.current) break;

        const pt = mesh[i];
        setCurrentCornerIndex(i);

        // Move to safe height first, then XY
        setStatusMsg(`Moving to ${pt.name} (X${pt.x}, Y${pt.y})...`);
        await serial.writeLine(`G0 Z${probeStartZ} F800`);
        await delay(2500);
        await serial.writeLine(`G0 X${pt.x} Y${pt.y} F3000`);

        // Wait for XY travel — estimate worst case 235mm / 50mm/s = 4.7s
        await delay(6000);

        // Probe down
        const probedZ = await probeOnePoint(serial, pt.name);

        if (probedZ === null) {
          setStatusMsg(`⚠️ ${pt.name}: Probe did not trigger! Check sensor wiring. Aborting.`);
          break;
        }

        // Save to local copy
        updatedMesh[i] = { ...updatedMesh[i], zParam: probedZ };
        setMesh([...updatedMesh]);

        // Retract
        setStatusMsg(`${pt.name} done (Z=${probedZ.toFixed(3)}). Retracting...`);
        await serial.writeLine(`G0 Z${probeStartZ} F800`);
        await delay(1500);

        setProgress(Math.round(((i + 1) / mesh.length) * 100));
      }

      if (!abortRef.current) {
        // Return to first corner
        await serial.writeLine(`G0 X${mesh[0].x} Y${mesh[0].y} F3000`);
        setStatusMsg('✅ Auto-Leveling Complete! Mesh saved to browser storage.');
      } else {
        setStatusMsg('⚠️ Calibration aborted by user.');
      }

    } catch (err) {
      console.error(err);
      setStatusMsg('❌ Serial error during calibration: ' + err.message);
    } finally {
      await serial.writeLine('M211 S1'); // always re-enable endstops
      setIsCalibrating(false);
      setCurrentCornerIndex(-1);
    }
  };

  // ──────────────────────────────────────────────────
  // Manual mode helpers
  // ──────────────────────────────────────────────────
  const [manualCornerIndex, setManualCornerIndex] = useState(-1);
  const [manualStatus, setManualStatus] = useState('Idle.');

  const startManualCalibration = async () => {
    const serial = window.serial;
    if (!serial || !serial.writeLine) { alert('Machine not connected!'); return; }
    if (!confirm('Manual mode: Machine will move to each corner. You jog Z down until nozzle touches, then click Save Z.')) return;
    setIsCalibrating(true);
    setManualCornerIndex(0);
    setManualStatus(`Move to ${mesh[0].name}: jogging to position...`);
    await serial.writeLine('G90');
    await serial.writeLine('M211 S0');
    await serial.writeLine(`G0 Z${probeStartZ} F800`);
    await delay(2000);
    await serial.writeLine(`G0 X${mesh[0].x} Y${mesh[0].y} F3000`);
    await delay(5000);
    setManualStatus(`Jog nozzle down to touch bed at ${mesh[0].name}, then click Save Z.`);
  };

  const saveManualZ = async () => {
    const serial = window.serial;
    if (!machinePosition) { alert('Machine position not available.'); return; }
    const probedZ = machinePosition.z;
    const i = manualCornerIndex;
    setMesh(prev => { const n=[...prev]; n[i].zParam = probedZ; return n; });
    // Advance
    if (i + 1 >= mesh.length) {
      await serial.writeLine('M211 S1');
      await serial.writeLine(`G0 Z${probeStartZ} F800`);
      await serial.writeLine(`G0 X${mesh[0].x} Y${mesh[0].y} F3000`);
      setManualStatus('✅ Manual calibration complete!');
      setIsCalibrating(false);
      setManualCornerIndex(-1);
    } else {
      const next = mesh[i + 1];
      setManualCornerIndex(i + 1);
      setManualStatus(`Moving to ${next.name}...`);
      await serial.writeLine(`G0 Z${probeStartZ} F800`);
      await delay(2000);
      await serial.writeLine(`G0 X${next.x} Y${next.y} F3000`);
      await delay(5000);
      setManualStatus(`Jog nozzle down to touch bed at ${next.name}, then click Save Z.`);
    }
  };

  const abortCalibration = async () => {
    abortRef.current = true;
    if (window.serial?.writeLine) await window.serial.writeLine('M211 S1');
    setIsCalibrating(false);
    setCurrentCornerIndex(-1);
    setManualCornerIndex(-1);
    setStatusMsg('⚠️ Calibration aborted.');
    setManualStatus('⚠️ Aborted.');
  };

  const clearMesh = () => {
    if (!confirm('Clear all calibration data?')) return;
    setMesh(prev => prev.map(p => ({ ...p, zParam: 0 })));
    setStatusMsg('Mesh cleared. Ready to re-calibrate.');
  };

  const meshCalibrated = mesh.some(p => p.zParam !== 0);
  const activeIndex = mode === 'auto' ? currentCornerIndex : manualCornerIndex;

  return (
    <div style={{ padding: '15px', color: '#ccc' }}>
      <h3 style={{ color: '#00c49a', marginBottom: '4px' }}>🔧 Bed Level Calibration</h3>
      <p style={{ fontSize: '0.82em', color: '#888', marginBottom: '14px' }}>
        Maps the physical slope of the bed surface so the nozzle height auto-adjusts during dispensing.
      </p>

      {/* Mode Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '14px', border: '1px solid #444', borderRadius: '6px', overflow: 'hidden' }}>
        {['auto', 'manual'].map(m => (
          <button key={m} onClick={() => !isCalibrating && setMode(m)}
            style={{ flex: 1, padding: '8px', background: mode === m ? '#00c49a' : '#1e1e1e',
              color: mode === m ? '#000' : '#aaa', border: 'none', cursor: 'pointer', fontWeight: mode === m ? 'bold' : 'normal',
              fontSize: '0.9em', textTransform: 'capitalize' }}>
            {m === 'auto' ? '⚡ Auto (M119)' : '🖐 Manual'}
          </button>
        ))}
      </div>

      {/* Mesh Table */}
      <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px', marginBottom: '14px', border: '1px solid #333' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h4 style={{ margin: 0, fontSize: '0.9em', color: '#aaa' }}>Probe Points</h4>
          <button onClick={clearMesh} disabled={isCalibrating}
            style={{ fontSize: '0.75em', padding: '3px 8px', background: '#333', border: '1px solid #555', color: '#888', borderRadius: '4px', cursor: 'pointer' }}>
            Clear Mesh
          </button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em' }}>
          <thead>
            <tr style={{ color: '#666', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px' }}>Corner</th>
              <th style={{ padding: '4px 6px' }}>X</th>
              <th style={{ padding: '4px 6px' }}>Y</th>
              <th style={{ padding: '4px 6px' }}>Probed Z</th>
            </tr>
          </thead>
          <tbody>
            {mesh.map((pt, idx) => (
              <tr key={pt.id} style={{ borderTop: '1px solid #2a2a2a',
                background: activeIndex === idx ? 'rgba(255,170,0,0.12)' : 'transparent' }}>
                <td style={{ padding: '5px 6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block',
                    background: activeIndex === idx ? '#ffaa00' : pt.zParam !== 0 ? '#00c49a' : '#444',
                    boxShadow: activeIndex === idx ? '0 0 6px #ffaa00' : 'none' }} />
                  {pt.name}
                </td>
                <td style={{ padding: '5px 6px' }}>
                  <input type="number" value={pt.x} disabled={isCalibrating}
                    onChange={e => setMesh(prev => { const n=[...prev]; n[idx].x = parseFloat(e.target.value)||0; return n; })}
                    style={{ width: '55px', padding: '3px', background: '#222', color: '#ddd', border: '1px solid #444', borderRadius: '3px' }} />
                </td>
                <td style={{ padding: '5px 6px' }}>
                  <input type="number" value={pt.y} disabled={isCalibrating}
                    onChange={e => setMesh(prev => { const n=[...prev]; n[idx].y = parseFloat(e.target.value)||0; return n; })}
                    style={{ width: '55px', padding: '3px', background: '#222', color: '#ddd', border: '1px solid #444', borderRadius: '3px' }} />
                </td>
                <td style={{ padding: '5px 6px', fontWeight: 'bold',
                  color: activeIndex === idx ? '#ffaa00' : pt.zParam !== 0 ? '#00c49a' : '#555' }}>
                  {pt.zParam !== 0 ? pt.zParam.toFixed(3) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Auto Mode */}
      {mode === 'auto' && (
        <div>
          {/* Settings */}
          <div style={{ background: '#131320', border: '1px solid #1a2a4a', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#64b5f6', fontSize: '0.88em' }}>⚙️ Auto-Probe Settings</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.82em' }}>
              {[
                { label: 'Start Z (mm)', val: probeStartZ, set: setProbeStartZ, step: 0.5, min: -5, max: 20 },
                { label: 'Step Size (mm)', val: stepSize, set: setStepSize, step: 0.025, min: 0.025, max: 0.5 },
                { label: 'Probe Speed (mm/min)', val: probeSpeed, set: setProbeSpeed, step: 10, min: 10, max: 200 },
                { label: 'Max Depth (mm)', val: maxDepth, set: setMaxDepth, step: 0.5, min: -20, max: 0 },
                { label: 'Dispense Gap (mm)', val: dispensingGap, set: setDispensingGap, step: 0.05, min: 0, max: 2 },
                { label: 'Travel Lift (mm)', val: liftHeight, set: setLiftHeight, step: 0.5, min: 1, max: 20 },
              ].map(({ label, val, set, step, min, max }) => (
                <div key={label}>
                  <label style={{ color: '#888', display: 'block', marginBottom: '2px' }}>{label}</label>
                  <input type="number" value={val} step={step} min={min} max={max}
                    onChange={e => set(parseFloat(e.target.value) || val)} disabled={isCalibrating}
                    style={{ width: '100%', padding: '5px', background: '#1e1e2e', color: 'white', border: '1px solid #334', borderRadius: '3px' }} />
                </div>
              ))}
            </div>
          </div>

          {/* Progress Bar */}
          {isCalibrating && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ height: '6px', background: '#333', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress}%`, background: '#00c49a', transition: 'width 0.5s' }} />
              </div>
              <div style={{ fontSize: '0.78em', color: '#ffaa00', marginTop: '6px', padding: '8px', background: '#1a1100', borderRadius: '4px', border: '1px solid #443300' }}>
                {statusMsg}
              </div>
            </div>
          )}

          {!isCalibrating && (
            <p style={{ fontSize: '0.8em', color: meshCalibrated ? '#00c49a' : '#888', marginBottom: '10px' }}>
              {meshCalibrated ? `✅ Mesh calibrated (${mesh.filter(p=>p.zParam!==0).length}/${mesh.length} points)` : statusMsg}
            </p>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={startAutoCalibration} disabled={isCalibrating}
              style={{ flex: 1, padding: '10px', fontWeight: 'bold', background: '#00c49a', color: '#000',
                border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '0.9em' }}>
              ⚡ Start Auto-Leveling
            </button>
            {isCalibrating && (
              <button onClick={abortCalibration}
                style={{ padding: '10px 16px', background: '#c0392b', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
                ■ Abort
              </button>
            )}
          </div>

          <div style={{ marginTop: '10px', padding: '8px', background: '#0d1926', border: '1px solid #1a3050', borderRadius: '4px', fontSize: '0.78em', color: '#5588aa' }}>
            💡 <strong>How it works:</strong> The machine steps down by <strong>{stepSize}mm</strong> at <strong>{probeSpeed}mm/min</strong>, then sends <code style={{background:'#111',padding:'1px 4px',borderRadius:'3px'}}>M119</code> after each step. When your pressure sensor pin shows <strong>TRIGGERED</strong>, Z is recorded automatically.
          </div>
        </div>
      )}

      {/* Manual Mode */}
      {mode === 'manual' && (
        <div>
          {manualCornerIndex >= 0 && isCalibrating && (
            <div style={{ padding: '10px', background: '#1a1100', border: '1px solid #443300', borderRadius: '5px', marginBottom: '10px', fontSize: '0.85em', color: '#ffaa00' }}>
              {manualStatus}
              {machinePosition && (
                <div style={{ marginTop: '6px', color: '#fff' }}>
                  Current Z: <strong>{machinePosition.z?.toFixed(3)}</strong>
                </div>
              )}
            </div>
          )}

          {!isCalibrating && (
            <p style={{ fontSize: '0.82em', color: '#888', marginBottom: '10px' }}>{manualStatus}</p>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            {!isCalibrating && (
              <button onClick={startManualCalibration}
                style={{ flex: 1, padding: '10px', fontWeight: 'bold', background: '#1565c0', color: 'white',
                  border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
                🖐 Start Manual Leveling
              </button>
            )}
            {isCalibrating && manualCornerIndex >= 0 && (
              <>
                <button onClick={saveManualZ}
                  style={{ flex: 1, padding: '10px', fontWeight: 'bold', background: '#00c49a', color: 'black',
                    border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
                  💾 Save Z & Continue
                </button>
                <button onClick={abortCalibration}
                  style={{ padding: '10px 14px', background: '#c0392b', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}>
                  ■ Abort
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
