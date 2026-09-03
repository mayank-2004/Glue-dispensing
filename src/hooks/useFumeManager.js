import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "fumeManager_v1";

export const FUME_STATUS = {
  READY: "READY",
  RUNNING: "RUNNING",
  POST_RUN: "POST_RUN",
  FAULT: "FAULT",
  SERVICE_REQUIRED: "SERVICE_REQUIRED",
  UNKNOWN: "UNKNOWN"
};

const DEFAULT_STATE = {
  status: FUME_STATUS.READY,
  operatingHours: 0,
  airflowLpm: 0, // Liters per minute
  pumpLoadPct: 0, 
  // Config
  postRunDurationSec: 30,
  serviceThresholdHours: 500,
  minAirflowThreshold: 15,
  // Event Log
  eventLog: [] // { type: 'START'|'STOP'|'FAULT'|'SERVICE', time: isoString, detail: string }
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!s) return { ...DEFAULT_STATE };
    return { 
      ...DEFAULT_STATE, 
      ...s, 
      status: s.status === FUME_STATUS.FAULT ? FUME_STATUS.FAULT : FUME_STATUS.READY, // Reset transient states, keep FAULT if stuck
      airflowLpm: 0, 
      pumpLoadPct: 0 
    };
  } catch { return { ...DEFAULT_STATE }; }
}

