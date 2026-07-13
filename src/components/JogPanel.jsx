import React, { useState, useRef } from "react";
import "./JogPanel.css";
import { jogRel } from "../lib/motion/gcode.js";
import { useToast } from '../Toast.jsx';

export default function JogPanel({
    machinePosition,
    isConnected = false
}) {
    const toast = useToast();
    const jogRestoreRef = useRef(null); // debounce handle for G90 restore
    const [stepSize, setStepSize] = useState(10); // mm
    const [xyFeedRate, setXyFeedRate] = useState(3000); // mm/min — 50 mm/s, fast manual jog
    const [zFeedRate, setZFeedRate] = useState(600);   // mm/min — 10 mm/s, Z max feedrate
    const [safeZ, setSafeZ] = useState(-5); // mm (Machine coordinate usually negative)
    const [isBusy, setIsBusy] = useState(false);

    // Send a jog command
    const jog = async (axis, dir) => {
        if (!isConnected) { toast.warning("Please connect to machine first!"); return; }
        if (isBusy) return;
        setIsBusy(true);

        // Cancel any pending G90 restore — the user is still jogging
        if (jogRestoreRef.current) {
            clearTimeout(jogRestoreRef.current);
            jogRestoreRef.current = null;
        }

        try {
            let da = {};
            const feed = axis === "Z" ? zFeedRate : xyFeedRate;
            if (axis === "X") da = { dx: dir * stepSize };
            else if (axis === "Y") da = { dy: dir * stepSize };
            else if (axis === "Z") da = { dz: dir * stepSize };

            const cmds = jogRel({ ...da, feed });

            if (window.serial?.writeLine) {
                for (const line of cmds) await window.serial.writeLine(line);
            }
        } catch (e) {
            console.error("Jog failed:", e);
        } finally {
            setIsBusy(false);
            // Restore absolute mode 600 ms after the last jog click so Marlin is
            // back in G90 before any job or homing command runs.
            jogRestoreRef.current = setTimeout(async () => {
                try { if (window.serial?.writeLine) await window.serial.writeLine('G90'); } catch {}
                jogRestoreRef.current = null;
            }, 600);
        }
    };

    const moveToSafeZ = async () => {
        if (isBusy) return;
        if (!confirm(`Move Z to absolute position ${safeZ}mm? Ensure path is clear.`)) return;

        setIsBusy(true);
        try {
            const cmd = `G53 G0 Z${safeZ}`;
            console.log("Safe Z:", cmd);
            if (window.serial?.writeLine) {
                await window.serial.writeLine(cmd);
            }
        } catch (e) {
            console.error("Safe Z failed:", e);
        } finally {
            setIsBusy(false);
        }
    };

    const handleHomeClick = async () => {
        if (!isConnected) { toast.warning("Please connect to machine first!"); return; }
        if (isBusy) return;
        if (!confirm("Home all axes (G28)? Ensure area is clear.")) return;

        setIsBusy(true);
        try {
            if (window.serial?.writeLine) {
                await window.serial.writeLine("G28");
            }
        } catch (e) {
            console.error("Home failed:", e);
        } finally {
            setIsBusy(false);
        }
    };

    return (
        <div className="panel jog-panel">
            <h3 style={{ marginLeft: 10 }}>Manual Jog Control</h3>

            <div className="jog-controls-container">
                {/* XY Jog Grid */}
                <div className="jog-grid">
                    <div className="jog-cell"></div>
                    <div className="jog-cell">
                        <button className="btn jog-btn y-plus" onClick={() => jog("Y", -1)} disabled={isBusy}>Y+</button>
                    </div>
                    <div className="jog-cell"></div>

                    <div className="jog-cell">
                        <button className="btn jog-btn x-minus" onClick={() => jog("X", -1)} disabled={isBusy}>X-</button>
                    </div>
                    <div className="jog-cell">
                        <button className="btn jog-btn home-btn" onClick={handleHomeClick} disabled={isBusy} title="Home All Axes (G28)">
                            🏠
                        </button>
                    </div>
                    <div className="jog-cell">
                        <button className="btn jog-btn x-plus" onClick={() => jog("X", 1)} disabled={isBusy}>X+</button>
                    </div>

                    <div className="jog-cell"></div>
                    <div className="jog-cell">
                        <button className="btn jog-btn y-minus" onClick={() => jog("Y", 1)} disabled={isBusy}>Y-</button>
                    </div>
                    <div className="jog-cell"></div>
                </div>

                {/* Z Axis Control */}
                <div className="z-jog-column" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
                    <button className="btn jog-btn z-plus" style={{ height: 60, width: 50 }} onClick={() => jog("Z", 1)} disabled={isBusy}>Z+</button>
                    <div style={{ color: '#666', fontSize: '0.8em' }}>Z-Axis</div>
                    <button className="btn jog-btn z-minus" style={{ height: 60, width: 50 }} onClick={() => jog("Z", -1)} disabled={isBusy}>Z-</button>
                </div>

                {/* Settings Column */}
                <div className="jog-settings">
                    <label>
                        Step Size (mm)
                        <select value={stepSize} onChange={(e) => setStepSize(Number(e.target.value))}>
                            <option value={0.01}>0.01 mm</option>
                            <option value={0.1}>0.1 mm</option>
                            <option value={1}>1.0 mm</option>
                            <option value={5}>5.0 mm</option>
                            <option value={10}>10.0 mm</option>
                            <option value={50}>50.0 mm</option>
                        </select>
                    </label>

                    <label>
                        XY Feed Rate (mm/min)
                        <input type="number" value={xyFeedRate} onChange={(e) => setXyFeedRate(Number(e.target.value))} step={50} min={10} />
                    </label>

                    <label>
                        Z Feed Rate (mm/min)
                        <input type="number" value={zFeedRate} onChange={(e) => setZFeedRate(Number(e.target.value))} step={20} min={10} />
                    </label>

                    <div className="safe-z-section">
                        <label>Safe Z Height (Abs)</label>
                        <div className="flex-row">
                            <input type="number" value={safeZ} onChange={(e) => setSafeZ(Number(e.target.value))} style={{ width: 60 }} />
                            <button className="btn secondary sm" onClick={moveToSafeZ} disabled={isBusy}>Go Safe Z</button>
                        </div>
                        <small>Uses G53 (Machine Coords)</small>
                    </div>
                </div>
            </div>

            <div className="status-display">
                <strong>Current Pos:</strong>
                {machinePosition ?
                    ` X:${machinePosition.x.toFixed(2)} Y:${machinePosition.y.toFixed(2)} Z:${machinePosition.z.toFixed(2)}`
                    : " Unknown (Connect First)"}
            </div>

            <div className="keyboard-hint">
                <small>Tip: Ensure serial connection is active in Serial Panel.</small>
            </div>
        </div>
    );
}
