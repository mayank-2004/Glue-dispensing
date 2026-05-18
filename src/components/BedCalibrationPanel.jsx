/**
 * BedCalibrationPanel.jsx
 *
 * PCB Surface Leveling — probes the PCB surface only (not the full bed).
 * Includes a guided flow: home → anchor PCB origin → auto-probe 5 points.
 *
 * Props
 * ─────
 *  machinePosition     { x, y, z }                live from App
 *  boardOutline        { minX, minY, width, height } from extractBoardOutline
 *  xf                  transform object (may be null)
 *  applyXf             bool
 *  isConnected         bool
 *  onSetPcbOrigin      (machinePos) => void        call App's setPcbOriginOffset
 *  onSendGcode         async (line: string) => void  wraps window.serial.writeLine
 *
 * Exports
 * ───────
 *  getZOffsetForPoint(x, y) → number
 *    Import and call this in AutomatedDispensingPanel before every dispense Z move.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { applyTransform } from '../lib/utils/transform2d.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Z-mesh interpolation (IDW) ──────────────────────────────────────────────
export function interpolateZ(mesh, px, py) {
  if (!mesh || mesh.length === 0) return 0;
  const cal = mesh.filter(p => p.zParam !== 0);
  if (cal.length === 0) return 0;
  if (cal.length === 1) return cal[0].zParam;
  let num = 0, den = 0;
  for (const pt of cal) {
    const d2 = (pt.x - px) ** 2 + (pt.y - py) ** 2;
    if (d2 < 1e-6) return pt.zParam;
    const w = 1 / d2;
    num += w * pt.zParam;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

let _meshRef = [];
export function getZOffsetForPoint(x, y) { return interpolateZ(_meshRef, x, y); }

// ─── Flow steps ───────────────────────────────────────────────────────────────
const FLOW = {
  IDLE:       'idle',
  ANCHOR:     'anchor',   // user jogs to PCB BL corner
  PROBING:    'probing',  // auto-stepping through 5 points
  DONE:       'done',
};

// ─── Small reusable UI pieces ─────────────────────────────────────────────────
const Btn = ({ onClick, disabled, color = '#00c49a', textColor = '#000', children, style = {} }) => (
  <button onClick={onClick} disabled={disabled} style={{
    padding: '9px 14px', fontWeight: 'bold', fontSize: '0.88em',
    background: disabled ? '#333' : color,
    color: disabled ? '#666' : textColor,
    border: 'none', borderRadius: 5, cursor: disabled ? 'not-allowed' : 'pointer',
    ...style,
  }}>{children}</button>
);

const Field = ({ label, value, onChange, step, min, max, disabled, unit }) => (
  <div>
    <label style={{ color: '#888', display: 'block', marginBottom: 2, fontSize: '0.82em' }}>{label}</label>
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <input type="number" value={value} step={step} min={min} max={max}
        disabled={disabled}
        onChange={e => onChange(parseFloat(e.target.value) || value)}
        style={{ flex: 1, padding: 5, background: '#1e1e2e', color: 'white', border: '1px solid #334', borderRadius: 3 }} />
      {unit && <span style={{ color: '#666', fontSize: '0.82em' }}>{unit}</span>}
    </div>
  </div>
);

// ─── Inline jog panel (used during ANCHOR step) ───────────────────────────────
function InlineJog({ onSend, disabled }) {
  const [step, setStep] = useState(1);
  const send = useCallback(async (cmd) => {
    try { await onSend(cmd); } catch (e) { console.error('[Jog]', e); }
  }, [onSend]);

  const jogXY = (axis, dir) => send(`G91\nG1 ${axis}${(dir * step).toFixed(3)} F1500\nG90`);
  const jogZ  = (dir)       => send(`G91\nG1 Z${(dir * 0.5).toFixed(3)} F300\nG90`);

  const btn = (label, onClick, w = 44) => (
    <button onClick={onClick} disabled={disabled}
      style={{ width: w, height: 36, background: '#1e2a3a', color: '#9cf', border: '1px solid #334',
        borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '0.8em', fontWeight: 'bold' }}>
      {label}
    </button>
  );

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.78em', color: '#888' }}>Step:</span>
        {[0.1, 0.5, 1, 5, 10].map(s => (
          <button key={s} onClick={() => setStep(s)}
            style={{ padding: '3px 8px', fontSize: '0.78em', background: step === s ? '#00c49a' : '#1e1e1e',
              color: step === s ? '#000' : '#aaa', border: '1px solid #444', borderRadius: 3, cursor: 'pointer' }}>
            {s}mm
          </button>
        ))}
      </div>
      {/* XY grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '44px 44px 44px', gridTemplateRows: '36px 36px 36px', gap: 3 }}>
        <div />
        {btn('Y+', () => jogXY('Y',  1))}
        <div />
        {btn('X-', () => jogXY('X', -1))}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#111', borderRadius: 4, fontSize: '0.7em', color: '#555' }}>XY</div>
        {btn('X+', () => jogXY('X',  1))}
        <div />
        {btn('Y-', () => jogXY('Y', -1))}
        <div />
      </div>
      {/* Z */}
      <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
        {btn('Z+', () => jogZ( 1), 66)}
        {btn('Z-', () => jogZ(-1), 66)}
        <span style={{ fontSize: '0.72em', color: '#555', alignSelf: 'center', marginLeft: 4 }}>0.5mm / click</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function BedCalibrationPanel({
  machinePosition = { x: 0, y: 0, z: 0 },
  boardOutline,
  xf,
  applyXf,
  isConnected,
  onSetPcbOrigin,
}) {

  // ── Mesh ────────────────────────────────────────────────────────────────────
  const [mesh, setMesh] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('bedLevelMesh'));
      if (Array.isArray(s) && s.length > 0) return s;
    } catch (_) {}
    return [];
  });
  useEffect(() => { _meshRef = mesh; }, [mesh]);
  useEffect(() => { localStorage.setItem('bedLevelMesh', JSON.stringify(mesh)); }, [mesh]);

  // ── Probe settings ──────────────────────────────────────────────────────────
  const ls = (k, d) => { try { return parseFloat(localStorage.getItem(k) ?? d); } catch { return parseFloat(d); } };
  const [probeStartZ,   setProbeStartZ]   = useState(() => ls('probeStartZ',   '3'));
  const [stepSize,      setStepSize]      = useState(() => ls('probeStepSize', '0.1'));
  const [probeSpeed,    setProbeSpeed]    = useState(() => ls('probeSpeed',    '60'));
  const [maxDepth,      setMaxDepth]      = useState(() => ls('probeMaxDepth', '-5'));
  const [dispensingGap, setDispensingGap] = useState(() => ls('dispensingGap', '0.1'));
  const [liftHeight,    setLiftHeight]    = useState(() => ls('liftHeight',    '5'));
  const [edgeInset,     setEdgeInset]     = useState(() => ls('pcbProbeEdgeInset', '5'));

  useEffect(() => { localStorage.setItem('probeStartZ',        String(probeStartZ));   }, [probeStartZ]);
  useEffect(() => { localStorage.setItem('probeStepSize',      String(stepSize));      }, [stepSize]);
  useEffect(() => { localStorage.setItem('probeSpeed',         String(probeSpeed));    }, [probeSpeed]);
  useEffect(() => { localStorage.setItem('probeMaxDepth',      String(maxDepth));      }, [maxDepth]);
  useEffect(() => { localStorage.setItem('dispensingGap',      String(dispensingGap)); }, [dispensingGap]);
  useEffect(() => { localStorage.setItem('liftHeight',         String(liftHeight));    }, [liftHeight]);
  useEffect(() => { localStorage.setItem('pcbProbeEdgeInset',  String(edgeInset));     }, [edgeInset]);

  // ── Flow state ──────────────────────────────────────────────────────────────
  const [flowStep,      setFlowStep]      = useState(FLOW.IDLE);
  const [probeMode,     setProbeMode]     = useState('auto');   // 'auto' | 'manual'
  const [statusMsg,     setStatus]        = useState('');
  const [progress,      setProgress]      = useState(0);
  const [currentPtIdx,  setCurrentPtIdx]  = useState(-1);
  const [pcbOrigin,     setPcbOrigin]     = useState(null);     // machine coords of PCB (0,0)

  // Manual mode
  const [manualIdx,     setManualIdx]     = useState(-1);
  const [manualStatus,  setManualStatus]  = useState('Idle.');

  const abortRef    = useRef(false);
  const mPosRef     = useRef(machinePosition);
  useEffect(() => { mPosRef.current = machinePosition; }, [machinePosition]);

  // ── Send helper ───────────────────────────────────────────────────────────────
  const send = useCallback(async (cmd) => {
    if (window.serial?.writeLine) {
      for (const line of cmd.split('\n').map(l => l.trim()).filter(Boolean)) {
        await window.serial.writeLine(line);
      }
    }
  }, []);

  // ── Coordinate mapping: design → machine ────────────────────────────────────
  const toMachine = useCallback((designPt, origin) => {
    // If we have a full fiducial transform, use it
    if (xf && applyXf) return applyTransform(xf, designPt);
    // Otherwise offset by the captured pcbOrigin
    const o = origin || pcbOrigin || { x: 0, y: 0 };
    return { x: o.x + designPt.x, y: o.y + designPt.y };
  }, [xf, applyXf, pcbOrigin]);

  // ── Build 5 probe points from boardOutline + captured origin ────────────────
  const buildProbePoints = useCallback((origin) => {
    if (!boardOutline) return null;

    const minX = boardOutline.minX ?? 0;
    const minY = boardOutline.minY ?? 0;
    const maxX = boardOutline.maxX ?? (minX + (boardOutline.width  ?? 100));
    const maxY = boardOutline.maxY ?? (minY + (boardOutline.height ?? 100));
    const w = maxX - minX, h = maxY - minY;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const ins = Math.min(edgeInset, w * 0.4, h * 0.4); // safety clamp

    const designPts = [
      { id: 'BL', name: 'Bottom-Left',  x: minX + ins, y: minY + ins },
      { id: 'BR', name: 'Bottom-Right', x: maxX - ins, y: minY + ins },
      { id: 'TR', name: 'Top-Right',    x: maxX - ins, y: maxY - ins },
      { id: 'TL', name: 'Top-Left',     x: minX + ins, y: maxY - ins },
      { id: 'C',  name: 'Center',       x: cx,         y: cy         },
    ];

    return designPts.map(p => {
      const m = toMachine(p, origin);
      return {
        id: p.id, name: p.name,
        designX: p.x, designY: p.y,
        x: parseFloat(m.x.toFixed(3)),
        y: parseFloat(m.y.toFixed(3)),
        zParam: 0,
      };
    });
  }, [boardOutline, edgeInset, toMachine]);

  // ── Validate probe points stay within bed (235×235) ─────────────────────────
  const BED_MAX = 235;
  const validatePoints = (pts) => {
    const bad = pts.filter(p => p.x < 0 || p.y < 0 || p.x > BED_MAX || p.y > BED_MAX);
    return bad;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // FLOW STEP 1: Start — check preconditions then enter ANCHOR step
  // ─────────────────────────────────────────────────────────────────────────────
  const startLevelingFlow = useCallback(() => {
    if (!isConnected)  { alert('Connect the machine first.'); return; }
    if (!boardOutline) { alert('Load a Gerber board outline file first (must include an outline/edge layer).'); return; }

    abortRef.current = false;
    setProgress(0);
    setCurrentPtIdx(-1);
    setPcbOrigin(null);
    setMesh([]);

    setFlowStep(FLOW.ANCHOR);
    setStatus(
      'Jog the nozzle to the BOTTOM-LEFT corner of your PCB. ' +
      'The nozzle tip should just touch the board surface at that corner. ' +
      'Then click "Confirm PCB Origin".'
    );
  }, [isConnected, boardOutline]);

  // ─────────────────────────────────────────────────────────────────────────────
  // FLOW STEP 2: User confirms the PCB origin (nozzle is physically at BL corner)
  // ─────────────────────────────────────────────────────────────────────────────
  const confirmPcbOrigin = useCallback(async () => {
    const pos = mPosRef.current;
    if (!pos) { alert('Machine position not available — is the machine connected and homed?'); return; }

    // Capture current machine position as the PCB (0,0) anchor
    const origin = { x: pos.x, y: pos.y, z: pos.z };
    setPcbOrigin(origin);

    // Tell App.jsx so the rest of the app (pad distances, path planning, etc.) stays in sync
    if (onSetPcbOrigin) onSetPcbOrigin(origin);

    // Build the 5 probe points now that we know the origin
    const pts = buildProbePoints(origin);
    if (!pts) { alert('Could not compute probe points — check board outline.'); return; }

    // Safety: ensure all points are within bed travel
    const outOfBounds = validatePoints(pts);
    if (outOfBounds.length > 0) {
      const names = outOfBounds.map(p => p.name).join(', ');
      if (!confirm(
        `Warning: these probe points exceed bed limits (${BED_MAX}×${BED_MAX}mm):\n${names}\n\n` +
        `This can happen if the PCB origin is placed near the bed edge.\n` +
        `Move machine to a better position or reduce Edge Inset. Continue anyway?`
      )) return;
    }

    setMesh(pts);
    setStatus(`PCB origin set at machine (${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}). ` +
              `${pts.length} probe points generated. Ready to probe.`);

    // Lift nozzle to safe height before probing begins
    await send(`G1 Z${liftHeight} F800`);
    await delay(1000);

    if (probeMode === 'auto') {
      setFlowStep(FLOW.PROBING);
      runAutoProbe(pts, origin);
    } else {
      setFlowStep(FLOW.PROBING);
      runManualProbe(pts, 0);
    }
  }, [buildProbePoints, liftHeight, onSetPcbOrigin, probeMode, send]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Endstop poll (waits for 'endstop-z-probe-triggered' or 'endstop-z-probe-open'
  // DOM events fired by SerialPanel's onData bridge)
  // ─────────────────────────────────────────────────────────────────────────────
  const pollEndstop = (timeoutMs = 600) =>
    new Promise(resolve => {
      const onTrig = () => { cleanup(); resolve(true);  };
      const onOpen = () => { cleanup(); resolve(false); };
      const timer  = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const cleanup = () => {
        window.removeEventListener('endstop-z-probe-triggered', onTrig);
        window.removeEventListener('endstop-z-probe-open',      onOpen);
        clearTimeout(timer);
      };
      window.addEventListener('endstop-z-probe-triggered', onTrig, { once: true });
      window.addEventListener('endstop-z-probe-open',      onOpen, { once: true });
    });

  // ─────────────────────────────────────────────────────────────────────────────
  // Single-point auto probe
  // ─────────────────────────────────────────────────────────────────────────────
  const probeOnePoint = useCallback(async (ptName) => {
    const msPerStep = Math.ceil((stepSize / probeSpeed) * 60 * 1000) + 150;

    // Confirm endstop open at start height
    setStatus(`[${ptName}] Checking sensor state at Z=${probeStartZ}…`);
    await send('M119');
    const alreadyHit = await pollEndstop(700);
    if (alreadyHit) {
      setStatus(`⚠️ [${ptName}] Sensor already triggered at Z=${probeStartZ} — increase Start Z.`);
      return null;
    }

    let z = probeStartZ;
    setStatus(`[${ptName}] Stepping down from Z=${probeStartZ}…`);

    while (z > maxDepth) {
      if (abortRef.current) return null;
      z = parseFloat((z - stepSize).toFixed(4));
      await send(`G1 Z${z} F${probeSpeed}`);
      await delay(msPerStep);
      await send('M119');
      const hit = await pollEndstop(500);
      if (hit) {
        console.log(`✅ Contact at Z=${z} for ${ptName}`);
        return z;
      }
      setStatus(`[${ptName}] Z=${z.toFixed(3)} — stepping…`);
    }

    setStatus(`⚠️ [${ptName}] Reached max depth (${maxDepth}) without contact.`);
    return null;
  }, [stepSize, probeSpeed, probeStartZ, maxDepth, send]);

  // ─────────────────────────────────────────────────────────────────────────────
  // FLOW STEP 3a: Full auto-probe loop through all 5 points
  // ─────────────────────────────────────────────────────────────────────────────
  const runAutoProbe = useCallback(async (pts, _origin) => {
    const serial = window.serial;
    if (!serial?.writeLine) return;

    abortRef.current = false;
    const updated = pts.map(p => ({ ...p, zParam: 0 }));

    try {
      await send('G90');      // absolute
      await send('M211 S0'); // disable soft endstops

      for (let i = 0; i < pts.length; i++) {
        if (abortRef.current) break;
        const pt = pts[i];
        setCurrentPtIdx(i);

        // Move to safe Z, then travel to XY
        setStatus(`Moving to ${pt.name} (X${pt.x.toFixed(2)} Y${pt.y.toFixed(2)})…`);
        await send(`G1 Z${probeStartZ} F800`);
        await delay(1500);
        await send(`G1 X${pt.x.toFixed(3)} Y${pt.y.toFixed(3)} F3000`);
        // Wait for XY travel — proportional to estimated distance
        await delay(5000);

        const probedZ = await probeOnePoint(pt.name);

        if (probedZ === null) {
          abortRef.current = true;
          break;
        }

        // Store surface Z + gap as the dispense Z for this location
        updated[i] = { ...updated[i], zParam: parseFloat((probedZ + dispensingGap).toFixed(4)) };
        setMesh([...updated]);

        setStatus(`✅ ${pt.name}: surface Z=${probedZ.toFixed(3)}, dispense Z=${updated[i].zParam.toFixed(3)}. Retracting…`);
        await send(`G1 Z${probeStartZ} F800`);
        await delay(1000);
        setProgress(Math.round(((i + 1) / pts.length) * 100));
      }

      if (!abortRef.current) {
        // Return to PCB origin (BL corner) at safe height
        await send(`G1 Z${liftHeight} F800`);
        await send(`G1 X${pts[0].x.toFixed(3)} Y${pts[0].y.toFixed(3)} F3000`);
        setFlowStep(FLOW.DONE);
        setStatus(`✅ PCB leveling complete! ${pts.length} points probed. Z-compensation is now active.`);
      } else {
        setStatus('⚠️ Probing aborted.');
        setFlowStep(FLOW.IDLE);
      }

    } catch (err) {
      console.error('[AutoProbe]', err);
      setStatus('❌ Error: ' + err.message);
      setFlowStep(FLOW.IDLE);
    } finally {
      await send('M211 S1'); // always re-enable soft endstops
      setCurrentPtIdx(-1);
    }
  }, [probeStartZ, liftHeight, dispensingGap, probeOnePoint, send]);

  // ─────────────────────────────────────────────────────────────────────────────
  // FLOW STEP 3b: Manual probe — drive to point, user jogs Z, clicks Save
  // ─────────────────────────────────────────────────────────────────────────────
  const runManualProbe = useCallback(async (pts, idx) => {
    if (idx >= pts.length) {
      await send('M211 S1');
      await send(`G1 Z${liftHeight} F800`);
      setFlowStep(FLOW.DONE);
      setStatus('✅ Manual leveling complete!');
      setManualIdx(-1);
      return;
    }
    const pt = pts[idx];
    setManualIdx(idx);
    setCurrentPtIdx(idx);
    setManualStatus(`Moving to ${pt.name}…`);
    await send('M211 S0');
    await send(`G1 Z${probeStartZ} F800`);
    await delay(1500);
    await send(`G1 X${pt.x.toFixed(3)} Y${pt.y.toFixed(3)} F3000`);
    await delay(5000);
    setManualStatus(`Jog nozzle down until it JUST touches the PCB at ${pt.name}, then click Save Z.`);
  }, [probeStartZ, liftHeight, send]);

  // Mesh ref needed inside saveManualZ closure
  const meshRef = useRef(mesh);
  useEffect(() => { meshRef.current = mesh; }, [mesh]);

  const saveManualZ = useCallback(async () => {
    const pos = mPosRef.current;
    if (!pos) { alert('Machine position unavailable.'); return; }
    const i = manualIdx;
    const dispZ = parseFloat((pos.z + dispensingGap).toFixed(4));

    setMesh(prev => {
      const n = [...prev];
      n[i] = { ...n[i], zParam: dispZ };
      return n;
    });

    setProgress(Math.round(((i + 1) / meshRef.current.length) * 100));
    // Advance to next point
    await runManualProbe(meshRef.current, i + 1);
  }, [manualIdx, dispensingGap, runManualProbe]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Abort
  // ─────────────────────────────────────────────────────────────────────────────
  const abortFlow = useCallback(async () => {
    abortRef.current = true;
    try { await send('M211 S1'); } catch (_) {}
    setFlowStep(FLOW.IDLE);
    setCurrentPtIdx(-1);
    setManualIdx(-1);
    setProgress(0);
    setStatus('⚠️ Leveling aborted.');
    setManualStatus('Aborted.');
  }, [send]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Reset (clear mesh data, go back to idle)
  // ─────────────────────────────────────────────────────────────────────────────
  const resetFlow = useCallback(() => {
    if (!confirm('Clear all leveling data and start over?')) return;
    setMesh([]);
    setPcbOrigin(null);
    setFlowStep(FLOW.IDLE);
    setProgress(0);
    setCurrentPtIdx(-1);
    setManualIdx(-1);
    setStatus('');
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const calibratedCount = mesh.filter(p => p.zParam !== 0).length;
  const meshCalibrated  = calibratedCount === mesh.length && mesh.length > 0;
  const zVals  = mesh.filter(p => p.zParam !== 0).map(p => p.zParam);
  const zRange = zVals.length >= 2
    ? (Math.max(...zVals) - Math.min(...zVals)).toFixed(3)
    : null;

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  const probePointRow = (pt, idx) => {
    const isActive  = currentPtIdx === idx;
    const isDone    = pt.zParam !== 0;
    const dotColor  = isActive ? '#ffaa00' : isDone ? '#00c49a' : '#444';
    return (
      <tr key={pt.id} style={{ borderTop: '1px solid #2a2a2a',
        background: isActive ? 'rgba(255,170,0,0.10)' : 'transparent' }}>
        <td style={{ padding: '5px 8px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor,
              boxShadow: isActive ? '0 0 6px #ffaa00' : 'none', flexShrink: 0 }} />
            <span style={{ fontSize: '0.85em' }}>{pt.name}</span>
          </span>
        </td>
        <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: '0.82em', color: '#aaa' }}>
          {pt.x?.toFixed(2) ?? '—'}, {pt.y?.toFixed(2) ?? '—'}
        </td>
        <td style={{ padding: '5px 8px', fontWeight: 'bold', fontFamily: 'monospace',
          color: isActive ? '#ffaa00' : isDone ? '#00c49a' : '#555' }}>
          {isDone ? `${pt.zParam.toFixed(3)} mm` : isActive ? '…' : '—'}
        </td>
      </tr>
    );
  };

  return (
    <div style={{ padding: '15px', color: '#ccc', maxWidth: 520 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div>
          <h3 style={{ color: '#00c49a', margin: 0 }}>🔧 PCB Surface Leveling</h3>
          <p style={{ fontSize: '0.8em', color: '#666', margin: '4px 0 0 0' }}>
            Probes the actual PCB surface so the nozzle maintains a constant
            gap even when the board is slightly warped or tilted.
          </p>
        </div>
        {flowStep !== FLOW.IDLE && (
          <button onClick={resetFlow}
            style={{ fontSize: '0.75em', padding: '4px 10px', background: '#2a1010',
              border: '1px solid #c0392b', color: '#c0392b', borderRadius: 4, cursor: 'pointer' }}>
            ✕ Reset
          </button>
        )}
      </div>

      {/* ── Mesh summary badge ── */}
      {mesh.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, marginTop: 8 }}>
          <span style={{ fontSize: '0.78em', padding: '3px 8px', borderRadius: 10,
            background: meshCalibrated ? '#0d3320' : '#1a2a1a',
            border: `1px solid ${meshCalibrated ? '#00c49a' : '#3a5a3a'}`,
            color: meshCalibrated ? '#00c49a' : '#5a9a5a' }}>
            {calibratedCount}/{mesh.length} points probed
          </span>
          {zRange && (
            <span style={{ fontSize: '0.78em', padding: '3px 8px', borderRadius: 10,
              background: '#1a1a00', border: '1px solid #555500', color: '#cccc00' }}>
              PCB warp: {zRange} mm
            </span>
          )}
          {meshCalibrated && (
            <span style={{ fontSize: '0.78em', padding: '3px 8px', borderRadius: 10,
              background: '#001a2a', border: '1px solid #005588', color: '#00aaff' }}>
              ✅ Z-compensation active
            </span>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          FLOW: IDLE — show start button + settings
      ════════════════════════════════════════════════════════════════════════ */}
      {flowStep === FLOW.IDLE && (
        <div>
          {/* Mode selector */}
          <div style={{ display: 'flex', marginBottom: 12, border: '1px solid #333', borderRadius: 6, overflow: 'hidden' }}>
            {['auto', 'manual'].map(m => (
              <button key={m} onClick={() => setProbeMode(m)}
                style={{ flex: 1, padding: 8, border: 'none', cursor: 'pointer',
                  background: probeMode === m ? '#00c49a' : '#1e1e1e',
                  color:      probeMode === m ? '#000'    : '#aaa',
                  fontWeight: probeMode === m ? 'bold'    : 'normal', fontSize: '0.88em' }}>
                {m === 'auto' ? '⚡ Auto (pressure sensor)' : '🖐 Manual (jog)'}
              </button>
            ))}
          </div>

          {/* Settings */}
          <div style={{ background: '#131320', border: '1px solid #1a2a4a', borderRadius: 8,
            padding: 12, marginBottom: 14 }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#64b5f6', fontSize: '0.88em' }}>
              ⚙️ {probeMode === 'auto' ? 'Auto-Probe' : 'Manual'} Settings
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Field label="Start Z (mm)"        value={probeStartZ}   onChange={setProbeStartZ}   step={0.5}  min={0}    max={20}  unit="mm" />
              <Field label="Edge Inset (mm)"      value={edgeInset}     onChange={setEdgeInset}     step={1}    min={0}    max={30}  unit="mm" />
              <Field label="Dispense Gap (mm)"    value={dispensingGap} onChange={setDispensingGap} step={0.05} min={0}    max={2}   unit="mm" />
              <Field label="Travel Lift (mm)"     value={liftHeight}    onChange={setLiftHeight}    step={0.5}  min={1}    max={20}  unit="mm" />
              {probeMode === 'auto' && <>
                <Field label="Step Size (mm)"       value={stepSize}      onChange={setStepSize}      step={0.025} min={0.025} max={0.5} unit="mm" />
                <Field label="Speed (mm/min)"        value={probeSpeed}    onChange={setProbeSpeed}    step={10}   min={10}   max={300} unit="mm/min" />
                <Field label="Max Depth (mm)"        value={maxDepth}      onChange={setMaxDepth}      step={0.5}  min={-20}  max={0}   unit="mm" />
              </>}
            </div>
          </div>

          {/* Precondition hints */}
          <div style={{ marginBottom: 12, fontSize: '0.8em' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ color: isConnected ? '#00c49a' : '#cc4400' }}>
                {isConnected ? '✅' : '❌'}
              </span>
              <span style={{ color: isConnected ? '#aaa' : '#cc6600' }}>
                {isConnected ? 'Machine connected' : 'Machine not connected'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: boardOutline ? '#00c49a' : '#cc4400' }}>
                {boardOutline ? '✅' : '❌'}
              </span>
              <span style={{ color: boardOutline ? '#aaa' : '#cc6600' }}>
                {boardOutline
                  ? `Board outline loaded (${(boardOutline.width ?? 0).toFixed(1)} × ${(boardOutline.height ?? 0).toFixed(1)} mm)`
                  : 'No board outline loaded — load a Gerber with an outline/edge layer'}
              </span>
            </div>
          </div>

          <Btn onClick={startLevelingFlow}
            disabled={!isConnected || !boardOutline}
            style={{ width: '100%' }}>
            🚀 Start PCB Leveling
          </Btn>

          {mesh.length > 0 && calibratedCount > 0 && (
            <div style={{ marginTop: 12, background: '#1a1a1a', borderRadius: 6,
              padding: 10, border: '1px solid #333' }}>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '0.85em', color: '#888' }}>
                Previous Calibration
              </h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82em' }}>
                <thead>
                  <tr style={{ color: '#555', textAlign: 'left', borderBottom: '1px solid #2a2a2a' }}>
                    <th style={{ padding: '3px 8px' }}>Point</th>
                    <th style={{ padding: '3px 8px' }}>Machine XY</th>
                    <th style={{ padding: '3px 8px' }}>Dispense Z</th>
                  </tr>
                </thead>
                <tbody>{mesh.map(probePointRow)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          FLOW: ANCHOR — user jogs to PCB bottom-left corner
      ════════════════════════════════════════════════════════════════════════ */}
      {flowStep === FLOW.ANCHOR && (
        <div>
          <div style={{ background: '#0d1f0d', border: '1px solid #1a4a1a',
            borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <h4 style={{ color: '#00c49a', margin: '0 0 8px 0', fontSize: '0.95em' }}>
              📍 Step 1 of 2 — Set PCB Origin
            </h4>
            <p style={{ fontSize: '0.85em', color: '#aaa', margin: '0 0 10px 0', lineHeight: 1.6 }}>
              Jog the nozzle to the <strong style={{ color: '#fff' }}>bottom-left corner</strong> of
              your PCB. The nozzle tip should <em>just touch</em> the board surface at that corner.
              <br /><br />
              This tells the machine where the PCB is sitting on the bed.
              All 5 probe points will be calculated from this position.
            </p>

            {/* Live position readout */}
            <div style={{ display: 'flex', gap: 12, fontFamily: 'monospace', fontSize: '0.85em',
              background: '#111', padding: '6px 10px', borderRadius: 4, marginBottom: 10 }}>
              <span>X <strong style={{ color: '#0f0' }}>{machinePosition.x.toFixed(3)}</strong></span>
              <span>Y <strong style={{ color: '#0f0' }}>{machinePosition.y.toFixed(3)}</strong></span>
              <span>Z <strong style={{ color: '#0f0' }}>{machinePosition.z.toFixed(3)}</strong></span>
            </div>

            <InlineJog onSend={send} disabled={!isConnected} />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={confirmPcbOrigin} disabled={!isConnected} style={{ flex: 1 }}>
              ✅ Confirm PCB Origin — Start Probing
            </Btn>
            <Btn onClick={abortFlow} color="#c0392b" textColor="#fff" style={{ width: 90 }}>
              Cancel
            </Btn>
          </div>

          <p style={{ fontSize: '0.75em', color: '#555', marginTop: 8 }}>
            Tip: use 0.1 mm steps for fine Z positioning. The exact X/Y corner
            position sets the coordinate origin for all subsequent probe points.
          </p>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          FLOW: PROBING — auto or manual probe in progress
      ════════════════════════════════════════════════════════════════════════ */}
      {flowStep === FLOW.PROBING && (
        <div>
          <div style={{ background: '#0d1926', border: '1px solid #1a3050',
            borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <h4 style={{ color: '#64b5f6', margin: '0 0 8px 0', fontSize: '0.9em' }}>
              🔍 Step 2 of 2 — Probing PCB Surface ({probeMode === 'auto' ? 'Auto' : 'Manual'})
            </h4>

            {/* Progress bar */}
            <div style={{ height: 6, background: '#333', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', width: `${progress}%`,
                background: '#00c49a', transition: 'width 0.5s ease' }} />
            </div>
            <div style={{ fontSize: '0.78em', color: '#ffaa00', padding: '7px 10px',
              background: '#1a1100', borderRadius: 4, border: '1px solid #443300',
              minHeight: 32, lineHeight: 1.5 }}>
              {statusMsg || 'Starting…'}
            </div>
          </div>

          {/* Points table — live status */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em',
            background: '#1a1a1a', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
            <thead>
              <tr style={{ color: '#555', textAlign: 'left', borderBottom: '1px solid #2a2a2a',
                background: '#111' }}>
                <th style={{ padding: '5px 8px' }}>Point</th>
                <th style={{ padding: '5px 8px' }}>Machine XY</th>
                <th style={{ padding: '5px 8px' }}>Dispense Z</th>
              </tr>
            </thead>
            <tbody>{mesh.map(probePointRow)}</tbody>
          </table>

          {/* Manual: live Z + Save button */}
          {probeMode === 'manual' && manualIdx >= 0 && (
            <div style={{ background: '#1a1100', border: '1px solid #443300',
              borderRadius: 6, padding: 12, marginBottom: 10 }}>
              <div style={{ fontSize: '0.85em', color: '#ffaa00', marginBottom: 8 }}>
                {manualStatus}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.9em', marginBottom: 10 }}>
                Current Z: <strong style={{ color: '#fff' }}>
                  {machinePosition.z?.toFixed(3)}
                </strong>
                <span style={{ color: '#666', marginLeft: 8 }}>
                  → will save as {(machinePosition.z + dispensingGap).toFixed(3)} mm
                  (+{dispensingGap} mm gap)
                </span>
              </div>
              <InlineJog onSend={send} disabled={!isConnected} />
              <Btn onClick={saveManualZ} style={{ marginTop: 10, width: '100%' }}>
                💾 Save Z & Move to Next Point
              </Btn>
            </div>
          )}

          <Btn onClick={abortFlow} color="#c0392b" textColor="#fff" style={{ width: '100%' }}>
            ■ Abort Probing
          </Btn>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          FLOW: DONE
      ════════════════════════════════════════════════════════════════════════ */}
      {flowStep === FLOW.DONE && (
        <div>
          <div style={{ background: '#0d3320', border: '1px solid #00c49a',
            borderRadius: 8, padding: 14, marginBottom: 14, textAlign: 'center' }}>
            <div style={{ fontSize: '2em', marginBottom: 6 }}>✅</div>
            <h4 style={{ color: '#00c49a', margin: '0 0 6px 0' }}>PCB Leveling Complete</h4>
            <p style={{ fontSize: '0.85em', color: '#aaa', margin: 0 }}>
              {calibratedCount} points probed.
              {zRange && ` PCB warp: ${zRange} mm.`}
              {' '}Z-compensation is now active — the nozzle height will auto-adjust
              across the board during dispensing.
            </p>
          </div>

          {/* Final mesh table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85em',
            background: '#1a1a1a', borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
            <thead>
              <tr style={{ color: '#555', textAlign: 'left', borderBottom: '1px solid #2a2a2a', background: '#111' }}>
                <th style={{ padding: '5px 8px' }}>Point</th>
                <th style={{ padding: '5px 8px' }}>Machine XY</th>
                <th style={{ padding: '5px 8px' }}>Dispense Z</th>
              </tr>
            </thead>
            <tbody>{mesh.map(probePointRow)}</tbody>
          </table>

          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={() => setFlowStep(FLOW.IDLE)} color="#1565c0" textColor="#fff" style={{ flex: 1 }}>
              ← Back to Settings
            </Btn>
            <Btn onClick={resetFlow} color="#2a1010" textColor="#c0392b" style={{ flex: 1 }}>
              🗑 Clear & Re-calibrate
            </Btn>
          </div>
        </div>
      )}

      {/* ── How it works note (always visible at bottom) ── */}
      {flowStep === FLOW.IDLE && (
        <div style={{ marginTop: 14, padding: 10, background: '#0d1926',
          border: '1px solid #1a3050', borderRadius: 6, fontSize: '0.76em', color: '#5588aa',
          lineHeight: 1.6 }}>
          <strong>How it works:</strong> You jog the nozzle to the PCB bottom-left corner once to
          anchor the coordinate system. The machine then automatically drives to all 5 points
          on the PCB surface (4 corners + centre), probes the Z height at each, and builds an
          interpolation mesh. During dispensing, <code style={{ background: '#111', padding: '1px 4px',
          borderRadius: 3 }}>getZOffsetForPoint(x,y)</code> returns the correct Z for any pad location.
          {probeMode === 'auto' && (
            <><br /><br />
            <strong>Serial bridge required in SerialPanel.jsx <code>onData</code>:</strong>
            <pre style={{ background: '#111', padding: 6, borderRadius: 3, marginTop: 4,
              whiteSpace: 'pre-wrap', color: '#adf', fontSize: '0.95em' }}>{`if (line.includes('z_min:')) {
  const hit = /z_min:\\s*TRIGGERED/i.test(line);
  window.dispatchEvent(new CustomEvent(
    hit ? 'endstop-z-probe-triggered'
        : 'endstop-z-probe-open'
  ));
}`}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}