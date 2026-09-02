import { useState } from "react";
import { FLUX_LEVEL, CLEAN_STATE, DISPENSE_STATE } from "../hooks/useFluxManager.js";
import "./FluxPanel.css";

function formatTime(iso) {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return iso; }
}

function LevelGauge({ pct, state }) {
  const fillClass = pct <= 5 ? "level-empty" : pct <= 20 ? "level-low" : "level-normal";
  return (
    <div className="flux-gauge-wrap">
      <div className="flux-gauge-bar">
        <div className="flux-gauge-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
      <small style={{ color: "var(--text-secondary)", fontSize: "0.8em", }}>{pct}% remaining</small>
    </div>
  );
}

function StateBadge({ state }) {
  const labels = {
    [FLUX_LEVEL.NORMAL]:            "NORMAL",
    [FLUX_LEVEL.LOW]:               "LOW",
    [FLUX_LEVEL.EMPTY]:             "EMPTY",
    [FLUX_LEVEL.REFILL_REQUIRED]:   "REFILL REQUIRED",
    [FLUX_LEVEL.CLEANING_REQUIRED]: "CLEAN DUE",
    [FLUX_LEVEL.UNKNOWN]:           "UNKNOWN",
  };
  return <span className={`flux-state-badge ${state}`}>{labels[state] ?? state}</span>;
}

function ActivityBadge({ dispenseState, cleanState }) {
  if (cleanState === CLEAN_STATE.RUNNING)         return <span className="flux-activity-badge CLEANING">⟳ Cleaning…</span>;
  if (dispenseState === DISPENSE_STATE.DISPENSING)return <span className="flux-activity-badge DISPENSING">● Dispensing</span>;
  if (dispenseState === DISPENSE_STATE.CLEANING)  return <span className="flux-activity-badge CLEANING">⟳ Cleaning…</span>;
  if (dispenseState === DISPENSE_STATE.PAUSED)    return <span className="flux-activity-badge PAUSED">⏸ Paused</span>;
  return <span className="flux-activity-badge IDLE">○ Idle</span>;
}

