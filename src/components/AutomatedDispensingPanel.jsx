import { useState } from 'react';

export default function AutomatedDispensingPanel({
  dispensingSequencer,
  dispensingSequence,
  safeSequence,
  jobStatistics,
  referencePoint,
  selectedOrigin,
  pressureSettings,
  speedSettings,
  boardOutline,
  useSafePathPlanning,
  setUseSafePathPlanning,
  componentHeights,
  setComponentHeights,
  safePathPlanner,
  onStartJob,
  onDownloadGCode,
  batchProcessor,
  currentBatch,
  onStartBatch
}) {
  const [isJobRunning, setIsJobRunning] = useState(false);
  const [currentPadIndex, setCurrentPadIndex] = useState(0);
  const [jobMode, setJobMode] = useState('single'); // 'single' or 'batch'

  const refPoint = referencePoint || selectedOrigin;

  const handleStartAutomatedJob = () => {
    if (!refPoint || dispensingSequence.length === 0) return;
    
    setIsJobRunning(true);
    setCurrentPadIndex(0);
    
    // Generate G-code based on path planning mode
    const gcode = useSafePathPlanning && safeSequence.length > 0 ?
      safePathPlanner.generateSafeGCode(refPoint, safeSequence, { pressureSettings, speedSettings }) :
      dispensingSequencer.generateDispensingGCode(refPoint, dispensingSequence, { pressureSettings, speedSettings });
    
    if (onStartJob) {
      onStartJob(gcode, dispensingSequence);
    }
  };

  const handleDownloadGCode = () => {
    if (!refPoint || dispensingSequence.length === 0) return;
    
    const gcode = useSafePathPlanning && safeSequence.length > 0 ?
      safePathPlanner.generateSafeGCode(refPoint, safeSequence, { pressureSettings, speedSettings }) :
      dispensingSequencer.generateDispensingGCode(refPoint, dispensingSequence, { pressureSettings, speedSettings });
    
    const filename = useSafePathPlanning ? 'safe_dispensing_job.gcode' : 'dispensing_job.gcode';
    
    const blob = new Blob([gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStopJob = () => {
    setIsJobRunning(false);
    setCurrentPadIndex(0);
  };

  return (
    <div className="linear-panel">
      <h3>🤖 Automated Dispensing</h3>
      
      {/* Path Planning Mode */}
      <div className="box">
        <h4>Path Planning Mode</h4>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input 
            type="checkbox" 
            checked={useSafePathPlanning} 
            onChange={(e) => setUseSafePathPlanning(e.target.checked)}
          />
          <span>Enable Safe Path Planning (Collision Avoidance)</span>
        </label>
        <small style={{ color: '#666', marginTop: '4px', display: 'block' }}>
          {useSafePathPlanning ? 
            'Uses 3D path planning with safe Z-heights to avoid component collisions' :
            'Uses simple nearest neighbor algorithm (faster but no collision avoidance)'
          }
        </small>
      </div>

      {/* Job Statistics */}
      {jobStatistics && (
        <div className="box">
          <h4>Job Overview</h4>
          <div className="grid2">
            <div>
              <strong>Total Pads:</strong> {jobStatistics.totalPads}
            </div>
            <div>
              <strong>Total Distance:</strong> {jobStatistics.totalDistance} mm
            </div>
            <div>
              <strong>Estimated Time:</strong> {jobStatistics.estimatedTime} min
            </div>
            <div>
              <strong>Avg Distance:</strong> {jobStatistics.averageDistance} mm
            </div>
            {useSafePathPlanning && jobStatistics.safePathsUsed !== undefined && (
              <>
                <div>
                  <strong>Safe Paths:</strong> {jobStatistics.safePathsUsed}
                </div>
                <div>
                  <strong>High Clearance:</strong> {jobStatistics.highClearancePaths}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Board Information */}
      {boardOutline && (
        <div className="box">
          <h4>Board Dimensions</h4>
          <div className="grid2">
            <div>
              <strong>Width:</strong> {boardOutline.width.toFixed(2)} mm
            </div>
            <div>
              <strong>Height:</strong> {boardOutline.height.toFixed(2)} mm
            </div>
            <div>
              <strong>Center:</strong> ({boardOutline.centerX.toFixed(2)}, {boardOutline.centerY.toFixed(2)})
            </div>
            <div>
              <strong>Area:</strong> {(boardOutline.width * boardOutline.height).toFixed(1)} mm²
            </div>
          </div>
        </div>
      )}

      {/* Reference Point Status */}
      <div className="box">
        <h4>Reference Point</h4>
        {refPoint ? (
          <div>
            <strong>{referencePoint ? `Fiducial ${referencePoint.id}` : 'Top-Left Origin'}:</strong>
            <br />
            Position: ({refPoint.x.toFixed(3)}, {refPoint.y.toFixed(3)}) mm
          </div>
        ) : (
          <div style={{ color: '#dc3545' }}>
            ⚠️ No reference point selected. Please select an origin or fiducial.
          </div>
        )}
      </div>

      {/* Dispensing Sequence Preview */}
      {dispensingSequence.length > 0 && (
        <div className="box">
          <h4>Dispensing Sequence ({dispensingSequence.length} pads)</h4>
          <div style={{ maxHeight: '200px', overflowY: 'auto', fontSize: '12px' }}>
            {dispensingSequence.slice(0, 10).map((pad, index) => (
              <div key={index} style={{ 
                padding: '4px 8px', 
                backgroundColor: currentPadIndex === index && isJobRunning ? '#e3f2fd' : 'transparent',
                borderLeft: currentPadIndex === index && isJobRunning ? '3px solid #2196f3' : 'none'
              }}>
                <strong>{index + 1}.</strong> {pad.id || `Pad ${index + 1}`} 
                ({pad.x.toFixed(2)}, {pad.y.toFixed(2)}) 
                - {(pad.pathDistance || pad.distanceFromPrevious || 0).toFixed(1)}mm
                {useSafePathPlanning && pad.requiresHighClearance && (
                  <span style={{ color: '#ff6600', marginLeft: '4px' }}>⚠️ High clearance</span>
                )}
                {useSafePathPlanning && pad.safePath && (
                  <span style={{ color: '#666', marginLeft: '4px' }}>({pad.safePath.pathType})</span>
                )}
              </div>
            ))}
            {dispensingSequence.length > 10 && (
              <div style={{ padding: '4px 8px', fontStyle: 'italic', color: '#666' }}>
                ... and {dispensingSequence.length - 10} more pads
              </div>
            )}
          </div>
        </div>
      )}

      {/* Job Mode Selection */}
      <div className="box">
        <h4>Job Mode</h4>
        <div className="flex-row" style={{ gap: 16 }}>
          <label>
            <input 
              type="radio" 
              name="jobMode" 
              value="single" 
              checked={jobMode === 'single'}
              onChange={(e) => setJobMode(e.target.value)}
            />
            Single Board
          </label>
          <label>
            <input 
              type="radio" 
              name="jobMode" 
              value="batch" 
              checked={jobMode === 'batch'}
              onChange={(e) => setJobMode(e.target.value)}
            />
            Batch Processing
          </label>
        </div>
      </div>

      {/* Batch Status */}
      {jobMode === 'batch' && currentBatch && (
        <div className="box">
          <h4>Current Batch: {currentBatch.name}</h4>
          <div className="grid2">
            <div>
              <strong>Total Boards:</strong> {currentBatch.totalBoards}
            </div>
            <div>
              <strong>Completed:</strong> {currentBatch.completedBoards}
            </div>
            <div>
              <strong>Failed:</strong> {currentBatch.failedBoards}
            </div>
            <div>
              <strong>Status:</strong> 
              <span style={{ 
                color: currentBatch.status === 'completed' ? '#28a745' : 
                       currentBatch.status === 'running' ? '#007bff' : 
                       currentBatch.status === 'failed' ? '#dc3545' : '#6c757d'
              }}>
                {currentBatch.status.toUpperCase()}
              </span>
            </div>
          </div>
          {currentBatch.status === 'running' && (
            <div style={{ marginTop: 8 }}>
              <div style={{ 
                width: '100%', 
                height: '6px', 
                backgroundColor: '#e9ecef', 
                borderRadius: '3px',
                overflow: 'hidden'
              }}>
                <div style={{
                  width: `${(currentBatch.completedBoards / currentBatch.totalBoards) * 100}%`,
                  height: '100%',
                  backgroundColor: '#007bff',
                  transition: 'width 0.3s ease'
                }} />
              </div>
              <small style={{ color: '#666', marginTop: '4px', display: 'block' }}>
                Processing Board {currentBatch.currentBoardIndex + 1} of {currentBatch.totalBoards}
              </small>
            </div>
          )}
        </div>
      )}

      {/* Job Controls */}
      <div className="controls">
        {jobMode === 'single' ? (
          <button 
            className="btn" 
            onClick={handleStartAutomatedJob}
            disabled={!refPoint || dispensingSequence.length === 0 || isJobRunning}
          >
            {isJobRunning ? '🔄 Job Running...' : 
             useSafePathPlanning ? '🛡️ Start Safe Dispensing Job' : '▶️ Start Automated Job'}
          </button>
        ) : (
          <button 
            className="btn" 
            onClick={() => currentBatch && onStartBatch && onStartBatch(currentBatch.id)}
            disabled={!currentBatch || currentBatch.status === 'running' || currentBatch.boards.length === 0}
          >
            {currentBatch?.status === 'running' ? '🔄 Batch Running...' : '🚀 Start Batch Job'}
          </button>
        )}
        
        {isJobRunning && (
          <button className="btn secondary" onClick={handleStopJob}>
            ⏹️ Stop Job
          </button>
        )}
        
        <button 
          className="btn secondary" 
          onClick={handleDownloadGCode}
          disabled={!refPoint || dispensingSequence.length === 0}
        >
          💾 Download {useSafePathPlanning ? 'Safe ' : ''}G-Code
        </button>
      </div>

      {/* Job Progress */}
      {isJobRunning && (
        <div className="box">
          <h4>Job Progress</h4>
          <div style={{ marginBottom: '8px' }}>
            <strong>Current Pad:</strong> {currentPadIndex + 1} of {dispensingSequence.length}
          </div>
          <div style={{ 
            width: '100%', 
            height: '8px', 
            backgroundColor: '#e9ecef', 
            borderRadius: '4px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${((currentPadIndex + 1) / dispensingSequence.length) * 100}%`,
              height: '100%',
              backgroundColor: '#28a745',
              transition: 'width 0.3s ease'
            }} />
          </div>
          <small style={{ color: '#666', marginTop: '4px', display: 'block' }}>
            {Math.round(((currentPadIndex + 1) / dispensingSequence.length) * 100)}% Complete
          </small>
        </div>
      )}

      {/* Warnings */}
      {jobMode === 'single' && !refPoint && (
        <div className="collision-warning">
          <strong>⚠️ Setup Required:</strong> Please select a reference point (origin or fiducial) before starting automated dispensing.
        </div>
      )}
      
      {jobMode === 'batch' && !currentBatch && (
        <div className="collision-warning">
          <strong>⚠️ No Batch Selected:</strong> Please create and select a batch from the Batch Panel before starting batch processing.
        </div>
      )}
      
      {jobMode === 'batch' && currentBatch && currentBatch.boards.length === 0 && (
        <div className="collision-warning">
          <strong>⚠️ Empty Batch:</strong> Please add boards to the batch before starting batch processing.
        </div>
      )}
      
      {dispensingSequence.length === 0 && refPoint && (
        <div className="collision-warning">
          <strong>⚠️ No Pads:</strong> No pads available for dispensing. Please load a solderpaste layer.
        </div>
      )}
    </div>
  );
}