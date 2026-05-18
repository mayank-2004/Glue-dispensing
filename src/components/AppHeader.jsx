export default function AppHeader({ mPos, isSerialConnected, isEmergencyStopped, onStop, onReset }) {
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
      </div>
    </header>
  );
}
