/**
 * GlueGauge.jsx
 *
 * Displays cartridge stock, job consumption forecast, per-pad breakdown,
 * and lets the user set stock / trigger refill.
 *
 * Props
 * ─────
 *  summary        — output of buildJobGlueSummary()  (may be null)
 *  nozzleDia      — number (mm)
 *  onNozzleDia    — (v) => void
 *  onRefill       — (newStockMm3) => void
 *  onStockChange  — (mm3) => void
 */

import { useState } from 'react';
import { GlueStore } from '../lib/glue/glueTracker.js';

// ── tiny bar component ────────────────────────────────────────────────────────
function Bar({ pct, color, height = 10, label }) {
  const clamped = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div style={{ marginBottom: label ? 6 : 0 }}>
      {label && <div style={{ fontSize: '0.75em', color: '#888', marginBottom: 2 }}>{label}</div>}
      <div style={{ height, background: '#222', borderRadius: height / 2, overflow: 'hidden',
        border: '1px solid #333' }}>
        <div style={{
          height: '100%', width: `${clamped}%`,
          background: clamped > 40 ? color || '#00c49a' : clamped > 15 ? '#ffaa00' : '#c0392b',
          transition: 'width 0.4s ease',
          borderRadius: height / 2,
        }} />
      </div>
    </div>
  );
}

// ── kv row ────────────────────────────────────────────────────────────────────
const KV = ({ k, v, warn }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82em',
    padding: '3px 0', borderBottom: '1px solid #1e1e1e' }}>
    <span style={{ color: '#777' }}>{k}</span>
    <span style={{ fontFamily: 'monospace', fontWeight: 'bold',
      color: warn ? '#ffaa00' : '#ccc' }}>{v}</span>
  </div>
);

