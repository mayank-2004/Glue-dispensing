import { useState } from "react";
import { TIP_VERIFY } from "../hooks/useTipManager.js";
import "./TipManagementPanel.css";

const STEP_ICON = { pending: "○", running: "⟳", done: "✓", error: "✗", skipped: "—" };

function VerifyBadge({ state }) {
  const cls = state === TIP_VERIFY.VERIFIED ? "verified" : state === TIP_VERIFY.FAILED ? "failed" : "unverified";
  const label = state === TIP_VERIFY.VERIFIED ? "VERIFIED" : state === TIP_VERIFY.FAILED ? "FAILED" : "UNVERIFIED";
  return <span className={`tip-verify-badge ${cls}`}>{label}</span>;
}

export default function TipManagementPanel({ tipManager, machinePosition, isConnected }) {
  const [tab, setTab] = useState("tips");
  const [editId, setEditId] = useState(null);
  const [fromTipId, setFromTipId] = useState(null);
  const [toTipId, setToTipId] = useState(null);
  const [slotCountInput, setSlotCountInput] = useState(tipManager.slots.length);

  if (!tipManager) return <div className="panel"><p>Tip manager not available.</p></div>;

  const {
    tipLibrary, slots, activeTipId, activeTip, verificationState,
    sequenceRunning, sequenceSteps, sequenceError, targetTipId,
    addTip, updateTip, removeTip,
    setSlotCount, saveSlotPosition, assignTipToSlot,
    runTipChangeSequence, abortSequence, resetSequence,
    manualConfirmTip, setActiveTipId,
  } = tipManager;

  // ── Status bar ────────────────────────────────────────────────────────────

  const statusBar = (
    <div className="tip-status-bar">
      <div>
        <div className="tip-name">{activeTip ? activeTip.name : "No tip installed"}</div>
        {activeTip && <div className="tip-type">Type: {activeTip.type}</div>}
      </div>
      <VerifyBadge state={verificationState} />
      {activeTip && (
        <div className="tip-offset-readout">
          Offset: dx={activeTip.toolOffset.dx.toFixed(3)} dy={activeTip.toolOffset.dy.toFixed(3)} dz={activeTip.toolOffset.dz.toFixed(3)} mm
        </div>
      )}
    </div>
  );

  // ── Tips tab ──────────────────────────────────────────────────────────────

  const tipsTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn primary" onClick={() => { const id = addTip(); setEditId(id); }}>+ Add Tip</button>
        <small style={{ color: "var(--text-secondary)" }}>{tipLibrary.length} tip{tipLibrary.length !== 1 ? "s" : ""} configured</small>
      </div>

      {tipLibrary.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.88em" }}>No tips configured yet. Add a tip to get started.</p>
      ) : (
        <table className="tip-table">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Slot</th><th>Offset (dx,dy,dz)</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tipLibrary.map(tip => (
              <tr key={tip.id}>
                <td>
                  {editId === tip.id ? (
                    <input
                      autoFocus defaultValue={tip.name}
                      onBlur={e => updateTip(tip.id, { name: e.target.value })}
                      style={{ width: 110, padding: "2px 5px", borderRadius: 3, border: "1px solid var(--border-color)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }}
                    />
                  ) : (
                    <strong style={{ cursor: "pointer" }} onClick={() => setEditId(tip.id)}>{tip.name}</strong>
                  )}
                </td>
                <td>
                  {editId === tip.id ? (
                    <select
                      value={tip.type}
                      onChange={e => updateTip(tip.id, { type: e.target.value })}
                      style={{ padding: "2px 4px", borderRadius: 3, border: "1px solid var(--border-color)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }}
                    >
                      {["Standard","Chisel","Conical","Knife","Bevel","Hoof","Micro"].map(t => <option key={t}>{t}</option>)}
                    </select>
                  ) : tip.type}
                </td>
                <td>Slot {tip.slotIndex + 1}</td>
                <td style={{ fontFamily: "monospace", fontSize: "0.82em" }}>
                  {editId === tip.id ? (
                    <div className="tip-offset-row">
                      {["dx","dy","dz"].map(axis => (
                        <label key={axis}>
                          {axis}
                          <input
                            type="number" step="0.001"
                            value={tip.toolOffset[axis]}
                            onChange={e => updateTip(tip.id, { toolOffset: { ...tip.toolOffset, [axis]: parseFloat(e.target.value) || 0 } })}
                          />
                        </label>
                      ))}
                    </div>
                  ) : `${tip.toolOffset.dx.toFixed(3)}, ${tip.toolOffset.dy.toFixed(3)}, ${tip.toolOffset.dz.toFixed(3)}`}
                </td>
                <td>
                  {tip.id === activeTipId
                    ? <span style={{ color: "var(--accent-primary)", fontWeight: 600 }}>● Active</span>
                    : tip.presenceConfirmed
                      ? <span style={{ color: "#28a745" }}>Present</span>
                      : <span style={{ color: "var(--text-secondary)" }}>—</span>
                  }
                </td>
                <td style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <button className="btn sm" onClick={() => setEditId(editId === tip.id ? null : tip.id)}>
                    {editId === tip.id ? "Done" : "Edit"}
                  </button>
                  <button className="btn sm secondary" onClick={() => { setActiveTipId(tip.id); manualConfirmTip(tip.id); }}>
                    Set Active
                  </button>
                  <button className="btn sm danger" onClick={() => { if (window.confirm(`Remove tip "${tip.name}"?`)) removeTip(tip.id); }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  // ── Change Tip tab ────────────────────────────────────────────────────────

  const changeTipTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.88em" }}>
          <span style={{ color: "var(--text-secondary)" }}>Current Tip (to drop)</span>
          <select
            value={fromTipId ?? ""}
            onChange={e => setFromTipId(e.target.value || null)}
            style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border-color)", background: "var(--bg-tertiary)", color: "var(--text-primary)", minWidth: 160 }}
          >
            <option value="">(No tip / skip drop)</option>
            {tipLibrary.map(t => <option key={t.id} value={t.id}>{t.name} — Slot {t.slotIndex + 1}</option>)}
          </select>
        </label>
        <span style={{ fontSize: "1.4em", paddingBottom: 4 }}>→</span>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.88em" }}>
          <span style={{ color: "var(--text-secondary)" }}>Target Tip (to pick up)</span>
          <select
            value={toTipId ?? ""}
            onChange={e => setToTipId(e.target.value || null)}
            style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border-color)", background: "var(--bg-tertiary)", color: "var(--text-primary)", minWidth: 160 }}
          >
            <option value="">— Select tip —</option>
            {tipLibrary.filter(t => t.id !== fromTipId).map(t => <option key={t.id} value={t.id}>{t.name} — Slot {t.slotIndex + 1}</option>)}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          className="btn primary"
          onClick={() => runTipChangeSequence(fromTipId, toTipId)}
          disabled={!toTipId || sequenceRunning || !isConnected}
          title={!isConnected ? "Machine not connected" : ""}
        >
          {sequenceRunning ? "⟳ Running Sequence…" : "🔧 Change Tip"}
        </button>
        {sequenceRunning && (
          <button className="btn secondary" onClick={abortSequence}>⛔ Abort</button>
        )}
        {!sequenceRunning && sequenceSteps.some(s => s.status !== "pending") && (
          <button className="btn secondary" onClick={resetSequence}>↺ Reset</button>
        )}
        {!sequenceRunning && sequenceError && toTipId && (
          <button className="btn secondary" onClick={() => { manualConfirmTip(toTipId); resetSequence(); }}>
            ✋ Manual Confirm Installed
          </button>
        )}
      </div>

      {sequenceError && <div className="tip-error-box"><strong>Error:</strong> {sequenceError}</div>}

      {sequenceSteps.some(s => s.status !== "pending") && (
        <div className="tip-sequence-grid">
          {sequenceSteps.map(step => (
            <div key={step.key} className={`tip-sequence-step ${step.status}`}>
              <span className="tip-step-icon">{STEP_ICON[step.status] ?? "○"}</span>
              <span>{step.label}</span>
              {step.status === "running" && <span style={{ marginLeft: "auto", fontSize: "0.8em", color: "var(--accent-primary)" }}>In progress…</span>}
              {step.status === "done"    && <span style={{ marginLeft: "auto", fontSize: "0.8em", color: "#28a745" }}>Done</span>}
              {step.status === "error"   && <span style={{ marginLeft: "auto", fontSize: "0.8em", color: "#dc3545" }}>Failed</span>}
              {step.status === "skipped" && <span style={{ marginLeft: "auto", fontSize: "0.8em", color: "var(--text-secondary)" }}>Skipped</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ── Calibrate Slots tab ───────────────────────────────────────────────────

  const calibrateTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label style={{ fontSize: "0.88em", color: "var(--text-secondary)" }}>
          Number of slots:
          <input
            type="number" min={4} max={20} value={slotCountInput}
            onChange={e => setSlotCountInput(Number(e.target.value))}
            style={{ width: 60, marginLeft: 8, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border-color)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }}
          />
        </label>
        <button className="btn sm secondary" onClick={() => setSlotCount(slotCountInput)}>Apply</button>
        <small style={{ color: "var(--text-secondary)" }}>Min 4, max 20</small>
      </div>

      <div className="slot-grid">
        {slots.map((slot, i) => {
          const assignedTip = tipLibrary.find(t => t.id === slot.tipId);
          const hasPos = slot.position.x !== null;
          return (
            <div key={i} className="slot-card">
              <div className="slot-header">
                <span>Slot {i + 1}</span>
                {hasPos
                  ? <span style={{ color: "#28a745", fontSize: "0.8em" }}>● Calibrated</span>
                  : <span style={{ color: "#ffc107", fontSize: "0.8em" }}>○ Not set</span>
                }
              </div>

              {hasPos && (
                <div className="slot-coords">
                  X: {slot.position.x?.toFixed(3)} &nbsp; Y: {slot.position.y?.toFixed(3)} &nbsp; Z: {slot.position.z?.toFixed(3)}
                </div>
              )}

              <label style={{ fontSize: "0.82em", color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 2 }}>
                Assigned tip
                <select
                  value={slot.tipId ?? ""}
                  onChange={e => assignTipToSlot(i, e.target.value || null)}
                  style={{ padding: "3px 5px", borderRadius: 3, border: "1px solid var(--border-color)", background: "var(--bg-tertiary)", color: "var(--text-primary)" }}
                >
                  <option value="">— None —</option>
                  {tipLibrary.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>

              {assignedTip && <div className="slot-tip-label">🔧 {assignedTip.name} ({assignedTip.type})</div>}

              <button
                className="btn sm"
                disabled={!isConnected || !machinePosition}
                title={!machinePosition ? "Machine position unknown" : "Save current machine position as this slot position"}
                onClick={() => {
                  if (!machinePosition) return;
                  if (window.confirm(`Save current position as Slot ${i + 1}?\nX:${machinePosition.x.toFixed(3)} Y:${machinePosition.y.toFixed(3)} Z:${machinePosition.z.toFixed(3)}`)) {
                    saveSlotPosition(i, { x: machinePosition.x, y: machinePosition.y, z: machinePosition.z });
                  }
                }}
              >
                📍 Save Position
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="panel tip-panel">
      <h3>🔧 Tip Management</h3>

      {statusBar}

      {verificationState === TIP_VERIFY.FAILED && (
        <div className="tip-error-box">
          <strong>⚠ Tip Verification Failed</strong> — The embedded controller could not confirm tip installation.
          Use <em>Manual Confirm</em> in the Change Tip tab if you have visually verified the tip is correctly seated.
        </div>
      )}

      {verificationState === TIP_VERIFY.UNVERIFIED && activeTip && (
        <div className="tip-warning-box">
          <strong>⚠ Tip Unverified</strong> — Tip has not been confirmed since the last change. Run a tip change or use Manual Confirm.
        </div>
      )}

      <div className="tip-tabs">
        {[["tips","Tips"], ["change","Change Tip"], ["calibrate","Calibrate Slots"]].map(([id, label]) => (
          <button key={id} className={`tip-tab-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      <div className="tab-content">
        {tab === "tips"      && tipsTab}
        {tab === "change"    && changeTipTab}
        {tab === "calibrate" && calibrateTab}
      </div>
    </div>
  );
}
