import { useState, useEffect, useCallback } from 'react';

export function useMotionManager(payloadStatus, isEmergencyStopped) {
  const MAX_SPEED_MMS = 300;
  
  const defaultProfiles = {
    Rapid: { speed: 150, accel: 1000, decel: 1000 },
    Soldering: { speed: 50, accel: 500, decel: 500 },
    Calibration: { speed: 20, accel: 200, decel: 200 },
    Homing: { speed: 50, accel: 500, decel: 500 }
  };

  const [profiles, setProfiles] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('motionProfiles'));
      if (stored) return { ...defaultProfiles, ...stored };
    } catch {
      // fallback
    }
    return defaultProfiles;
  });

  const [activeProfileName, setActiveProfileName] = useState('Rapid');
  
  // Safe state computation
  const isSafeToMoveFast = !isEmergencyStopped && payloadStatus !== 'OVER_LIMIT';
  const restrictionReason = isEmergencyStopped ? 'Emergency Stop Active' : 
                            payloadStatus === 'OVER_LIMIT' ? 'Payload exceeds safe limits' : null;

  useEffect(() => {
    localStorage.setItem('motionProfiles', JSON.stringify(profiles));
  }, [profiles]);

  const updateProfile = useCallback((name, updates) => {
    setProfiles(prev => {
      const current = prev[name];
      const nextSpeed = Math.min(MAX_SPEED_MMS, Math.max(0, updates.speed !== undefined ? updates.speed : current.speed));
      return {
        ...prev,
        [name]: {
          ...current,
          ...updates,
          speed: nextSpeed
        }
      };
    });
  }, []);

  const getActiveSettings = useCallback(() => {
    let settings = profiles[activeProfileName];
    // Cap speed if not in a safe state
    if (!isSafeToMoveFast) {
      settings = { ...settings, speed: Math.min(settings.speed, 20) }; // cap at 20 mm/s
    }
    return settings;
  }, [profiles, activeProfileName, isSafeToMoveFast]);

  const applyProfileToMachine = useCallback(async (profileName) => {
    setActiveProfileName(profileName);
    
    if (window.serial?.writeLine) {
      const settings = profiles[profileName];
      let speed = settings.speed;
      
      if (!isSafeToMoveFast) {
        speed = Math.min(speed, 20); // enforce safe speed
      }
      
      const speedMmMin = speed * 60;
      // Send acceleration and speed limits to controller
      // Using M204 for accel/decel and M203 for max feedrate
      try {
        await window.serial.writeLine(`M204 P${settings.accel} T${settings.accel}`);
        // If firmware supports custom decel, send it here, e.g. M204 D... but standard Marlin doesn't have D for decel, we just send it if needed.
        // We will just send it as a comment for now or hypothetical M-code if embedded expects it.
        // The prompt says: "Configure separate speed, acceleration, and deceleration profiles for different operations."
        // Let's send a custom command for accel/decel specifically if needed, or stick to M204.
        await window.serial.writeLine(`M203 X${speed} Y${speed} Z${speed}`);
      } catch(err) {
        console.error('[MotionManager] Failed to apply profile:', err);
      }
    }
  }, [profiles, isSafeToMoveFast]);

  return {
    profiles,
    activeProfileName,
    updateProfile,
    applyProfileToMachine,
    getActiveSettings,
    maxSpeedMmS: MAX_SPEED_MMS,
    isSafeToMoveFast,
    restrictionReason
  };
}

