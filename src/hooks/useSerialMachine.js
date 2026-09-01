import { useEffect, useRef, useState } from "react";

export function useSerialMachine() {
  const [isSerialConnected, setIsSerialConnected] = useState(false);
  const [machinePos, setMachinePos] = useState({ x: 0, y: 0, z: 0 });
  const [isEmergencyStopped, setIsEmergencyStopped] = useState(false);
  const statusIntervalRef = useRef(null);

  const handleSerialConnect = (status) => {
    setIsSerialConnected(status);
    // M114 polling is handled exclusively by SerialPanel's startStatusQuery,
    // which also detects cable-pull via consecutive write failures.
    // Do not start a second competing interval here.
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

  const triggerEmergencyStop = async () => {
    setIsEmergencyStopped(true);
    console.error('[E-STOP] Emergency Stop Triggered!');
    try {
      if (window.serial?.writeLine) {
        if (window.serial.write) await window.serial.write('\x18');
        await window.serial.writeLine('M112');
        await window.serial.writeLine('!');
        await window.serial.writeLine('M0');
        await window.serial.writeLine('G91');
        await window.serial.writeLine('G0 Z10 F300');
        await window.serial.writeLine('G90');
      }
    } catch (err) { console.error('[E-STOP] Failed to send stop commands:', err); }
  };

  const resetEmergencyStop = async () => {
    setIsEmergencyStopped(false);
    try {
      if (window.serial?.writeLine) {
        await window.serial.writeLine('$X');
        await window.serial.writeLine('M999');
      }
    } catch (err) { console.error('[E-STOP] Failed to send reset commands:', err); }
  };

  useEffect(() => {
    if (window.serial?.onData) {
      window.serial.onData((line) => {
        let x = null, y = null, z = null;
        const marlinMatch = line.match(/X\s*:\s*([-\d.]+).*?Y\s*:\s*([-\d.]+).*?Z\s*:\s*([-\d.]+)/i);
        if (marlinMatch) {
          x = parseFloat(marlinMatch[1]);
          y = parseFloat(marlinMatch[2]);
          z = parseFloat(marlinMatch[3]);
        } else {
          const grblMatch = line.match(/MPos:([-\d.]+),([-\d.]+),([-\d.]+)/);
          if (grblMatch) {
            x = parseFloat(grblMatch[1]);
            y = parseFloat(grblMatch[2]);
            z = parseFloat(grblMatch[3]);
          }
        }
        if (x !== null && y !== null && z !== null) setMachinePos({ x, y, z });

        // Parse Payload Status
        const payloadMatch = line.match(/PAYLOAD_KG:([-\d.]+)\s+STATUS:([A-Z_]+)/);
        if (payloadMatch) {
           window.dispatchEvent(new CustomEvent('payload-sync', { 
             detail: { 
               kg: parseFloat(payloadMatch[1]), 
               status: payloadMatch[2].toLowerCase() 
             } 
           }));
        }

        // Parse Tip Status  (e.g. "TIP_STATUS:PRESENT SLOT:0")
        const tipStatusMatch = line.match(/TIP_STATUS:(PRESENT|ABSENT)\s+SLOT:(\d+)/i);
        if (tipStatusMatch) {
          window.dispatchEvent(new CustomEvent('tip-status', {
            detail: {
              present:   tipStatusMatch[1].toUpperCase() === 'PRESENT',
              slotIndex: parseInt(tipStatusMatch[2], 10),
            }
          }));
        }

        // Parse tip-change result events from embedded
        if (/TIP_CHANGE_OK/i.test(line)) {
          window.dispatchEvent(new CustomEvent('tip-change-ok'));
        }
        if (/TIP_CHANGE_FAIL/i.test(line)) {
          window.dispatchEvent(new CustomEvent('tip-change-fail'));
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
