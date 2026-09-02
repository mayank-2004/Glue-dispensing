import { useState, useEffect, useCallback, useRef } from "react";

export const FAULT_LEVEL = {
  INFO: "INFO",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
  EMERGENCY: "EMERGENCY",
};

// Common codes:
// E001 - Emergency Stop Activated
// E002 - Fume Extraction Failure
// E003 - Light Curtain Triggered
// E004 - Axis Travel Limit Reached
// E005 - Driver/Motor Fault
// E006 - Heater Fault
// E007 - Spool Low Wire

export function useSafetySystem(serialWrite) {
  const [activeFaults, setActiveFaults] = useState([]);
  
  const isEmergency = activeFaults.some(f => f.level === FAULT_LEVEL.EMERGENCY);
  const isCritical = activeFaults.some(f => f.level === FAULT_LEVEL.CRITICAL || f.level === FAULT_LEVEL.EMERGENCY);
  
  // States to control capabilities
  const isMotionPermitted = !isCritical;
  const isHeatingPermitted = !isCritical;
  const isJobExecutionPermitted = !isCritical;

  const activeFaultsRef = useRef(activeFaults);
  useEffect(() => { activeFaultsRef.current = activeFaults; }, [activeFaults]);

  // Log to history when a fault occurs
  const logFault = useCallback(async (fault) => {
    if (window.fs && window.fs.logFault) {
      try {
        await window.fs.logFault({ level: fault.level, code: fault.code, message: fault.message, timestamp: new Date().toISOString() });
      } catch (e) {
        console.error("Failed to log fault to history", e);
      }
    }
  }, []);

  const triggerFault = useCallback((code, message, level = FAULT_LEVEL.WARNING) => {
    setActiveFaults(prev => {
      if (prev.some(f => f.code === code)) return prev; // already active
      const newFault = { id: crypto.randomUUID(), code, message, level, timestamp: Date.now() };
      logFault(newFault);
      return [...prev, newFault];
    });

    if (level === FAULT_LEVEL.CRITICAL || level === FAULT_LEVEL.EMERGENCY) {
      executeEmergencyHalt();
    }
  }, [logFault]);

  const clearFault = useCallback((code) => {
    setActiveFaults(prev => prev.filter(f => f.code !== code));
  }, []);

  const clearAllFaults = useCallback(() => {
    setActiveFaults([]);
  }, []);

  const executeEmergencyHalt = useCallback(async () => {
    console.error("[SAFETY] Executing Emergency Halt Sequence!");
    if (serialWrite) {
      // 1. Stop Motion
      await serialWrite('\x18'); // Grbl Soft Reset / Halt
      await serialWrite('M112'); // Emergency Stop
      await serialWrite('!');    // Hold
      await serialWrite('M0');   // Program Pause
      // 2. Disable Heating
      await serialWrite('M104 S0'); 
      // 3. Stop Air/Flux/Valve
      await serialWrite('M107');
      // 4. Stop Solder Feed (assuming custom command or mapped to extruder E axis)
      // If it's E, M0 or M112 stops it. Can also send specific commands if needed.
    }
    // 5. Stop Job Execution is handled by the component reacting to !isJobExecutionPermitted
    window.dispatchEvent(new CustomEvent('safety-halt'));
  }, [serialWrite]);

  return {
    activeFaults,
    isMotionPermitted,
    isHeatingPermitted,
    isJobExecutionPermitted,
    isEmergency,
    isCritical,
    triggerFault,
    clearFault,
    clearAllFaults,
    executeEmergencyHalt,
  };
}
