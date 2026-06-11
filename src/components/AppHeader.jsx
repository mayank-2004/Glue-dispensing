import { useState, useEffect, useRef } from 'react';

export default function AppHeader({ mPos, isSerialConnected, isEmergencyStopped, onStop, onReset, onQuit }) {
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  const confirmTimerRef = useRef(null);

  const handleQuitClick = () => {
    if (!confirmingQuit) {
      // First tap: arm the confirmation for 3 seconds
      setConfirmingQuit(true);
      confirmTimerRef.current = setTimeout(() => setConfirmingQuit(false), 3000);
    } else {
      // Second tap within 3s: execute quit
      clearTimeout(confirmTimerRef.current);
      setConfirmingQuit(false);
      if (onQuit) onQuit();
    }
  };

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(confirmTimerRef.current), []);

  return (
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
              marginLeft: 8,
              padding: '6px 12px',
              borderRadius: 6,
              border: `1px solid ${confirmingQuit ? '#f85149' : '#444'}`,
              background: confirmingQuit ? 'rgba(248,81,73,0.18)' : 'rgba(255,255,255,0.06)',
              color: confirmingQuit ? '#f85149' : '#8b949e',
              fontSize: '0.8em',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s',
              letterSpacing: '0.04em',
            }}
          >
            {confirmingQuit ? 'Confirm Exit?' : '⏻ Exit'}
          </button>
        )}
      </div>
    </header>
  );
}
