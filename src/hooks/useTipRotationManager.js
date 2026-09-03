import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "tipRotationManager_v1";

export const ROTATION_STATUS = {
  IDLE: "IDLE",
  HOMING: "HOMING",
  ROTATING: "ROTATING",
  TARGET_REACHED: "TARGET_REACHED",
  FAULT: "FAULT",
};

const DEFAULT_STATE = {
  status: ROTATION_STATUS.IDLE,
  currentAngle: null,        // null until homed
  targetAngle: 0,
  isHomed: false,
  lastFaultMessage: null,
  defaultSolderAngle: 45,    // Stored recipe angle (configurable)
  stepDegree: 1.8,           // Stepper resolution (configurable)
  eventLog: [],              // last 100 events
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!s) return { ...DEFAULT_STATE };
    return {
      ...DEFAULT_STATE,
      ...s,
      status: ROTATION_STATUS.IDLE, // always start IDLE
      currentAngle: null,           // position unknown until re-homed after restart
      isHomed: false,
    };
  } catch { return { ...DEFAULT_STATE }; }
}

export function useTipRotationManager() {
  const [state, setState] = useState(loadState);
  const rotationTimeoutRef = useRef(null);

  // Persist config-level settings
  useEffect(() => {
    const { defaultSolderAngle, stepDegree } = state;
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, defaultSolderAngle, stepDegree }));
  }, [state.defaultSolderAngle, state.stepDegree]);

  const patch = useCallback((updates) =>
    setState(prev => ({ ...prev, ...(typeof updates === "function" ? updates(prev) : updates) })), []);

  const logEvent = useCallback((type, detail) => {
    setState(prev => {
      const entry = { type, detail, time: new Date().toISOString() };
      return { ...prev, eventLog: [entry, ...prev.eventLog].slice(0, 100) };
    });
  }, []);

  // ── Serial Telemetry Listener ──
  useEffect(() => {
    const onRotEvent = (e) => {
      const { phase, angle, message } = e.detail;
      clearTimeout(rotationTimeoutRef.current);

      if (phase === "HOMING") {
        patch({ status: ROTATION_STATUS.HOMING, isHomed: false, currentAngle: null });
        logEvent("HOMING", "Homing to zero reference...");
      } else if (phase === "HOMED") {
        patch({ status: ROTATION_STATUS.IDLE, isHomed: true, currentAngle: 0 });
        logEvent("HOMED", "Zero reference established at 0°");
      } else if (phase === "MOVING") {
        patch({ status: ROTATION_STATUS.ROTATING });
        logEvent("MOVING", `Rotating to ${angle ?? "?"}°`);
      } else if (phase === "REACHED") {
        patch({ status: ROTATION_STATUS.TARGET_REACHED, currentAngle: angle ?? null });
        logEvent("REACHED", `Target ${angle}° confirmed by encoder`);
      } else if (phase === "FAULT") {
        patch({ status: ROTATION_STATUS.FAULT, lastFaultMessage: message || "Stepper fault" });
        logEvent("FAULT", message || "Stepper motor fault");
      }
    };

    window.addEventListener("tip-rotation-event", onRotEvent);
    return () => window.removeEventListener("tip-rotation-event", onRotEvent);
  }, [patch, logEvent]);

  // ── API ──
  const rotateTo = useCallback((angleDeg, reason = "Manual") => {
    const clamped = Math.max(0, Math.min(180, Math.round(angleDeg)));
    return new Promise(async (resolve, reject) => {
      if (state.status === ROTATION_STATUS.FAULT) return reject(new Error("Tip rotation is in FAULT state"));
      if (!state.isHomed) return reject(new Error("Must home tip rotation before commanding an angle"));

      patch({ status: ROTATION_STATUS.ROTATING, targetAngle: clamped });
      logEvent("ROTATE_CMD", `Target: ${clamped}° — Reason: ${reason}`);

      const onEvent = (e) => {
        const { phase } = e.detail;
        if (phase === "REACHED") { window.removeEventListener("tip-rotation-event", onEvent); resolve(); }
        if (phase === "FAULT")   { window.removeEventListener("tip-rotation-event", onEvent); reject(new Error("Rotation fault")); }
      };
      window.addEventListener("tip-rotation-event", onEvent);

      // Safety timeout: clear listener if no feedback in 15 s
      rotationTimeoutRef.current = setTimeout(() => {
        window.removeEventListener("tip-rotation-event", onEvent);
        patch(prev => ({
          status: prev.status === ROTATION_STATUS.ROTATING ? ROTATION_STATUS.FAULT : prev.status,
          lastFaultMessage: "Rotation timed out — no encoder feedback"
        }));
        reject(new Error("Rotation timeout"));
      }, 15000);

      try {
        // M730 R{angle} — custom M-code to command stepper rotation
        if (window.serial?.writeLine) await window.serial.writeLine(`M730 R${clamped}`);
      } catch (e) {
        clearTimeout(rotationTimeoutRef.current);
        window.removeEventListener("tip-rotation-event", onEvent);
        patch({ status: ROTATION_STATUS.FAULT, lastFaultMessage: "Serial write failed" });
        logEvent("FAULT", "Serial write failed");
        reject(e);
      }
    });
  }, [state.status, state.isHomed, patch, logEvent]);

  const home = useCallback(async () => {
    patch({ status: ROTATION_STATUS.HOMING, isHomed: false, currentAngle: null });
    logEvent("HOMING", "Homing initiated");
    try {
      if (window.serial?.writeLine) await window.serial.writeLine("M731"); // M731 = home rotation axis
    } catch (e) {
      patch({ status: ROTATION_STATUS.FAULT, lastFaultMessage: "Failed to send home command" });
      logEvent("FAULT", "Serial write failed during home");
    }
  }, [patch, logEvent]);

  const resetFault = useCallback(() => {
    patch({ status: ROTATION_STATUS.IDLE, lastFaultMessage: null });
    logEvent("RESET", "Fault cleared by operator");
  }, [patch, logEvent]);

  const setConfig = useCallback((key, value) => {
    patch({ [key]: value });
  }, [patch]);

  const validateForRun = useCallback(() => {
    const issues = [];
    if (state.status === ROTATION_STATUS.FAULT) issues.push("Tip rotation mechanism is in FAULT state.");
    if (!state.isHomed) issues.push("Tip rotation must be homed before starting a job.");
    return { valid: issues.length === 0, issues };
  }, [state.status, state.isHomed]);

  return {
    ...state,
    rotateTo,
    home,
    resetFault,
    setConfig,
    validateForRun,
  };
}
