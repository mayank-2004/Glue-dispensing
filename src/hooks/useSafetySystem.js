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
  const [activeFaults, setActiveFaults] = useState([]);
  
  const isEmergency = activeFaults.some(f => f.level === FAULT_LEVEL.EMERGENCY);
  const isCritical = activeFaults.some(f => f.level === FAULT_LEVEL.CRITICAL || f.level === FAULT_LEVEL.EMERGENCY);
  
  // States to control capabilities
  const isMotionPermitted = !isCritical;
  const isHeatingPermitted = !isCritical;
  const isJobExecutionPermitted = !isCritical;

  const activeFaultsRef = useRef(activeFaults);
  useEffect(() => { activeFaultsRef.current = activeFaults; }, [activeFaults]);

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
    if (serialWrite) {
      // 1. Stop Motion (GRBL)
      // Send reset byte without newline, then feed hold
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
