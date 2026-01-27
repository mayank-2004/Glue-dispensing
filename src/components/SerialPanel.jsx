import { useEffect, useRef, useState } from "react";
import "./SerialPanel.css";
import { DispensingSequencer } from '../lib/automation/dispensingSequence.js';

export default function SerialPanel({
  dispensingSequence = [],
  jobStatistics = null,
  pressureSettings = {},
  speedSettings = {},
  onJobStart = null,
  onJobComplete = null
}) {
  const [ports, setPorts] = useState([]);
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState(115200);
  const [connected, setConnected] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const [isRunningJob, setIsRunningJob] = useState(false);
  const [jobProgress, setJobProgress] = useState({ current: 0, total: 0 });
  const [machineStatus, setMachineStatus] = useState('idle'); // idle, busy, error
  const dispensingSequencer = new DispensingSequencer();
  const inputRef = useRef(null);

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
    });
  }, []);

  const connect = async () => {
    if (!path) {
      alert("Select a serial port first (click Refresh, pick COM/tty, then Connect).");
      return;
    }
    try {
      await window.serial.open({ path, baudRate: baud });
      setConnected(true);
    } catch (e) {
      alert(`Failed to open ${path}: ${e.message || e}`);
    }
  };

  const disconnect = async () => {
    try { await window.serial.close(); } catch { }
    setConnected(false);
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

  const startDispensingJob = async () => {
    if (!connected || !dispensingSequence.length) return;

    setIsRunningJob(true);
    setJobProgress({ current: 0, total: dispensingSequence.length });
    setMachineStatus('busy');

    try {
      // Generate G-code for the job
      const gcode = generateJobGCode();

      // Send initialization commands
      await window.serial.writeLine('G21 ; Set units to millimeters');
      await window.serial.writeLine('G90 ; Absolute positioning');
      await window.serial.writeLine('G28 ; Home all axes');
      await window.serial.writeLine('G1 Z6 F3000 ; Move to safe height');

      // Process each pad
      for (let i = 0; i < dispensingSequence.length; i++) {
        const pad = dispensingSequence[i];
        setJobProgress({ current: i + 1, total: dispensingSequence.length });

        // Move to pad and dispense
        await window.serial.writeLine(`G1 X${pad.x.toFixed(3)} Y${pad.y.toFixed(3)} Z6 F3000`);
        await window.serial.writeLine('G1 Z0.1 F500');
        await window.serial.writeLine(`M42 P4 S${calculatePressure(pad)}`);
        await window.serial.writeLine(`G4 P${calculateDwellTime(pad)}`);
        await window.serial.writeLine('M42 P4 S0');
        await window.serial.writeLine('G1 Z6 F3000');

        // Small delay between pads
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      setMachineStatus('idle');
      onJobComplete?.();
    } catch (error) {
      setMachineStatus('error');
      alert(`Job failed: ${error.message}`);
    } finally {
      setIsRunningJob(false);
      setJobProgress({ current: 0, total: 0 });
    }
  };

  const stopJob = async () => {
    try {
      await window.serial.writeLine('M42 P4 S0 ; Stop dispensing');
      await window.serial.writeLine('G1 Z6 F3000 ; Move to safe height');
      setIsRunningJob(false);
      setMachineStatus('idle');
    } catch (error) {
      console.error('Failed to stop job:', error);
    }
  };

  const calculatePressure = (pad) => {
    const baseP = pressureSettings.customPressure || 25;
    const area = (pad.width || 1) * (pad.height || 1);
    return area < 0.5 ? Math.round(baseP * 1.3) : baseP;
  };

  const calculateDwellTime = (pad) => {
    const baseT = pressureSettings.customDwellTime || 120;
    const area = (pad.width || 1) * (pad.height || 1);
    return area < 0.5 ? Math.round(baseT * 0.8) : baseT;
  };

  const generateJobGCode = () => {
    return dispensingSequencer.generateDispensingGCode(
      referencePoint || selectedOrigin || { x: 0, y: 0 },
      dispensingSequence,
      { pressureSettings, speedSettings }
    );
  };

  return (
    <div className="card">
      <h3>Machine</h3>

      <div className="flex-row">
        <button className="btn secondary" onClick={refresh}>Refresh</button>

        <select value={path} onChange={e => setPath(e.target.value)} style={{ minWidth: 220 }}>
          {ports.length === 0
            ? <option value="">(no serial ports found)</option>
            : ports.map(p => (
              <option key={p.path} value={p.path}>
                {p.label} — {p.path}
              </option>
            ))
          }
        </select>

        <input type="number" value={baud} onChange={e => setBaud(+e.target.value)} style={{ width: 120 }} />

        <button className="btn" onClick={connect} disabled={!path || connected}>Connect</button>
        <button className="btn secondary" onClick={disconnect} disabled={!connected}>Disconnect</button>
      </div>

      {ports.length === 0 && (
        <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>
          No ports found. Make sure your machine is plugged in and shows a COM/tty in Device Manager.
          Install drivers if needed (common: FTDI/CP2102/CH340). Click Refresh after plugging in.
        </div>
      )}

      {/* Job Control Section */}
      {dispensingSequence.length > 0 && (
        <div className="job-control" style={{ marginTop: 12, padding: 8, backgroundColor: '#f8f9fa', borderRadius: 4 }}>
          <h4 style={{ margin: '0 0 8px 0' }}>Dispensing Job Control</h4>

          {jobStatistics && (
            <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
              {jobStatistics.totalPads} pads • {jobStatistics.totalDistance}mm • ~{jobStatistics.estimatedTime}min
            </div>
          )}

          <div className="flex-row" style={{ gap: 8 }}>
            <button
              className="btn"
              onClick={startDispensingJob}
              disabled={!connected || isRunningJob}
              style={{ backgroundColor: isRunningJob ? '#28a745' : undefined }}
            >
              {isRunningJob ? '🔄 Running...' : '▶️ Start Job'}
            </button>

            <button
              className="btn secondary"
              onClick={stopJob}
              disabled={!connected || !isRunningJob}
            >
              ⏹️ Stop
            </button>

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', fontSize: 12 }}>
              Status: <span style={{ color: machineStatus === 'busy' ? '#007bff' : machineStatus === 'error' ? '#dc3545' : '#28a745', marginLeft: 4 }}>
                {machineStatus.toUpperCase()}
              </span>
            </div>
          </div>

          {isRunningJob && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>Progress: {jobProgress.current}/{jobProgress.total} pads</div>
              <div style={{ width: '100%', height: 6, backgroundColor: '#e9ecef', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width: `${(jobProgress.current / jobProgress.total) * 100}%`,
                  height: '100%',
                  backgroundColor: '#007bff',
                  transition: 'width 0.3s ease'
                }}></div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex-row" style={{ marginTop: 8 }}>
        <input ref={inputRef} placeholder="G-code line..." style={{ flex: 1 }} />
        <button className="btn" onClick={sendLine} disabled={!connected}>Send</button>
        <label className="btn">
          Send file
          <input type="file" accept=".gcode,.nc,.txt" style={{ display: 'none' }} onChange={sendFile} disabled={!connected} />
        </label>
      </div>

      <div className="console" style={{ marginTop: 8 }}>
        {consoleLines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
