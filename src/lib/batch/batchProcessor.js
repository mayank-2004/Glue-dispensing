/**
 * Batch Processing Manager - Handle multiple board dispensing jobs
 */

export class BatchProcessor {
  constructor() {
    this.batches = new Map();
    this.currentBatchId = null;
    this.isProcessing = false;
    this.listeners = new Set();
  }

  // Create new batch
  createBatch(name, boards = []) {
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const batch = {
      id: batchId,
      name,
      boards,
      status: 'pending', // pending, running, paused, completed, failed
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      currentBoardIndex: 0,
      totalBoards: boards.length,
      completedBoards: 0,
      failedBoards: 0,
      statistics: {
        totalPads: 0,
        completedPads: 0,
        totalTime: 0,
        estimatedTime: 0
      }
    };
    
    this.batches.set(batchId, batch);
    this.notifyListeners('batchCreated', batch);
    return batchId;
  }

  // Add board to batch
  addBoard(batchId, board) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status === 'running') return false;
    
    batch.boards.push({
      id: `board_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: board.name || `Board ${batch.boards.length + 1}`,
      gerberFiles: board.gerberFiles,
      pads: board.pads || [],
      fiducials: board.fiducials || [],
      settings: board.settings || {},
      position: board.position || { x: 0, y: 0, rotation: 0 },
      status: 'pending', // pending, processing, completed, failed, skipped
      startTime: null,
      endTime: null,
      padCount: board.pads?.length || 0,
      completedPads: 0
    });
    
    batch.totalBoards = batch.boards.length;
    this.updateBatchStatistics(batchId);
    this.notifyListeners('boardAdded', { batchId, board: batch.boards[batch.boards.length - 1] });
    return true;
  }

  // Start batch processing
  async startBatch(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status === 'running' || this.isProcessing) return false;
    
    batch.status = 'running';
    batch.startedAt = new Date();
    batch.currentBoardIndex = 0;
    this.currentBatchId = batchId;
    this.isProcessing = true;
    
    this.notifyListeners('batchStarted', batch);
    return true;
  }

  // Process next board in batch
  async processNextBoard(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status !== 'running') return null;
    
    if (batch.currentBoardIndex >= batch.boards.length) {
      return this.completeBatch(batchId);
    }
    
    const currentBoard = batch.boards[batch.currentBoardIndex];
    currentBoard.status = 'processing';
    currentBoard.startTime = new Date();
    
    this.notifyListeners('boardStarted', { batchId, board: currentBoard });
    return currentBoard;
  }

  // Complete current board and move to next
  completeBoard(batchId, boardId, success = true, completedPads = 0) {
    const batch = this.batches.get(batchId);
    if (!batch) return false;
    
    const board = batch.boards.find(b => b.id === boardId);
    if (!board) return false;
    
    board.status = success ? 'completed' : 'failed';
    board.endTime = new Date();
    board.completedPads = completedPads;
    
    if (success) {
      batch.completedBoards++;
    } else {
      batch.failedBoards++;
    }
    
    batch.currentBoardIndex++;
    this.updateBatchStatistics(batchId);
    
    this.notifyListeners('boardCompleted', { 
      batchId, 
      board, 
      success,
      isLastBoard: batch.currentBoardIndex >= batch.boards.length 
    });
    
    return true;
  }

  // Update batch statistics
  updateBatchStatistics(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    
    batch.statistics.totalPads = batch.boards.reduce((sum, board) => sum + board.padCount, 0);
    batch.statistics.completedPads = batch.boards.reduce((sum, board) => sum + board.completedPads, 0);
  }

  // Get batch info
  getBatch(batchId) {
    return this.batches.get(batchId);
  }

  // Get all batches
  getAllBatches() {
    return Array.from(this.batches.values());
  }

  // Pause batch processing
  pauseBatch(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status !== 'running') return false;
    
    batch.status = 'paused';
    this.isProcessing = false;
    this.notifyListeners('batchPaused', batch);
    return true;
  }

  // Resume batch processing
  resumeBatch(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status !== 'paused') return false;
    
    batch.status = 'running';
    this.isProcessing = true;
    this.notifyListeners('batchResumed', batch);
    return true;
  }

  // Complete batch
  completeBatch(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return false;
    
    batch.status = 'completed';
    batch.completedAt = new Date();
    this.isProcessing = false;
    this.currentBatchId = null;
    
    this.notifyListeners('batchCompleted', batch);
    return batch;
  }

  // Delete batch
  deleteBatch(batchId) {
    if (this.currentBatchId === batchId && this.isProcessing) return false;
    
    const deleted = this.batches.delete(batchId);
    if (deleted) {
      this.notifyListeners('batchDeleted', { batchId });
    }
    return deleted;
  }

  // Event listeners
  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners(event, data) {
    this.listeners.forEach(callback => {
      try {
        callback(event, data);
      } catch (error) {
        console.error('Batch processor listener error:', error);
      }
    });
  }
}