export default function GlueGauge({ summary, nozzleDia, onNozzleDia, onRefill, onStockChange }) {
  const [stockInput, setStockInput]     = useState(() => GlueStore.getStock().toFixed(0));
  const [showPerPad, setShowPerPad]     = useState(false);
  const [showRefill, setShowRefill]     = useState(false);
  const [refillInput, setRefillInput]   = useState('5000');

  const stock   = GlueStore.getStock();
  const used    = GlueStore.getUsed();
  const remain  = Math.max(0, stock - used);
  const usedPct = stock > 0 ? (used / stock) * 100 : 0;

  const jobVol      = summary?.totalVolUl  ?? 0;
  const afterJobPct = stock > 0 ? Math.max(0, ((remain - jobVol) / stock) * 100) : 0;
  const willRunOut  = summary?.willRunOut ?? false;

  return (
    <div style={{ background: '#111', border: '1px solid #2a2a2a', borderRadius: 8,
      padding: 12, color: '#ccc' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 10 }}>
        <h4 style={{ margin: 0, color: '#00c49a', fontSize: '0.92em' }}>💧 Glue Tracker</h4>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setShowRefill(v => !v)}
            style={{ fontSize: '0.72em', padding: '3px 8px', background: '#1a3a1a',
              border: '1px solid #00c49a', color: '#00c49a', borderRadius: 4, cursor: 'pointer' }}>
            🔄 Refill
          </button>
          <button onClick={() => setShowPerPad(v => !v)}
            style={{ fontSize: '0.72em', padding: '3px 8px', background: '#1a1a2a',
              border: '1px solid #445', color: '#aaa', borderRadius: 4, cursor: 'pointer' }}>
            {showPerPad ? '▲ Hide' : '▼ Per-Pad'}
          </button>
        </div>
      </div>

      {/* ── Nozzle diameter ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        fontSize: '0.82em' }}>
        <span style={{ color: '#777' }}>Nozzle Ø</span>
        <input type="number" value={nozzleDia} step={0.05} min={0.1} max={3}
          onChange={e => onNozzleDia?.(parseFloat(e.target.value) || 0.6)}
          style={{ width: 60, padding: '3px 5px', background: '#1e1e2e', color: 'white',
            border: '1px solid #334', borderRadius: 3 }} />
        <span style={{ color: '#555' }}>mm</span>
      </div>

      {/* ── Cartridge stock bar ── */}
      <Bar pct={100 - usedPct} label={`Cartridge: ${remain.toFixed(1)} µL remaining of ${stock.toFixed(0)} µL`} height={12} />

      {/* ── After-job forecast bar ── */}
      {jobVol > 0 && (
        <div style={{ marginTop: 8 }}>
          <Bar pct={afterJobPct}
            label={`After this job: ${Math.max(0, remain - jobVol).toFixed(1)} µL remaining`}
            color="#64b5f6" height={8} />
        </div>
      )}

      {/* ── Warning banner ── */}
      {willRunOut && (
        <div style={{ margin: '8px 0', padding: '6px 10px', background: '#3a0d00',
          border: '1px solid #c0392b', borderRadius: 4, fontSize: '0.8em', color: '#ff6b6b' }}>
          ⚠️ Glue will run out at pad #{(summary.runOutAfterPad + 1)} of {summary.annotated?.length}.
          Remaining stock covers {summary.runOutAfterPad} pads.
        </div>
      )}

      {/* ── Job stats ── */}
      {summary && (
        <div style={{ marginTop: 8 }}>
          <KV k="Pads in job"        v={summary.annotated?.length ?? 0} />
          <KV k="Job volume"         v={`${jobVol.toFixed(2)} µL`} warn={willRunOut} />
          <KV k="Stock after job"    v={`${Math.max(0, remain - jobVol).toFixed(2)} µL`} warn={willRunOut} />
          {summary.remainPct !== null && (
            <KV k="Stock remaining %" v={`${Math.max(0, (summary.remainPct - (jobVol / stock * 100))).toFixed(1)}%`} />
          )}
        </div>
      )}

      {/* ── Stock input ── */}
      <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.82em' }}>
        <span style={{ color: '#777', whiteSpace: 'nowrap' }}>Set stock:</span>
        <input type="number" value={stockInput} min={0} step={100}
          onChange={e => setStockInput(e.target.value)}
          style={{ flex: 1, padding: '3px 5px', background: '#1e1e2e', color: 'white',
            border: '1px solid #334', borderRadius: 3 }} />
        <span style={{ color: '#555' }}>µL</span>
        <button onClick={() => {
          const v = parseFloat(stockInput) || 0;
          GlueStore.setStock(v);
          onStockChange?.(v);
        }} style={{ padding: '3px 8px', background: '#1a2a3a', border: '1px solid #336',
          color: '#6af', borderRadius: 3, cursor: 'pointer', fontSize: '0.9em' }}>
          Save
        </button>
      </div>

      {/* ── Refill panel ── */}
      {showRefill && (
        <div style={{ marginTop: 10, padding: 10, background: '#0d1a0d',
          border: '1px solid #1a4a1a', borderRadius: 6 }}>
          <div style={{ fontSize: '0.82em', color: '#aaa', marginBottom: 6 }}>
            Refill cartridge — resets usage counter to 0.
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="number" value={refillInput} min={0} step={500}
              onChange={e => setRefillInput(e.target.value)}
              style={{ flex: 1, padding: '4px 6px', background: '#1e2e1e', color: 'white',
                border: '1px solid #2a4a2a', borderRadius: 3 }} />
            <span style={{ color: '#555', fontSize: '0.82em' }}>µL</span>
            <button onClick={() => {
              const v = parseFloat(refillInput) || 5000;
              GlueStore.refill(v);
              onRefill?.(v);
              setShowRefill(false);
            }} style={{ padding: '4px 10px', background: '#00c49a', color: '#000',
              border: 'none', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer' }}>
              ✅ Confirm Refill
            </button>
          </div>
          <div style={{ fontSize: '0.72em', color: '#555', marginTop: 4 }}>
            Common cartridge sizes: 3 mL = 3000 µL, 5 mL = 5000 µL, 10 mL = 10000 µL
          </div>
        </div>
      )}

      {/* ── Per-pad breakdown ── */}
      {showPerPad && summary?.annotated?.length > 0 && (
        <div style={{ marginTop: 10, maxHeight: 220, overflowY: 'auto',
          border: '1px solid #222', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78em' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#111', zIndex: 1 }}>
              <tr style={{ color: '#555', textAlign: 'left', borderBottom: '1px solid #222' }}>
                <th style={{ padding: '4px 6px' }}>#</th>
                <th style={{ padding: '4px 6px' }}>Size (mm)</th>
                <th style={{ padding: '4px 6px' }}>Dots</th>
                <th style={{ padding: '4px 6px' }}>Vol (µL)</th>
                <th style={{ padding: '4px 6px' }}>Cumul.</th>
                <th style={{ padding: '4px 6px' }}>Left</th>
              </tr>
            </thead>
            <tbody>
              {summary.annotated.map((pad, i) => {
                const g = pad.glue;
                const isWarn = g.remainMm3 < (GlueStore.getStock() * 0.1);
                return (
                  <tr key={i} style={{ borderTop: '1px solid #1a1a1a',
                    background: summary.runOutAfterPad === i ? 'rgba(192,57,43,0.15)' : 'transparent' }}>
                    <td style={{ padding: '3px 6px', color: '#555' }}>{i + 1}</td>
                    <td style={{ padding: '3px 6px', fontFamily: 'monospace', color: '#aaa' }}>
                      {(pad.width||0).toFixed(2)}×{(pad.height||0).toFixed(2)}
                    </td>
                    <td style={{ padding: '3px 6px', color: '#aaa' }}>{g.dots}</td>
                    <td style={{ padding: '3px 6px', fontFamily: 'monospace',
                      color: summary.runOutAfterPad === i ? '#ff6b6b' : '#ccc' }}>
                      {g.volUl.toFixed(3)}
                    </td>
                    <td style={{ padding: '3px 6px', fontFamily: 'monospace', color: '#888' }}>
                      {g.cumMm3.toFixed(2)}
                    </td>
                    <td style={{ padding: '3px 6px', fontFamily: 'monospace',
                      color: isWarn ? '#ffaa00' : '#666' }}>
                      {g.remainMm3.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}