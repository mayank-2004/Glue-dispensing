import { useState } from "react";
import { FUME_STATUS } from "../hooks/useFumeManager.js";
import "./FumePanel.css";

function formatTimeOnly(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  } catch { return iso; }
}

export default function FumePanel({ fumeManager }) {
  if (!fumeManager) return <div className="panel"><p>Fume extraction manager not available.</p></div>;

  const {
    status, operatingHours, airflowLpm, pumpLoadPct,
    postRunDurationSec, serviceThresholdHours, minAirflowThreshold, eventLog,
    startExtraction, stopExtraction, resetFault, markFilterReplaced, setConfig,
  } = fumeManager;

  const [isAdmin, setIsAdmin] = useState(false); // Simulate admin toggle for config

  const filterLifePct = Math.max(0, 100 - (operatingHours / serviceThresholdHours) * 100);
  const filterClass = filterLifePct > 20 ? "good" : filterLifePct > 0 ? "warn" : "danger";

  return (
    <div className="panel fume-panel">
      {/* ── Status Bar ── */}
      <div className="fume-status-bar">
        <div className="fume-status-item">
          <div className="fume-label">System Status</div>
          <span className={`fume-badge ${status}`}>
            {status === FUME_STATUS.RUNNING && "🟢 "}
            {status === FUME_STATUS.POST_RUN && "⏱ "}
            {status === FUME_STATUS.FAULT && "❌ "}
            {status === FUME_STATUS.SERVICE_REQUIRED && "⚠ "}
            {status.replace("_", " ")}
          </span>
        </div>

        <div className="fume-status-item" style={{ flex: 1, minWidth: 200, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
          <button className="btn sm secondary" onClick={startExtraction} disabled={status === FUME_STATUS.RUNNING || status === FUME_STATUS.FAULT}>Manual Start</button>
          <button className="btn sm secondary" onClick={stopExtraction} disabled={status === FUME_STATUS.READY || status === FUME_STATUS.FAULT}>Stop</button>
          {status === FUME_STATUS.FAULT && <button className="btn sm primary" onClick={resetFault}>Reset Fault</button>}
        </div>
      </div>

      {/* ── Warnings ── */}
      {status === FUME_STATUS.FAULT && (
        <div style={{ padding: "12px", background: "rgba(220,53,69,0.15)", border: "1px solid #dc3545", borderRadius: 4, color: "#ff7b72", fontSize: "0.9em" }}>
          <strong>⛔ Critical Fume Extraction Fault</strong> — Safe soldering operations are blocked until the issue is resolved and reset.
        </div>
      )}
      {status === FUME_STATUS.SERVICE_REQUIRED && (
        <div style={{ padding: "12px", background: "rgba(255,193,7,0.1)", border: "1px solid #ffc107", borderRadius: 4, color: "#c69500", fontSize: "0.9em", display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
             <strong>⚠ HEPA Filter Service Required</strong> — The filter has exceeded its operational lifespan threshold ({serviceThresholdHours} hours).
          </div>
          <button className="btn sm" style={{ background: '#ffc107', color: '#000', border: 'none' }} onClick={markFilterReplaced}>Log Filter Replacement</button>
        </div>
      )}

      {/* ── Metrics ── */}
      <div className="fume-metrics-grid">
        <div className="fume-metric-card">
          <div className="fume-label">HEPA Filter Life</div>
          <div className="fume-metric-val">{filterLifePct.toFixed(1)}<span className="fume-metric-unit">%</span></div>
          <div className="filter-bar-wrap"><div className={`filter-bar-fill ${filterClass}`} style={{ width: `${filterLifePct}%` }} /></div>
          <div className="fume-metric-sub">{operatingHours.toFixed(1)} / {serviceThresholdHours} hours used</div>
        </div>
        <div className="fume-metric-card">
          <div className="fume-label">Live Airflow</div>
          <div className="fume-metric-val" style={{ color: airflowLpm > 0 && airflowLpm < minAirflowThreshold ? '#ffc107' : 'inherit' }}>
            {airflowLpm.toFixed(1)}<span className="fume-metric-unit">LPM</span>
          </div>
          <div className="fume-metric-sub">{airflowLpm < minAirflowThreshold ? 'Below minimum threshold' : 'Nominal extraction'}</div>
        </div>
        <div className="fume-metric-card">
          <div className="fume-label">Vacuum Pump Load</div>
          <div className="fume-metric-val">{pumpLoadPct.toFixed(0)}<span className="fume-metric-unit">%</span></div>
          <div className="fume-metric-sub">24V DC Extractor Motor</div>
        </div>
      </div>

      {/* ── Settings ── */}
      <div className="fume-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h4 style={{ margin: 0 }}>System Configuration</h4>
          <label style={{ fontSize: '0.8em', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={isAdmin} onChange={e => setIsAdmin(e.target.checked)} /> Unlock Settings
          </label>
        </div>
        <div className="fume-config-grid" style={{ opacity: isAdmin ? 1 : 0.5, pointerEvents: isAdmin ? 'auto' : 'none' }}>
           <div className="fume-config-item">
             <label>Post-Run Duration (seconds)</label>
             <input type="number" min="0" max="300" value={postRunDurationSec} onChange={e => setConfig("postRunDurationSec", Number(e.target.value))} />
           </div>
           <div className="fume-config-item">
             <label>Service Threshold (hours)</label>
             <input type="number" min="10" max="2000" value={serviceThresholdHours} onChange={e => setConfig("serviceThresholdHours", Number(e.target.value))} />
           </div>
           <div className="fume-config-item">
             <label>Min Airflow Alert (LPM)</label>
             <input type="number" min="0" max="100" value={minAirflowThreshold} onChange={e => setConfig("minAirflowThreshold", Number(e.target.value))} />
           </div>
        </div>
      </div>

      {/* ── Event Log ── */}
      <div className="fume-section" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <h4>Extraction Event Log</h4>
        <div className="fume-log-container">
          {eventLog.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.9em', padding: 8 }}>No events logged yet.</div>}
          {eventLog.map((ev, i) => (
            <div key={i} className="fume-log-item">
              <div className="fume-log-time">{formatTimeOnly(ev.time)}</div>
              <div className={`fume-log-type ${ev.type}`}>{ev.type}</div>
              <div className="fume-log-detail">{ev.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