export function useFumeManager() {
  const [state, setState] = useState(loadState);
  const postRunTimerRef = useRef(null);

  // Persist important data
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      operatingHours: state.operatingHours,
      postRunDurationSec: state.postRunDurationSec,
      serviceThresholdHours: state.serviceThresholdHours,
      minAirflowThreshold: state.minAirflowThreshold,
      eventLog: state.eventLog
    }));
  }, [state.operatingHours, state.postRunDurationSec, state.serviceThresholdHours, state.minAirflowThreshold, state.eventLog]);

  const patch = useCallback((updates) => setState(prev => ({ ...prev, ...updates })), []);

  const logEvent = useCallback((type, detail) => {
    setState(prev => {
      const newEvent = { type, detail, time: new Date().toISOString() };
      const log = [newEvent, ...prev.eventLog].slice(0, 100); // Keep last 100 events
      return { ...prev, eventLog: log };
    });
  }, []);

  // ── Serial Listeners ──
  useEffect(() => {
    const onFumeTelemetry = (e) => {
      const { status, airflow, pumpLoad, hours } = e.detail;
      patch(prev => {
        const nextState = { ...prev };
        if (airflow !== undefined) nextState.airflowLpm = airflow;
        if (pumpLoad !== undefined) nextState.pumpLoadPct = pumpLoad;
        if (hours !== undefined) nextState.operatingHours = hours;
        
        // If the hardware reports FAULT, lock it
        if (status === 'FAULT' && prev.status !== FUME_STATUS.FAULT) {
          nextState.status = FUME_STATUS.FAULT;
          logEvent('FAULT', 'Hardware reported critical fume extraction failure.');
        } else if (status === 'RUNNING' && prev.status === FUME_STATUS.READY) {
          nextState.status = FUME_STATUS.RUNNING;
        }
        
        // Dynamic degraded performance checks
        if (nextState.status === FUME_STATUS.RUNNING) {
           if (nextState.airflowLpm > 0 && nextState.airflowLpm < nextState.minAirflowThreshold) {
               // Log degraded airflow if not recently logged
               const lastDegraded = prev.eventLog.find(ev => ev.type === 'FAULT' && ev.detail.includes('airflow'));
               const isRecent = lastDegraded && (new Date() - new Date(lastDegraded.time)) < 60000;
               if (!isRecent) logEvent('FAULT', `Degraded airflow detected: ${nextState.airflowLpm} LPM (Threshold: ${nextState.minAirflowThreshold})`);
           }
        }

        return nextState;
      });
    };

    const onHardwareFault = (e) => {
      if (e.detail?.code === 'E002') { // FUME_FAIL
        patch({ status: FUME_STATUS.FAULT });
        logEvent('FAULT', `Safety System Interlock: ${e.detail.message}`);
      }
    };

    window.addEventListener('fume-telemetry', onFumeTelemetry);
    window.addEventListener('hardware-fault', onHardwareFault);
    return () => {
      window.removeEventListener('fume-telemetry', onFumeTelemetry);
      window.removeEventListener('hardware-fault', onHardwareFault);
    };
  }, [patch, logEvent]);

  // ── Periodic Filter Checks ──
  useEffect(() => {
    if (state.operatingHours >= state.serviceThresholdHours && state.status !== FUME_STATUS.FAULT) {
      if (state.status !== FUME_STATUS.SERVICE_REQUIRED) {
         patch({ status: FUME_STATUS.SERVICE_REQUIRED });
         logEvent('SERVICE', `Filter reached service threshold (${state.operatingHours.toFixed(1)} / ${state.serviceThresholdHours} hrs)`);
      }
    }
  }, [state.operatingHours, state.serviceThresholdHours, state.status, patch, logEvent]);

  // ── Commands ──
  const startExtraction = useCallback(async () => {
    if (state.status === FUME_STATUS.FAULT) return;
    
    if (postRunTimerRef.current) {
      clearTimeout(postRunTimerRef.current);
      postRunTimerRef.current = null;
    }

    patch({ status: FUME_STATUS.RUNNING });
    logEvent('START', 'Fume extraction started for soldering cycle.');
    
    try {
      if (window.serial?.writeLine) await window.serial.writeLine("M800"); // Custom: Fume Extractor ON
    } catch (e) {
      console.error(e);
    }
  }, [state.status, patch, logEvent]);

  const stopExtraction = useCallback(() => {
    if (state.status === FUME_STATUS.FAULT) return;
    if (state.status === FUME_STATUS.READY) return; // Already stopped
    
    const delayMs = state.postRunDurationSec * 1000;
    
    if (delayMs > 0) {
      patch({ status: FUME_STATUS.POST_RUN });
      logEvent('STOP', `Entering post-run phase for ${state.postRunDurationSec}s`);
      
      if (postRunTimerRef.current) clearTimeout(postRunTimerRef.current);
      postRunTimerRef.current = setTimeout(async () => {
        patch(prev => ({ status: prev.operatingHours >= prev.serviceThresholdHours ? FUME_STATUS.SERVICE_REQUIRED : FUME_STATUS.READY }));
        logEvent('STOP', 'Post-run complete. Extractor off.');
        try { if (window.serial?.writeLine) await window.serial.writeLine("M801"); } catch(e){}
      }, delayMs);
    } else {
      patch(prev => ({ status: prev.operatingHours >= prev.serviceThresholdHours ? FUME_STATUS.SERVICE_REQUIRED : FUME_STATUS.READY }));
      logEvent('STOP', 'Extractor off.');
      try { if (window.serial?.writeLine) window.serial.writeLine("M801"); } catch(e){}
    }
  }, [state.status, state.postRunDurationSec, state.operatingHours, state.serviceThresholdHours, patch, logEvent]);

  const resetFault = useCallback(() => {
    patch(prev => ({ 
      status: prev.operatingHours >= prev.serviceThresholdHours ? FUME_STATUS.SERVICE_REQUIRED : FUME_STATUS.READY 
    }));
    logEvent('SERVICE', 'Operator reset fume fault.');
  }, [patch, logEvent]);

  const markFilterReplaced = useCallback(() => {
    patch({ operatingHours: 0, status: FUME_STATUS.READY });
    logEvent('SERVICE', 'HEPA Filter replaced. Hours reset.');
  }, [patch, logEvent]);

  const setConfig = useCallback((key, value) => {
    patch({ [key]: value });
  }, [patch]);

  const validateForRun = useCallback(() => {
    const issues = [];
    if (state.status === FUME_STATUS.FAULT) {
      issues.push("Fume extractor has a critical fault. Reset required.");
    }
    // Note: SERVICE_REQUIRED allows running but shows warning.
    return { valid: issues.length === 0, issues };
  }, [state.status]);

  return {
    ...state,
    startExtraction,
    stopExtraction,
    resetFault,
    markFilterReplaced,
    setConfig,
    validateForRun
  };
}
