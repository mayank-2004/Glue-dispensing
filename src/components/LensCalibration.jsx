import React, { useState } from 'react';

const LensCalibration = ({
    pixelsPerMm,
    setPixelsPerMm,
    machinePosition,
    visionResult
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [step, setStep] = useState(1);
    const [dataA, setDataA] = useState(null); // { mPos, pPos }
    const [dataB, setDataB] = useState(null); // { mPos, pPos }

    const getCenterBlob = () => {
        if (!visionResult || !visionResult.detected || !visionResult.fiducials || visionResult.fiducials.length === 0) {
            return null;
        }
        // Assume the blob closest to center, or just the first one if there's only one
        let closestFid = null;
        let minDist = Infinity;
        // The vision panel runs at 640x360 default mostly, but we just use the raw circle coordinates
        visionResult.fiducials.forEach(fid => {
            const dist = Math.hypot(fid.pixelPosition.x - 320, fid.pixelPosition.y - 180);
            if (dist < minDist) {
                minDist = dist;
                closestFid = fid;
            }
        });
        return closestFid;
    };

    const handleLockA = () => {
        if (!machinePosition) return alert("Machine position unknown! Please connect and home.");
        const blob = getCenterBlob();
        if (!blob) return alert("No circular target detected by OpenCV. Please jog until a circle is visible.");

        setDataA({
            mPos: { ...machinePosition },
            pPos: { ...blob.pixelPosition }
        });
        setStep(2);
    };

    const handleLockB = () => {
        if (!machinePosition) return alert("Machine position unknown!");
        const blob = getCenterBlob();
        if (!blob) return alert("No circular target detected! Jog back until the original circle is visible.");

        setDataB({
            mPos: { ...machinePosition },
            pPos: { ...blob.pixelPosition }
        });
        setStep(3);
    };

    const calculateRatio = () => {
        if (!dataA || !dataB) return 20;

        const physicalDx = dataB.mPos.x - dataA.mPos.x;
        const physicalDy = dataB.mPos.y - dataA.mPos.y;
        const distanceMm = Math.hypot(physicalDx, physicalDy);

        const pixelDx = dataB.pPos.x - dataA.pPos.x;
        const pixelDy = dataB.pPos.y - dataA.pPos.y;
        const distancePx = Math.hypot(pixelDx, pixelDy);

        if (distanceMm < 0.2) {
            // Distance too small, bad calibration
            return -1;
        }

        return distancePx / distanceMm;
    };

    const handleSave = () => {
        const ratio = calculateRatio();
        if (ratio === -1) {
            alert("Error: You didn't jog the machine far enough. Please jog at least 0.5 millimeters before locking point B.");
            return;
        }
        if (window.confirm(`Save new optical ratio?\n\nCalculated: ${ratio.toFixed(2)} pixels per mm`)) {
            setPixelsPerMm(ratio);
            setStep(4);
        }
    };

    const handleReset = () => {
        setDataA(null);
        setDataB(null);
        setStep(1);
    };

    const previewRatio = calculateRatio();

    return (
        <div style={{ border: '1px solid #444', borderRadius: '4px', marginBottom: '12px' }}>
            <div
                style={{ padding: '8px 12px', background: '#2c2e33', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div>
                    <strong style={{ color: '#00c49a' }}>🔍 Camera Lens Calibration</strong>
                    <div style={{ fontSize: '0.8em', color: '#9aa0a6', marginTop: '4px' }}>
                        Current Ratio: {pixelsPerMm?.toFixed(2) || 20.00} px/mm
                    </div>
                </div>
                <div style={{ fontSize: '1.2em' }}>{isExpanded ? '▼' : '▶'}</div>
            </div>

            {isExpanded && (
                <div style={{ padding: '12px', background: '#1d1f24' }}>
                    <p style={{ fontSize: '0.9em', color: '#ccc', marginBottom: '16px' }}>
                        Calculate the exact pixels-to-millimeters optical scaling of your specific camera lens to prevent placement scaling errors.
                    </p>

                    {/* Step 1 */}
                    <div style={{ opacity: step >= 1 ? 1 : 0.4, marginBottom: '16px', borderLeft: step === 1 ? '3px solid #00c49a' : '3px solid transparent', paddingLeft: '8px' }}>
                        <strong>Step 1: Lock Target</strong>
                        <p style={{ fontSize: '0.85em', margin: '4px 0' }}>Place a dot or pad under the camera. Wait until a green circle appears on it.</p>
                        <button
                            className={`btn sm ${step === 1 ? 'primary' : 'secondary'}`}
                            onClick={handleLockA}
                            disabled={step !== 1}
                        >
                            Lock Initial Point (A)
                        </button>
                        {dataA && <span style={{ marginLeft: 10, fontSize: '0.8em', color: '#00c49a' }}>Locked.</span>}
                    </div>

                    {/* Step 2 */}
                    <div style={{ opacity: step >= 2 ? 1 : 0.4, marginBottom: '16px', borderLeft: step === 2 ? '3px solid #00c49a' : '3px solid transparent', paddingLeft: '8px' }}>
                        <strong>Step 2: Jog Machine</strong>
                        <p style={{ fontSize: '0.85em', margin: '4px 0' }}>Jog the machine approx 1mm to 2mm (ensure the dot stays inside the camera view).</p>
                        <button
                            className={`btn sm ${step === 2 ? 'primary' : 'secondary'}`}
                            onClick={handleLockB}
                            disabled={step !== 2}
                        >
                            Lock New Point (B)
                        </button>
                        {dataB && <span style={{ marginLeft: 10, fontSize: '0.8em', color: '#00c49a' }}>Locked.</span>}
                    </div>

                    {/* Step 3 */}
                    <div style={{ opacity: step >= 3 ? 1 : 0.4, marginBottom: '16px', borderLeft: step === 3 ? '3px solid #00c49a' : '3px solid transparent', paddingLeft: '8px' }}>
                        <strong>Step 3: Save Scaling</strong>
                        <p style={{ fontSize: '0.85em', margin: '4px 0' }}>
                            {step >= 3 ? `Result: ${previewRatio > 0 ? previewRatio.toFixed(3) : 'ERR'} px/mm` : 'Awaiting data...'}
                        </p>
                        {step === 3 && (
                            <button
                                className="btn sm primary"
                                style={{ background: '#00c49a', color: '#000' }}
                                onClick={handleSave}
                            >
                                ✅ Save Optical Ratio
                            </button>
                        )}
                        {step === 4 && <span style={{ fontSize: '0.85em', color: '#00c49a' }}>Lens Ratio Saved!</span>}
                    </div>

                    {(step > 1) && (
                        <div style={{ marginTop: '16px', borderTop: '1px solid #444', paddingTop: '12px' }}>
                            <button className="btn sm danger" onClick={handleReset}>Restart Wizard</button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default LensCalibration;
