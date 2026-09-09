import { useState, useEffect, useCallback } from 'react';
import { fw } from '../lib/firmware/grblCommands.js';

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
        [name]: { ...current, ...updates, speed: nextSpeed }
      };
    });
  }, []);

  const getActiveSettings = useCallback(() => {
    let settings = profiles[activeProfileName];
    if (!isSafeToMoveFast) {
      settings = { ...settings, speed: Math.min(settings.speed, 20) };
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
      try {
        // GRBL acceleration settings (mm/s²): $120=X, $121=Y, $122=Z
        await window.serial.writeLine(fw.accelX(settings.accel));
        await window.serial.writeLine(fw.accelY(settings.accel));
        await window.serial.writeLine(fw.accelZ(settings.accel));
        // GRBL max rate settings (mm/min): $110=X, $111=Y, $112=Z
        await window.serial.writeLine(fw.maxRateX(speedMmMin));
        await window.serial.writeLine(fw.maxRateY(speedMmMin));
        await window.serial.writeLine(fw.maxRateZ(speedMmMin));
      } catch (err) {
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

