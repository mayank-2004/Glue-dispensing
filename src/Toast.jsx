import { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

const TYPE_STYLES = {
  success: { bg: '#0d2818', border: '#3fb950', icon: '✓' },
  error:   { bg: '#2d0f0f', border: '#f85149', icon: '✗' },
  warning: { bg: '#2d1f00', border: '#e3b341', icon: '⚠' },
  info:    { bg: '#0d1a2d', border: '#58a6ff', icon: 'ℹ' },
};

const DURATIONS = { success: 3000, info: 3000, warning: 4000, error: 5000 };

function ToastItem({ id, message, type, onDismiss }) {
  const s = TYPE_STYLES[type] || TYPE_STYLES.info;
  return (
    <div
      onClick={() => onDismiss(id)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: '10px 14px', borderRadius: 7, cursor: 'pointer',
        background: s.bg, border: `1px solid ${s.border}`,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        fontSize: '0.84em', lineHeight: 1.45,
        maxWidth: 360, wordBreak: 'break-word',
        animation: 'toast-slide-in 0.18s ease',
      }}
    >
      <span style={{ color: s.border, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{s.icon}</span>
      <span className={type === 'success' ? 'text-success' : type === 'error' ? 'text-error' : type === 'warning' ? 'text-warning' : ''} style={type === 'info' ? { color: s.border } : {}}>{message}</span>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  const addToast = useCallback((message, type = 'info') => {
    const id = ++idRef.current;
    const duration = DURATIONS[type] ?? 3500;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    if ((type === 'error' || type === 'warning') && window.fs?.appendFaultLog) {
      window.fs.appendFaultLog({
        timestamp: new Date().toISOString(),
        level: type.toUpperCase(),
        message: String(message),
      }).catch(() => {});
    }
  }, []);

  const toast = {
    success: (msg) => addToast(msg, 'success'),
    error:   (msg) => addToast(msg, 'error'),
    warning: (msg) => addToast(msg, 'warning'),
    info:    (msg) => addToast(msg, 'info'),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <style>{`@keyframes toast-slide-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }`}</style>
      <div style={{
        position: 'fixed', bottom: 120, right: 24, zIndex: 99999,
        display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
      }}>
        {toasts.map(t => (
          <div key={t.id} style={{ pointerEvents: 'auto' }}>
            <ToastItem id={t.id} message={t.message} type={t.type} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside <ToastProvider>');
  return ctx;
}
