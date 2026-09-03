import { useState } from "react";
import { ROTATION_STATUS } from "../hooks/useTipRotationManager.js";
import "./TipRotationPanel.css";

const QUICK_ANGLES = [0, 30, 45, 90, 135, 180];

function fmtTime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
  catch { return iso; }
}

/** Converts a 0-180 angle to SVG arc path coordinates on a semicircle. */
function AngleArc({ currentAngle, targetAngle, size = 180 }) {
  const cx = size / 2, cy = size - 20, r = size / 2 - 16;

  function polarToXY(angleDeg) {
    const rad = (180 - angleDeg) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
  }

  const startPt = { x: cx - r, y: cy };
  const endPt   = { x: cx + r, y: cy };

  const tgtPt = polarToXY(targetAngle ?? 0);
  const curPt = currentAngle != null ? polarToXY(currentAngle) : null;

  const tgtRad = (180 - (targetAngle ?? 0)) * (Math.PI / 180);
  const curRad = currentAngle != null ? (180 - currentAngle) * (Math.PI / 180) : null;

  return (
    <svg width={size} height={size / 2 + 16} className="tiprotate-arc-svg" viewBox={`0 0 ${size} ${size / 2 + 16}`}>
      {/* Track */}
      <path d={`M${startPt.x},${startPt.y} A${r},${r} 0 0,1 ${endPt.x},${endPt.y}`} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="8" strokeLinecap="round" />
      {/* Target arc fill */}
      {targetAngle != null && (
        <path
          d={`M${startPt.x},${startPt.y} A${r},${r} 0 0,1 ${tgtPt.x},${tgtPt.y}`}
          fill="none" stroke="rgba(88,166,255,0.5)" strokeWidth="8" strokeLinecap="round"
        />
      )}
      {/* Labels */}
      <text x={cx - r - 4} y={cy + 16} textAnchor="middle" fill="#8b949e" fontSize="11">0°</text>
      <text x={cx}       y={cy + 18} textAnchor="middle" fill="#8b949e" fontSize="11">90°</text>
      <text x={cx + r + 4} y={cy + 16} textAnchor="middle" fill="#8b949e" fontSize="11">180°</text>
      {/* Target needle */}
      <line x1={cx} y1={cy} x2={cx + (r - 10) * Math.cos(tgtRad)} y2={cy - (r - 10) * Math.sin(tgtRad)} stroke="#58a6ff" strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round" />
      <circle cx={tgtPt.x} cy={tgtPt.y} r="6" fill="#58a6ff" opacity="0.7" />
      {/* Current position needle (solid) */}
      {curPt && curRad != null && (
        <>
          <line x1={cx} y1={cy} x2={cx + (r - 6) * Math.cos(curRad)} y2={cy - (r - 6) * Math.sin(curRad)} stroke="#28a745" strokeWidth="3" strokeLinecap="round" />
          <circle cx={curPt.x} cy={curPt.y} r="7" fill="#28a745" />
        </>
      )}
      {/* Pivot */}
      <circle cx={cx} cy={cy} r="6" fill="var(--bg-tertiary)" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
    </svg>
  );
}

