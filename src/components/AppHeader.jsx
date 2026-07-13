import { useState, useEffect, useRef } from 'react';
import FaultLogViewer from './FaultLogViewer';

const DEFAULT_PIN = '1234';
const PIN_KEY = 'glueAdminPin';
// Recovery key printed in machine manual — allows supervisor to reset a forgotten PIN
const RECOVERY_KEY = 'SWAJA0000';

function PinModal({ title, hint, error, success, onSubmit, onCancel, onForgot }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(value);
    setValue('');
  };

  if (success) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          background: '#1e1e2e', border: '1px solid #3fb950', borderRadius: 10,
          padding: '28px 32px', minWidth: 290, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '2em', marginBottom: 10 }}>✅</div>
          <div style={{ color: '#3fb950', fontWeight: 700, fontSize: '0.95em', marginBottom: 8 }}>
            {success}
          </div>
          <button
            onClick={onCancel}
            style={{
              marginTop: 14, padding: '6px 24px', borderRadius: 6,
              border: '1px solid #3fb950', background: 'rgba(63,185,80,0.15)',
              color: '#3fb950', cursor: 'pointer', fontSize: '0.85em', fontWeight: 600,
            }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e1e2e', border: '1px solid #3a3a4e', borderRadius: 10,
        padding: '24px 28px', minWidth: 290, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }}>
        <div style={{ color: '#cdd6f4', fontWeight: 700, fontSize: '0.95em', marginBottom: hint ? 6 : 14 }}>
          {title}
        </div>
        {hint && (
          <div style={{ color: '#8b949e', fontSize: '0.78em', marginBottom: 12 }}>{hint}</div>
        )}
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="password"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Enter PIN"
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${error ? '#f85149' : '#444'}`,
              background: '#13131f', color: '#cdd6f4',
              fontSize: '1.1em', letterSpacing: '0.25em',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          {error && (
            <div style={{ color: '#f85149', fontSize: '0.8em', marginTop: 6 }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onCancel}
              style={{
                padding: '6px 16px', borderRadius: 6, border: '1px solid #444',
                background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: '0.85em',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={{
                padding: '6px 16px', borderRadius: 6, border: '1px solid #58a6ff',
                background: 'rgba(88,166,255,0.15)', color: '#58a6ff',
                cursor: 'pointer', fontSize: '0.85em', fontWeight: 600,
              }}
            >
              OK
            </button>
          </div>
          {onForgot && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                type="button"
                onClick={onForgot}
                style={{
                  background: 'none', border: 'none', color: '#8b949e',
                  fontSize: '0.78em', cursor: 'pointer', textDecoration: 'underline', padding: 0,
                }}
              >
                Forgot PIN?
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default function AppHeader({ mPos, isSerialConnected, isEmergencyStopped, onStop, onReset, onQuit, isAdminMode, onToggleAdmin }) {
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  const confirmTimerRef = useRef(null);

  // null | 'unlock' | 'forgot' | 'change-current' | 'change-new' | 'change-confirm' | 'success'
  const [pinFlow, setPinFlow] = useState(null);
  const [pinError, setPinError] = useState('');
  const [pinSuccess, setPinSuccess] = useState('');
  const [tempPin, setTempPin] = useState('');
  const [showFaultLog, setShowFaultLog] = useState(false);

  const closeModal = () => { setPinFlow(null); setPinError(''); setPinSuccess(''); setTempPin(''); };

  const handleAdminToggle = () => {
    if (isAdminMode) {
      onToggleAdmin(false);
    } else {
      setPinFlow('unlock');
      setPinError('');
    }
  };

  const handleChangePin = () => {
    setPinFlow('change-current');
    setPinError('');
  };

  const handlePinSubmit = (value) => {
    const stored = localStorage.getItem(PIN_KEY) || DEFAULT_PIN;

    if (pinFlow === 'unlock') {
      if (value === stored) { onToggleAdmin(true); closeModal(); }
      else setPinError('Incorrect PIN. Please try again.');

    } else if (pinFlow === 'forgot') {
      if (value === RECOVERY_KEY) {
        localStorage.removeItem(PIN_KEY);
        setPinSuccess(`PIN has been reset to the default (${DEFAULT_PIN}). Please change it after logging in.`);
        setPinFlow('success');
      } else {
        setPinError('Incorrect recovery key. Contact your machine supervisor.');
      }

    } else if (pinFlow === 'change-current') {
      if (value === stored) { setPinFlow('change-new'); setPinError(''); }
      else setPinError('Incorrect PIN. Please try again.');

    } else if (pinFlow === 'change-new') {
      if (!/^\d{4,8}$/.test(value)) {
        setPinError('PIN must be 4–8 digits only.');
        return;
      }
      if (value === stored) {
        setPinError('This PIN is already in use. Please choose a different PIN.');
        return;
      }
      setTempPin(value);
      setPinFlow('change-confirm');
      setPinError('');

    } else if (pinFlow === 'change-confirm') {
      if (value === tempPin) {
        localStorage.setItem(PIN_KEY, tempPin);
        setPinSuccess('PIN changed successfully.');
        setPinFlow('success');
      } else {
        setPinError('PINs do not match. Please try again.');
      }
    }
  };

  const PIN_MODAL_CONFIG = {
    'unlock':         { title: 'Enter Admin PIN' },
    'forgot':         { title: 'Enter Recovery Key', hint: 'Contact your supervisor for the machine recovery key.' },
    'change-current': { title: 'Enter current PIN' },
    'change-new':     { title: 'Enter new PIN (4–8 digits)' },
    'change-confirm': { title: 'Confirm new PIN' },
  };

  const handleQuitClick = () => {
    if (!confirmingQuit) {
      setConfirmingQuit(true);
      confirmTimerRef.current = setTimeout(() => setConfirmingQuit(false), 3000);
    } else {
      clearTimeout(confirmTimerRef.current);
      setConfirmingQuit(false);
      if (onQuit) onQuit();
    }
  };

  useEffect(() => () => clearTimeout(confirmTimerRef.current), []);

  const modalConfig = PIN_MODAL_CONFIG[pinFlow] ?? {};

  return (
    <>
      {pinFlow && (
        <PinModal
          title={modalConfig.title}
          hint={modalConfig.hint}
          error={pinError}
          success={pinFlow === 'success' ? pinSuccess : null}
          onSubmit={handlePinSubmit}
          onCancel={closeModal}
          onForgot={pinFlow === 'unlock' ? () => { setPinFlow('forgot'); setPinError(''); } : null}
        />
      )}
      {showFaultLog && (
        <FaultLogViewer isAdmin={isAdminMode} onClose={() => setShowFaultLog(false)} />
      )}
      <header className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon">🔧</div>
          <div>
            <div className="app-logo-text">GlueDispenser</div>
            <div className="app-logo-sub">Motion Control System</div>
          </div>
        </div>
        <div className="header-divider" />
        <div className="header-dro">
          <div className="dro-axis">
            <span className="dro-label">X</span>
            <span className="dro-value">{mPos.x.toFixed(3)}</span>
            <span className="dro-unit">mm</span>
          </div>
          <div className="dro-sep" />
          <div className="dro-axis">
            <span className="dro-label">Y</span>
            <span className="dro-value">{mPos.y.toFixed(3)}</span>
            <span className="dro-unit">mm</span>
          </div>
          <div className="dro-sep" />
          <div className="dro-axis">
            <span className="dro-label">Z</span>
            <span className="dro-value">{(mPos.z ?? 0).toFixed(3)}</span>
            <span className="dro-unit">mm</span>
          </div>
        </div>
        <div className="header-spacer" />
        <div className="header-right">
          <div className={`status-pill ${isSerialConnected ? 'connected' : 'disconnected'}`}>
            <span className="pill-dot" />
            {isSerialConnected ? 'CONNECTED' : 'OFFLINE'}
          </div>
          {/* onToggleAdmin && (
            <>
              <button
                onClick={handleAdminToggle}
                title={isAdminMode ? 'Lock settings (switch to Operator mode)' : 'Unlock settings (Admin login)'}
                style={{
                  marginRight: 4, padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${isAdminMode ? '#3fb950' : '#e3b341'}`,
                  background: isAdminMode ? 'rgba(63,185,80,0.12)' : 'rgba(227,179,65,0.12)',
                  color: isAdminMode ? '#3fb950' : '#e3b341',
                  fontSize: '0.8em', fontWeight: 700, letterSpacing: '0.04em',
                }}
              >
                {isAdminMode ? '🔓 ADMIN' : '🔒 OPERATOR'}
              </button>
              {isAdminMode && (
                <button
                  onClick={handleChangePin}
                  title="Change admin PIN"
                  style={{
                    marginRight: 8, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid #58a6ff',
                    background: 'rgba(88,166,255,0.10)',
                    color: '#58a6ff',
                    fontSize: '0.75em', fontWeight: 600, letterSpacing: '0.04em',
                  }}
                >
                  Change PIN
                </button>
              )}
            </>
          ) */}
          <button
            onClick={() => setShowFaultLog(true)}
            title="View fault log"
            style={{
              marginRight: 8, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid #444', background: 'rgba(255,255,255,0.05)',
              color: '#8b949e', fontSize: '0.78em', fontWeight: 600, letterSpacing: '0.03em',
            }}
          >
            📋 Log
          </button>
          <button
            className={`estop-btn ${isEmergencyStopped ? 'triggered' : ''}`}
            onClick={isEmergencyStopped ? onReset : onStop}
            title={isEmergencyStopped ? 'Click to RESET machine' : 'Emergency Stop'}
          >
            <span className="estop-dot" />
            {isEmergencyStopped ? 'RESET' : 'E-STOP'}
          </button>
          {onQuit && (
            <button
              onClick={handleQuitClick}
              title={confirmingQuit ? 'Tap again to confirm exit' : 'Exit application'}
              style={{
                marginLeft: 8, padding: '6px 12px', borderRadius: 6,
                border: `1px solid ${confirmingQuit ? '#f85149' : '#444'}`,
                background: confirmingQuit ? 'rgba(248,81,73,0.18)' : 'rgba(255,255,255,0.06)',
                color: confirmingQuit ? '#f85149' : '#8b949e',
                fontSize: '0.8em', fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.2s', letterSpacing: '0.04em',
              }}
            >
              {confirmingQuit ? 'Confirm Exit?' : '⏻ Exit'}
            </button>
          )}
        </div>
      </header>
    </>
  );
}
