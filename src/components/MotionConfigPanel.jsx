import React, { useState } from 'react';
import './MotionConfigPanel.css';

export default function MotionConfigPanel({ motionManager }) {
  const {
    profiles,
    activeProfileName,
    updateProfile,
    applyProfileToMachine,
    maxSpeedMmS,
    isSafeToMoveFast,
    restrictionReason
  } = motionManager;

  const profileNames = Object.keys(profiles);
  const [selectedTab, setSelectedTab] = useState(profileNames[0]);

  const activeProf = profiles[selectedTab];

  const handleChange = (field, value) => {
    let num = parseFloat(value);
    if (isNaN(num)) num = 0;
    updateProfile(selectedTab, { [field]: num });
  };

  return (
    <div className="panel motion-config-panel">
      <h3>Motion Settings & Calibration</h3>

      {!isSafeToMoveFast && (
        <div className="safety-alert">
          <strong>⚠ High-Speed Motion Restricted</strong>
          <p>{restrictionReason}</p>
          <small>Speeds are automatically capped to 20 mm/s until the condition is resolved.</small>
        </div>
      )}

      <div className="box">
        <legend>Motion Profiles</legend>
        
        <div className="tabs">
          {profileNames.map(name => (
            <button 
              key={name} 
              className={`tab-btn ${selectedTab === name ? 'active' : ''}`}
              onClick={() => setSelectedTab(name)}
            >
              {name}
            </button>
          ))}
        </div>

        <div className="tab-content">
          <h4>{selectedTab} Profile</h4>
          <div className="config-grid">
            <div className="config-row">
              <label>
                <span>Speed (mm/s)</span>
                <input 
                  type="number" 
                  min="0" 
                  max={maxSpeedMmS} 
                  value={activeProf.speed}
                  onChange={(e) => handleChange('speed', e.target.value)}
                />
              </label>
              <small>Max: {maxSpeedMmS} mm/s</small>
            </div>
            <div className="config-row">
              <label>
                <span>Acceleration (mm/s²)</span>
                <input 
                  type="number" 
                  min="10" 
                  max="10000" 
                  value={activeProf.accel}
                  onChange={(e) => handleChange('accel', e.target.value)}
                />
              </label>
            </div>
            <div className="config-row">
              <label>
                <span>Deceleration (mm/s²)</span>
                <input 
                  type="number" 
                  min="10" 
                  max="10000" 
                  value={activeProf.decel}
                  onChange={(e) => handleChange('decel', e.target.value)}
                />
              </label>
            </div>
          </div>
          
          <button 
            className="btn primary" 
            style={{ marginTop: '16px' }}
            onClick={() => applyProfileToMachine(selectedTab)}
          >
            Activate {selectedTab} Profile
          </button>
        </div>
      </div>

      <div className="box">
        <legend>Live Motion State</legend>
        <div className="live-motion-state">
          <div>
            <span className="label">Active Profile:</span>
            <span className="value active-pill">{activeProfileName}</span>
          </div>
          <div>
            <span className="label">Commanded Speed:</span>
            <span className="value">
              {!isSafeToMoveFast 
                ? Math.min(profiles[activeProfileName].speed, 20).toFixed(1) 
                : profiles[activeProfileName].speed.toFixed(1)} mm/s
            </span>
          </div>
          <div>
            <span className="label">Max Allowed:</span>
            <span className="value">{maxSpeedMmS} mm/s</span>
          </div>
        </div>
      </div>
    </div>
  );
}

