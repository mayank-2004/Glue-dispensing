import { useState, useEffect, useCallback } from 'react';

export function usePayloadManager() {
  const MAX_PAYLOAD_KG = 2.0;
  
  const [configuredPayload, setConfiguredPayload] = useState(() => {
    try {
      return parseFloat(localStorage.getItem('configuredPayload')) || 0.0;
    } catch {
      return 0.0;
    }
  });

  const [warningThreshold, setWarningThreshold] = useState(() => {
    try {
      return parseFloat(localStorage.getItem('payloadWarningThreshold')) || 1.6;
    } catch {
      return 1.6;
    }
  });

  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [lastConfirmedPayload, setLastConfirmedPayload] = useState(null);
  const [payloadStatus, setPayloadStatus] = useState('NORMAL'); // NORMAL, NEAR_LIMIT, OVER_LIMIT

  useEffect(() => {
    localStorage.setItem('configuredPayload', configuredPayload.toString());
  }, [configuredPayload]);

  useEffect(() => {
    localStorage.setItem('payloadWarningThreshold', warningThreshold.toString());
  }, [warningThreshold]);

  // Update status whenever payload or threshold changes
  useEffect(() => {
    if (configuredPayload > MAX_PAYLOAD_KG) {
      setPayloadStatus('OVER_LIMIT');
    } else if (configuredPayload >= warningThreshold) {
      setPayloadStatus('NEAR_LIMIT');
    } else {
      setPayloadStatus('NORMAL');
    }
  }, [configuredPayload, warningThreshold]);

  // Listen for payload sync events from useSerialMachine
  useEffect(() => {
    const handlePayloadSync = (event) => {
      const { kg, status } = event.detail;
      setLastConfirmedPayload(kg);
      setLastSyncTime(new Date().toISOString());
      
      // If embedded reports a different status, we log it, but UI is driven by local settings 
      // since the embedded might not have the threshold config.
      console.log(`[PayloadManager] Sync from embedded: ${kg} kg (Status: ${status})`);
    };

    window.addEventListener('payload-sync', handlePayloadSync);
    return () => window.removeEventListener('payload-sync', handlePayloadSync);
  }, []);

  const syncWithController = useCallback(async () => {
    if (window.serial?.writeLine) {
      try {
        await window.serial.writeLine('M765');
      } catch (err) {
        console.error('[PayloadManager] Failed to query payload:', err);
      }
    } else {
      console.warn('[PayloadManager] Cannot sync: Serial not connected');
    }
  }, []);

  const setPayload = useCallback(async (newPayloadKg) => {
    if (newPayloadKg > MAX_PAYLOAD_KG) {
      return { success: false, error: `Payload exceeds maximum capacity of ${MAX_PAYLOAD_KG} kg` };
    }

    if (window.serial?.writeLine) {
      try {
        await window.serial.writeLine(`M766 P${newPayloadKg.toFixed(2)}`);
      } catch (err) {
        console.error('[PayloadManager] Failed to set payload on controller:', err);
        return { success: false, error: 'Failed to send command to controller' };
      }
    } else {
      console.warn('[PayloadManager] Serial not connected, saving locally only.');
    }

    setConfiguredPayload(newPayloadKg);
    return { success: true };
  }, []);

  return {
    configuredPayload,
    maxPayload: MAX_PAYLOAD_KG,
    warningThreshold,
    setWarningThreshold,
    payloadStatus,
    lastSyncTime,
    lastConfirmedPayload,
    setPayload,
    syncWithController
  };
}

