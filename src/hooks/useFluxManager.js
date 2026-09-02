import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "fluxManager_v1";

// Flux level states
export const FLUX_LEVEL = {
  NORMAL:           "NORMAL",
  LOW:              "LOW",
  EMPTY:            "EMPTY",
  REFILL_REQUIRED:  "REFILL_REQUIRED",
  CLEANING_REQUIRED:"CLEANING_REQUIRED",
  UNKNOWN:          "UNKNOWN",
};

// Cleaning states
export const CLEAN_STATE = {
  IDLE:      "IDLE",
  RUNNING:   "RUNNING",
  COMPLETE:  "COMPLETE",
  FAILED:    "FAILED",
};

// Dispense states
export const DISPENSE_STATE = {
  IDLE:      "IDLE",
  DISPENSING:"DISPENSING",
  CLEANING:  "CLEANING",
  PAUSED:    "PAUSED",
};

const DEFAULT_STATE = {
  // Level tracking from encoder feedback
  levelPct:         100,      // 0–100 from embedded encoder
  levelState:       FLUX_LEVEL.UNKNOWN,
  // Cleaning
  cleanState:       CLEAN_STATE.IDLE,
  lastCleanedAt:    null,
  cleanCycleCount:  0,
  // Dispense
  dispenseState:    DISPENSE_STATE.IDLE,
  lastDispensedAt:  null,
  totalDispenseCount: 0,
  lastSprayStatus:  null, // null, "SUCCESS", or "FAILED"
  // Config
  lowThresholdPct:  20,
  cleanAfterCycles: 10,       // Auto-clean after this many dispense cycles
  // Manual mode
  sourceIsReliable: false,    // true once embedded sends valid FLUX_* messages
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!s) return { ...DEFAULT_STATE };
    // Always reset transient states on load
    return { ...DEFAULT_STATE, ...s, dispenseState: DISPENSE_STATE.IDLE, cleanState: CLEAN_STATE.IDLE };
  } catch { return { ...DEFAULT_STATE }; }
}

