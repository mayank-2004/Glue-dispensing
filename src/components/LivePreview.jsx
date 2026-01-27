import { useState, useEffect } from 'react';

export default function LivePreview({
  dispensingSequence = [],
  isJobRunning = false,
  currentPadIndex = -1,
  machinePosition = null,
  onUpdateOverlay = null
}) {
  const [liveData, setLiveData] = useState({
    currentPad: null,
    completedPads: [],
    estimatedTimeRemaining: 0,
    dispensingRate: 0
  });

  useEffect(() => {
    if (!isJobRunning || currentPadIndex < 0) {
      setLiveData({
        currentPad: null,
        completedPads: [],
        estimatedTimeRemaining: 0,
        dispensingRate: 0
      });
      return;
    }

    const currentPad = dispensingSequence[currentPadIndex];
    const completedPads = dispensingSequence.slice(0, currentPadIndex);
    const remainingPads = dispensingSequence.length - currentPadIndex;
    const avgTimePerPad = 3; // seconds
    const estimatedTimeRemaining = remainingPads * avgTimePerPad;
    const dispensingRate = currentPadIndex > 0 ? (currentPadIndex / (Date.now() / 1000)) * 60 : 0;

    setLiveData({
      currentPad,
      completedPads,
      estimatedTimeRemaining,
      dispensingRate: dispensingRate.toFixed(1)
    });

    // Trigger overlay update to show current position
    onUpdateOverlay?.();
  }, [isJobRunning, currentPadIndex, dispensingSequence, onUpdateOverlay]);

  if (!isJobRunning) {
    return (
      <div className="live-preview-panel" style={{
        padding: 12,
        backgroundColor: '#f8f9fa',
        borderRadius: 6,
        border: '1px solid #dee2e6'
      }}>
        <h4 style={{ margin: '0 0 8px 0', color: '#6c757d' }}>🔴 Live Preview (Inactive)</h4>
        <p style={{ margin: 0, fontSize: 12, color: '#6c757d' }}>
          Start a dispensing job to see real-time progress
        </p>
      </div>
    );
  }

  return (
    <div className="live-preview-panel" style={{
      padding: 12,
      backgroundColor: '#e8f5e8',
      borderRadius: 6,
      border: '2px solid #28a745'
    }}>
      <h4 style={{ margin: '0 0 12px 0', color: '#155724' }}>
        🟢 Live Preview - Job Running
      </h4>

      {/* Current Status */}
      <div className="current-status" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 4 }}>
          Current: Pad {currentPadIndex + 1} of {dispensingSequence.length}
        </div>
        
        {liveData.currentPad && (
          <div style={{ fontSize: 12, color: '#495057' }}>
            Position: X{liveData.currentPad.x.toFixed(2)} Y{liveData.currentPad.y.toFixed(2)}mm
            <br />
            Size: {liveData.currentPad.width?.toFixed(2) || 1.0}×{liveData.currentPad.height?.toFixed(2) || 1.0}mm
          </div>
        )}
      </div>

      {/* Progress Bar */}
      <div className="progress-section" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>
          Progress: {Math.round((currentPadIndex / dispensingSequence.length) * 100)}%
        </div>
        <div style={{
          width: '100%',
          height: 8,
          backgroundColor: '#e9ecef',
          borderRadius: 4,
          overflow: 'hidden'
        }}>
          <div style={{
            width: `${(currentPadIndex / dispensingSequence.length) * 100}%`,
            height: '100%',
            backgroundColor: '#28a745',
            transition: 'width 0.5s ease'
          }}></div>
        </div>
      </div>

      {/* Statistics */}
      <div className="live-stats" style={{ 
        display: 'grid', 
        gridTemplateColumns: '1fr 1fr', 
        gap: 8,
        fontSize: 12 
      }}>
        <div>
          <strong>Completed:</strong> {liveData.completedPads.length}
        </div>
        <div>
          <strong>Remaining:</strong> {dispensingSequence.length - currentPadIndex}
        </div>
        <div>
          <strong>ETA:</strong> {Math.floor(liveData.estimatedTimeRemaining / 60)}:{(liveData.estimatedTimeRemaining % 60).toString().padStart(2, '0')}
        </div>
        <div>
          <strong>Rate:</strong> {liveData.dispensingRate} pads/min
        </div>
      </div>

      {/* Machine Position */}
      {machinePosition && (
        <div className="machine-position" style={{
          marginTop: 12,
          padding: 8,
          backgroundColor: '#d4edda',
          borderRadius: 4,
          fontSize: 11
        }}>
          <strong>Machine Position:</strong><br />
          X: {machinePosition.x?.toFixed(3) || 0} Y: {machinePosition.y?.toFixed(3) || 0} Z: {machinePosition.z?.toFixed(3) || 0}
        </div>
      )}
    </div>
  );
}