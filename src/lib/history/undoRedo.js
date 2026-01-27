// Undo/Redo functionality for application state
export class UndoRedoManager {
  constructor(maxHistorySize = 50) {
    this.history = [];
    this.currentIndex = -1;
    this.maxHistorySize = maxHistorySize;
  }

  // Save current state
  saveState(state, action = 'unknown') {
    // Remove any future states if we're not at the end
    if (this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    // Add new state
    this.history.push({
      state: this.deepClone(state),
      action,
      timestamp: Date.now()
    });

    // Limit history size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    } else {
      this.currentIndex++;
    }
  }

  // Undo to previous state
  undo() {
    if (!this.canUndo()) return null;
    
    this.currentIndex--;
    return this.deepClone(this.history[this.currentIndex].state);
  }

  // Redo to next state
  redo() {
    if (!this.canRedo()) return null;
    
    this.currentIndex++;
    return this.deepClone(this.history[this.currentIndex].state);
  }

  // Check if undo is possible
  canUndo() {
    return this.currentIndex > 0;
  }

  // Check if redo is possible
  canRedo() {
    return this.currentIndex < this.history.length - 1;
  }

  // Get current action description
  getCurrentAction() {
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length) {
      return this.history[this.currentIndex].action;
    }
    return null;
  }

  // Get next undo action
  getUndoAction() {
    if (this.canUndo()) {
      return this.history[this.currentIndex - 1].action;
    }
    return null;
  }

  // Get next redo action
  getRedoAction() {
    if (this.canRedo()) {
      return this.history[this.currentIndex + 1].action;
    }
    return null;
  }

  // Clear history
  clear() {
    this.history = [];
    this.currentIndex = -1;
  }

  // Deep clone object
  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof Array) return obj.map(item => this.deepClone(item));
    if (typeof obj === 'object') {
      const cloned = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          cloned[key] = this.deepClone(obj[key]);
        }
      }
      return cloned;
    }
  }

  // Get history summary
  getHistorySummary() {
    return {
      totalStates: this.history.length,
      currentIndex: this.currentIndex,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoAction: this.getUndoAction(),
      redoAction: this.getRedoAction()
    };
  }
}