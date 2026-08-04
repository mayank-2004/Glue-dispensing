import { useEffect, useRef, useState } from "react";
import "./SerialPanel.css";
import { useToast } from '../Toast.jsx';

export default function SerialPanel({
  onMachinePositionUpdate = null,
  isConnected = false,
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
  const [baud, setBaud] = useState(250000);
  const [consoleLines, setConsoleLines] = useState([]);
  const [isHoming, setIsHoming] = useState(false);

  const inputRef = useRef(null);
  const mPosRef = useRef(machinePosition);
  const hasReceivedPosRef = useRef(false);
  const statusQueryRef = useRef(null); // interval handle for M114 polling
  const watchdogRef = useRef(null);   // interval handle for data-update watchdog
  const lastDataRef = useRef(0);      // timestamp of last received serial data
  const awaitingOkRef = useRef(null);      // one-shot callback fired on next "ok" from Marlin
  const marlinBootCbRef = useRef(null);    // fired once when Marlin's boot message is detected
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
      marlinBootCbRef.current = null;  // cancel any pending boot detection
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
      toast.info("Machine detected — reconnecting automatically…");
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
          // Send Quick Stop (M410) to flush the machine's internal buffer
          if (window.serial.writeLine) {
            window.serial.writeLine('M410');
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
      setConsoleLines((prev) => [...prev, `[RECE] ${ts} ${line}`].slice(-500));

      let x = null, y = null, z = null;
      // Try Marlin format
      const marlinMatch = line.match(/X\s*:\s*([-\d.]+).*?Y\s*:\s*([-\d.]+).*?Z\s*:\s*([-\d.]+)/i);
      if (marlinMatch) {
        x = parseFloat(marlinMatch[1]);
        y = parseFloat(marlinMatch[2]);
        z = parseFloat(marlinMatch[3]);
      } else {
        // Try GRBL format
        const grblMatch = line.match(/MPos:([-\d.]+),([-\d.]+),([-\d.]+)/);
        if (grblMatch) {
          x = parseFloat(grblMatch[1]);
          y = parseFloat(grblMatch[2]);
          z = parseFloat(grblMatch[3]);
        }
      }

      if (x !== null && y !== null && z !== null) {
        hasReceivedPosRef.current = true;
        const pos = { x, y, z };
        if (onMachinePositionUpdate) onMachinePositionUpdate(pos);
      }
      // Detect Marlin boot — fires the ready callback as soon as firmware is alive
      if (marlinBootCbRef.current) {
        const trimmed = line.trim();
        const isReady = /\bstart\b/i.test(trimmed)
                     || /marlin/i.test(trimmed)
                     || /^ok\b/i.test(trimmed);
        if (isReady) {
          const cb = marlinBootCbRef.current;
          marlinBootCbRef.current = null;
          cb();
        }
      }

      // Resolve pending G28 ok-waiter (fires when Marlin sends "ok" after homing completes)
      if (awaitingOkRef.current && /^ok\b/i.test(line.trim())) {
        const cb = awaitingOkRef.current;
        awaitingOkRef.current = null;
        cb();
      }
      // Bridge for BedCalibrationPanel auto-probe (M119 endstop response)
      if (line.includes('z_min:')) {
        const triggered = /z_min:\s*TRIGGERED/i.test(line);
        window.dispatchEvent(new CustomEvent(
          triggered ? 'endstop-z-probe-triggered' : 'endstop-z-probe-open'
        ));
      }
    });
    return unsub;
  }, []);

  const connect = async () => {
    if (!path) { toast.warning("Select a serial port first."); return; }
    try {
      hasReceivedPosRef.current = false;
      setIsHoming(false);
      window._pollPauseCount = 0; // always start clean
      await window.serial.open({ path, baudRate: baud });
      // setConnected(true); // Removed
      if (onConnect) onConnect(); // Notify Parent
      
      setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Connected to ${path} at ${baud} baud.`].slice(-500));

      // Grace period covers DTR reset + bootloader + Marlin boot + fallback delay.
      // 15 s is enough for the slowest boards; on fast ones the boot message
      // arrives in 3-6 s and homing starts immediately.
      startWatchdog(skipHome ? 0 : 15);

      if (skipHome) {
        // Reconnect — machine is at a known position, resume M114 polling immediately
        startStatusQuery();
        setTimeout(async () => {
          try { await window.serial.writeLine('M114'); } catch {}
        }, 500);
      } else {
        // Dynamic boot detection for RAMPS v1.4 + Arduino Mega 2560:
        // Arduino resets on USB connect (DTR), bootloader runs ~2s, then Marlin boots ~4-6s.
        // We listen for Marlin's "start" / version line / first "ok" instead of fixed delays.
        // Falls back to 12s if no boot message received.
        let bootHandled = false;

        const onMarlinReady = async () => {
          if (bootHandled) return;
          bootHandled = true;
          clearTimeout(bootFallback);
          console.log('[Boot] Marlin ready — starting M114 polling and homing sequence');

          startStatusQuery();

          await new Promise(r => setTimeout(r, 500));

          try {
            setIsHoming(true);
            window.pauseSerialPolling = true;
            // Wait 3 seconds to allow stepper drivers and Marlin to fully stabilize 
            // after the bootloader reset before blasting movement commands.
            await new Promise(r => setTimeout(r, 3000));

            setConsoleLines(prev => [...prev, `[SYS] ${new Date().toISOString()} Starting Auto-Home (G28)...`].slice(-500));
            await window.serial.writeLine('G90');
            await window.serial.writeLine('G28');
            await window.serial.writeLine('M400');

            const homingTimeout = setTimeout(() => {
              awaitingOkRef.current = null;
              window.pauseSerialPolling = false;
              setIsHoming(false);
              if (onHomingComplete) onHomingComplete();
            }, 120000);

            let okPhase = 0;
            const resolveHoming = () => {
              okPhase++;
              if (okPhase < 2) {
                awaitingOkRef.current = resolveHoming;
              } else {
                clearTimeout(homingTimeout);
                window.pauseSerialPolling = false;
                setIsHoming(false);
                if (onHomingComplete) onHomingComplete();
              }
            };
            awaitingOkRef.current = resolveHoming;
          } catch (e) {
            console.error(e);
            window.pauseSerialPolling = false;
            setIsHoming(false);
            toast.warning("Auto-home failed — check machine connection and retry.");
          }
        };

        marlinBootCbRef.current = onMarlinReady;

        const bootFallback = setTimeout(() => {
          if (!bootHandled) {
            console.warn('[Boot] No Marlin boot message in 12 s — using fallback timing');
            marlinBootCbRef.current = null;
            onMarlinReady();
          }
        }, 12000);
      }
    } catch (e) {
      toast.error(`Failed to open ${path}: ${e.message}`);
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
        try { window.serial.close(); } catch {}
        setIsHoming(false);
        hasReceivedPosRef.current = false;
        const handler = onUnexpectedDisconnect || onDisconnect;
        if (handler) handler();
      }
    }, 1000);
  };

  // Called by the dispense loop on every successful G-code write so the watchdog
  // knows the connection is alive even when M114 polling is paused.
  useEffect(() => {
    window.serialHeartbeat = () => { lastDataRef.current = Date.now(); };
    return () => { delete window.serialHeartbeat; };
  }, []);

  const startStatusQuery = () => {
    if (statusQueryRef.current) clearInterval(statusQueryRef.current);
    let failCount = 0;
    statusQueryRef.current = setInterval(async () => {
      if (window.pauseSerialPolling) { failCount = 0; return; } // job running — skip
      try {
        await window.serial.writeLine('M114');
        failCount = 0;
      } catch {
        failCount++;
        if (failCount >= 3) {
          // 3 consecutive write failures (~1.5 s) → port closed unexpectedly
          clearInterval(statusQueryRef.current);
          statusQueryRef.current = null;
          stopWatchdog();
          try { await window.serial.close(); } catch {}
          setIsHoming(false);
          hasReceivedPosRef.current = false;
          const handler = onUnexpectedDisconnect || onDisconnect;
          if (handler) handler();
        }
      }
    }, 500);
  };

  const disconnect = async () => {
    stopWatchdog();
    if (statusQueryRef.current) {
      clearInterval(statusQueryRef.current);
      statusQueryRef.current = null;
    }
    try { await window.serial.close(); } catch { }
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
            <span style={{ fontSize: '0.7em', fontWeight: 'bold', background: '#ffaa00', color: 'black', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase', animation: 'pulse 1.5s infinite' }}>
              Homing...
            </span>
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
        </div>
      </div>

      <div className="flex-row" style={{ marginTop: 8, paddingBottom: 16, borderBottom: '1px solid #444', flexWrap: 'wrap', gap: '8px' }}>
        <button className="btn secondary" onClick={refresh}>Refresh</button>

        <select value={baud} onChange={e => setBaud(Number(e.target.value))} style={{ width: 100 }}>
          <option value={250000}>250000</option>
          <option value={115200}>115200</option>
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
          {/* <div className="control-grid-3">
            <button className="btn-dark" onClick={() => sendCommand('M8')}>Left Air On</button>
            <button className="btn-dark" onClick={() => sendCommand('M8')}>Right Air On</button>
            <button className="btn-dark" onClick={() => sendCommand('M8')}>Ring Lights On</button>
 
            <button className="btn-dark" onClick={() => sendCommand('M9')}>Left Air Off</button>
            <button className="btn-dark" onClick={() => sendCommand('M9')}>Right Air Off</button>
            <button className="btn-dark" onClick={() => sendCommand('M9')}>Ring Lights Off</button>

            <button className="btn-dark" onClick={() => sendCommand('M8')}>Left Vac</button>
            <button className="btn-dark" onClick={() => sendCommand('M8')}>Right Vac</button>
            <button className="btn-dark" onClick={() => sendCommand('M18')}>Disable<br />Steppers</button>
          </div> */}

          <div className="control-grid-5" style={{ marginTop: 'auto' }}>
            <button className="btn-dark small" onClick={() => sendCommand('G28 X')}>Home<br />X</button>
            <button className="btn-dark small" onClick={() => sendCommand('G28 Y')}>Home<br />Y</button>
            <button className="btn-dark small" onClick={() => sendCommand('G28 Z')}>Home<br />Z</button>
            {/* <button className="btn-dark small" onClick={() => sendCommand('G0 X200')}>Jog<br/>Max</button>
            <button className="btn-dark small" onClick={() => sendCommand('G0 X0')}>Jog<br/>Min</button> */}
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
