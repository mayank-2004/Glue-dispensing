import { useState, useEffect, useCallback, useRef } from "react";

export function useCameraSystem() {
  const [pythonServerOk, setPythonServerOk] = useState(false);
  const [visionData, setVisionData] = useState(null);
  const [cameraErrors, setCameraErrors] = useState(null);
  const PYTHON_URL = "http://localhost:8000";
  
  const pollRef = useRef(null);
  const lastFrameCountRef = useRef(0);
  const lastFrameTimeRef = useRef(Date.now());
  
  const checkCameraStatus = useCallback(async () => {
    try {
      const r = await fetch(`${PYTHON_URL}/api/vision_data`, { signal: AbortSignal.timeout(1500) });
      const d = await r.json();
      setPythonServerOk(true);
      setVisionData(d);
    } catch {
      setPythonServerOk(false);
    }
  }, []);

  useEffect(() => {
    const pollStatus = async () => {
      try {
        const r = await fetch(`${PYTHON_URL}/api/status`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) throw new Error();
        const d = await r.json();
        setPythonServerOk(true);
        
        let localErrors = { ...d.errors };
        const now = Date.now();
        if (d.frames === lastFrameCountRef.current) {
          if (now - lastFrameTimeRef.current > 2000) localErrors.unavailable_frames = true;
        } else {
          lastFrameCountRef.current = d.frames;
          lastFrameTimeRef.current = now;
          localErrors.unavailable_frames = false;
        }
        
        if (!d.ok) localErrors.camera_disconnected = true;
        else localErrors.camera_disconnected = false;
        
        setCameraErrors(localErrors);
      } catch {
        setPythonServerOk(false);
        setCameraErrors({ communication_error: true });
      }
    };
    pollStatus();
    pollRef.current = setInterval(pollStatus, 2000);
    return () => clearInterval(pollRef.current);
  }, []);
  
  const hasCriticalError = cameraErrors && (
    cameraErrors.camera_disconnected || 
    cameraErrors.communication_error || 
    cameraErrors.unavailable_frames || 
    cameraErrors.low_resolution || 
    cameraErrors.poor_lighting || 
    cameraErrors.focus_problem
  );

  const updateConfig = async (newConfig) => {
    try {
      await fetch(`${PYTHON_URL}/api/vision/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig)
      });
    } catch (e) { console.error("Failed to update vision config", e); }
  };

  return { pythonServerOk, cameraErrors, hasCriticalError, visionData, updateConfig };
}
