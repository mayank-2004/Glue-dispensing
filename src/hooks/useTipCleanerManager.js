import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "tipCleanerManager_v1";

export const CLEANER_STATUS = {
  IDLE: "IDLE",
  CLEANING: "CLEANING",
  FAULT: "FAULT",
  CLEANING_REQUIRED: "CLEANING_REQUIRED",
};

const DEFAULT_STATE = {
  status: CLEANER_STATUS.IDLE,
  padsSinceLastClean: 0,
  totalCleans: 0,
  lastCleanTime: null,
  cleanIntervalPads: 500, // Configurable threshold
  eventLog: [] // { type: 'START'|'DONE'|'FAIL'|'REQUIRED', time: ISO, reason: string }
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!s) return { ...DEFAULT_STATE };
    return { 
      ...DEFAULT_STATE, 
      ...s, 
      status: s.status === CLEANER_STATUS.FAULT ? CLEANER_STATUS.FAULT : CLEANER_STATUS.IDLE
    };
  } catch { return { ...DEFAULT_STATE }; }
}

export function useTipCleanerManager() {
  const [state, setState] = useState(loadState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      padsSinceLastClean: state.padsSinceLastClean,
      totalCleans: state.totalCleans,
      lastCleanTime: state.lastCleanTime,
      cleanIntervalPads: state.cleanIntervalPads,
      eventLog: state.eventLog
    }));
  }, [state.padsSinceLastClean, state.totalCleans, state.lastCleanTime, state.cleanIntervalPads, state.eventLog]);

  const patch = useCallback((updates) => setState(prev => ({ ...prev, ...updates })), []);

  const logEvent = useCallback((type, reason) => {
    setState(prev => {
      const newEvent = { type, reason, time: new Date().toISOString() };
      const log = [newEvent, ...prev.eventLog].slice(0, 100);
      return { ...prev, eventLog: log };
    });
  }, []);

  // ── Serial Listeners ──
  useEffect(() => {
    const onTipCleanEvent = (e) => {
      const { phase, message } = e.detail;
      
      if (phase === "START") {
        patch({ status: CLEANER_STATUS.CLEANING });
        logEvent('START', message || 'Cleaning cycle started');
      } else if (phase === "DONE") {
        patch(prev => ({ 
          status: CLEANER_STATUS.IDLE,
          padsSinceLastClean: 0,
          totalCleans: prev.totalCleans + 1,
          lastCleanTime: new Date().toISOString()
        }));
        logEvent('DONE', 'Cleaning completed successfully');
      } else if (phase === "FAIL") {
        patch({ status: CLEANER_STATUS.FAULT });
        logEvent('FAIL', message || 'Cleaning mechanism reported a fault');
      }
    };

    window.addEventListener('tip-clean-event', onTipCleanEvent);
    return () => {
      window.removeEventListener('tip-clean-event', onTipCleanEvent);
    };
  }, [patch, logEvent]);

  // ── Periodic Checks ──
  useEffect(() => {
    if (state.padsSinceLastClean >= state.cleanIntervalPads && state.status === CLEANER_STATUS.IDLE) {
      patch({ status: CLEANER_STATUS.CLEANING_REQUIRED });
      logEvent('REQUIRED', `Cleaning interval reached (${state.padsSinceLastClean} pads)`);
    }
  }, [state.padsSinceLastClean, state.cleanIntervalPads, state.status, patch, logEvent]);

  // ── API ──
  const triggerClean = useCallback((reason = 'Manual request') => {
    return new Promise(async (resolve, reject) => {
      if (state.status === CLEANER_STATUS.FAULT) return reject(new Error("Tip cleaner is in FAULT state"));
      
      patch({ status: CLEANER_STATUS.CLEANING });
      logEvent('START', `Triggered: ${reason}`);
      
      const onEvent = (e) => {
        const { phase } = e.detail;
        if (phase === "DONE") {
          window.removeEventListener('tip-clean-event', onEvent);
          resolve();
        } else if (phase === "FAIL") {
          window.removeEventListener('tip-clean-event', onEvent);
          reject(new Error("Cleaning failed"));
        }
      };
      window.addEventListener('tip-clean-event', onEvent);
      
      try {
        if (window.serial?.writeLine) {
          await window.serial.writeLine("M720"); 
        }
      } catch (e) {
        window.removeEventListener('tip-clean-event', onEvent);
        patch({ status: CLEANER_STATUS.FAULT });
        logEvent('FAIL', 'Failed to send clean command to hardware');
        reject(e);
      }
    });
  }, [state.status, patch, logEvent]);

  const recordPadDispensed = useCallback(() => {
    setState(prev => ({ ...prev, padsSinceLastClean: prev.padsSinceLastClean + 1 }));
  }, []);

  const resetFault = useCallback(() => {
    patch(prev => ({ 
      status: prev.padsSinceLastClean >= prev.cleanIntervalPads ? CLEANER_STATUS.CLEANING_REQUIRED : CLEANER_STATUS.IDLE 
    }));
    logEvent('DONE', 'Operator reset tip cleaner fault.');
  }, [patch, logEvent]);

  const setConfig = useCallback((key, value) => {
    patch({ [key]: value });
  }, [patch]);

  const validateForRun = useCallback(() => {
    const issues = [];
    if (state.status === CLEANER_STATUS.FAULT) {
      issues.push("Tip cleaner mechanism is in FAULT state.");
    }
    if (state.status === CLEANER_STATUS.CLEANING_REQUIRED) {
      issues.push(`Mandatory cleaning required (>${state.cleanIntervalPads} pads).`);
    }
    return { valid: issues.length === 0, issues };
  }, [state.status, state.cleanIntervalPads]);

  return {
    ...state,
    triggerClean,
    recordPadDispensed,
    resetFault,
    setConfig,
    validateForRun
  };
}
