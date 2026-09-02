import React from 'react';
import { FAULT_LEVEL } from '../hooks/useSafetySystem.js';

export default function SafetyBanner({ safetySystem }) {
  const { activeFaults, isMotionPermitted, clearFault, isEmergency, isCritical } = safetySystem;

  if (activeFaults.length === 0) return null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '12px 16px', background: isEmergency ? '#4a0000' : isCritical ? '#5a2a00' : '#4b3e00',
      color: '#fff', borderBottom: `2px solid ${isEmergency ? '#ff0000' : isCritical ? '#ff7f00' : '#ffc107'}`,
      zIndex: 9000, flexShrink: 0
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: '1.1em', letterSpacing: '1px' }}>
          {isEmergency ? '🚨 EMERGENCY STOP ACTIVE' : isCritical ? '⚠️ CRITICAL FAULT' : '⚠️ WARNING'}
        </strong>
        <div style={{ display: 'flex', gap: 12, fontSize: '0.9em', opacity: 0.9 }}>
          <span>Motion: {isMotionPermitted ? 'Permitted' : 'DISABLED'}</span>
          <span>Heating: {safetySystem.isHeatingPermitted ? 'Permitted' : 'DISABLED'}</span>
        </div>
      </div>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
        {activeFaults.map(fault => (
          <div key={fault.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '6px 10px', borderRadius: 4 }}>
            <span style={{ fontSize: '0.95em' }}>
              <strong>[{fault.code}]</strong> {fault.message}
            </span>
            <button 
              onClick={() => clearFault(fault.code)}
              style={{
                padding: '4px 12px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.3)',
                color: '#fff', borderRadius: 4, cursor: 'pointer', fontSize: '0.85em'
              }}
            >
              Clear Fault
            </button>
          </div>
        ))}
      </div>
      
      {(isCritical || isEmergency) && (
        <small style={{ marginTop: 4, color: 'rgba(255,255,255,0.7)' }}>
          System operations have been halted. Resolve the faults and clear them to resume normal operation.
        </small>
      )}
    </div>
  );
}
