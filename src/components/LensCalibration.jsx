import React, { useState } from 'react';

const LensCalibration = ({
    pixelsPerMm,
    setPixelsPerMm
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [dpiInput, setDpiInput] = useState(96); // Default Windows/Web standard

    // Common standard presets from user's image
    const presets = [
        { dpi: 72, label: "72 DPI (Older Mac/Web)" },
        { dpi: 96, label: "96 DPI (Modern Standard)" },
        { dpi: 150, label: "150 DPI (Medium Quality)" },
        { dpi: 300, label: "300 DPI (High Quality)" },
        { dpi: 600, label: "600 DPI (HD Scanning)" }
    ];

    const applyDPI = (dpi) => {
        // Formula: Pixels in 1 mm = Resolution (DPI) / 25.4
        // (Since 1 inch = 25.4 millimeters)
        const calculatedPxPerMm = dpi / 25.4;
        setPixelsPerMm(calculatedPxPerMm);
    };

    const handlePresetChange = (e) => {
        const val = Number(e.target.value);
        setDpiInput(val);
        applyDPI(val);
    };

    const handleManualSubmit = (e) => {
        e.preventDefault();
        applyDPI(dpiInput);
    };

    return (
        <div style={{ border: '1px solid #444', borderRadius: '4px', marginBottom: '12px' }}>
            <div
                style={{ padding: '8px 12px', background: '#2c2e33', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div>
                    <strong style={{ color: '#00c49a' }}>🔍 Camera Lens Scaling (DPI)</strong>
                    <div style={{ fontSize: '0.8em', color: '#9aa0a6', marginTop: '4px' }}>
                        Current Scale: {pixelsPerMm?.toFixed(2) || (96 / 25.4).toFixed(2)} px/mm
                    </div>
                </div>
                <div style={{ fontSize: '1.2em' }}>{isExpanded ? '▼' : '▶'}</div>
            </div>

            {isExpanded && (
                <div style={{ padding: '12px', background: '#1d1f24' }}>
                    <p style={{ fontSize: '0.85em', color: '#ccc', marginBottom: '16px' }}>
                        Select or enter your camera's resolution density (DPI/PPI) to mathematically calculate the exact number of pixels in 1 millimeter using the standard formula <code>(DPI / 25.4)</code>.
                    </p>

                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '4px' }}>Preset Resolutions</label>
                        <select 
                            value={dpiInput} 
                            onChange={handlePresetChange}
                            style={{ width: '100%', padding: '6px', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '4px' }}
                        >
                            {presets.map(p => (
                                <option key={p.dpi} value={p.dpi}>{p.label} (≈{(p.dpi / 25.4).toFixed(2)} px/mm)</option>
                            ))}
                            <option value="custom">-- Custom DPI --</option>
                        </select>
                    </div>

                    <form onSubmit={handleManualSubmit} style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                        <div style={{ flex: 1 }}>
                            <label style={{ display: 'block', fontSize: '0.85em', fontWeight: 'bold', marginBottom: '4px' }}>Custom DPI</label>
                            <input 
                                type="number" 
                                value={dpiInput} 
                                onChange={(e) => setDpiInput(Number(e.target.value))}
                                style={{ width: '100%', padding: '6px', background: '#111', color: '#fff', border: '1px solid #444', borderRadius: '4px' }}
                            />
                        </div>
                        <button type="submit" className="btn sm primary">Apply DPI</button>
                    </form>

                    <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(0, 196, 154, 0.1)', borderLeft: '3px solid #00c49a', borderRadius: '2px' }}>
                        <strong>Active Calculation:</strong>
                        <p style={{ margin: '4px 0 0 0', fontSize: '0.9em', fontFamily: 'monospace' }}>
                            {dpiInput} / 25.4 = <span style={{ color: '#00c49a', fontWeight: 'bold' }}>{(dpiInput / 25.4).toFixed(3)} px/mm</span>
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default LensCalibration;
