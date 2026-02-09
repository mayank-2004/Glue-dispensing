import React, { useState, useEffect } from 'react';

const MaintenanceManager = ({ manager }) => {
    const [status, setStatus] = useState(null);

    useEffect(() => {
        if (!manager) return;

        // Initial fetch
        setStatus(manager.getMaintenanceStatus());

        // Poll for updates (since manager is a class and doesn't trigger re-renders)
        const interval = setInterval(() => {
            setStatus(manager.getMaintenanceStatus());
        }, 5000);

        return () => clearInterval(interval);
    }, [manager]);

    if (!status) return null;

    return (
        <div className="section maintenance-section" style={{ borderTop: '1px solid #eee', marginTop: 16, paddingTop: 16 }}>
            <h3 style={{ color: '#ff6b35', margin: '0 0 12px 0' }}>Nozzle Care</h3>

            <div className="maintenance-stats" style={{ fontSize: '0.9em', marginBottom: 12 }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                    <span>Dispenses:</span>
                    <strong>{status.dispenseCount} <span className="text-muted">/ {status.settings?.maxDispensesBeforeCleaning || 100}</span></strong>
                </div>
                <div className="flex-row" style={{ justifyContent: 'space-between' }}>
                    <span>Hours Since Clean:</span>
                    <strong>{status.hoursSinceLastCleaning}h <span className="text-muted">/ {status.settings?.maxHoursBeforeCleaning || 4}h</span></strong>
                </div>
            </div>

            {status.needsCleaning && (
                <div className="alert alert-warning" style={{ background: '#fff3cd', color: '#856404', padding: 8, borderRadius: 4, marginBottom: 12, fontSize: '0.9em' }}>
                    ⚠️ Cleaning Recommended!
                </div>
            )}

            <div className="flex-row" style={{ gap: 8 }}>
                <button
                    className="btn sm"
                    onClick={() => {
                        manager.markCleaned();
                        setStatus(manager.getMaintenanceStatus()); // Force update
                    }}
                    disabled={!manager}
                    style={{ flex: 1 }}
                >
                    Mark Cleaned
                </button>
                <button
                    className="btn sm secondary"
                    onClick={() => {
                        // Placeholder for purge
                        alert("Purge feature not yet implemented. Please manually clear nozzle.");
                    }}
                    style={{ flex: 1 }}
                >
                    Purge
                </button>
            </div>

            <div style={{ marginTop: 8, fontSize: '0.8em', color: '#666', textAlign: 'center' }}>
                <small>Last Clean: {new Date(status.lastCleaningTime).toLocaleTimeString()}</small>
            </div>
        </div>
    );
};

export default MaintenanceManager;
