import { useEffect, useRef, useState } from "react";
import "./SerialPanel.css";

export default function SerialPanel({
  onMachinePositionUpdate = null,
  isConnected = false,
  onConnect,
  onDisconnect,
  onHomingComplete,
  machinePosition = { x: 0, y: 0, z: 0 } // Default for safety
}) {
  const [ports, setPorts] = useState([]);
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState(115200);
  // const [connected, setConnected] = useState(false); // Removed local state
  const [consoleLines, setConsoleLines] = useState([]);
  const [isHoming, setIsHoming] = useState(false);

  const inputRef = useRef(null);
  const mPosRef = useRef(machinePosition);
  const hasReceivedPosRef = useRef(false);

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

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    window.serial.onData((line) => {
      const ts = new Date().toISOString();
      const isStatusPos = line.match(/X\s*:\s*([-\d.]+)/i) || line.match(/MPos:([-\d.]+)/);
      // Optional: hide M114 responses if they spam too much, but for now we'll format them all
      // as per request if they aren't purely repetitive. We will just format it.
      if (!isStatusPos) {
        setConsoleLines((prev) => [...prev, `[RECE] - ${ts} - ${line}`].slice(-500));
      }

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
      // Bridge for BedCalibrationPanel auto-probe (M119 endstop response)
      if (line.includes('z_min:')) {
        const triggered = /z_min:\s*TRIGGERED/i.test(line);
        window.dispatchEvent(new CustomEvent(
          triggered ? 'endstop-z-probe-triggered' : 'endstop-z-probe-open'
        ));
      }
    });
  }, []);

  const connect = async () => {
    if (!path) return alert("Select a serial port first.");
    try {
      hasReceivedPosRef.current = false;
      setIsHoming(false);
      await window.serial.open({ path, baudRate: baud });
      // setConnected(true); // Removed
      if (onConnect) onConnect(); // Notify Parent

      startStatusQuery();

      // Auto-Home
      setTimeout(async () => {
        try {
          console.log("Sending G28 auto-home...");
          setIsHoming(true);
          await window.serial.writeLine('G28');
          // Clear homing status after a reasonable time since we are no longer tracking reach
          setTimeout(() => {
            setIsHoming(false);
            if (onHomingComplete) onHomingComplete();
          }, 5000);
        } catch (e) {
          console.error(e);
          setIsHoming(false);
        }
      }, 2000);
    } catch (e) {
      alert(`Failed to open ${path}: ${e.message}`);
    }
  };

  const startStatusQuery = () => {
    const interval = setInterval(async () => {
      if (window.pauseSerialPolling) return; // Prevent background M114s causing 'ok' spam
      try {
        await window.serial.writeLine('M114');
      } catch { /* ignore */ }
    }, 500);
    return interval;
  };

  const disconnect = async () => {
    try { await window.serial.close(); } catch { }
    setIsHoming(false);
    // setConnected(false); // Removed
    if (onDisconnect) onDisconnect();
  };

  const sendCommand = async (cmd) => {
    if (!isConnected) return;
    const ts = new Date().toISOString();
    setConsoleLines((prev) => [...prev, `[SEND] - ${ts} - ${cmd}`].slice(-500));
    try {
      await window.serial.writeLine(cmd);
    } catch (e) {
      alert(`Send failed: ${e.message || e}`);
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
      alert(`Send file failed: ${err.message || err}`);
    }
    e.target.value = '';
  };

  return (
    <div className="panel serial-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>
          Machine Connectivity
          {isConnected && <span style={{ fontSize: '0.6em', background: '#28a745', color: 'white', padding: '2px 6px', borderRadius: 4, marginLeft: 8, verticalAlign: 'middle' }}>CONNECTED</span>}
        </h3>

        {/* Machine Position Display */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isConnected && (isHoming || !hasReceivedPosRef.current) && (
            <span style={{ fontSize: '0.7em', fontWeight: 'bold', background: '#ffaa00', color: 'black', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase', animation: 'pulse 1.5s infinite' }}>
              Homing...
            </span>
          )}
          {isConnected && !isHoming && hasReceivedPosRef.current && (
            <span style={{ fontSize: '0.7em', fontWeight: 'bold', background: '#00c49a', color: 'black', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase' }}>
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