export default function FluxPanel({ fluxManager }) {
  const [showConfig, setShowConfig] = useState(false);

  if (!fluxManager) return <div className="panel"><p>Flux manager not available.</p></div>;

  const {
    levelPct, levelState, cleanState, lastCleanedAt, cleanCycleCount, cleanAfterCycles,
    dispenseState, lastDispensedAt, totalDispenseCount, sourceIsReliable,
    lowThresholdPct, triggerClean, triggerManualDispense, markRefilled, setConfig,
  } = fluxManager;

  const isBusy = dispenseState !== DISPENSE_STATE.IDLE || cleanState === CLEAN_STATE.RUNNING;

  return (
    <div className="panel flux-panel">
      <h3>🧪 Flux Spraying System</h3>

      {/* ── Status bar ── */}
      <div className="flux-status-bar">
        <div>
          <div className="flux-label">Level Status</div>
          <StateBadge state={levelState} />
        </div>

        <LevelGauge pct={levelPct} state={levelState} />

        <div>
          <div className="flux-label">Activity</div>
          <ActivityBadge dispenseState={dispenseState} cleanState={cleanState} />
        </div>

        {fluxManager.lastSprayStatus && (
          <div>
            <div className="flux-label">Last Spray</div>
            <span className={`flux-state-badge ${fluxManager.lastSprayStatus === 'SUCCESS' ? 'NORMAL' : 'EMPTY'}`}>
              {fluxManager.lastSprayStatus === 'SUCCESS' ? '✅ SUCCESS' : '❌ FAILED'}
            </span>
          </div>
        )}

        {!sourceIsReliable && (
          <div style={{ fontSize: "0.78em", color: "#ffc107", border: "1px solid #ffc107", padding: "3px 8px", borderRadius: 4 }}>
            ⚠ No encoder feedback — software estimate
          </div>
        )}
      </div>

      {/* ── Warnings ── */}
      {levelState === FLUX_LEVEL.EMPTY && (
        <div style={{ padding: "10px 14px", background: "rgba(220,53,69,0.12)", border: "1px solid #dc3545", borderRadius: 4, color: "#ff7b72", fontSize: "0.87em" }}>
          <strong>⛔ Flux Tank Empty</strong> — Flux-dependent operations are paused. Refill the tank before continuing.
        </div>
      )}
      {levelState === FLUX_LEVEL.LOW && (
        <div style={{ padding: "10px 14px", background: "rgba(255,193,7,0.1)", border: "1px solid #ffc107", borderRadius: 4, color: "#c69500", fontSize: "0.87em" }}>
          <strong>⚠ Flux Level Low</strong> — Plan a refill soon. Operations can continue for now.
        </div>
      )}
      {levelState === FLUX_LEVEL.CLEANING_REQUIRED && (
        <div style={{ padding: "10px 14px", background: "rgba(255,193,7,0.1)", border: "1px solid #ffc107", borderRadius: 4, color: "#c69500", fontSize: "0.87em" }}>
          <strong>⚠ Nozzle Cleaning Due</strong> — Run a clean cycle before the next job to prevent clogging.
        </div>
      )}
      {cleanState === CLEAN_STATE.FAILED && (
        <div style={{ padding: "10px 14px", background: "rgba(220,53,69,0.12)", border: "1px solid #dc3545", borderRadius: 4, color: "#ff7b72", fontSize: "0.87em" }}>
          <strong>✗ Last Cleaning Failed</strong> — Check water supply and pump connections and try again.
        </div>
      )}

      {/* ── Controls ── */}
      <div className="flux-section">
        <h4>Manual Controls</h4>
        <div className="flux-controls">
          <button
            className="btn primary"
            onClick={triggerManualDispense}
            disabled={isBusy || levelState === FLUX_LEVEL.EMPTY}
            title={levelState === FLUX_LEVEL.EMPTY ? "Tank is empty" : "Manually fire one flux burst"}
          >
            💧 Dispense Flux
          </button>
          <button
            className="btn secondary"
            onClick={triggerClean}
            disabled={isBusy}
            title="Flush distilled water through nozzle then reverse pump to remove waste"
          >
            {cleanState === CLEAN_STATE.RUNNING ? "⟳ Cleaning…" : "🔄 Run Clean Cycle"}
          </button>
          <button
            className="btn sm"
            onClick={markRefilled}
            style={{ background: "rgba(40,167,69,0.1)", border: "1px solid #28a745", color: "#28a745" }}
          >
            ✅ Mark as Refilled
          </button>
        </div>

        <div className="flux-clean-meta" style={{ marginTop: 10 }}>
          <div>Last cleaned: <span>{formatTime(lastCleanedAt)}</span></div>
          <div>Last dispensed: <span>{formatTime(lastDispensedAt)}</span></div>
          <div>Total dispenses: <span>{totalDispenseCount}</span> &nbsp;|&nbsp; Cycles since last clean: <span style={{ color: cleanCycleCount >= cleanAfterCycles ? "#ffc107" : "var(--text-primary)" }}>{cleanCycleCount}/{cleanAfterCycles}</span></div>
        </div>
      </div>

      {/* ── Config ── */}
      <div className="flux-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: showConfig ? 12 : 0 }}>
          <h4 style={{ margin: 0 }}>Configuration</h4>
          <button className="btn sm secondary" onClick={() => setShowConfig(s => !s)}>
            {showConfig ? "Hide" : "Show Settings"}
          </button>
        </div>
        {showConfig && (
          <div className="flux-config-grid">
            <div className="flux-config-item">
              <label>Low level threshold (%)</label>
              <input
                type="number" min={5} max={50}
                value={lowThresholdPct}
                onChange={e => setConfig("lowThresholdPct", Number(e.target.value))}
              />
            </div>
            <div className="flux-config-item">
              <label>Clean cycle interval (dispenses)</label>
              <input
                type="number" min={1} max={500}
                value={cleanAfterCycles}
                onChange={e => setConfig("cleanAfterCycles", Number(e.target.value))}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Instructions ── */}
      <div className="flux-section">
        <h4>Instructions</h4>
        <details className="flux-instructions">
          <summary>Refill Instructions</summary>
          <div className="flux-instructions-body">
            <ol>
              <li>Stop all machine operations before refilling.</li>
              <li>Locate the flux storage tank attached to the machine base — slide or lift to remove.</li>
              <li>Open the tank cap (IPA-resistant material, safe to handle with gloves).</li>
              <li>Fill with the correct flux (IPA-based or as specified for your solder process).</li>
              <li>Reattach the tank firmly until it clicks into place.</li>
              <li>Click <strong>Mark as Refilled</strong> above to reset the level indicator.</li>
            </ol>
          </div>
        </details>
        <details className="flux-instructions">
          <summary>Cleaning Instructions</summary>
          <div className="flux-instructions-body">
            <ol>
              <li>Ensure distilled water reservoir is filled.</li>
              <li>Click <strong>Run Clean Cycle</strong> — the system will flush forward then reverse-suck waste.</li>
              <li>The cleaning cycle runs automatically on startup and after each job.</li>
              <li>If the cycle fails, check pump connections and distilled water supply.</li>
              <li>For manual nozzle cleaning, remove the nozzle and soak in IPA for 5 minutes.</li>
            </ol>
          </div>
        </details>
      </div>
    </div>
  );
}
