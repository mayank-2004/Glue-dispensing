import { useState } from "react";
import "./SpeedPanel.css";

export default function SpeedPanel({
  speedProfileManager,
  speedSettings,
  setSpeedSettings,
  selectedPad,
  pressureSettings,
  pads
}) {
  const [showProfiles, setShowProfiles] = useState(false);

  const calculateSpeedProfile = () => {
    if (!selectedPad || !speedProfileManager) return null;

    return speedProfileManager.calculateOptimalSpeeds(
      selectedPad,
      pressureSettings?.viscosity || 'medium'
    );
  };

  const getProfileStats = () => {
    if (!pads.length || !speedProfileManager) return {};
    return speedProfileManager.getProfileStats(pads);
  };

  const speedProfile = calculateSpeedProfile();
  const profileStats = getProfileStats();

  return (
    <div className="card speed-panel">
      <h3>Speed Profiles</h3>

      <div className="control-row">
        <label>
          <input
            type="checkbox"
            checked={speedSettings.autoAdjust}
            onChange={(e) => setSpeedSettings({
              ...speedSettings,
              autoAdjust: e.target.checked
            })}
          />
          Auto-adjust speeds by pad size
        </label>

        <button
          className="btn secondary"
          onClick={() => setShowProfiles(!showProfiles)}
        >
          {showProfiles ? "Hide" : "Show"} Profiles
        </button>
      </div>

      {selectedPad && speedProfile && (
        <div className="info-box">
          <strong>Profile: {speedProfile.profile.name}</strong>
          <div className="profile-details">
            <div>Area: {speedProfile.area.toFixed(2)}mm² | Category: {speedProfile.profile.key}</div>
            <div>Travel: {speedProfile.speeds.travel} mm/min | Dispense: {speedProfile.speeds.dispense} mm/min</div>
            <div>Approach: {speedProfile.speeds.approach} mm/min | Retract: {speedProfile.speeds.retract} mm/min</div>
            {speedProfile.viscosityAdjusted && (
              <div className="viscosity-note">
                * Adjusted for {pressureSettings.viscosity} viscosity
              </div>
            )}
          </div>
        </div>
      )}

      <div className="speed-controls">
        <label>
          Global Speed Multiplier
          <div className="multiplier-row">
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={speedSettings.globalMultiplier}
              onChange={(e) => setSpeedSettings({
                ...speedSettings,
                globalMultiplier: +e.target.value
              })}
              style={{ flex: 1 }}
            />
            <span className="multiplier-display">
              {speedSettings.globalMultiplier.toFixed(1)}x
            </span>
          </div>
        </label>
      </div>

      {Object.keys(profileStats).length > 0 && (
        <div className="profile-stats">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Pad Distribution:</div>
          {Object.entries(profileStats).map(([key, stat]) => (
            <div key={key} style={{ marginBottom: 2 }}>
              {stat.profile.name}: {stat.count} pads
            </div>
          ))}
        </div>
      )}

      {showProfiles && (
        <div className="profiles-list">
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Speed Profiles:</div>
          {Object.entries(speedProfileManager?.getAllProfiles() || {}).map(([key, profile]) => (
            <div key={key} className="profile-item">
              <div style={{ fontWeight: 600 }}>{profile.name}</div>
              <div className="profile-item-desc">
                {profile.description}
              </div>
              <div className="profile-item-specs">
                Travel: {profile.travelSpeed} | Approach: {profile.approachSpeed} |
                Dispense: {profile.dispenseSpeed} | Retract: {profile.retractSpeed} mm/min
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}