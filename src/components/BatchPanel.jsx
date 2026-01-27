import { useState, useEffect } from "react";

export default function BatchPanel({ 
  batchProcessor, 
  currentBatch, 
  onBatchSelect,
  onStartBatch,
  onPauseBatch,
  onAddBoard 
}) {
  const [batches, setBatches] = useState([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newBatchName, setNewBatchName] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState(null);

  useEffect(() => {
    if (!batchProcessor) return;
    
    const updateBatches = () => setBatches(batchProcessor.getAllBatches());
    updateBatches();
    
    return batchProcessor.addListener((event, data) => {
      updateBatches();
      if (event === 'batchStarted' || event === 'boardCompleted') {
        // Force re-render for progress updates
        setBatches([...batchProcessor.getAllBatches()]);
      }
    });
  }, [batchProcessor]);

  const handleCreateBatch = () => {
    if (!newBatchName.trim()) return;
    const batchId = batchProcessor.createBatch(newBatchName.trim());
    setNewBatchName('');
    setShowCreateForm(false);
    setSelectedBatchId(batchId);
    onBatchSelect?.(batchId);
  };

  const handleAddCurrentBoard = () => {
    if (!selectedBatchId || !onAddBoard) return;
    onAddBoard(selectedBatchId);
  };

  const handleDeleteBatch = (batchId) => {
    if (!batchProcessor) return;
    
    const batch = batchProcessor.getBatch(batchId);
    if (!batch) return;
    
    const confirmDelete = window.confirm(
      `Are you sure you want to delete batch "${batch.name}"?\n\n` +
      `This will permanently remove the batch and all ${batch.totalBoards} boards.\n` +
      `This action cannot be undone.`
    );
    
    if (confirmDelete) {
      const success = batchProcessor.deleteBatch(batchId);
      if (success) {
        if (selectedBatchId === batchId) {
          setSelectedBatchId(null);
          onBatchSelect?.(null);
        }
        alert('Batch deleted successfully!');
      } else {
        alert('Cannot delete batch: Batch may be currently running.');
      }
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending': return '#6c757d';
      case 'running': return '#007bff';
      case 'paused': return '#ffc107';
      case 'completed': return '#28a745';
      case 'failed': return '#dc3545';
      default: return '#6c757d';
    }
  };

  const formatDuration = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Batch Processing</h3>
        <button 
          className="btn sm" 
          onClick={() => setShowCreateForm(!showCreateForm)}
        >
          + New Batch
        </button>
      </div>

      {showCreateForm && (
        <div className="form-group" style={{ padding: 12, background: '#f8f9fa', margin: '8px 0' }}>
          <input
            type="text"
            placeholder="Batch name"
            value={newBatchName}
            onChange={(e) => setNewBatchName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreateBatch()}
            style={{ marginBottom: 8 }}
          />
          <div className="flex-row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={handleCreateBatch}>Create</button>
            <button className="btn sm secondary" onClick={() => setShowCreateForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="batch-list" style={{ maxHeight: 300, overflowY: 'auto' }}>
        {batches.map(batch => (
          <div 
            key={batch.id} 
            className={`batch-item ${selectedBatchId === batch.id ? 'selected' : ''}`}
            style={{
              padding: 12,
              border: '1px solid #dee2e6',
              borderRadius: 4,
              margin: '8px 0',
              cursor: 'pointer',
              backgroundColor: selectedBatchId === batch.id ? '#e3f2fd' : 'white',
              position: 'relative'
            }}
            onClick={() => {
              setSelectedBatchId(batch.id);
              onBatchSelect?.(batch.id);
            }}
          >
            <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', paddingRight: '32px' }}>
              <div style={{ flex: 1 }}>
                <strong>{batch.name}</strong>
                <div style={{ fontSize: '0.85em', color: '#666' }}>
                  {batch.totalBoards} boards • {batch.statistics.totalPads} pads
                </div>
              </div>
              <div 
                className="status-badge"
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: '0.75em',
                  color: 'white',
                  backgroundColor: getStatusColor(batch.status),
                  marginTop: '2px',
                  flexShrink: 0
                }}
              >
                {batch.status}
              </div>
            </div>

            {batch.status === 'running' && (
              <div style={{ marginTop: 8 }}>
                <div className="progress-bar" style={{
                  width: '100%',
                  height: 4,
                  backgroundColor: '#e9ecef',
                  borderRadius: 2,
                  overflow: 'hidden'
                }}>
                  <div 
                    style={{
                      width: `${(batch.completedBoards / batch.totalBoards) * 100}%`,
                      height: '100%',
                      backgroundColor: '#007bff',
                      transition: 'width 0.3s ease'
                    }}
                  />
                </div>
                <div style={{ fontSize: '0.75em', color: '#666', marginTop: 4 }}>
                  Board {batch.currentBoardIndex + 1} of {batch.totalBoards} • 
                  {batch.statistics.completedPads} / {batch.statistics.totalPads} pads
                </div>
              </div>
            )}

            {batch.status === 'completed' && (
              <div style={{ fontSize: '0.75em', color: '#28a745', marginTop: 4 }}>
                ✓ Completed in {formatDuration(new Date(batch.completedAt) - new Date(batch.startedAt))}
              </div>
            )}
            
            {/* Delete button for each batch */}
            <button 
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteBatch(batch.id);
              }}
              disabled={batch.status === 'running'}
              title={batch.status === 'running' ? 'Cannot delete running batch' : 'Delete batch'}
            >
              🗑️
            </button>
          </div>
        ))}
      </div>

      {selectedBatchId && (
        <div className="batch-controls" style={{ marginTop: 12, padding: 12, background: '#f8f9fa' }}>
          <div className="flex-row" style={{ gap: 8, marginBottom: 8 }}>
            <button 
              className="btn sm"
              onClick={handleAddCurrentBoard}
              disabled={!onAddBoard}
            >
              Add Current Board
            </button>
            {currentBatch?.status === 'pending' && (
              <button 
                className="btn sm primary"
                onClick={() => onStartBatch?.(selectedBatchId)}
              >
                Start Batch
              </button>
            )}
            {currentBatch?.status === 'running' && (
              <button 
                className="btn sm warning"
                onClick={() => onPauseBatch?.(selectedBatchId)}
              >
                Pause Batch
              </button>
            )}
            {currentBatch?.status === 'paused' && (
              <button 
                className="btn sm primary"
                onClick={() => onStartBatch?.(selectedBatchId)}
              >
                Resume Batch
              </button>
            )}
          </div>
          
          {currentBatch && (
            <div style={{ fontSize: '0.85em' }}>
              <div>Status: <strong>{currentBatch.status}</strong></div>
              <div>Progress: {currentBatch.completedBoards} / {currentBatch.totalBoards} boards</div>
              {currentBatch.failedBoards > 0 && (
                <div style={{ color: '#dc3545' }}>Failed: {currentBatch.failedBoards}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}