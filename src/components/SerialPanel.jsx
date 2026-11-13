import { useEffect, useRef, useState } from "react";
import "./SerialPanel.css";
import { useToast } from '../Toast.jsx';
import { fw, isGrblBoot, parseGrblStatus, setOriginToCurrent } from '../lib/firmware/grblCommands.js';

export default function SerialPanel({
  onMachinePositionUpdate = null,
  isConnected = false,
  motionManager,
  onConnect,
  onDisconnect,
  onUnexpectedDisconnect,  // called when cable is pulled / port closes unexpectedly
  onHomingComplete,
  skipHome = false,         // true on reconnect — skip G28, preserve current position
  isHomed = false,
  machinePosition = { x: 0, y: 0, z: 0 } // Default for safety
}) {
  const toast = useToast();
  const [ports, setPorts] = useState([]);
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState(115200);
  const [consoleLines, setConsoleLines] = useState([]);
  const [isHoming, setIsHoming] = useState(false);
  const [endstops, setEndstops] = useState({ x: false, y: false, z: false });
  const isHomingAbortRef = useRef(false);

  const inputRef = useRef(null);
  const mPosRef = useRef(machinePosition);
  const hasReceivedPosRef = useRef(false);
  const statusQueryRef = useRef(null); // interval handle for '?' status polling
  const watchdogRef = useRef(null);   // interval handle for data-update watchdog
  const lastDataRef = useRef(0);      // timestamp of last received serial data
  const awaitingOkRef = useRef(null);      // one-shot callback fired on next "ok" from GRBL
  const grblBootCbRef = useRef(null);      // fired once when GRBL's boot message is detected
  const latestGrblStatusRef = useRef({ state: 'Idle', xTriggered: false, yTriggered: false, zTriggered: false, x: 0, y: 0, z: 0 });
  const activeHomingAxisRef = useRef(null); // 'Z', 'X', 'Y' or null during guided homing
  const homingHitDetectedRef = useRef(false); // Un-failable latched switch/alarm trigger flag
  // Always-current refs for callbacks so native disconnect handler never goes stale
  const onUnexpectedDisconnectRef = useRef(onUnexpectedDisconnect);
  const onDisconnectRef = useRef(onDisconnect);
  useEffect(() => { onUnexpectedDisconnectRef.current = onUnexpectedDisconnect; });
  useEffect(() => { onDisconnectRef.current = onDisconnect; });
  // Keep a live ref to connect() so auto-reconnect never calls a stale closure
  const connectRef = useRef(null);
  const isConnectedRef = useRef(isConnected);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  useEffect(() => {
    mPosRef.current = machinePosition;
  }, [machinePosition]);

  const refresh = async () => {
    try {
      const list = await window.serial.list();
      setPorts(list);
      setPath(prev => prev || (list[0]?.path ?? ''));
    } catch (e) {
      console.error('Failed to list serial ports', e);
      setPorts([]);
      setPath('');
    }
  };

  // Native cable-pull detection — fires the moment SerialPort emits 'close' in main process
  useEffect(() => {
    if (!window.serial?.onDisconnect) return;
    const remove = window.serial.onDisconnect(() => {
      stopWatchdog();
      if (statusQueryRef.current) { clearInterval(statusQueryRef.current); statusQueryRef.current = null; }
      setIsHoming(false);
      hasReceivedPosRef.current = false;
      grblBootCbRef.current = null;    // cancel any pending boot detection
      window._pollPauseCount = 0;      // reset counter — homing/job may have left it non-zero
      const handler = onUnexpectedDisconnectRef.current || onDisconnectRef.current;
      if (handler) handler();
    });
    return remove;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-reconnect — when the port reappears after a cable pull, reconnect without operator click
  useEffect(() => {
    if (!window.serial?.onPortAppeared) return;
    const remove = window.serial.onPortAppeared(({ path: portPath, baudRate }) => {
      if (isConnectedRef.current) return; // already connected, ignore
      setPath(portPath);
      setBaud(baudRate);
      // Brief delay so the USB device finishes initialising before we open it
      setTimeout(() => { connectRef.current?.(); }, 1500);
    });
    return remove;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, []);

  // Ensure serial port is closed when the page refreshes or unloads
  useEffect(() => {
    const handleUnload = () => {
      try {
        if (isConnectedRef.current && window.serial) {
          // GRBL: send Soft Reset (Ctrl-X) to abort any stuck motions (e.g. homing) before port closes
          if (window.serial.writeLine) {
            window.serial.writeLine('\x18'); // '\x18' Soft Reset
          }
          if (window.serial.close) {
            window.serial.close();
          }
        }
      } catch (e) {
        console.error("Error closing serial on unload", e);
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, []);

  useEffect(() => {
    if (!window.serial?.onData) return;
    const unsub = window.serial.onData((line) => {
      lastDataRef.current = Date.now();
      const ts = new Date().toISOString();
      // Filter out high-frequency real-time status packets (<...>) from console state
      // to prevent re-rendering SerialPanel 5 times every second on Pi 4
      if (!line.startsWith('<')) {
        setConsoleLines((prev) => [...prev, `[RECE] ${ts} ${line}`].slice(-200));
      }

      // ── GRBL real-time status: <Idle|MPos:x,y,z|FS:f,s|Pn:Z> ───────────
      const grbl = parseGrblStatus(line);
      if (grbl) {
        latestGrblStatusRef.current = {
          state: grbl.state,
          xTriggered: grbl.xTriggered,
          yTriggered: grbl.yTriggered,
          zTriggered: grbl.zTriggered,
          x: grbl.x,
          y: grbl.y,
          z: grbl.z,
        };
        hasReceivedPosRef.current = true;
        if (onMachinePositionUpdate) onMachinePositionUpdate({ x: grbl.x, y: grbl.y, z: grbl.z });
        // Probe pin events (replaces Marlin M119 bridge)
        if (grbl.zTriggered) {
          window.dispatchEvent(new CustomEvent('endstop-z-probe-triggered'));
        } else {
          window.dispatchEvent(new CustomEvent('endstop-z-probe-open'));
        }
      }

      // Direct un-failable switch & alarm detection
      const hasPn = /\|?pn:/i.test(line);
      const hasAlarm = /alarm/i.test(line);

      let xHit = false;
      let yHit = false;
      let zHit = false;

      if (hasPn) {
        xHit = /pn:[A-Za-z]*X/i.test(line);
        yHit = /pn:[A-Za-z]*Y/i.test(line);
        zHit = /pn:[A-Za-z]*Z/i.test(line) || /pn:[A-Za-z]*P/i.test(line);

        setEndstops({ x: xHit, y: yHit, z: zHit });

        latestGrblStatusRef.current.xTriggered = xHit;
        latestGrblStatusRef.current.yTriggered = yHit;
        latestGrblStatusRef.current.zTriggered = zHit;
      } else if (line.startsWith('<')) {
        // Status response without Pn: means all limit switches are open
        setEndstops({ x: false, y: false, z: false });
        latestGrblStatusRef.current.xTriggered = false;
        latestGrblStatusRef.current.yTriggered = false;
        latestGrblStatusRef.current.zTriggered = false;
      }

      // ── DETECT LIMIT SWITCH HIT DURING HOMING ────────────────────────────
      // Just set the flag here — the main homing loop polls this ref every 60ms.
      // The actual stop command (\x18 Soft Reset) is sent from the main sequence
      // so we have full control over timing and recovery.
      if (activeHomingAxisRef.current && !homingHitDetectedRef.current) {
        const curAxis = activeHomingAxisRef.current;
        const axisHit = curAxis === 'X' ? xHit : curAxis === 'Y' ? yHit : zHit;
        if (axisHit || hasAlarm) {
          homingHitDetectedRef.current = true;
        }
      }

      if (hasAlarm) {
        latestGrblStatusRef.current.state = 'Alarm';
        if (awaitingOkRef.current) {
          const cb = awaitingOkRef.current;
          awaitingOkRef.current = null;
          cb(new Error(`GRBL ${line.trim()}`));
        }
      }

      // ── Detect GRBL boot greeting ─────────────────────────────────────────
      // GRBL sends "Grbl X.Xx ['$' for help]" on startup.
      if (grblBootCbRef.current && isGrblBoot(line)) {
        const cb = grblBootCbRef.current;
        grblBootCbRef.current = null;
        cb();
      }

      // ── Resolve pending homing ok-waiter ──────────────────────────────────
      if (awaitingOkRef.current && /^ok$/i.test(line.trim())) {
        const cb = awaitingOkRef.current;
        awaitingOkRef.current = null;
        cb();
      }
    });
    return unsub;
  }, []);

  const abortHoming = async () => {
    isHomingAbortRef.current = true;
    try {
      if (window.serial?.write) await window.serial.write('\x18');
      else await window.serial.writeLine('\x18');
      await new Promise(r => setTimeout(r, 300));
      await window.serial.writeLine('$21=0');
      await new Promise(r => setTimeout(r, 100));
      await window.serial.writeLine(fw.unlock);
    } catch {}
    setIsHoming(false);
    activeHomingAxisRef.current = null;
    window._pollPauseCount = 0;
    window.pauseSerialPolling = false;
    startStatusQuery();
    setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Auto-homing cancelled by operator.`].slice(-500));
    toast.warning("Homing aborted by operator.");
  };

  const runSmartHomingSequence = async () => {
    if (!window.serial?.writeLine) return;
    isHomingAbortRef.current = false;
    setIsHoming(true);
    setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Starting Guided 3-Axis Auto-Homing (Z -> X -> Y)...`].slice(-500));

    // Helper: waits for the physical duration of a move + verifies GRBL reports 'Idle'
    // Also handles Alarm mid-poll (clears with $X and continues)
    const waitForMotionComplete = async (distMm, feedMmMin = 400, maxWaitMs = 15000) => {
      // 1. Mandatory wait for the physical travel time (motors cannot move faster than physics!)
      const moveDurationMs = Math.ceil((distMm / (feedMmMin / 60)) * 1000) + 600;
      await new Promise(r => setTimeout(r, moveDurationMs));

      // 2. Invalidate status so a stale 'Idle' from before the move cannot cause premature return
      latestGrblStatusRef.current.state = 'Busy';

      // 3. Poll '?' until GRBL explicitly returns 'Idle'; recover from Alarm automatically
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        if (isHomingAbortRef.current) throw new Error("Homing cancelled by operator");
        if (!isConnectedRef.current) throw new Error("Disconnected during homing");
        if (window.serial?.write) await window.serial.write('?');
        else await window.serial.writeLine('?');
        await new Promise(r => setTimeout(r, 120));
        const st = latestGrblStatusRef.current.state;
        if (st === 'Idle') return true;
        if (st === 'Alarm') {
          // Auto-recover: clear alarm so the pull-off motion can be reported Idle
          await window.serial.writeLine(fw.unlock); // $X
          await new Promise(r => setTimeout(r, 200));
          latestGrblStatusRef.current.state = 'Idle';
          return true;
        }
      }
      return true;
    };

    // Helper: ensures GRBL is out of Alarm and ready for motion commands
    const ensureUnlockedAndIdle = async (maxAttempts = 4) => {
      for (let i = 0; i < maxAttempts; i++) {
        await window.serial.writeLine(fw.unlock); // '$X'
        await new Promise(r => setTimeout(r, 200));
        if (window.serial?.write) await window.serial.write('?');
        else await window.serial.writeLine('?');
        await new Promise(r => setTimeout(r, 120));
        if (latestGrblStatusRef.current.state === 'Idle') return true;
      }
      await window.serial.writeLine(fw.unlock);
      await new Promise(r => setTimeout(r, 150));
      latestGrblStatusRef.current.state = 'Idle';
      return true;
    };

    try {
      // ── HELPER: Stop motor + recover GRBL after a limit switch hit ────────
      // Uses \x18 (Soft Reset) — the ONLY 100% reliable stop on GRBL-Mega.
      // After reset: wait for GRBL reboot greeting, then re-disable hard limits,
      // then clear alarm — machine is then safe to accept G1 pull-off.
      const stopAndRecover = async (axisLabel) => {
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} ${axisLabel} switch hit — sending Soft Reset to stop motor...`].slice(-500));

        // 1. Send Soft Reset (\x18) — stops all motion immediately, MCU reboots
        if (window.serial?.write) await window.serial.write('\x18');
        else await window.serial.writeLine('\x18');

        // 2. Wait for GRBL-Mega to fully reboot (Arduino Mega needs ~1200ms)
        await new Promise(r => setTimeout(r, 1200));

        // 3. Re-send $21=0 — Soft Reset reloads EEPROM, so force hard limits OFF again
        await window.serial.writeLine('$21=0');
        await new Promise(r => setTimeout(r, 300));

        // 4. Clear any alarm state from the reset
        await window.serial.writeLine(fw.unlock); // $X
        await new Promise(r => setTimeout(r, 300));

        // 5. Poll to confirm Idle
        if (window.serial?.write) await window.serial.write('?');
        else await window.serial.writeLine('?');
        await new Promise(r => setTimeout(r, 200));

        // Force Idle regardless — G1 pull-off must be accepted
        latestGrblStatusRef.current.state = 'Idle';
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} ${axisLabel} recovered — ready for pull-off.`].slice(-500));
      };

      // 0a. Force $21=0 (hard limits OFF) — previous failed runs may have persisted $21=1 in EEPROM.
      await window.serial.writeLine('$21=0');
      await new Promise(r => setTimeout(r, 300));

      // 0b. Ensure machine is unlocked from any previous alarm
      await ensureUnlockedAndIdle();

      // Pause background 200ms timer so only the active seek loop queries '?'
      window.pauseSerialPolling = true;

      // ==========================================
      // PHASE 1: Z AXIS HOMING & LIFT
      // ==========================================
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} [1/3] Homing Z Axis...`].slice(-500));

      latestGrblStatusRef.current.zTriggered = false;
      latestGrblStatusRef.current.state = 'Idle';
      homingHitDetectedRef.current = false;
      activeHomingAxisRef.current = null;

      // Check if Z switch is already pressed before we start
      if (window.serial?.write) await window.serial.write('?');
      else await window.serial.writeLine('?');
      await new Promise(r => setTimeout(r, 200));

      if (latestGrblStatusRef.current.zTriggered) {
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Z already at switch — recovering and lifting...`].slice(-500));
        await stopAndRecover('Z');
      } else {
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Moving Z down toward limit switch at 150 mm/min...`].slice(-500));
        activeHomingAxisRef.current = 'Z';
        homingHitDetectedRef.current = false;
        latestGrblStatusRef.current.zTriggered = false;
        await window.serial.writeLine('$J=G91 Z-300 F150');
        await new Promise(r => setTimeout(r, 100));

        // Poll until Z switch triggers or timeout
        const startZ = Date.now();
        let hitZ = false;
        while (!hitZ && (Date.now() - startZ < 120000)) {
          if (isHomingAbortRef.current) throw new Error('Homing cancelled by operator');
          if (!isConnectedRef.current) throw new Error('Disconnected during homing');
          if (homingHitDetectedRef.current || latestGrblStatusRef.current.zTriggered) {
            hitZ = true; break;
          }
          if (window.serial?.write) await window.serial.write('?');
          else await window.serial.writeLine('?');
          await new Promise(r => setTimeout(r, 60));
        }

        activeHomingAxisRef.current = null;
        homingHitDetectedRef.current = false;
        if (!hitZ) throw new Error('Z limit switch not reached within 120s');

        // Stop motor and recover GRBL
        await stopAndRecover('Z');
      }

      // Lift Z 10mm away from switch
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Lifting Z upward 10mm...`].slice(-500));
      await window.serial.writeLine(fw.relMode); // G91
      await new Promise(r => setTimeout(r, 100));
      await window.serial.writeLine('G1 Z10 F250');
      await waitForMotionComplete(10, 250, 6000);
      await window.serial.writeLine(fw.absMode); // G90
      await new Promise(r => setTimeout(r, 100));
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Z Axis Homed & Lifted 10mm.`].slice(-500));


      // ==========================================
      // PHASE 2: X AXIS HOMING & PULL-OFF
      // ==========================================
      // Enable hard limits ($21=1) during X seek so GRBL MCU hardware interrupt
      // halts the motor instantly on switch contact — zero bounce, zero multiple hits.
      // Then stopAndRecover disables hard limits ($21=0) before pull-off so head moves away cleanly.
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} [2/3] Homing X Axis...`].slice(-500));

      await ensureUnlockedAndIdle();
      latestGrblStatusRef.current.xTriggered = false;
      latestGrblStatusRef.current.state = 'Idle';
      homingHitDetectedRef.current = false;
      activeHomingAxisRef.current = null;

      // Enable debounce ($26=25) and hard limits ($21=1) for hardware-level stop
      await window.serial.writeLine('$26=25');
      await new Promise(r => setTimeout(r, 80));
      await window.serial.writeLine('$21=1');
      await new Promise(r => setTimeout(r, 150));

      // Check if X switch is already pressed before we start
      if (window.serial?.write) await window.serial.write('?');
      else await window.serial.writeLine('?');
      await new Promise(r => setTimeout(r, 200));

      if (latestGrblStatusRef.current.xTriggered || latestGrblStatusRef.current.state === 'Alarm') {
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} X already at switch — recovering and pulling off...`].slice(-500));
        await stopAndRecover('X');
      } else {
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Moving X toward limit switch at 250 mm/min (hard limits active)...`].slice(-500));
        activeHomingAxisRef.current = 'X';
        homingHitDetectedRef.current = false;
        latestGrblStatusRef.current.xTriggered = false;
        await window.serial.writeLine('$J=G91 X-2000 F250');
        await new Promise(r => setTimeout(r, 80));

        const startX = Date.now();
        let hitX = false;
        while (!hitX && (Date.now() - startX < 120000)) {
          if (isHomingAbortRef.current) throw new Error('Homing cancelled by operator');
          if (!isConnectedRef.current) throw new Error('Disconnected during homing');
          if (homingHitDetectedRef.current || latestGrblStatusRef.current.xTriggered || latestGrblStatusRef.current.state === 'Alarm') {
            hitX = true; break;
          }
          if (window.serial?.write) await window.serial.write('?');
          else await window.serial.writeLine('?');
          await new Promise(r => setTimeout(r, 50));
        }

        activeHomingAxisRef.current = null;
        homingHitDetectedRef.current = false;
        if (!hitX) throw new Error('X limit switch not reached within 120s');

        // Switch hit! GRBL hardware interrupt immediately stopped motor.
        // stopAndRecover sends \x18, sets $21=0, clears alarm, ready to pull off
        await stopAndRecover('X');
      }

      // Pull off X 10mm (hard limits are now $21=0, so move away succeeds)
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Pulling off X 10mm...`].slice(-500));
      await window.serial.writeLine(fw.relMode); // G91
      await new Promise(r => setTimeout(r, 100));
      await window.serial.writeLine('G1 X10 F250');
      await waitForMotionComplete(10, 250, 6000);
      await window.serial.writeLine(fw.absMode); // G90
      await new Promise(r => setTimeout(r, 100));
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} X Axis Homed & Pulled Off 10mm.`].slice(-500));


      // ==========================================
      // PHASE 3: Y AXIS HOMING & PULL-OFF
      // ==========================================
      // Enable hard limits ($21=1) during Y seek so GRBL MCU hardware interrupt
      // halts the motor instantly on switch contact — zero bounce, zero multiple hits.
      // Then stopAndRecover disables hard limits ($21=0) before pull-off so head moves away cleanly.
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} [3/3] Homing Y Axis...`].slice(-500));

      await ensureUnlockedAndIdle();
      latestGrblStatusRef.current.yTriggered = false;
      latestGrblStatusRef.current.state = 'Idle';
      homingHitDetectedRef.current = false;
      activeHomingAxisRef.current = null;

      // Enable debounce ($26=25) and hard limits ($21=1) for hardware-level stop
      await window.serial.writeLine('$26=25');
      await new Promise(r => setTimeout(r, 80));
      await window.serial.writeLine('$21=1');
      await new Promise(r => setTimeout(r, 150));

      // Check if Y switch is already pressed before we start
      if (window.serial?.write) await window.serial.write('?');
      else await window.serial.writeLine('?');
      await new Promise(r => setTimeout(r, 200));

      if (latestGrblStatusRef.current.yTriggered || latestGrblStatusRef.current.state === 'Alarm') {
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Y already at switch — recovering and pulling off...`].slice(-500));
        await stopAndRecover('Y');
      } else {
        setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Moving Y toward limit switch at 180 mm/min (hard limits active)...`].slice(-500));
        activeHomingAxisRef.current = 'Y';
        homingHitDetectedRef.current = false;
        latestGrblStatusRef.current.yTriggered = false;
        await window.serial.writeLine('$J=G91 Y-2000 F180');
        await new Promise(r => setTimeout(r, 80));

        const startY = Date.now();
        let hitY = false;
        while (!hitY && (Date.now() - startY < 120000)) {
          if (isHomingAbortRef.current) throw new Error('Homing cancelled by operator');
          if (!isConnectedRef.current) throw new Error('Disconnected during homing');
          if (homingHitDetectedRef.current || latestGrblStatusRef.current.yTriggered || latestGrblStatusRef.current.state === 'Alarm') {
            hitY = true; break;
          }
          if (window.serial?.write) await window.serial.write('?');
          else await window.serial.writeLine('?');
          await new Promise(r => setTimeout(r, 50));
        }

        activeHomingAxisRef.current = null;
        homingHitDetectedRef.current = false;
        if (!hitY) throw new Error('Y limit switch not reached within 120s');

        // Switch hit! GRBL hardware interrupt immediately stopped motor.
        // stopAndRecover sends \x18, sets $21=0, clears alarm, ready to pull off
        await stopAndRecover('Y');
      }

      // Pull off Y 10mm (hard limits are now $21=0, so move away succeeds)
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Pulling off Y 10mm...`].slice(-500));
      await window.serial.writeLine(fw.relMode); // G91
      await new Promise(r => setTimeout(r, 100));
      await window.serial.writeLine('G1 Y10 F200');
      await waitForMotionComplete(10, 200, 6000);
      await window.serial.writeLine(fw.absMode); // G90
      await new Promise(r => setTimeout(r, 100));
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Y Axis Homed & Pulled Off 10mm.`].slice(-500));


      // ==========================================
      // FINALE: ESTABLISH ORIGIN (0, 0, 0)
      // ==========================================
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Establishing Origin (0, 0, 0) at current position...`].slice(-500));

      // 1. Direct firmware coordinate offset to 0 for all 3 axes
      await window.serial.writeLine('G10 L20 P1 X0 Y0 Z0');
      await new Promise(r => setTimeout(r, 200));
      await window.serial.writeLine('G92 X0 Y0 Z0');
      await new Promise(r => setTimeout(r, 150));

      // 2. Direct GRBL to report Work Position (WPos) directly
      await window.serial.writeLine('$10=0');
      await new Promise(r => setTimeout(r, 100));

      // 3. Sync app-side coordinate system immediately with current MPos
      setOriginToCurrent();

      // 4. Configure firmware acceleration and max speeds for buttery-smooth motion:
      // $120=80, $121=50: Smooth acceleration ramping ($121=50 for quiet, resonance-free Y motion)
      // $110=500, $111=300: Safe max travel rates (Y capped at 300 mm/min to eliminate all Y noise)
      // $11=0.015: Smooth cornering junction deviation
      await window.serial.writeLine('$120=80');
      await new Promise(r => setTimeout(r, 60));
      await window.serial.writeLine('$121=50');
      await new Promise(r => setTimeout(r, 60));
      await window.serial.writeLine('$110=500');
      await new Promise(r => setTimeout(r, 60));
      await window.serial.writeLine('$111=300');
      await new Promise(r => setTimeout(r, 60));
      await window.serial.writeLine('$11=0.015');
      await new Promise(r => setTimeout(r, 60));

      // 5. Return to Absolute Mode and query status
      await window.serial.writeLine(fw.absMode); // G90
      await new Promise(r => setTimeout(r, 150));
      if (window.serial?.write) await window.serial.write('?');
      else await window.serial.writeLine('?');
      await new Promise(r => setTimeout(r, 250));

      if (onMachinePositionUpdate) onMachinePositionUpdate({ x: 0, y: 0, z: 0 });

      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} All axes successfully homed! Machine ready at (0, 0, 0).`].slice(-500));
      if (onHomingComplete) onHomingComplete();

    } catch (err) {
      console.error("Auto-homing error:", err);
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Auto-home error: ${err.message || err}`].slice(-500));
      toast.error(`Auto-home error: ${err.message || err}`);
    } finally {
      try { await window.serial?.writeLine('$21=0'); } catch {}
      setIsHoming(false);
      window._pollPauseCount = 0;
      window.pauseSerialPolling = false;
      startStatusQuery();
    }
  };

  useEffect(() => {
    window._runAutoHomingSequence = runSmartHomingSequence;
    return () => { delete window._runAutoHomingSequence; };
  }, []);

  const connect = async () => {
    if (!path) { toast.warning("Select a serial port first."); return; }
    try {
      hasReceivedPosRef.current = false;
      setIsHoming(true);
      window._pollPauseCount = 0;
      await window.serial.open({ path, baudRate: baud });
      if (onConnect) onConnect();

      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Connected. Waking up machine...`].slice(-500));

      window.pauseSerialPolling = true;

      // Wait 3.5 seconds for Arduino Mega to boot
      await new Promise(r => setTimeout(r, 3500));

      // Preset smooth motion tuning in GRBL firmware EEPROM
      try {
        await window.serial.writeLine('$120=80');
        await new Promise(r => setTimeout(r, 60));
        await window.serial.writeLine('$121=50');
        await new Promise(r => setTimeout(r, 60));
        await window.serial.writeLine('$110=500');
        await new Promise(r => setTimeout(r, 60));
        await window.serial.writeLine('$111=300');
        await new Promise(r => setTimeout(r, 60));
        await window.serial.writeLine('$11=0.015');
        await new Promise(r => setTimeout(r, 60));
      } catch {}

      startWatchdog(25);

      // Run our intelligent homing sequence!
      await runSmartHomingSequence();

    } catch (e) {
      toast.error(`Failed to open ${path}: ${e.message}`);
    } finally {
      try { await window.serial?.writeLine('$21=0'); } catch {}
      setIsHoming(false);
      window._pollPauseCount = 0;
      window.pauseSerialPolling = false;
      startStatusQuery();
    }
  };

  connectRef.current = connect; // always points to the latest connect closure

  const stopWatchdog = () => {
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
  };

  const startWatchdog = (delaySec = 0) => {
    stopWatchdog();
    // Seed with future time so an initial grace period can be applied.
    // Arduino Mega 2560 resets on DTR and takes up to 8 s to boot Marlin;
    // without this delay the watchdog fires before the first M114 response arrives.
    lastDataRef.current = Date.now() + delaySec * 1000;
    watchdogRef.current = setInterval(() => {
      if (window.pauseSerialPolling) {
        // A job is actively running — G-code write failures will catch cable pulls.
        // Reset the timer so we don't accumulate stale time during long moves/dwells.
        lastDataRef.current = Date.now();
        return;
      }
      if (Date.now() - lastDataRef.current > 10000) {
        // No incoming data for 10 s while idle → cable pulled or port closed
        stopWatchdog();
        if (statusQueryRef.current) { clearInterval(statusQueryRef.current); statusQueryRef.current = null; }
        try { window.serial.close(); } catch { }
        setIsHoming(false);
        hasReceivedPosRef.current = false;
        const handler = onUnexpectedDisconnect || onDisconnect;
        if (handler) handler();
      }
    }, 1000);
  };

  // Called by the dispense loop on every successful G-code write so the watchdog
  // knows the connection is alive even when '?' polling is paused.
  useEffect(() => {
    window.serialHeartbeat = () => { lastDataRef.current = Date.now(); };
    return () => { delete window.serialHeartbeat; };
  }, []);

  const startStatusQuery = () => {
    if (statusQueryRef.current) clearInterval(statusQueryRef.current);
    let failCount = 0;
    // GRBL status query interval: 200 ms (GRBL responds with real-time status)
    statusQueryRef.current = setInterval(async () => {
      if (window.pauseSerialPolling) { failCount = 0; return; } // job running — skip
      try {
        if (window.serial?.write) await window.serial.write(fw.statusQuery);
        else await window.serial.writeLine(fw.statusQuery);
        failCount = 0;
      } catch {
        failCount++;
        if (failCount >= 5) {
          // 5 consecutive write failures (~1.0 s) → port closed unexpectedly
          clearInterval(statusQueryRef.current);
          statusQueryRef.current = null;
          stopWatchdog();
          try { await window.serial.close(); } catch { }
          setIsHoming(false);
          hasReceivedPosRef.current = false;
          const handler = onUnexpectedDisconnect || onDisconnect;
          if (handler) handler();
        }
      }
    }, 200);
  };

  const disconnect = async () => {
    stopWatchdog();
    if (statusQueryRef.current) {
      clearInterval(statusQueryRef.current);
      statusQueryRef.current = null;
    }
    try {
      if (isConnected && window.serial?.writeLine) {
        await window.serial.writeLine('\x18'); // Soft Reset to abort stuck operations
      }
      await window.serial.close();
    } catch { }
    setIsHoming(false);
    if (onDisconnect) onDisconnect();
  };

  const sendCommand = async (cmd) => {
    if (!isConnected) return;
    const ts = new Date().toISOString();
    setConsoleLines((prev) => [...prev, `[SEND] - ${ts} - ${cmd}`].slice(-500));
    try {
      await window.serial.writeLine(cmd);
    } catch (e) {
      toast.error(`Send failed: ${e.message || e}`);
    }
  };

  const sendLine = async () => {
    const line = inputRef.current?.value.trim();
    if (!line) return;
    inputRef.current.value = '';
    await sendCommand(line);
  };

  const sendFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    try {
      await window.serial.sendGcode(text);
    } catch (err) {
      toast.error(`Send file failed: ${err.message || err}`);
    }
    e.target.value = '';
  };

  return (
    <div className="panel serial-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ marginTop: 10, marginLeft: 8 }}>
          Machine Connectivity
          {isConnected && <span className="text-success" style={{ fontSize: '0.6em', background: 'rgba(0, 232, 122, 0.1)', padding: '2px 6px', borderRadius: 4, marginLeft: 8, verticalAlign: 'middle', border: '1px solid var(--status-ok)' }}>CONNECTED</span>}
        </h3>

        {/* Machine Position Display */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isConnected && isHoming && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '0.7em', fontWeight: 'bold', background: '#ffaa00', color: 'black', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase', animation: 'pulse 1.5s infinite' }}>
                Homing...
              </span>
              <button
                onClick={abortHoming}
                style={{
                  background: '#ff3333',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  padding: '3px 8px',
                  fontSize: '0.75em',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
                title="Immediately halt motors and stop homing sequence"
              >
                Abort
              </button>
            </div>
          )}
          {isConnected && !isHoming && isHomed && hasReceivedPosRef.current && (
            <span className="text-success" style={{ fontSize: '0.7em', fontWeight: 'bold', background: 'rgba(0, 232, 122, 0.1)', border: '1px solid var(--status-ok)', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase' }}>
              Homed
            </span>
          )}
          {isConnected && !isHoming && !isHomed && hasReceivedPosRef.current && (
            <span className="text-warning" style={{ fontSize: '0.7em', fontWeight: 'bold', background: 'rgba(245, 166, 35, 0.1)', border: '1px solid var(--status-warn)', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase' }}>
              Position Known
            </span>
          )}
          <div style={{
            background: '#222',
            color: '#0f0',
            fontFamily: 'monospace',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: '0.9em',
            display: 'flex',
            gap: '12px'
          }}>
            <span>X: {machinePosition.x.toFixed(2)}</span>
            <span>Y: {machinePosition.y.toFixed(2)}</span>
            <span>Z: {machinePosition.z.toFixed(2)}</span>
          </div>

          {/* Real-time Endstop Diagnostic Badges */}
          {isConnected && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              background: '#1a1a1a',
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #333',
              fontSize: '0.75em',
              fontFamily: 'monospace'
            }} title="Real-time Limit Switch / Endstop States from GRBL status (? Pn:)">
              <span style={{ color: '#888' }}>PINS:</span>
              <span style={{
                padding: '2px 5px',
                borderRadius: 3,
                background: endstops.x ? '#ff3333' : '#2a2a2a',
                color: endstops.x ? '#fff' : '#666',
                fontWeight: endstops.x ? 'bold' : 'normal',
                border: endstops.x ? '1px solid #ff6666' : '1px solid transparent'
              }}>X</span>
              <span style={{
                padding: '2px 5px',
                borderRadius: 3,
                background: endstops.y ? '#ff3333' : '#2a2a2a',
                color: endstops.y ? '#fff' : '#666',
                fontWeight: endstops.y ? 'bold' : 'normal',
                border: endstops.y ? '1px solid #ff6666' : '1px solid transparent'
              }}>Y</span>
              <span style={{
                padding: '2px 5px',
                borderRadius: 3,
                background: endstops.z ? '#ff3333' : '#2a2a2a',
                color: endstops.z ? '#fff' : '#666',
                fontWeight: endstops.z ? 'bold' : 'normal',
                border: endstops.z ? '1px solid #ff6666' : '1px solid transparent'
              }}>Z</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-row" style={{ marginTop: 8, marginLeft: 8, marginRight: 8, paddingBottom: 16, borderBottom: '1px solid #444', flexWrap: 'wrap', gap: '8px' }}>
        <button className="btn secondary" onClick={refresh}>Refresh</button>

        <select value={baud} onChange={e => setBaud(Number(e.target.value))} style={{ width: 100 }}>
          <option value={115200}>115200</option>
          <option value={250000}>250000</option>
          <option value={57600}>57600</option>
          <option value={9600}>9600</option>
        </select>

        <select value={path} onChange={e => setPath(e.target.value)} style={{ minWidth: 220, flex: 1 }}>
          {ports.length === 0
            ? <option value="">(no serial ports found)</option>
            : ports.map(p => (
              <option key={p.path} value={p.path}>
                {p.friendly || p.path}
              </option>
            ))
          }
        </select>

        <button className="btn" onClick={connect} disabled={!path || isConnected}>Connect</button>
        <button className="btn secondary" onClick={disconnect} disabled={!isConnected}>Disconnect</button>

        <label className="btn">
          Send file
          <input type="file" accept=".gcode,.nc,.txt" style={{ display: 'none' }} onChange={sendFile} disabled={!isConnected} />
        </label>
      </div>

      <div className="serial-layout">
        {/* Left Panel: Control Grid */}
        <div className="control-pane">
          <h3>Control</h3>
          <div className="control-grid-5" style={{ marginTop: 'auto' }}>
            <button className="btn-dark small" onClick={runSmartHomingSequence} disabled={isHoming || !isConnected} title="Run Guided Auto-Homing (Z 10mm Lift + XY Home)">Home<br />All</button>
            <button className="btn-dark small" onClick={() => sendCommand(fw.homeX)} disabled={isHoming || !isConnected}>Home<br />X</button>
            <button className="btn-dark small" onClick={() => sendCommand(fw.homeY)} disabled={isHoming || !isConnected}>Home<br />Y</button>
          </div>
        </div>

        {/* Right Panel: Formatted Console */}
        <div className="console-pane">
          <div className="console-window">
            {consoleLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
          <div className="console-input-row">
            <button className="btn-send" onClick={sendLine} disabled={!isConnected}>Send</button>
            <input
              ref={inputRef}
              placeholder="G-code command..."
              onKeyDown={(e) => e.key === 'Enter' && sendLine()}
              disabled={!isConnected}
            />
          </div>
        </div>
      </div>
    </div>
  );
}


