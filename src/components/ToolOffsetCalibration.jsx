import React, { useState } from 'react';

const ToolOffsetCalibration = ({
    toolOffset,
    setToolOffset,
    machinePosition,
    isConnected,
    onAutoDetect
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [step, setStep] = useState(1);
    const [posA, setPosA] = useState(null); // Needle position
    const [posB, setPosB] = useState(null); // Camera position

    const handleSetNeedle = () => {
        if (!machinePosition) return alert("Machine position unknown! Please connect and home.");
        setPosA({ ...machinePosition });
        setStep(2);
    };

    const handleSetCamera = () => {
        if (!machinePosition) return alert("Machine position unknown!");
        setPosB({ ...machinePosition });
        setStep(3);
    };

    const calculateOffset = () => {
        if (!posA || !posB) return { dx: 0, dy: 0 };
        return {
            dx: posA.x - posB.x,
            dy: posA.y - posB.y
        };
    };

    const handleSaveOffset = () => {
        const offset = calculateOffset();
        if (window.confirm(`Save new Camera-to-Nozzle offset?\n\nDX: ${offset.dx.toFixed(3)} mm\nDY: ${offset.dy.toFixed(3)} mm`)) {
            setToolOffset(offset);
            setStep(4);
        }
    };

    const handleReset = () => {
        setPosA(null);
        setPosB(null);
        setStep(1);
    };

    const offset = calculateOffset();

    return (
        <div className="section" style={{ border: '1px solid #444', borderRadius: '4px', marginBottom: '12px' }}>
            <div
                style={{ padding: '8px 12px', background: '#2c2e33', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div>
                    <strong style={{ color: '#f39c12' }}>📐 Camera-to-Nozzle Calibration Wizard</strong>
                    <div style={{ fontSize: '0.8em', color: '#9aa0a6', marginTop: '4px' }}>
                        Current Offset: (dx: {toolOffset?.dx?.toFixed(2) || 0} mm, dy: {toolOffset?.dy?.toFixed(2) || 0} mm)
                    </div>
                </div>
                <div style={{ fontSize: '1.2em' }}>{isExpanded ? '▼' : '▶'}</div>
            </div>

            {isExpanded && (
                <div style={{ padding: '12px', background: '#1d1f24' }}>
                    <p style={{ fontSize: '0.9em', color: '#ccc', marginBottom: '16px' }}>
                        This wizard calculates the physical distance between your dispensing needle and the camera crosshair. Once calibrated, camera coordinates will perfectly target your needle.
                    </p>

                    {/* Step 1 */}
                    <div style={{ opacity: step >= 1 ? 1 : 0.4, marginBottom: '16px', borderLeft: step === 1 ? '3px solid #f39c12' : '3px solid transparent', paddingLeft: '8px' }}>
                        <strong>Step 1: Mark Needle Position</strong>
                        <p style={{ fontSize: '0.85em', margin: '4px 0' }}>Place a dot on scrap paper. Jog the machine until your <strong>needle tip</strong> is perfectly touching the dot.</p>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
                            <button
                                className={`btn sm ${step === 1 ? 'primary' : 'secondary'}`}
                                onClick={handleSetNeedle}
                                disabled={!isConnected || step !== 1}
                            >
                                SET NEEDLE POSITION (A)
                            </button>
                            {posA && <span style={{ fontSize: '0.8em', color: '#00c49a' }}>Recorded: X:{posA.x.toFixed(2)} Y:{posA.y.toFixed(2)}</span>}
                        </div>
                    </div>

                    {/* Step 2 */}
                    <div style={{ opacity: step >= 2 ? 1 : 0.4, marginBottom: '16px', borderLeft: step === 2 ? '3px solid #f39c12' : '3px solid transparent', paddingLeft: '8px' }}>
                        <strong>Step 2: Align Camera Crosshair</strong>
                        <p style={{ fontSize: '0.85em', margin: '4px 0' }}>Now jog the machine so that the Camera's <strong>center crosshair</strong> is perfectly looking at that exact same dot.</p>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
                            <button
                                className={`btn sm ${step === 2 ? 'primary' : 'secondary'}`}
                                onClick={handleSetCamera}
                                disabled={!isConnected || step !== 2}
                            >
                                SET CAMERA POSITION (B)
                            </button>
                            {onAutoDetect && (
                                <button
                                    className="btn sm secondary"
                                    onClick={async () => {
                                        const success = await onAutoDetect();
                                        if (!success) alert("Could not auto-detect dot! Please jog manually.");
                                    }}
                                    disabled={!isConnected || step !== 2}
                                    title="Uses computer vision to find the dot and jog the machine to center it perfectly"
                                    style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                                >
                                    🎯 AUTO-CENTER DOT
                                </button>
                            )}
                        </div>
                        {posB && <span style={{ fontSize: '0.8em', color: '#00c49a', display: 'block', marginTop: '6px' }}>Recorded: X:{posB.x.toFixed(2)} Y:{posB.y.toFixed(2)}</span>}
                    </div>

                    {/* Step 3 */}
                    <div style={{ opacity: step >= 3 ? 1 : 0.4, marginBottom: '16px', borderLeft: step === 3 ? '3px solid #f39c12' : '3px solid transparent', paddingLeft: '8px' }}>
                        <strong>Step 3: Save Calibration</strong>
                        <p style={{ fontSize: '0.85em', margin: '4px 0' }}>
                            {step >= 3 ? `Calculated Offset -> DX: ${offset.dx.toFixed(3)} mm, DY: ${offset.dy.toFixed(3)} mm` : ''}
                        </p>
                        {step === 3 && (
                            <button
                                className="btn sm primary"
                                style={{ background: '#f39c12', color: '#000', marginTop: '8px' }}
                                onClick={handleSaveOffset}
                            >
                                ✅ Save Calibration
                            </button>
                        )}
                        {step === 4 && <span style={{ fontSize: '0.85em', color: '#00c49a', display: 'block', marginTop: '8px' }}>Calibration Saved Successfully!</span>}
                    </div>

                    {(step > 1) && (
                        <div style={{ marginTop: '16px', borderTop: '1px solid #444', paddingTop: '12px' }}>
                            <button className="btn sm danger outline" onClick={handleReset}>RESTART WIZARD</button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ToolOffsetCalibration;