export function useFluxManager() {
  const [state, setState] = useState(loadState);

  // Persist to localStorage whenever state changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const patch = useCallback((updates) => setState(prev => ({ ...prev, ...updates })), []);

  // ── Serial event listeners ────────────────────────────────────────────────
  useEffect(() => {
    // FLUX_LEVEL:75 STATUS:NORMAL
    const onFluxLevel = (e) => {
      const { levelPct, status } = e.detail;
      const rawState = (status || "").toUpperCase();
      const levelState = Object.values(FLUX_LEVEL).includes(rawState) ? rawState : FLUX_LEVEL.UNKNOWN;
      patch({ levelPct, levelState, sourceIsReliable: true });
    };

    // FLUX_DISPENSE:START, DONE, or FAIL
    const onFluxDispense = (e) => {
      const { phase } = e.detail;
      if (phase === "START") {
        patch({ dispenseState: DISPENSE_STATE.DISPENSING, lastSprayStatus: null });
      } else if (phase === "DONE") {
        patch(prev => ({
          dispenseState: DISPENSE_STATE.IDLE,
          lastDispensedAt: new Date().toISOString(),
          totalDispenseCount: (prev.totalDispenseCount || 0) + 1,
          lastSprayStatus: "SUCCESS"
        }));
      } else if (phase === "FAIL") {
        patch({ dispenseState: DISPENSE_STATE.IDLE, lastSprayStatus: "FAILED" });
      }
    };

    // FLUX_CLEAN:START | FLUX_CLEAN:DONE | FLUX_CLEAN:FAIL
    const onFluxClean = (e) => {
      const { phase } = e.detail;
      if (phase === "START") {
        patch({ cleanState: CLEAN_STATE.RUNNING, dispenseState: DISPENSE_STATE.CLEANING });
      } else if (phase === "DONE") {
        patch({
          cleanState: CLEAN_STATE.COMPLETE,
          dispenseState: DISPENSE_STATE.IDLE,
          lastCleanedAt: new Date().toISOString(),
          levelState: prev => prev.levelState === FLUX_LEVEL.CLEANING_REQUIRED ? FLUX_LEVEL.NORMAL : prev.levelState,
        });
        // Reset cycle count after clean
        setState(prev => {
          const newState = { ...prev, cleanState: CLEAN_STATE.COMPLETE, dispenseState: DISPENSE_STATE.IDLE, lastCleanedAt: new Date().toISOString() };
          if (prev.levelState === FLUX_LEVEL.CLEANING_REQUIRED) newState.levelState = FLUX_LEVEL.NORMAL;
          return { ...newState, cleanCycleCount: 0 };
        });
      } else if (phase === "FAIL") {
        patch({ cleanState: CLEAN_STATE.FAILED, dispenseState: DISPENSE_STATE.IDLE });
      }
    };

    window.addEventListener("flux-level", onFluxLevel);
    window.addEventListener("flux-dispense", onFluxDispense);
    window.addEventListener("flux-clean", onFluxClean);
    return () => {
      window.removeEventListener("flux-level", onFluxLevel);
      window.removeEventListener("flux-dispense", onFluxDispense);
      window.removeEventListener("flux-clean", onFluxClean);
    };
  }, [patch]);

  // ── Auto-clean threshold detection ──────────────────────────────────────
  useEffect(() => {
    const { totalDispenseCount, cleanAfterCycles, cleanCycleCount, levelState } = state;
    if (
      cleanAfterCycles > 0 &&
      cleanCycleCount >= cleanAfterCycles &&
      levelState !== FLUX_LEVEL.CLEANING_REQUIRED &&
      levelState !== FLUX_LEVEL.EMPTY
    ) {
      patch({ levelState: FLUX_LEVEL.CLEANING_REQUIRED });
    }
  }, [state.cleanCycleCount, state.cleanAfterCycles]);

  // ── Manual software-side dispense tracking (when no encoder feedback) ───
  const recordDispense = useCallback(() => {
    setState(prev => {
      const newCount = (prev.cleanCycleCount || 0) + 1;
      const updates = { totalDispenseCount: (prev.totalDispenseCount || 0) + 1, lastDispensedAt: new Date().toISOString(), cleanCycleCount: newCount };
      if (!prev.sourceIsReliable) {
        // Software-estimated level: each cycle costs ~1%
        const newPct = Math.max(0, prev.levelPct - 1);
        updates.levelPct = newPct;
        updates.levelState = newPct <= 0 ? FLUX_LEVEL.EMPTY : newPct <= prev.lowThresholdPct ? FLUX_LEVEL.LOW : FLUX_LEVEL.NORMAL;
      }
      return { ...prev, ...updates };
    });
  }, []);

  // ── Commands to machine ──────────────────────────────────────────────────
  const triggerClean = useCallback(async () => {
    if (state.dispenseState === DISPENSE_STATE.RUNNING) return;
    patch({ cleanState: CLEAN_STATE.RUNNING, dispenseState: DISPENSE_STATE.CLEANING });
    try {
      if (window.serial?.writeLine) {
        await window.serial.writeLine("M700");      // Custom: Start flux clean cycle
        await window.serial.writeLine("M701 S1");   // Flush water forward
        await window.serial.writeLine("M701 S-1");  // Reverse pump to suck waste
        await window.serial.writeLine("M702");      // End clean cycle
      }
      patch({ cleanState: CLEAN_STATE.COMPLETE, dispenseState: DISPENSE_STATE.IDLE, lastCleanedAt: new Date().toISOString(), cleanCycleCount: 0 });
    } catch (e) {
      patch({ cleanState: CLEAN_STATE.FAILED, dispenseState: DISPENSE_STATE.IDLE });
    }
  }, [state.dispenseState, patch]);

  const triggerManualDispense = useCallback(async () => {
    if (state.levelState === FLUX_LEVEL.EMPTY) return;
    patch({ dispenseState: DISPENSE_STATE.DISPENSING });
    try {
      if (window.serial?.writeLine) {
        await window.serial.writeLine("M710");      // Custom: Manual flux dispense burst
      }
      setTimeout(() => patch({ dispenseState: DISPENSE_STATE.IDLE }), 2000);
      recordDispense();
    } catch (e) {
      patch({ dispenseState: DISPENSE_STATE.IDLE });
    }
  }, [state.levelState, patch, recordDispense]);

  const markRefilled = useCallback(() => {
    patch({ levelPct: 100, levelState: FLUX_LEVEL.NORMAL });
  }, [patch]);

  const setConfig = useCallback((key, value) => {
    patch({ [key]: value });
  }, [patch]);

  // ── Validation for pre-flight ─────────────────────────────────────────────
  const validateForRun = useCallback(() => {
    const issues = [];
    if (state.levelState === FLUX_LEVEL.EMPTY) issues.push("Flux tank is empty — refill before starting.");
    if (state.levelState === FLUX_LEVEL.REFILL_REQUIRED) issues.push("Flux refill required — tank critically low.");
    if (state.levelState === FLUX_LEVEL.CLEANING_REQUIRED) issues.push("Nozzle cleaning is due — run a clean cycle before the next job.");
    return { valid: issues.length === 0, issues };
  }, [state.levelState]);

  return {
    ...state,
    recordDispense,
    triggerClean,
    triggerManualDispense,
    markRefilled,
    setConfig,
    validateForRun,
  };
}
