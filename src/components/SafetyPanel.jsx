import React, { useState, useEffect } from 'react';
import './SafetyPanel.css';

export default function SafetyPanel({ safetySystem }) {
  const { activeFaults, isCritical, clearFault, executeEmergencyHalt } = safetySystem;
  
  // Keep track of history locally
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (activeFaults.length > 0) {
      setHistory(prev => {
        const newHistory = [...prev];
        activeFaults.forEach(fault => {
          // Use fault.code and timestamp to uniquely identify in history if id doesn't exist
          const uid = fault.id || `${fault.code}-${fault.timestamp}`;
          if (!newHistory.find(h => (h.id || `${h.code}-${h.timestamp}`) === uid)) {
            newHistory.unshift({ ...fault, uid, cleared: null });
          }
        });
        return newHistory;
      });
    }
  }, [activeFaults]);

  // When a fault is removed from activeFaults, mark it cleared in history
  useEffect(() => {
    setHistory(prev => prev.map(h => {
      if (!h.cleared && !activeFaults.find(f => (f.id || `${f.code}-${f.timestamp}`) === h.uid)) {
        return { ...h, cleared: Date.now() };
      }
      return h;
    }));
  }, [activeFaults]);

  const clearLog = () => setHistory([]);

  // Determine hardware sensor statuses based on active faults (mocked linkage)
  const isCurtainFault = activeFaults.some(f => f.code === 'E003');
  const isEStopFault = activeFaults.some(f => f.code === 'E001');
  const isAxisFault = activeFaults.some(f => f.code === 'E004');
  const isSpoolFault = activeFaults.some(f => f.code === 'E007');

  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  return (
    <div className="safety-panel-container">
      <div className="safety-header">
        <span className="safety-header-icon">🛡️</span> SAFETY & DIAGNOSTICS
      </div>

      <div className={`safety-status-box ${isCritical ? 'critical' : ''}`}>
        <div className="safety-status-left">
          <div className="safety-status-title">
            {isCritical ? '❌ SYSTEM HALTED' : '✅ SYSTEM SAFE'}
          </div>
          <div className="safety-status-desc">
            {isCritical 
              ? 'Critical fault detected. Motion and active operations are disabled.' 
              : 'All interlocks closed, motion permitted.'}
          </div>
        </div>
        <button className="stop-btn" onClick={executeEmergencyHalt}>STOP</button>
      </div>

      <div className="safety-section">
        <h4>Hardware Sensors</h4>
        <div className="hardware-sensors-grid">
          <div className="sensor-badge">
            <div className={`sensor-dot ${isCurtainFault ? 'fault' : ''}`} /> Light Curtain
          </div>
          <div className="sensor-badge">
            <div className={`sensor-dot ${isEStopFault ? 'fault' : ''}`} /> E-Stop Button
          </div>
          <div className="sensor-badge">
            <div className={`sensor-dot ${isAxisFault ? 'fault' : ''}`} /> Axis Limits
          </div>
          <div className="sensor-badge">
            <div className={`sensor-dot ${isSpoolFault ? 'fault' : ''}`} /> Wire Spool
          </div>
        </div>
      </div>

      <div className="safety-section">
        <h4>Active Faults</h4>
        {activeFaults.length === 0 ? (
          <div className="no-faults">No active faults.</div>
        ) : (
          <div className="fault-list">
            {activeFaults.map(fault => (
              <div key={fault.id || fault.code} className="fault-item">
                <div className="fault-info">
                  <span className="fault-code">{fault.code}</span>
                  <span>{fault.message}</span>
                </div>
                <button className="btn sm" onClick={() => clearFault(fault.code)}>Clear</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="safety-section">
        <div className="history-header-row">
          <h4>Fault History</h4>
          <button className="btn-clear-log" onClick={clearLog}>CLEAR LOG</button>
        </div>
        <table className="fault-history-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Code</th>
              <th>Message</th>
              <th>Cleared</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr><td colSpan="4" style={{ textAlign: 'center', color: '#8b949e', fontStyle: 'italic', padding: '16px' }}>No fault history.</td></tr>
            ) : (
              history.map((item, i) => (
                <tr key={i}>
                  <td>{formatTime(item.timestamp)}</td>
                  <td>{item.code}</td>
                  <td>{item.message}</td>
                  <td>{item.cleared ? formatTime(item.cleared) : <span style={{color: '#f85149'}}>Active</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

