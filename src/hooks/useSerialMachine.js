import { useEffect, useRef, useState } from "react";
import { fw, parseGrblStatus, parseGrblError } from "../lib/firmware/grblCommands.js";

export function useSerialMachine() {
  const [isSerialConnected, setIsSerialConnected] = useState(false);
  const [machinePos, setMachinePos] = useState({ x: 0, y: 0, z: 0 });
  const [isEmergencyStopped, setIsEmergencyStopped] = useState(false);
  const statusIntervalRef = useRef(null);

  // Throttled position update: buffer raw parsed position in a ref,
  // and flush it to React state at most once per animation frame (~60fps cap).
  const pendingPosRef = useRef(null);
  const posRafRef = useRef(null);

  const flushMachinePos = () => {
    posRafRef.current = null;
    if (pendingPosRef.current) {
      setMachinePos(pendingPosRef.current);
      pendingPosRef.current = null;
    }
  };

  const scheduleMachinePosUpdate = (pos) => {
    pendingPosRef.current = pos;
    if (!posRafRef.current) {
      posRafRef.current = requestAnimationFrame(flushMachinePos);
    }
  };

  const handleSerialConnect = (status) => {
    setIsSerialConnected(status);
    // Status-query ('?') polling is handled exclusively by SerialPanel's
    // startStatusQuery. Do not start a competing interval here.
    if (!status && statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
      statusIntervalRef.current = null;
    }
  };

  const handleSerialDisconnect = () => {
    setIsSerialConnected(false);
    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
      statusIntervalRef.current = null;
    }
  };

  // GRBL Emergency Stop sequence:
  //   1. fw.reset (\x18) — instant soft reset, clears planner & stops motion
  //   2. fw.pause ('!')  — feed hold as belt-and-suspenders
  //   3. Lift Z in relative mode, restore absolute
  //   Note: fw.unlock ('$X') is called separately in resetEmergencyStop
  const triggerEmergencyStop = async () => {
    setIsEmergencyStopped(true);
    console.error('[E-STOP] Emergency Stop Triggered!');
    try {
      if (window.serial?.writeLine) {
        if (window.serial.write) await window.serial.write(fw.reset); // Ctrl-X byte
        await window.serial.writeLine(fw.pause);                      // '!'
        await window.serial.writeLine(fw.relMode);                    // G91
        await window.serial.writeLine('G0 Z10 F300');
        await window.serial.writeLine(fw.absMode);                    // G90
      }
    } catch (err) { console.error('[E-STOP] Failed to send stop commands:', err); }
  };

  const resetEmergencyStop = async () => {
    setIsEmergencyStopped(false);
    try {
      if (window.serial?.writeLine) {
        await window.serial.writeLine(fw.unlock); // '$X' — kill GRBL alarm lock
      }
    } catch (err) { console.error('[E-STOP] Failed to send reset commands:', err); }
  };

  useEffect(() => {
    if (window.serial?.onData) {
      window.serial.onData((line) => {
        // ── GRBL real-time status: <Idle|MPos:x,y,z|...> ──────────────────
        const grbl = parseGrblStatus(line);
        if (grbl) {
          scheduleMachinePosUpdate({ x: grbl.x, y: grbl.y, z: grbl.z });
          // Fire probe DOM events from GRBL Pn:Z pin flag
          if (grbl.probeTriggered) {
            window.dispatchEvent(new CustomEvent('endstop-z-probe-triggered'));
          } else if (line.startsWith('<')) {
            window.dispatchEvent(new CustomEvent('endstop-z-probe-open'));
          }
        }

        // Parse Tip Status (e.g. "TIP_STATUS:PRESENT SLOT:0")
        const tipStatusMatch = line.match(/TIP_STATUS:(PRESENT|ABSENT)\s+SLOT:(\d+)/i);
        if (tipStatusMatch) {
          window.dispatchEvent(new CustomEvent('tip-status', {
            detail: { present: tipStatusMatch[1].toUpperCase() === 'PRESENT', slotIndex: parseInt(tipStatusMatch[2], 10) }
          }));
        }

        if (/TIP_CHANGE_OK/i.test(line))   window.dispatchEvent(new CustomEvent('tip-change-ok'));
        if (/TIP_CHANGE_FAIL/i.test(line)) window.dispatchEvent(new CustomEvent('tip-change-fail'));

        // Parse Flux Weight (e.g. "FLUX_WEIGHT:123.4")
        const fluxWeightMatch = line.match(/FLUX_WEIGHT:([\d.]+)/i);
        if (fluxWeightMatch) {
          window.dispatchEvent(new CustomEvent('flux-weight', {
            detail: { weight: parseFloat(fluxWeightMatch[1]) }
          }));
        }

        // Parse Flux Level (e.g. "FLUX_LEVEL:75 STATUS:NORMAL")
        const fluxLevelMatch = line.match(/FLUX_LEVEL:([\d.]+)\s+STATUS:([A-Z_]+)/i);
        if (fluxLevelMatch) {
          window.dispatchEvent(new CustomEvent('flux-level', {
            detail: { levelPct: parseFloat(fluxLevelMatch[1]), status: fluxLevelMatch[2].toUpperCase() }
          }));
        }

        const fluxDispMatch = line.match(/FLUX_DISPENSE:(START|DONE|FAIL)/i);
        if (fluxDispMatch) {
          window.dispatchEvent(new CustomEvent('flux-dispense', { detail: { phase: fluxDispMatch[1].toUpperCase() } }));
        }

        const fumeMatch = line.match(/FUME_STATUS:([A-Z_]+)(?:\s+AIRFLOW:([\d.]+))?(?:\s+LOAD:([\d.]+))?(?:\s+HOURS:([\d.]+))?/i);
        if (fumeMatch) {
          window.dispatchEvent(new CustomEvent('fume-telemetry', {
            detail: {
              status: fumeMatch[1].toUpperCase(),
              airflow: fumeMatch[2] ? parseFloat(fumeMatch[2]) : undefined,
              pumpLoad: fumeMatch[3] ? parseFloat(fumeMatch[3]) : undefined,
              hours: fumeMatch[4] ? parseFloat(fumeMatch[4]) : undefined
            }
          }));
        }

        const fluxCleanMatch = line.match(/FLUX_CLEAN:(START|DONE|FAIL)/i);
        if (fluxCleanMatch) {
          window.dispatchEvent(new CustomEvent('flux-clean', { detail: { phase: fluxCleanMatch[1].toUpperCase() } }));
        }

        const tipCleanMatch = line.match(/TIP_CLEAN:(START|DONE|FAIL)(?:\s+(.*))?/i);
        if (tipCleanMatch) {
          window.dispatchEvent(new CustomEvent('tip-clean-event', {
            detail: { phase: tipCleanMatch[1].toUpperCase(), message: tipCleanMatch[2]?.trim() }
          }));
        }

        const tipRotMatch = line.match(/TIP_ROT:(HOMING|HOMED|MOVING|REACHED|FAULT)(?:\s+R?([0-9.]+))?(?:\s+(.*))?/i);
        if (tipRotMatch) {
          window.dispatchEvent(new CustomEvent('tip-rotation-event', {
            detail: { phase: tipRotMatch[1].toUpperCase(), angle: tipRotMatch[2] ? parseFloat(tipRotMatch[2]) : undefined, message: tipRotMatch[3]?.trim() || undefined }
          }));
        }

        const payloadMatch = line.match(/\[?PAYLOAD(?:_KG)?:([-\d.]+)(?:\s+STATUS:([A-Z_]+))?\]?/i);
        if (payloadMatch) {
          window.dispatchEvent(new CustomEvent('payload-sync', {
            detail: { kg: parseFloat(payloadMatch[1]), status: payloadMatch[2] ? payloadMatch[2].toUpperCase() : 'UNKNOWN' }
          }));
        }

        // Parse Hardware Faults — includes GRBL ALARM:N codes
        const grblErr = parseGrblError(line);
        const customFaultRx = /E-STOP:|FUME_FAIL:|CURTAIN_TRIP:|LOW_WIRE:|HEATER_FAULT:|DRIVER_FAULT:|TOUCH_FAULT:/i;

        if (grblErr || customFaultRx.test(line)) {
          let code = 'E000', level = 'CRITICAL', msg = line.trim();
          if      (/E-STOP:/i.test(line))                         { code = 'E001'; level = 'EMERGENCY'; msg = 'Emergency Stop Activated'; }
          else if (/FUME_FAIL:/i.test(line))                      { code = 'E002'; level = 'CRITICAL';  msg = 'Fume Extraction Failure'; }
          else if (/CURTAIN_TRIP:/i.test(line))                   { code = 'E003'; level = 'EMERGENCY'; msg = 'Light Curtain Triggered'; }
          else if (grblErr?.isAlarm && grblErr.code === 1)        { code = 'E004'; level = 'CRITICAL';  msg = 'Hard Limit Reached (ALARM:1)'; }
          else if (grblErr?.isAlarm && grblErr.code === 2)        { code = 'E004'; level = 'CRITICAL';  msg = 'Soft Limit Reached (ALARM:2)'; }
          else if (/DRIVER_FAULT:/i.test(line))                   { code = 'E005'; level = 'CRITICAL';  msg = 'Motor/Driver Fault'; }
          else if (/HEATER_FAULT:/i.test(line))                   { code = 'E006'; level = 'CRITICAL';  msg = 'Soldering Heater Fault'; }
          else if (/LOW_WIRE:/i.test(line))                       { code = 'E007'; level = 'WARNING';   msg = 'Solder Wire Spool Low'; }
          else if (/TOUCH_FAULT:/i.test(line))                    { code = 'E008'; level = 'CRITICAL';  msg = 'Unwanted Touch Detected'; }
          window.dispatchEvent(new CustomEvent('hardware-fault', { detail: { code, level, message: msg } }));
        }
      });
    }
    return () => { if (statusIntervalRef.current) clearInterval(statusIntervalRef.current); };
  }, []);

  return {
    isSerialConnected, setIsSerialConnected,
    machinePos, setMachinePos,
    isEmergencyStopped,
    handleSerialConnect, handleSerialDisconnect,
    triggerEmergencyStop, resetEmergencyStop,
  };
}
