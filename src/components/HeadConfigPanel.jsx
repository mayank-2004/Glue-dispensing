import React, { useState, useEffect } from 'react';
import './HeadConfigPanel.css';

export default function HeadConfigPanel({ payloadManager }) {
  const {
    configuredPayload,
    maxPayload,
    warningThreshold,
    setWarningThreshold,
    payloadStatus,
    lastSyncTime,
    lastConfirmedPayload,
    setPayload,
    syncWithController
  } = payloadManager;

  const [inputPayload, setInputPayload] = useState(configuredPayload.toString());
  const [inputThreshold, setInputThreshold] = useState(warningThreshold.toString());
  const [error, setError] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingPayload, setPendingPayload] = useState(null);

  // Keep input in sync with external changes (e.g. initial load)
  useEffect(() => {
    setInputPayload(configuredPayload.toString());
  }, [configuredPayload]);

  useEffect(() => {
    setInputThreshold(warningThreshold.toString());
  }, [warningThreshold]);

  const handleSavePayload = async () => {
    setError(null);
    const val = parseFloat(inputPayload);
    
    if (isNaN(val) || val < 0) {
      setError('Invalid payload value');
      return;
    }
    
    if (val > maxPayload) {
      setError(`Value exceeds maximum capacity (${maxPayload} kg)`);
      return;
    }

    // Check for significant deviation (>10% change from last confirmed OR crosses threshold)
    const deviation = lastConfirmedPayload !== null ? Math.abs(val - lastConfirmedPayload) / lastConfirmedPayload : 0;
    const isSignificantChange = lastConfirmedPayload !== null && deviation > 0.1;
    const isNowWarning = val >= warningThreshold;
    
    if (isSignificantChange || isNowWarning) {
      setPendingPayload(val);
      setShowConfirm(true);
      return;
    }

    applyPayload(val);
  };

  const applyPayload = async (val) => {
    const res = await setPayload(val);
    if (!res.success) {
      setError(res.error);
    }
  };

  const handleConfirmSave = () => {
    setShowConfirm(false);
    if (pendingPayload !== null) {
      applyPayload(pendingPayload);
      setPendingPayload(null);
    }
  };

  const handleSaveThreshold = () => {
    const val = parseFloat(inputThreshold);
    if (!isNaN(val) && val >= 0 && val <= maxPayload) {
      setWarningThreshold(val);
    }
  };

  const margin = maxPayload - configuredPayload;
  const marginPct = (margin / maxPayload) * 100;
  const usedPct = (configuredPayload / maxPayload) * 100;

  const statusColors = {
    NORMAL: '#3fb950',
    NEAR_LIMIT: '#d29922',
    OVER_LIMIT: '#f85149'
  };

  return (
    <div className="panel head-config-panel">
      <h3>Head Configuration & Payload</h3>

      <div className="box">
        <legend>Payload Status</legend>
        
        <div className="payload-status-row">
          <div className="payload-metric">
            <span className="label">Status</span>
            <div 
              className="status-pill"
              style={{ backgroundColor: statusColors[payloadStatus] || '#8b949e' }}
            >
              {payloadStatus.replace('_', ' ')}
            </div>
          </div>
          
          <div className="payload-metric">
            <span className="label">Remaining Margin</span>
            <span className="value">{margin.toFixed(2)} kg ({marginPct.toFixed(0)}%)</span>
          </div>
          
          <div className="payload-metric">
            <span className="label">Max Capacity</span>
            <span className="value">{maxPayload.toFixed(2)} kg</span>
          </div>
        </div>

        <div className="payload-bar-container">
          <div 
            className="payload-bar-fill" 
            style={{ 
              width: `${Math.min(100, usedPct)}%`,
              backgroundColor: statusColors[payloadStatus] 
            }} 
          />
          <div 
            className="payload-threshold-marker" 
            style={{ left: `${(warningThreshold / maxPayload) * 100}%` }}
            title={`Warning Threshold: ${warningThreshold} kg`}
          />
        </div>
        <div className="payload-bar-labels">
          <span>0 kg</span>
          <span>{maxPayload} kg</span>
        </div>
      </div>

      <div className="box">
        <legend>Configuration</legend>
        
        <div className="config-row">
          <label>
            <span>Configured Payload (kg)</span>
            <div className="input-group">
              <input 
                type="number" 
                step="0.01"
                min="0"
                max={maxPayload}
                value={inputPayload}
                onChange={e => {
                  setInputPayload(e.target.value);
                  setError(null);
                }}
              />
              <button 
                className="btn primary sm" 
                onClick={handleSavePayload}
                disabled={parseFloat(inputPayload) > maxPayload || inputPayload === configuredPayload.toString()}
              >
                Apply
              </button>
            </div>
          </label>
        </div>

        {error && <div className="error-text">{error}</div>}

        <div className="config-row" style={{ marginTop: 16 }}>
          <label>
            <span>Warning Threshold (kg)</span>
            <div className="input-group">
              <input 
                type="number" 
                step="0.01"
                min="0"
                max={maxPayload}
                value={inputThreshold}
                onChange={e => setInputThreshold(e.target.value)}
              />
              <button 
                className="btn secondary sm" 
                onClick={handleSaveThreshold}
                disabled={inputThreshold === warningThreshold.toString()}
              >
                Set
              </button>
            </div>
          </label>
          <div className="help-text">Trigger a warning when payload exceeds this value.</div>
        </div>
      </div>

      <div className="box">
        <legend>Embedded Synchronization</legend>
        <div className="sync-info">
          <div>
            <span className="label">Last Confirmed: </span>
            <span className="value">
              {lastConfirmedPayload !== null ? `${lastConfirmedPayload.toFixed(2)} kg` : 'Unconfirmed'}
            </span>
          </div>
          <div>
            <span className="label">Last Sync: </span>
            <span className="value">
              {lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString() : 'Never'}
            </span>
          </div>
          <button className="btn secondary sm" onClick={syncWithController}>
            Force Sync
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h4>Confirm Payload Change</h4>
            <p>
              You are about to change the payload to <strong>{pendingPayload} kg</strong>.
              This is a significant change or approaches the maximum limit.
            </p>
            <div className="modal-actions">
              <button className="btn primary" onClick={handleConfirmSave}>Confirm & Apply</button>
              <button className="btn secondary" onClick={() => setShowConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

