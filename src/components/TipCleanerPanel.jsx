import { useState } from "react";
import { CLEANER_STATUS } from "../hooks/useTipCleanerManager.js";
import "./TipCleanerPanel.css";

function formatTimeOnly(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  } catch { return iso; }
}

export default function TipCleanerPanel({ tipCleanerManager }) {
  if (!tipCleanerManager) return <div className="panel"><p>Tip cleaner manager not available.</p></div>;

  const {
    status, padsSinceLastClean, totalCleans, lastCleanTime, cleanIntervalPads, eventLog,
    triggerClean, resetFault, setConfig,
  } = tipCleanerManager;

  const [isAdmin, setIsAdmin] = useState(false);

  const cleanProgressPct = Math.max(0, Math.min(100, (padsSinceLastClean / cleanIntervalPads) * 100));
  const cleanBarClass = cleanProgressPct < 50 ? "good" : cleanProgressPct < 90 ? "warn" : "danger";

  return (
    <div className="panel tipclean-panel">
      {/* ── Status Bar ── */}
      <div className="tipclean-status-bar">
        <div className="tipclean-status-item">
          <div className="tipclean-label">Mechanism Status</div>
          <span className={`tipclean-badge ${status}`}>
            {status === CLEANER_STATUS.IDLE && "💤 "}
            {status === CLEANER_STATUS.CLEANING && "🌀 "}
            {status === CLEANER_STATUS.FAULT && "❌ "}
            {status === CLEANER_STATUS.CLEANING_REQUIRED && "⚠ "}
            {status.replace("_", " ")}
          </span>
        </div>

        <div className="tipclean-status-item" style={{ flex: 1, minWidth: 200, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
          <button className="btn sm primary" onClick={() => triggerClean('Manual Operator Request')} disabled={status === CLEANER_STATUS.CLEANING || status === CLEANER_STATUS.FAULT}>
            {status === CLEANER_STATUS.CLEANING ? 'Cleaning...' : 'Start Clean Cycle'}
          </button>
          {status === CLEANER_STATUS.FAULT && <button className="btn sm danger" onClick={resetFault}>Reset Fault</button>}
        </div>
      </div>

      {/* ── Warnings ── */}
      {status === CLEANER_STATUS.FAULT && (
        <div style={{ padding: "12px", background: "rgba(220,53,69,0.15)", border: "1px solid #dc3545", borderRadius: 4, color: "#ff7b72", fontSize: "0.9em" }}>
          <strong>⛔ Tip Cleaner Fault</strong> — The mechanism reported an error. Please check the servo bucket and air jet, then reset.
        </div>
      )}
      {status === CLEANER_STATUS.CLEANING_REQUIRED && (
        <div style={{ padding: "12px", background: "rgba(255,193,7,0.1)", border: "1px solid #ffc107", borderRadius: 4, color: "#c69500", fontSize: "0.9em" }}>
          <strong>⚠ Cleaning Required</strong> — Interval threshold reached. Further dispensing jobs are prevented until a cleaning cycle is performed.
        </div>
      )}

      {/* ── Metrics ── */}
      <div className="tipclean-metrics-grid">
        <div className="tipclean-metric-card">
          <div className="tipclean-label">Interval Progress</div>
          <div className="tipclean-metric-val">{padsSinceLastClean}<span className="tipclean-metric-unit">/ {cleanIntervalPads} pads</span></div>
          <div className="clean-bar-wrap"><div className={`clean-bar-fill ${cleanBarClass}`} style={{ width: `${cleanProgressPct}%` }} /></div>
          <div className="tipclean-metric-sub">{cleanIntervalPads - padsSinceLastClean > 0 ? `${cleanIntervalPads - padsSinceLastClean} pads remaining` : 'Overdue!'}</div>
        </div>
        <div className="tipclean-metric-card">
          <div className="tipclean-label">Lifetime Cleans</div>
          <div className="tipclean-metric-val">{totalCleans}</div>
          <div className="tipclean-metric-sub">Total auto-cleaning cycles</div>
        </div>
        <div className="tipclean-metric-card">
          <div className="tipclean-label">Last Cleaned At</div>
          <div className="tipclean-metric-val" style={{ fontSize: '1.2em', marginTop: 4 }}>{formatTimeOnly(lastCleanTime) || 'Never'}</div>
          <div className="tipclean-metric-sub">Timestamp of last successful cycle</div>
        </div>
      </div>

      {/* ── Settings ── */}
      <div className="tipclean-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h4 style={{ margin: 0 }}>Cleaning Configuration</h4>
          <label style={{ fontSize: '0.8em', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={isAdmin} onChange={e => setIsAdmin(e.target.checked)} /> Unlock Settings
          </label>
        </div>
        <div className="tipclean-config-grid" style={{ opacity: isAdmin ? 1 : 0.5, pointerEvents: isAdmin ? 'auto' : 'none' }}>
           <div className="tipclean-config-item">
             <label>Cleaning Interval (pads)</label>
             <input type="number" min="10" max="5000" value={cleanIntervalPads} onChange={e => setConfig("cleanIntervalPads", Number(e.target.value))} />
           </div>
        </div>
      </div>

      {/* ── Event Log ── */}
      <div className="tipclean-section" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <h4>Tip Cleaning Event Log</h4>
        <div className="tipclean-log-container">
          {eventLog.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.9em', padding: 8 }}>No events logged yet.</div>}
          {eventLog.map((ev, i) => (
            <div key={i} className="tipclean-log-item">
              <div className="tipclean-log-time">{formatTimeOnly(ev.time)}</div>
              <div className={`tipclean-log-type ${ev.type}`}>{ev.type}</div>
              <div className="tipclean-log-detail">{ev.reason}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
