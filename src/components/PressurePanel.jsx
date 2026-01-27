import { useState } from "react";
import { VISCOSITY_TYPES } from "../lib/pressure/pressureControl.js";
import "./PressurePanel.css";

export default function PressurePanel({
  pressureController,
  pressureSettings,
  setPressureSettings,
  selectedPad
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleViscosityChange = (viscosity) => {
    const preset = pressureController.getPreset(viscosity);
    setPressureSettings({
      ...pressureSettings,
      viscosity,
      customPressure: preset.pressure,
      customDwellTime: preset.dwellTime
    });
  };

  const calculateOptimalSettings = () => {
    if (!selectedPad) return null;
    
    const pressure = pressureController.calculatePressure(selectedPad, pressureSettings.viscosity);
    const dwellTime = pressureController.calculateDwellTime(selectedPad, pressureSettings.viscosity);
    
    return { pressure, dwellTime };
  };

  const optimal = calculateOptimalSettings();

  return (
    <div className="card">
      <h3>Pressure Control</h3>
      
      <div className="flex-row" style={{ gap: 12, alignItems: "center" }}>
        <label>
          Paste Viscosity
          <select 
            value={pressureSettings.viscosity} 
            onChange={(e) => handleViscosityChange(e.target.value)}
          >
            {Object.entries(VISCOSITY_TYPES).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>

        <button 
          className="btn secondary" 
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "Hide" : "Show"} Advanced
        </button>
      </div>

      {selectedPad && optimal && (
        <div className="info" style={{ marginTop: 8 }}>
          <strong>Optimal for selected pad ({selectedPad.width?.toFixed(2) || 1}×{selectedPad.height?.toFixed(2) || 1}mm):</strong>
          <div>Pressure: {optimal.pressure} PSI | Dwell: {optimal.dwellTime}ms</div>
        </div>
      )}

      {showAdvanced && (
        <div className="advanced-controls" style={{ marginTop: 12 }}>
          <div className="grid2">
            <label>
              Custom Pressure (PSI)
              <input 
                type="number" 
                min="5" 
                max="100" 
                value={pressureSettings.customPressure}
                onChange={(e) => setPressureSettings({
                  ...pressureSettings,
                  customPressure: +e.target.value
                })}
              />
            </label>
            
            <label>
              Custom Dwell Time (ms)
              <input 
                type="number" 
                min="50" 
                max="500" 
                value={pressureSettings.customDwellTime}
                onChange={(e) => setPressureSettings({
                  ...pressureSettings,
                  customDwellTime: +e.target.value
                })}
              />
            </label>
          </div>

          <div className="preset-info" style={{ fontSize: "0.9em", marginTop: 8, color: "#666" }}>
            <div><strong>Preset Values:</strong></div>
            {Object.entries(pressureController.presets).map(([key, preset]) => (
              <div key={key}>
                {preset.name}: {preset.pressure} PSI, {preset.dwellTime}ms
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
