import { useEffect, useRef, useState } from "react";
import "./SerialPanel.css";

export default function SerialPanel({
  onMachinePositionUpdate = null,
  isConnected = false,
  onConnect,
  onDisconnect,
  machinePosition = { x: 0, y: 0, z: 0 } // Default for safety
}) {
  const [ports, setPorts] = useState([]);
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState(115200);
  // const [connected, setConnected] = useState(false); // Removed local state
  const [consoleLines, setConsoleLines] = useState([]);
  const [isHoming, setIsHoming] = useState(false);
  const [pendingHomeZero, setPendingHomeZero] = useState(false);

  const inputRef = useRef(null);
  const mPosRef = useRef(machinePosition);
  const hasReceivedPosRef = useRef(false);

  useEffect(() => {
    mPosRef.current = machinePosition;

    // Auto-clear homing status once machine actually reaches 0,0,0
    if (isHoming && Math.abs(machinePosition.x) < 0.01 && Math.abs(machinePosition.y) < 0.01 && Math.abs(machinePosition.z) < 0.01) {
      setIsHoming(false);
    }

    // Trigger the 0,0,0 move when the controller actually reaches the physical -3, -10 hardware offsets
    if (pendingHomeZero) {
      const atHardwareHome = Math.abs(machinePosition.x - (-3)) < 0.1 &&
        Math.abs(machinePosition.y - (-10)) < 0.1 &&
        Math.abs(machinePosition.z - 0) < 0.1;

      if (atHardwareHome) {
        setPendingHomeZero(false);
        setTimeout(async () => {
          try {
            console.log("Moving to true Home (0,0,0) offset from hardware switches...");
            await window.serial.writeLine('G90');
            await window.serial.writeLine('G0 X0 Y0 Z0');
          } catch (e) {
            console.error("Home offset move failed:", e);
          }
        }, 100);
      }
    }
  }, [machinePosition, isHoming, pendingHomeZero]);

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
      setConsoleLines((prev) => [...prev, line].slice(-500));

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
    });
  }, []);

  const connect = async () => {
    if (!path) return alert("Select a serial port first.");
    try {
      hasReceivedPosRef.current = false;
      setIsHoming(false);
      setPendingHomeZero(false);
      await window.serial.open({ path, baudRate: baud });
      // setConnected(true); // Removed
      if (onConnect) onConnect(); // Notify Parent

      startStatusQuery();

      // Auto-Home
      setTimeout(async () => {
        try {
          const pos = mPosRef.current;
          const isAtHome = hasReceivedPosRef.current &&
            Math.abs(pos.x) < 0.01 &&
            Math.abs(pos.y) < 0.01 &&
            Math.abs(pos.z) < 0.01;

          if (!isAtHome) {
            console.log("Machine not at home (or position unknown), sending G28 auto-home...");
            setIsHoming(true);
            setPendingHomeZero(true);
            await window.serial.writeLine('G28');
          } else {
            console.log("Machine already at home position (0,0,0). Skipping G28.");
          }
        } catch (e) {
          console.error(e);
        }
      }, 2000);
    } catch (e) {
      alert(`Failed to open ${path}: ${e.message}`);
    }
  };

  const startStatusQuery = () => {
    const interval = setInterval(async () => {
      try {
        await window.serial.writeLine('M114');
      } catch (e) { console.error(e); }
    }, 500);
    return interval;
  };

  const disconnect = async () => {
    try { await window.serial.close(); } catch { }
    setIsHoming(false);
    // setConnected(false); // Removed
    if (onDisconnect) onDisconnect();
  };

  const sendLine = async () => {
    const line = inputRef.current.value.trim();
    if (!line) return;
    inputRef.current.value = '';
    try {
      await window.serial.writeLine(line);
    } catch (e) {
      alert(`Write failed: ${e.message || e}`);
    }
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
          {isConnected && !isHoming && hasReceivedPosRef.current && Math.abs(machinePosition.x) < 0.01 && Math.abs(machinePosition.y) < 0.01 && Math.abs(machinePosition.z) < 0.01 && (
            <span style={{ fontSize: '0.7em', fontWeight: 'bold', background: '#00c49a', color: 'black', padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase' }}>
              At Home (0,0,0)
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

      <div className="flex-row">
        <button className="btn secondary" onClick={refresh}>Refresh</button>

        <select value={baud} onChange={e => setBaud(Number(e.target.value))} style={{ width: 100, marginLeft: 8 }}>
          <option value={115200}>115200</option>
          <option value={250000}>250000</option>
          <option value={57600}>57600</option>
          <option value={9600}>9600</option>
        </select>

        <select value={path} onChange={e => setPath(e.target.value)} style={{ minWidth: 220 }}>
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
      </div>

      <div className="flex-row" style={{ marginTop: 8 }}>
        <input ref={inputRef} placeholder="G-code line..." style={{ flex: 1 }} />
        <button className="btn" onClick={sendLine} disabled={!isConnected}>Send</button>
        <label className="btn">
          Send file
          <input type="file" accept=".gcode,.nc,.txt" style={{ display: 'none' }} onChange={sendFile} disabled={!isConnected} />
        </label>
      </div>

      <div className="console" style={{ marginTop: 8, height: 200, overflowY: 'auto', background: '#333', color: '#0f0', padding: 4, fontSize: 12 }}>
        {consoleLines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
