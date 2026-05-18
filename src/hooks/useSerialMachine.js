import { useEffect, useRef, useState } from "react";

export function useSerialMachine() {
  const [isSerialConnected, setIsSerialConnected] = useState(false);
  const [machinePos, setMachinePos] = useState({ x: 0, y: 0, z: 0 });
  const [isEmergencyStopped, setIsEmergencyStopped] = useState(false);
  const statusIntervalRef = useRef(null);

  const handleSerialConnect = (status) => {
    setIsSerialConnected(status);
    if (status) {
      if (statusIntervalRef.current) clearInterval(statusIntervalRef.current);
      statusIntervalRef.current = setInterval(async () => {
        try {
          if (window.serial?.writeLine) await window.serial.writeLine('M114');
        } catch (e) { console.error('Status poll failed:', e); }
      }, 500);
    } else {
      if (statusIntervalRef.current) clearInterval(statusIntervalRef.current);
    }
  };

  const handleSerialDisconnect = () => {
    setIsSerialConnected(false);
    if (statusIntervalRef.current) clearInterval(statusIntervalRef.current);
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
        await window.serial.writeLine('G0 Z10 F1000');
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
