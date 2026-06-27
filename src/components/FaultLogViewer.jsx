import { useState, useEffect, useCallback } from 'react';

const LEVEL_STYLE = {
  ERROR:   { color: '#f85149', bg: 'rgba(248,81,73,0.12)',  border: '#f85149' },
  WARNING: { color: '#e3b341', bg: 'rgba(227,179,65,0.12)', border: '#e3b341' },
};

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date}, ${time}`;
  } catch {
    return iso;
  }
}

export default function FaultLogViewer({ isAdmin, onClose }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState('ALL');
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await window.fs.readFaultLog();
      setEntries(rows || []);
    } catch {
      setEntries([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleClear = async () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    setClearing(true);
    await window.fs.clearFaultLog();
    setEntries([]);
    setClearing(false);
    setConfirmClear(false);
  };

  const filtered = entries.filter(e => {
    if (levelFilter !== 'ALL' && e.level !== levelFilter) return false;
    if (search && !e.message.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const errorCount   = entries.filter(e => e.level === 'ERROR').length;
  const warningCount = entries.filter(e => e.level === 'WARNING').length;

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9998,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{
        background: '#161b22', border: '1px solid #30363d', borderRadius: 12,
        display: 'flex', flexDirection: 'column',
        width: '100%', maxWidth: 860, maxHeight: '85vh',
        boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 18px', borderBottom: '1px solid #21262d', flexShrink: 0,
        }}>
          <span style={{ fontSize: '1.1em' }}>📋</span>
          <span style={{ color: '#e6edf3', fontWeight: 700, fontSize: '0.95em', flex: 1 }}>
            Fault Log Viewer
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {errorCount > 0 && (
              <span style={{
                padding: '2px 8px', borderRadius: 10, fontSize: '0.75em', fontWeight: 700,
                background: 'rgba(248,81,73,0.18)', color: '#f85149', border: '1px solid #f85149',
              }}>{errorCount} ERROR{errorCount !== 1 ? 'S' : ''}</span>
            )}
            {warningCount > 0 && (
              <span style={{
                padding: '2px 8px', borderRadius: 10, fontSize: '0.75em', fontWeight: 700,
                background: 'rgba(227,179,65,0.18)', color: '#e3b341', border: '1px solid #e3b341',
              }}>{warningCount} WARNING{warningCount !== 1 ? 'S' : ''}</span>
            )}
          </div>
          <button
            onClick={load}
            title="Refresh"
            style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid #30363d',
              background: 'rgba(255,255,255,0.05)', color: '#8b949e',
              cursor: 'pointer', fontSize: '0.8em',
            }}
          >
            ↻ Refresh
          </button>
          <button
            onClick={onClose}
            title="Close"
            style={{
              padding: '4px 10px', borderRadius: 6, border: '1px solid #30363d',
              background: 'rgba(255,255,255,0.05)', color: '#8b949e',
              cursor: 'pointer', fontSize: '0.8em',
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* ── Filters ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 18px', borderBottom: '1px solid #21262d', flexShrink: 0,
        }}>
          {['ALL', 'ERROR', 'WARNING'].map(lvl => {
            const active = levelFilter === lvl;
            const s = lvl === 'ERROR' ? LEVEL_STYLE.ERROR : lvl === 'WARNING' ? LEVEL_STYLE.WARNING : null;
            return (
              <button
                key={lvl}
                onClick={() => setLevelFilter(lvl)}
                style={{
                  padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: '0.78em', fontWeight: 600,
                  border: `1px solid ${active ? (s?.border ?? '#58a6ff') : '#30363d'}`,
                  background: active ? (s?.bg ?? 'rgba(88,166,255,0.12)') : 'transparent',
                  color: active ? (s?.color ?? '#58a6ff') : '#8b949e',
                }}
              >
                {lvl}
              </button>
            );
          })}
          <input
            type="text"
            placeholder="Search messages..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              flex: 1, padding: '5px 10px', borderRadius: 6,
              border: '1px solid #30363d', background: '#0d1117',
              color: '#e6edf3', fontSize: '0.82em', outline: 'none',
            }}
          />
          <span style={{ color: '#8b949e', fontSize: '0.78em', whiteSpace: 'nowrap' }}>
            {filtered.length} of {entries.length} entries
          </span>
        </div>

        {/* ── Table ── */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#8b949e', fontSize: '0.85em' }}>
              Loading fault log...
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#8b949e', fontSize: '0.85em' }}>
              {entries.length === 0
                ? '✅ No faults recorded. Machine is running clean.'
                : 'No entries match the current filter.'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82em' }}>
              <thead>
                <tr style={{ background: '#0d1117', position: 'sticky', top: 0 }}>
                  {['Timestamp', 'Level', 'Message'].map(h => (
                    <th key={h} style={{
                      padding: '8px 14px', textAlign: 'left',
                      color: '#8b949e', fontWeight: 600, fontSize: '0.85em',
                      borderBottom: '1px solid #21262d', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => {
                  const s = LEVEL_STYLE[e.level];
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom: '1px solid #21262d',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                      }}
                    >
                      <td style={{
                        padding: '7px 14px', color: '#8b949e',
                        whiteSpace: 'nowrap', verticalAlign: 'top',
                        fontFamily: 'monospace', fontSize: '0.9em',
                      }}>
                        {formatTime(e.timestamp)}
                      </td>
                      <td style={{ padding: '7px 14px', verticalAlign: 'top' }}>
                        {s ? (
                          <span style={{
                            display: 'inline-block', padding: '1px 7px', borderRadius: 4,
                            background: s.bg, color: s.color, border: `1px solid ${s.border}`,
                            fontWeight: 700, fontSize: '0.85em', whiteSpace: 'nowrap',
                          }}>
                            {e.level}
                          </span>
                        ) : (
                          <span style={{ color: '#8b949e' }}>{e.level}</span>
                        )}
                      </td>
                      <td style={{ padding: '7px 14px', color: '#e6edf3', verticalAlign: 'top', lineHeight: 1.5 }}>
                        {e.message}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Footer ── */}
        {isAdmin && entries.length > 0 && (
          <div style={{
            padding: '10px 18px', borderTop: '1px solid #21262d',
            display: 'flex', justifyContent: 'flex-end', flexShrink: 0,
          }}>
            <button
              onClick={handleClear}
              disabled={clearing}
              style={{
                padding: '6px 14px', borderRadius: 6, cursor: clearing ? 'default' : 'pointer',
                border: `1px solid ${confirmClear ? '#f85149' : '#444'}`,
                background: confirmClear ? 'rgba(248,81,73,0.18)' : 'rgba(255,255,255,0.04)',
                color: confirmClear ? '#f85149' : '#8b949e',
                fontSize: '0.8em', fontWeight: 600, transition: 'all 0.2s',
              }}
            >
              {clearing ? 'Clearing...' : confirmClear ? '⚠ Confirm Clear All' : '🗑 Clear Log'}
            </button>
            {confirmClear && (
              <button
                onClick={() => setConfirmClear(false)}
                style={{
                  marginLeft: 8, padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
                  border: '1px solid #30363d', background: 'transparent',
                  color: '#8b949e', fontSize: '0.8em',
                }}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
