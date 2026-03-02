import React, { useState } from "react";
import "./JogPanel.css";
import { jogRel } from "../lib/motion/gcode.js";

export default function JogPanel({
    onSendGcode, // Function to send G-code lines (async)
    machinePosition, // Current machine position e.g. {x, y, z}
    isConnected = false
}) {
    const [stepSize, setStepSize] = useState(10); // mm
    const [feedRate, setFeedRate] = useState(2000); // mm/min
    const [safeZ, setSafeZ] = useState(-5); // mm (Machine coordinate usually negative)
    const [isBusy, setIsBusy] = useState(false);
    const [pendingHomeZero, setPendingHomeZero] = useState(false);

    // Watch for machine position to hit the hardware home offsets (-3, -10, 0)
    React.useEffect(() => {
        if (pendingHomeZero && machinePosition) {
            const atHardwareHome = Math.abs(machinePosition.x - (-3)) < 0.1 &&
                Math.abs(machinePosition.y - (-10)) < 0.1 &&
                Math.abs(machinePosition.z - 0) < 0.1;

            if (atHardwareHome) {
                setPendingHomeZero(false);
                // Machine has finished G28 and reached the hardware offset. Move to true (0,0,0)
                setTimeout(async () => {
                    try {
                        if (onSendGcode) {
                            await onSendGcode(["G90", "G0 X0 Y0 Z0"]);
                        } else if (window.serial && window.serial.writeLine) {
                            await window.serial.writeLine('G90');
                            await window.serial.writeLine('G0 X0 Y0 Z0');
                        }
                    } catch (e) {
                        console.error("Home offset move failed:", e);
                    } finally {
                        setIsBusy(false);
                    }
                }, 100); // Tiny 100ms delay to let the controller state settle
            }
        }
    }, [machinePosition, pendingHomeZero, onSendGcode]);

    // Send a jog command
    const jog = async (axis, dir) => {
        if (!isConnected) return alert("Please connect to machine first!");
        if (isBusy) return;
        setIsBusy(true);
        try {
            let da = {};
            if (axis === "X") da = { dx: dir * stepSize };
            else if (axis === "Y") da = { dy: dir * stepSize };
            else if (axis === "Z") da = { dz: dir * stepSize };

            const cmds = jogRel({ ...da, feed: feedRate });

            if (onSendGcode) {
                await onSendGcode(cmds);
            } else if (window.serial && window.serial.writeLine) {
                for (const line of cmds) await window.serial.writeLine(line);
            }
        } catch (e) {
            console.error("Jog failed:", e);
        } finally {
            setIsBusy(false);
        }
    };

    const moveToSafeZ = async () => {
        if (isBusy) return;
        if (!confirm(`Move Z to absolute position ${safeZ}mm? Ensure path is clear.`)) return;

        setIsBusy(true);
        try {
            const cmd = `G53 G0 Z${safeZ}`;
            console.log("Safe Z:", cmd);
            if (onSendGcode) {
                await onSendGcode([cmd]);
            } else if (window.serial && window.serial.writeLine) {
                await window.serial.writeLine(cmd);
            }
        } catch (e) {
            console.error("Safe Z failed:", e);
        } finally {
            setIsBusy(false);
        }
    };

    const handleHomeClick = async () => {
        if (!isConnected) return alert("Please connect to machine first!");
        if (isBusy) return;
        if (!confirm("Home all axes (G28)? Ensure area is clear.")) return;

        const isAtHome = machinePosition &&
            Math.abs(machinePosition.x) < 0.01 &&
            Math.abs(machinePosition.y) < 0.01 &&
            Math.abs(machinePosition.z) < 0.01;

        if (!isAtHome) {
            setIsBusy(true);
            setPendingHomeZero(true);
            try {
                if (onSendGcode) {
                    await onSendGcode(["G28"]);
                } else if (window.serial && window.serial.writeLine) {
                    await window.serial.writeLine("G28");
                }
            } catch (e) {
                console.error("Home failed:", e);
                setIsBusy(false);
                setPendingHomeZero(false);
            }
        } else {
            console.log("Machine already at home position (0,0,0). Skipping G28.");
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
                            <option value={0.1}>0.1 mm</option>
                            <option value={1}>1.0 mm</option>
                            <option value={5}>5.0 mm</option>
                            <option value={10}>10.0 mm</option>
                            <option value={50}>50.0 mm</option>
                        </select>
                    </label>

                    <label>
                        Feed Rate (mm/min)
                        <input type="number" value={feedRate} onChange={(e) => setFeedRate(Number(e.target.value))} step={100} />
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
