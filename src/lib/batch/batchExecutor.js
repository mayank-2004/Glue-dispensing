/**
 * Batch Job Executor - Execute dispensing jobs for multiple boards
 */

export class BatchExecutor {
  constructor(serialPanel, dispensingSequencer, pressureController, speedProfileManager) {
    this.serialPanel = serialPanel;
    this.dispensingSequencer = dispensingSequencer;
    this.pressureController = pressureController;
    this.speedProfileManager = speedProfileManager;
    this.isExecuting = false;
    this.currentJob = null;
    this.listeners = new Set();
  }

  // Execute a batch job
  async executeBatch(batch, batchProcessor) {
    if (this.isExecuting) {
      throw new Error('Another batch is already executing');
    }

    this.isExecuting = true;
    this.currentJob = { batchId: batch.id, startTime: Date.now() };

    try {
      console.log('Starting batch execution:', batch.name);
      
      for (let boardIndex = 0; boardIndex < batch.boards.length; boardIndex++) {
        const board = batch.boards[boardIndex];
        
        // Process next board
        const currentBoard = await batchProcessor.processNextBoard(batch.id);
        if (!currentBoard) break;

        console.log(`Processing board ${boardIndex + 1}/${batch.boards.length}:`, board.name);
        
        // Execute board dispensing
        const success = await this.executeBoard(board, batchProcessor);
        
        // Complete board
        const completedPads = success ? board.pads.length : 0;
        batchProcessor.completeBoard(batch.id, board.id, success, completedPads);
        
        if (!success) {
          console.error('Board processing failed:', board.name);
          // Continue with next board or stop based on settings
        }
        
        // Small delay between boards
        await this.delay(1000);
      }
      
      console.log('Batch execution completed');
      
    } catch (error) {
      console.error('Batch execution error:', error);
      throw error;
    } finally {
      this.isExecuting = false;
      this.currentJob = null;
    }
  }

  // Execute dispensing for a single board
  async executeBoard(board, batchProcessor) {
    try {
      // Apply board settings
      if (board.settings?.pressure) {
        this.pressureController.updateSettings(board.settings.pressure);
      }
      if (board.settings?.speed) {
        this.speedProfileManager.updateSettings(board.settings.speed);
      }

      // Generate dispensing sequence for this board
      const sequence = this.dispensingSequencer.calculateOptimalSequence(
        board.position, 
        board.pads
      );

      // Convert to G-code
      const gcode = this.generateGcodeForBoard(board, sequence);
      
      // Execute via serial panel
      return new Promise((resolve) => {
        const originalOnComplete = this.serialPanel.onJobComplete;
        
        this.serialPanel.onJobComplete = () => {
          // Restore original callback
          this.serialPanel.onJobComplete = originalOnComplete;
          resolve(true);
        };
        
        // Start the job
        this.serialPanel.onJobStart(gcode);
      });
      
    } catch (error) {
      console.error('Board execution error:', error);
      return false;
    }
  }

  // Generate G-code for a board
  generateGcodeForBoard(board, sequence) {
    const lines = [];
    
    // Header
    lines.push('; Generated G-code for batch processing');
    lines.push(`; Board: ${board.name}`);
    lines.push(`; Pads: ${board.pads.length}`);
    lines.push('G21 ; Set units to millimeters');
    lines.push('G90 ; Absolute positioning');
    
    // Move to board position
    const boardX = board.position.x;
    const boardY = board.position.y;
    const rotation = board.position.rotation || 0;
    
    lines.push(`; Board position: X${boardX} Y${boardY} R${rotation}`);
    
    // Process each pad in sequence
    sequence.forEach((pad, index) => {
      const x = boardX + pad.x;
      const y = boardY + pad.y;
      
      lines.push(`; Pad ${index + 1}: ${pad.id || `P${index + 1}`}`);
      lines.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} ; Move to pad`);
      lines.push('G0 Z2.0 ; Lower to dispensing height');
      lines.push('M106 S255 ; Start dispensing');
      lines.push('G4 P120 ; Dwell for dispensing');
      lines.push('M107 ; Stop dispensing');
      lines.push('G0 Z6.0 ; Lift nozzle');
    });
    
    // Footer
    lines.push('G0 Z10.0 ; Final lift');
    lines.push('M84 ; Disable motors');
    lines.push('; End of batch board');
    
    return lines.join('\n');
  }

  // Pause current batch execution
  pauseExecution() {
    if (this.isExecuting && this.serialPanel.pauseJob) {
      this.serialPanel.pauseJob();
    }
  }

  // Resume batch execution
  resumeExecution() {
    if (this.isExecuting && this.serialPanel.resumeJob) {
      this.serialPanel.resumeJob();
    }
  }

  // Stop batch execution
  stopExecution() {
    if (this.isExecuting && this.serialPanel.stopJob) {
      this.serialPanel.stopJob();
    }
    this.isExecuting = false;
    this.currentJob = null;
  }

  // Utility delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get execution status
  getStatus() {
    return {
      isExecuting: this.isExecuting,
      currentJob: this.currentJob
    };
  }
}