export default function TipRotationPanel({ tipRotationManager }) {
  if (!tipRotationManager) return <div className="panel"><p>Tip rotation manager not available.</p></div>;

  const {
    status, currentAngle, targetAngle, isHomed, lastFaultMessage, defaultSolderAngle, stepDegree, eventLog,
    rotateTo, home, resetFault, setConfig,
  } = tipRotationManager;

  const [sliderAngle, setSliderAngle] = useState(targetAngle ?? 0);
  const [isAdmin, setIsAdmin] = useState(false);
  const isBusy = status === ROTATION_STATUS.ROTATING || status === ROTATION_STATUS.HOMING;

  return (
    <div className="panel tiprotate-panel">

      {/* ── Status Bar ── */}
      <div className="tiprotate-status-bar">
        <div className="tiprotate-status-item">
          <div className="tiprotate-label">Rotation Status</div>
          <span className={`tiprotate-badge ${status}`}>
            {status === "IDLE"           && "⚙ "}
            {status === "HOMING"         && "🔄 "}
            {status === "ROTATING"       && "🌀 "}
            {status === "TARGET_REACHED" && "✅ "}
            {status === "FAULT"          && "❌ "}
            {status.replace("_", " ")}
          </span>
        </div>
        <div className="tiprotate-status-item">
          <div className="tiprotate-label">Home Status</div>
          <span style={{ fontSize: "0.95em", fontWeight: 700, color: isHomed ? "#28a745" : "#ffc107" }}>
            {isHomed ? "✔ Homed" : "⚠ Not Homed"}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={home} disabled={isBusy}>
          {status === ROTATION_STATUS.HOMING ? "Homing..." : "Home Rotation"}
        </button>
        {status === ROTATION_STATUS.FAULT && (
          <button className="btn sm danger" onClick={resetFault}>Reset Fault</button>
        )}
      </div>

      {/* ── Fault Banner ── */}
      {status === ROTATION_STATUS.FAULT && (
        <div style={{ padding: "10px 14px", background: "rgba(220,53,69,0.12)", border: "1px solid #dc3545", borderRadius: 4, color: "#ff7b72", fontSize: "0.9em" }}>
          <strong>⛔ Rotation Fault</strong>{lastFaultMessage ? ` — ${lastFaultMessage}` : ""}. Check stepper driver and wiring, then reset.
        </div>
      )}
      {!isHomed && status !== ROTATION_STATUS.HOMING && (
        <div style={{ padding: "10px 14px", background: "rgba(255,193,7,0.1)", border: "1px solid #ffc107", borderRadius: 4, color: "#c69500", fontSize: "0.9em" }}>
          <strong>⚠ Not Homed</strong> — Tip rotation position is unknown. Click <em>Home Rotation</em> to establish the 0° reference.
        </div>
      )}

      {/* ── Arc Visualizer ── */}
      <div className="tiprotate-arc-container">
        <AngleArc currentAngle={currentAngle} targetAngle={sliderAngle} size={200} />
        <div className="tiprotate-angle-readouts">
          <div className="tiprotate-angle-block">
            <div className="tiprotate-label">Current Angle</div>
            <div className="tiprotate-angle-val">
              {currentAngle != null ? currentAngle.toFixed(1) : "--"}<span>°</span>
            </div>
            <div className="tiprotate-angle-sub">🟢 Actual (encoder feedback)</div>
          </div>
          <div className="tiprotate-angle-block">
            <div className="tiprotate-label">Target Angle</div>
            <div className="tiprotate-angle-val" style={{ color: "#58a6ff" }}>
              {sliderAngle.toFixed(1)}<span>°</span>
            </div>
            <div className="tiprotate-angle-sub">🔵 Commanded</div>
          </div>
        </div>
      </div>

      {/* ── Manual Controls ── */}
      <div className="tiprotate-controls">
        <h4>Manual Rotation Control</h4>
        <div className="tiprotate-slider-row">
          <span style={{ fontSize: "0.85em", color: "var(--text-secondary)" }}>0°</span>
          <input
            type="range" min="0" max="180" step={stepDegree}
            value={sliderAngle}
            onChange={e => setSliderAngle(Number(e.target.value))}
            disabled={isBusy || !isHomed}
          />
          <span style={{ fontSize: "0.85em", color: "var(--text-secondary)" }}>180°</span>
          <div className="tiprotate-slider-num">{sliderAngle.toFixed(1)}°</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn sm primary" onClick={() => rotateTo(sliderAngle, "Manual Operator")} disabled={isBusy || !isHomed}>
            {status === ROTATION_STATUS.ROTATING ? "Rotating..." : "Go to Angle"}
          </button>
          <div className="tiprotate-quick-btns">
            {QUICK_ANGLES.map(a => (
              <button key={a} onClick={() => { setSliderAngle(a); rotateTo(a, `Quick preset ${a}°`); }} disabled={isBusy || !isHomed}>
                {a}°
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Configuration ── */}
      <div className="tiprotate-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h4 style={{ margin: 0 }}>Recipe & Calibration Settings</h4>
          <label style={{ fontSize: "0.8em", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={isAdmin} onChange={e => setIsAdmin(e.target.checked)} /> Unlock Settings
          </label>
        </div>
        <div className="tiprotate-config-grid" style={{ opacity: isAdmin ? 1 : 0.5, pointerEvents: isAdmin ? "auto" : "none" }}>
          <div className="tiprotate-config-item">
            <label>Default Solder Angle (°)</label>
            <input type="number" min="0" max="180" value={defaultSolderAngle}
              onChange={e => setConfig("defaultSolderAngle", Number(e.target.value))} />
          </div>
          <div className="tiprotate-config-item">
            <label>Stepper Resolution (°/step)</label>
            <input type="number" min="0.1" max="5" step="0.1" value={stepDegree}
              onChange={e => setConfig("stepDegree", Number(e.target.value))} />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="btn sm" disabled={isBusy || !isAdmin} onClick={() => {
            home().then(() => rotateTo(defaultSolderAngle, "Post-home calibration verify"));
          }}>
            🔧 Recalibrate (Home → Move to Default Angle)
          </button>
        </div>
      </div>

      {/* ── Event Log ── */}
      <div className="tiprotate-section" style={{ flex: 1 }}>
        <h4>Rotation Event Log</h4>
        <div className="tiprotate-log-container">
          {eventLog.length === 0 && <div style={{ color: "var(--text-secondary)", fontSize: "0.9em", padding: 8 }}>No events yet.</div>}
          {eventLog.map((ev, i) => (
            <div key={i} className="tiprotate-log-item">
              <div className="tiprotate-log-time">{fmtTime(ev.time)}</div>
              <div className={`tiprotate-log-type ${ev.type}`}>{ev.type}</div>
              <div className="tiprotate-log-detail">{ev.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
