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
    console.log('[MotionManager] Switched active profile to: ' + profileName);
  }, []);

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

