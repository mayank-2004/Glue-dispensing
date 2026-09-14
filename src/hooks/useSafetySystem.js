import { useState, useEffect, useCallback, useRef } from "react";
import { fw } from '../lib/firmware/grblCommands.js';

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
  const [activeFaults, setActiveFaults] = useState(() => {
    try {
      const saved = localStorage.getItem('safety_active_faults');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  
  const isEmergency = activeFaults.some(f => f.level === FAULT_LEVEL.EMERGENCY);
  const isCritical = activeFaults.some(f => f.level === FAULT_LEVEL.CRITICAL || f.level === FAULT_LEVEL.EMERGENCY);
  
  // States to control capabilities
  const isMotionPermitted = !isCritical;
  const isHeatingPermitted = !isCritical;
  const isJobExecutionPermitted = !isCritical;

  const activeFaultsRef = useRef(activeFaults);
  useEffect(() => { 
    activeFaultsRef.current = activeFaults; 
    localStorage.setItem('safety_active_faults', JSON.stringify(activeFaults));
  }, [activeFaults]);

  const triggerFault = useCallback((fault) => {
    setActiveFaults((prev) => {
      // Check if code already exists
      if (prev.find(f => f.code === fault.code)) return prev;
      return [...prev, { ...fault, timestamp: Date.now() }];
    });
  }, []);

  const clearFault = useCallback((code) => {
    setActiveFaults((prev) => prev.filter(f => f.code !== code));
  }, []);

  const clearAllFaults = useCallback(() => {
    setActiveFaults([]);
  }, []);

  const executeEmergencyHalt = useCallback(async () => {
    console.error("[SAFETY] Executing Emergency Halt Sequence!");
    
    // Inject the fault into the UI
    triggerFault({
      code: 'E001',
      level: FAULT_LEVEL.EMERGENCY,
      message: 'Operator manual E-Stop test'
    });

    if (serialWrite) {
      try {
        // 1. Stop Motion (GRBL)
        if (window.serial && window.serial.write) {
          await window.serial.write(fw.reset);
        } else {
          await serialWrite(fw.reset); 
        }
        await serialWrite(fw.pause);
        
        // 2. Disable Heating (Custom HAL mapping if applicable)
        await serialWrite('M104 S0'); 
        
        // 3. Stop Air/Flux/Valve
        await serialWrite(fw.dispenserOff);
      } catch (err) {
        console.warn("[SAFETY] Could not send hardware halt commands (Not connected or error).");
      }
    }
    // Stop Job Execution is handled by the component reacting to !isJobExecutionPermitted
    window.dispatchEvent(new CustomEvent('safety-halt'));
  }, [serialWrite, triggerFault]);

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
