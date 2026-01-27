import { useEffect, useRef, useMemo, useState } from "react";
import { applyTransform } from "../lib/utils/transform2d";
import "./LinearMovePanel.css";

export default function LinearMovePanel({
  homeDesign,
  focusDesign,
  xf,
  applyXf,
  components = [],
  axisLetter = "A",
  collisionDetector,
  maintenanceManager,
  pressureController,
  pressureSettings,
  speedProfileManager,
  speedSettings
}) {
  const toMachine = (pt) => {
    if (!pt) return null;
    return applyXf && xf ? applyTransform(xf, pt) : { ...pt };
  };
  const fmt = (n, d = 3) => (isFinite(n) ? n.toFixed(d) : "");

  const [A, setA] = useState({ x: 10, y: 20, z: 5 });
  const [B, setB] = useState({ x: 85, y: 40, z: 5 });
  const [zsafe, setZsafe] = useState(6);
  const [zwork, setZwork] = useState(0.4);

  const [Vx, setVx] = useState(200);
  const [Vy, setVy] = useState(150);
  const [Ax, setAx] = useState(1500);
  const [Ay, setAy] = useState(1200);
  const [Vz, setVz] = useState(50);
  const [Az, setAz] = useState(500);

  const [algo, setAlgo] = useState("linear");
  const [ddaStep, setDdaStep] = useState(0.5);
  const [rotDeg, setRotDeg] = useState(0);

  const [valveOn, setValveOn] = useState("M106 S255");
  const [valveOff, setValveOff] = useState("M107");
  const [dwellMs, setDwellMs] = useState(120);

  const [previewPts, setPreviewPts] = useState([])
  const [gcode, setGcode] = useState("");
  const [collisionWarnings, setCollisionWarnings] = useState([]);
  const [maintenanceStatus, setMaintenanceStatus] = useState(null);
  const svgRef = useRef(null);

  const useHomeForA = () => homeDesign && setA((s) => ({ ...s, ...toMachine(homeDesign) }))
  const useFocusForB = () => focusDesign && setB((s) => ({ ...s, ...toMachine(focusDesign) }))
  const useHomeForB = () => homeDesign && setB((s) => ({ ...s, ...toMachine(homeDesign) }))
  const useFocusForA = () => focusDesign && setA((s) => ({ ...s, ...toMachine(focusDesign) }))

  useEffect(() => {
    if (homeDesign) setA((s) => ({ ...s, ...toMachine(homeDesign) }));
    if (focusDesign) setB((s) => ({ ...s, ...toMachine(focusDesign) }));

    // Update collision detector
    if (collisionDetector) {
      collisionDetector.updateComponents(components);
    }

    // Update maintenance status
    if (maintenanceManager) {
      setMaintenanceStatus(maintenanceManager.getMaintenanceStatus());
    }
  }, [homeDesign, focusDesign, applyXf, xf, components, collisionDetector, maintenanceManager]);

  function capLineSpeed(dirx, diry) {
    const ux = Math.abs(dirx) < 1e-9 ? 1e-9 : Math.abs(dirx);
    const uy = Math.abs(diry) < 1e-9 ? 1e-9 : Math.abs(diry);
    const vmax = Math.min(Vx / ux, Vy / uy);
    const amax = Math.min(Ax / ux, Ay / uy);
    return { vmax, amax };
  }

  function planSegments(a, b) {
    const pts = [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) {
      return [{ x: b.x, y: b.y }];
    }
    const ux = dx / L, uy = dy / L;
    const { vmax } = capLineSpeed(ux, uy);

    if (algo === "linear") {
      pts.push({ x: b.x, y: b.y, feed: vmax * 60 });
    } else if (algo === "axis") {
      const xm = { x: b.x, y: a.y };
      const dx1 = xm.x - a.x, dy1 = xm.y - a.y;
      const L1 = Math.hypot(dx1, dy1) || 1;
      const ux1 = dx1 / L1, uy1 = dy1 / L1;
      const { vmax: v1 } = capLineSpeed(ux1, uy1);

      const dx2 = b.x - xm.x, dy2 = b.y - xm.y;
      const L2 = Math.hypot(dx2, dy2) || 1;
      const ux2 = dx2 / L2, uy2 = dy2 / L2;
      const { vmax: v2 } = capLineSpeed(ux2, uy2);

      pts.push({ x: xm.x, y: xm.y, feed: v1 * 60 });
      pts.push({ x: b.x, y: b.y, feed: v2 * 60 });
    } else if (algo === "dda") {
      const step = Math.max(0.05, ddaStep);
      const n = Math.ceil(L / step);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        pts.push({ x: a.x + dx * t, y: a.y + dy * t, feed: Math.min(Vx, Vy) * 60 });
      }
    } else {
      pts.push({ x: b.x, y: b.y, feed: Math.min(Vx, Vy) * 60 });
    }
    return pts;
  }

  function buildGcode(a, b, segs) {
    const g = [];
    g.push("; --- linearMovePanel (valve actuator) ---");
    g.push("G21");
    g.push("G90");
    
    // Add pressure control setup
    if (pressureController && pressureSettings) {
      const padSize = { width: 1, height: 1 }; // Default pad size
      const pressure = pressureSettings.viscosity === 'custom' 
        ? pressureSettings.customPressure
        : pressureController.calculatePressure(padSize, pressureSettings.viscosity);
      
      const pressureGcode = pressureController.generatePressureGcode(pressure, pressureSettings.viscosity);
      g.push(...pressureGcode);
    }

    // Check for collisions and generate safe path if needed
    let safePath = segs;
    if (collisionDetector) {
      const collisions = collisionDetector.checkPath(a, b, zwork);
      if (collisions.length > 0) {
        setCollisionWarnings(collisions);
        safePath = collisionDetector.generateSafePath(a, b).slice(1); // Remove first point
      } else {
        setCollisionWarnings([]);
      }
    }

    g.push(`G0 Z${fmt(Math.max(zsafe, a.z ?? zsafe))}`);
    g.push(`G0 X${fmt(a.x)} Y${fmt(a.y)}`);
    if (isFinite(rotDeg) && rotDeg !== 0) g.push(`G0 ${axisLetter}${fmt(rotDeg, 2)}`);
    g.push(`G1 Z${fmt(zwork)} F${fmt(Vz * 60, 0)}`);
    g.push("; pick");
    g.push(`G1 Z${fmt(zsafe)} F${fmt(Vz * 60, 0)}`);

    for (const p of safePath) {
      const z = p.z !== undefined ? p.z : (collisionWarnings.length > 0 ? zsafe : zwork);
      g.push(`G1 X${fmt(p.x)} Y${fmt(p.y)} Z${fmt(z)} F${fmt(p.feed || Math.min(Vx, Vy) * 60, 0)}`);
    }
    if (isFinite(rotDeg) && rotDeg !== 0) g.push(`G0 ${axisLetter}${fmt(rotDeg, 2)}`);

    g.push(`G1 Z${fmt(zwork)} F${fmt(Vz * 60, 0)}`);
    g.push(valveOn);
    
    // Use pressure-adjusted dwell time and speed profiles
    let adjustedDwellMs = dwellMs;
    let feedXY = Math.min(Vx, Vy) * 60;
    
    if (pressureController && pressureSettings) {
      const padSize = { width: 1, height: 1 };
      adjustedDwellMs = pressureSettings.viscosity === 'custom'
        ? pressureSettings.customDwellTime
        : pressureController.calculateDwellTime(padSize, pressureSettings.viscosity);
    }
    
    // Apply speed profile if enabled
    if (speedProfileManager && speedSettings?.autoAdjust) {
      const padSize = { width: 1, height: 1 };
      const speedProfile = speedProfileManager.calculateOptimalSpeeds(padSize, pressureSettings?.viscosity);
      feedXY = speedProfile.speeds.dispense * (speedSettings.globalMultiplier || 1.0);
      
      const speedGcode = speedProfileManager.generateSpeedGcode(speedProfile.speeds, "Speed profile for current pad");
      g.push(...speedGcode);
    }
    
    g.push(`G4 P${Math.max(0, Math.round(adjustedDwellMs))}`);
    g.push(valveOff);
    g.push(`G1 Z${fmt(zsafe)} F${fmt(Vz * 60, 0)}`);

    return g.join("\n");
  }

  function flattenPads() {
    const out = [];
    components.forEach((c) => (c.pads || []).forEach((p) => out.push({ x: p.x, y: p.y })));
    return out;
  }

  function exportJob() {
    const pads = flattenPads();
    if (!pads.length) return alert("No pads found in the top paste layer.");

    const ptA = toMachine(homeDesign) || toMachine(pads[0]);
    if (!ptA) return alert("No HOME and no pads to start from.");

    const feedXY = Math.min(Vx, Vy) * 60;
    const g = [];
    g.push("; --- Pad dispensing job (valve) ---");
    g.push("; Coordinate transformation applied: " + (applyXf && xf ? "YES" : "NO"));
    g.push("G21");
    g.push("G90");
    g.push(`G0 Z${fmt(zsafe)}`);
    g.push(`G0 X${fmt(ptA.x)} Y${fmt(ptA.y)}`);

    for (const dPad of pads) {
      const mPad = toMachine(dPad);
      if (!mPad) continue;
      
      // Calculate pressure, dwell time, and speeds for this specific pad
      let padPressure = 25; // default
      let padDwellTime = dwellMs;
      let padFeedXY = feedXY;
      
      const padSize = { width: dPad.width || 1, height: dPad.height || 1 };
      
      if (pressureController && pressureSettings) {
        if (pressureSettings.viscosity === 'custom') {
          padPressure = pressureSettings.customPressure;
          padDwellTime = pressureSettings.customDwellTime;
        } else {
          padPressure = pressureController.calculatePressure(padSize, pressureSettings.viscosity);
          padDwellTime = pressureController.calculateDwellTime(padSize, pressureSettings.viscosity);
        }
        
        // Add pressure adjustment for this pad
        const pressureGcode = pressureController.generatePressureGcode(padPressure, pressureSettings.viscosity);
        g.push(...pressureGcode);
      }
      
      // Apply speed profile for this pad
      if (speedProfileManager && speedSettings?.autoAdjust) {
        const speedProfile = speedProfileManager.calculateOptimalSpeeds(padSize, pressureSettings?.viscosity);
        padFeedXY = speedProfile.speeds.dispense * (speedSettings.globalMultiplier || 1.0);
        
        const speedGcode = speedProfileManager.generateSpeedGcode(speedProfile.speeds, `Speed profile for pad ${dPad.id || 'unknown'}`);
        g.push(...speedGcode);
      }
      
      g.push(`G1 X${fmt(mPad.x)} Y${fmt(mPad.y)} F${fmt(padFeedXY, 0)}`);
      if (isFinite(rotDeg) && rotDeg !== 0) g.push(`G0 ${axisLetter}${fmt(rotDeg, 2)}`);
      g.push(`G1 Z${fmt(zwork)} F${fmt(Vz * 60, 0)}`);
      g.push(valveOn);
      g.push(`G4 P${Math.max(0, Math.round(padDwellTime))}`);
      g.push(valveOff);
      g.push(`G1 Z${fmt(zsafe)} F${fmt(Vz * 60, 0)}`);
    }

    const blob = new Blob([g.join("\n") + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dispense_job.gcode";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function plan() {
    const a = { ...A }, b = { ...B };
    const segs = planSegments(a, b);
    setPreviewPts([{ x: a.x, y: a.y }, ...segs.map(s => ({ x: s.x, y: s.y }))]);
    setGcode(buildGcode(a, b, segs));
  }

  async function send() {
    if (!gcode) plan();
    const lines = (gcode || "").split("\n").filter(Boolean);

    // Record dispense for maintenance tracking
    if (maintenanceManager) {
      maintenanceManager.recordDispense();
    }

    const sendLine = async (ln) => {
      if (window?.electronSerial?.writeLine) return window.electronSerial.writeLine(ln + "\n");
      if (window?.serial?.writeLine) return window.serial.writeLine(ln + "\n");
      console.log(ln);
    };
    for (const ln of lines) await sendLine(ln);
    if (!window?.electronSerial?.writeLine && !window?.serial?.writeLine) {
      alert("No serial connection detected. G-code printed to console.");
    }
  }

  const bbox = useMemo(() => {
    const pts = previewPts.length ? previewPts : [A, B];
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    const minY = Math.min(...pts.map(p => p.y));
    const maxY = Math.max(...pts.map(p => p.y));
    return { minX, minY, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }, [previewPts, A, B]);

  function project(p) {
    const pad = 10;
    const W = 220, H = 180;
    const sx = (W - pad * 2) / bbox.w;
    const sy = (H - pad * 2) / bbox.h;
    const s = Math.min(sx, sy);
    const x = pad + (p.x - bbox.minX) * s;
    const y = pad + (bbox.maxY - p.y) * s;
    return { x, y };
  }

  return (
    <div className="panel linear-panel">
      <h3>Pick → Place Planner (XY + Zsafe/Zwork)</h3>
      
      <div className="params-row">
        <fieldset className="box">
          <legend>Point A (mm)</legend>
          <div className="grid2">
            <label>
              X Position
              <input type="number" value={A.x} onChange={e => setA({ ...A, x: +e.target.value })} />
            </label>
            <label>
              Y Position
              <input type="number" value={A.y} onChange={e => setA({ ...A, y: +e.target.value })} />
            </label>
          </div>
          <label>
            Z Position
            <input type="number" value={A.z} onChange={e => setA({ ...A, z: +e.target.value })} />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn sm" onClick={useHomeForA}>Use HOME</button>
            <button className="btn sm" onClick={useFocusForA}>Use Focus</button>
          </div>
        </fieldset>

        <fieldset className="box">
          <legend>Point B (mm)</legend>
          <div className="grid2">
            <label>
              X Position
              <input type="number" value={B.x} onChange={e => setB({ ...B, x: +e.target.value })} />
            </label>
            <label>
              Y Position
              <input type="number" value={B.y} onChange={e => setB({ ...B, y: +e.target.value })} />
            </label>
          </div>
          <label>
            Z Position
            <input type="number" value={B.z} onChange={e => setB({ ...B, z: +e.target.value })} />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn sm" onClick={useFocusForB}>Use Focus</button>
            <button className="btn sm" onClick={useHomeForB}>Use HOME</button>
          </div>
        </fieldset>

        <fieldset className="box faint">
          <legend>Motion Limits</legend>
          <div className="grid2">
            <label>Vx (mm/s) <input type="number" value={Vx} onChange={e => setVx(+e.target.value)} /></label>
            <label>Vy (mm/s) <input type="number" value={Vy} onChange={e => setVy(+e.target.value)} /></label>
            <label>Ax (mm/s²) <input type="number" value={Ax} onChange={e => setAx(+e.target.value)} /></label>
            <label>Ay (mm/s²) <input type="number" value={Ay} onChange={e => setAy(+e.target.value)} /></label>
            <label>Vz (mm/s) <input type="number" value={Vz} onChange={e => setVz(+e.target.value)} /></label>
            <label>Az (mm/s²) <input type="number" value={Az} onChange={e => setAz(+e.target.value)} /></label>
          </div>
        </fieldset>
      </div>

      {/* Configuration row */}
      <div className="params-row">
        <fieldset className="box">
          <legend>Heights</legend>
          <div className="grid2">
            <label>
              Safe Height (Zsafe)
              <input type="number" step="0.1" value={zsafe} onChange={e => setZsafe(+e.target.value)} />
            </label>
            <label>
              Work Height (Zwork)
              <input type="number" step="0.05" value={zwork} onChange={e => setZwork(+e.target.value)} />
            </label>
          </div>
        </fieldset>

        <fieldset className="box">
          <legend>Algorithm</legend>
          <label>
            Path Type
            <select value={algo} onChange={e => setAlgo(e.target.value)}>
              <option value="linear">Linear (diagonal)</option>
              <option value="axis">Axis-sequential (X → Y)</option>
              <option value="blended">Blended (S-curve approx)</option>
              <option value="dda">DDA staircase</option>
            </select>
          </label>
          {algo === "dda" && (
            <label style={{ marginTop: 8 }}>
              DDA Step (mm)
              <input type="number" step="0.1" value={ddaStep} onChange={e => setDdaStep(+e.target.value)} />
            </label>
          )}
        </fieldset>

        <fieldset className="box">
          <legend>Rotation</legend>
          <label>
            {axisLetter} Axis (degrees)
            <input type="number" step="0.1" value={rotDeg} onChange={e => setRotDeg(+e.target.value)} />
          </label>
        </fieldset>

        <fieldset className="box">
          <legend>Valve Control</legend>
          <label>
            ON G-code
            <input type="text" value={valveOn} onChange={e => setValveOn(e.target.value)} />
          </label>
          <label>
            OFF G-code
            <input type="text" value={valveOff} onChange={e => setValveOff(e.target.value)} />
          </label>
          <label>
            Dwell Time (ms)
            <input type="number" value={dwellMs} onChange={e => setDwellMs(+e.target.value || 0)} />
          </label>
          <small style={{ marginTop: 4, display: 'block' }}>
            Marlin: <code>M106 S255</code>/<code>M107</code> | GRBL: <code>M3</code>/<code>M5</code>
          </small>
        </fieldset>
      </div>

      {/* Action buttons */}
      <div className="controls">
        <button className="btn" onClick={plan}>Plan</button>
        <button className="btn" onClick={send}>Send</button>
        <button className="btn secondary" onClick={exportJob} disabled={!components?.length}>
          Export Job (all pads)
        </button>
      </div>

      {/* Status messages */}
      {collisionWarnings.length > 0 && (
        <div className="collision-warning">
          <strong>⚠️ Collision Warning:</strong> {collisionWarnings.length} potential collision(s) detected. Safe path will be used.
        </div>
      )}

      {maintenanceStatus && (
        <div className={`maintenance-status ${maintenanceStatus.needsCleaning ? 'warning' : ''}`}>
          <strong>🔧 Maintenance:</strong> {maintenanceStatus.dispenseCount} dispenses, {maintenanceStatus.hoursRemaining.toFixed(1)}h remaining
          {maintenanceStatus.needsCleaning && <span style={{ color: '#dc3545', marginLeft: 8 }}>CLEANING REQUIRED</span>}
        </div>
      )}

      {/* Preview and G-code section */}
      <div className="preview-section">
        <div className="box preview-box">
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Preview (XY)</div>
          <svg ref={svgRef} width="220" height="180" className="preview-canvas">
            <rect x="0" y="0" width="220" height="180" rx="8" ry="8" fill="#0b0b0b" />
            <line x1="10" y1="170" x2="210" y2="170" stroke="#333" strokeWidth="1" />
            <line x1="10" y1="10" x2="10" y2="170" stroke="#333" strokeWidth="1" />
            <circle cx={project(A).x} cy={project(A).y} r="3.5" fill="#4ade80" />
            {previewPts.length > 1 && (
              <polyline
                fill="none"
                stroke="#ffd400"
                strokeWidth="2"
                points={previewPts.map(p => {
                  const q = project(p); 
                  return `${q.x},${q.y}`;
                }).join(" ")} 
              />
            )}
            <circle cx={project(B).x} cy={project(B).y} r="3.5" fill="#ef4444" />
          </svg>
        </div>

        <div className="box gcode-box">
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Generated G-code</div>
          <pre style={{ 
            background: '#ffffff', 
            border: '1px solid #dee2e6', 
            borderRadius: 4, 
            padding: 8, 
            fontFamily: "'Courier New', monospace", 
            fontSize: 11,
            maxHeight: 200, 
            overflowY: 'auto', 
            margin: 0,
            lineHeight: 1.4
          }}>
            {gcode || "Click 'Plan' to generate G-code"}
          </pre>
        </div>
      </div>
    </div>
  );
}