import React from 'react';
import './OperatorDashboard.css';

function Metric({ label, value, detail, tone = 'neutral' }) {
  return (
    <div className={`operator-metric tone-${tone}`}>
      <div className="operator-metric-label">{label}</div>
      <div className="operator-metric-value">{value}</div>
      <div className="operator-metric-detail">{detail}</div>
    </div>
  );
}

function ModuleCard({ icon, title, description, status, tone = 'neutral', onOpen }) {
  return (
    <button className={`operator-module tone-${tone}`} onClick={onOpen}>
      <span className="operator-module-icon">{icon}</span>
      <span className="operator-module-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
      <span className="operator-module-status">{status}</span>
      <span className="operator-module-arrow">›</span>
    </button>
  );
}

export default function OperatorDashboard({
  isConnected,
  isHomed,
  isJobRunning,
  jobStage,
  jobStatistics,
  operationReport,
  operationFailure,
  glueStatus,
  nozzleHealth,
  machinePosition,
  maintenanceAlert,
  onOpen,
}) {
  const position = machinePosition || { x: 0, y: 0, z: 0 };
  const machineTone = isConnected ? (isHomed ? 'success' : 'warning') : 'danger';
  const machineStatus = isConnected ? (isHomed ? 'READY' : 'HOME REQUIRED') : 'OFFLINE';
  const operationStatus = isJobRunning ? 'RUNNING' : jobStage === 'finished' ? 'COMPLETE' : 'STANDBY';
  const operationTone = isJobRunning ? 'info' : jobStage === 'finished' ? 'success' : 'neutral';

  return (
    <section className="operator-dashboard">
      <div className="operator-dashboard-heading">
        <div>
          <div className="operator-eyebrow">CONTROL ROOM / OVERVIEW</div>
          <h1>Machine Dashboard</h1>
          <p>Live operating status, production context, and direct access to machine functions.</p>
        </div>
        <div className={`operator-machine-state tone-${machineTone}`}>
          <span className="state-light" />
          <span><strong>{machineStatus}</strong><small>{isConnected ? 'Serial link active' : 'Connect controller to continue'}</small></span>
        </div>
      </div>

      <div className="operator-metrics">
        <Metric label="Machine State" value={machineStatus} detail={isHomed ? 'Axes referenced' : 'Safety interlock: motion limited'} tone={machineTone} />
        <Metric label="Active Operation" value={operationStatus} detail={jobStage || 'No active cycle'} tone={operationTone} />
        <Metric label="Production Count" value={operationReport?.totalPads ?? jobStatistics?.totalPads ?? '—'} detail={operationReport ? 'Pads completed in last cycle' : jobStatistics ? 'Pads in current recipe' : 'Load a paste layer to calculate'} tone="info" />
        <Metric label="Cycle Time" value={operationReport?.jobDurationSec ? `${operationReport.jobDurationSec}s` : jobStatistics?.estimatedTime ? `${jobStatistics.estimatedTime}s` : '—'} detail={operationFailure ? 'Last cycle ended with a fault' : operationReport ? 'Last completed cycle' : 'Waiting for job data'} tone={operationFailure ? 'danger' : 'neutral'} />
      </div>

      <div className="operator-main-grid">
        <div className="operator-section operator-position-panel">
          <div className="operator-section-heading"><span>LIVE POSITION</span><span className="section-live"><i /> LIVE</span></div>
          <div className="operator-position-readout">
            {['X', 'Y', 'Z'].map(axis => (
              <div key={axis} className="operator-axis-readout">
                <span>{axis}</span>
                <strong>{Number(position[axis.toLowerCase()] ?? 0).toFixed(3)}</strong>
                <small>mm</small>
              </div>
            ))}
          </div>
          <div className="operator-position-footer">Coordinate feedback from machine controller</div>
        </div>

        <div className="operator-section operator-alert-panel">
          <div className="operator-section-heading"><span>OPERATOR ATTENTION</span><span className={`attention-count ${maintenanceAlert ? 'has-alert' : ''}`}>{maintenanceAlert ? '1 ACTIVE' : 'CLEAR'}</span></div>
          {maintenanceAlert ? (
            <div className="operator-alert-row tone-warning"><span className="alert-symbol">!</span><span><strong>Nozzle maintenance required</strong><small>Review maintenance status before starting a cycle.</small></span></div>
          ) : (
            <div className="operator-clear-state"><span>✓</span><strong>No active alarms</strong><small>System has no recorded operator actions.</small></div>
          )}
        </div>
      </div>

      <div className="operator-resource-grid">
        <div className={`operator-resource-card tone-${glueStatus?.willRunOut ? 'danger' : 'success'}`}>
          <div className="operator-section-heading"><span>GLUE SUPPLY</span><span className="section-live">BACKGROUND TRACKING</span></div>
          <div className="resource-value">{glueStatus ? `${glueStatus.remaining.toFixed(0)} µL` : '—'}</div>
          <div className="resource-detail">{glueStatus ? `${glueStatus.used.toFixed(0)} µL used of ${glueStatus.stock.toFixed(0)} µL` : 'Open operation monitor to initialize tracking'}</div>
          <div className="resource-bar"><span style={{ width: `${glueStatus?.stock ? Math.max(0, Math.min(100, (glueStatus.remaining / glueStatus.stock) * 100)) : 0}%` }} /></div>
          <small className={glueStatus?.willRunOut ? 'resource-alert' : ''}>{glueStatus?.willRunOut ? `Warning: supply may run out after pad ${glueStatus.runOutAfterPad + 1}` : glueStatus ? `Nozzle Ø ${glueStatus.nozzleDia.toFixed(2)} mm` : 'No stock report yet'}</small>
          <div className="resource-parameter-grid">
            <span>Used <b>{glueStatus ? `${glueStatus.used.toFixed(1)} µL` : '—'}</b></span>
            <span>Remaining <b>{glueStatus ? `${glueStatus.remaining.toFixed(1)} µL` : '—'}</b></span>
            <span>Remaining % <b>{glueStatus ? `${glueStatus.stockRemainingPct.toFixed(1)}%` : '—'}</b></span>
            <span>Job pads <b>{glueStatus?.jobPads ?? '—'}</b></span>
            <span>Job volume <b>{glueStatus ? `${glueStatus.jobVolume.toFixed(2)} µL` : '—'}</b></span>
            <span>After job <b>{glueStatus ? `${glueStatus.stockAfterJob.toFixed(1)} µL` : '—'}</b></span>
            <span>After job % <b>{glueStatus ? `${glueStatus.stockAfterJobPct.toFixed(1)}%` : '—'}</b></span>
            <span>Total stock <b>{glueStatus ? `${glueStatus.stock.toFixed(1)} µL` : '—'}</b></span>
          </div>
        </div>
        <div className={`operator-resource-card tone-${nozzleHealth?.level === 'critical' ? 'danger' : nozzleHealth?.level === 'warn' ? 'warning' : 'success'}`}>
          <div className="operator-section-heading"><span>NOZZLE HEALTH</span><span className="section-live">BACKGROUND MONITOR</span></div>
          <div className="resource-health-row"><div className="resource-score">{nozzleHealth?.score ?? '—'}</div><div><div className="resource-value-small">{nozzleHealth?.level ? nozzleHealth.level.toUpperCase() : 'WAITING'}</div><div className="resource-detail">{nozzleHealth?.recommendation || 'Health score appears after dispensing data is available.'}</div></div></div>
          <small>{nozzleHealth ? `Wear ${nozzleHealth.wearScore}/50 · Quality ${nozzleHealth.qualityScore}/50` : 'Nozzle monitor is active in the background'}</small>
          <div className="resource-parameter-grid">
            <span>Dispenses <b>{nozzleHealth?.dispenseCount ?? '—'}</b></span>
            <span>Remaining pads <b>{nozzleHealth?.dispensesRemaining ?? '—'}</b></span>
            <span>Hours since clean <b>{nozzleHealth ? `${nozzleHealth.hoursSinceLastCleaning}h` : '—'}</b></span>
            <span>Hours remaining <b>{nozzleHealth ? `${nozzleHealth.hoursRemaining}h` : '—'}</b></span>
            <span>Max pads <b>{nozzleHealth?.settings?.maxDispensesBeforeCleaning ?? '—'}</b></span>
            <span>Max hours <b>{nozzleHealth?.settings?.maxHoursBeforeCleaning ?? '—'}</b></span>
            <span>SPC jobs <b>{nozzleHealth?.spcJobsTracked ?? '—'}</b></span>
            <span>Last cleaned <b>{nozzleHealth?.lastCleaningTime ? new Date(nozzleHealth.lastCleaningTime).toLocaleDateString() : '—'}</b></span>
          </div>
        </div>
      </div>

      <div className="operator-section operator-modules-panel">
        <div className="operator-section-heading"><span>OPERATOR VIEWS</span><span className="operator-section-hint">SELECT A CONTROL SURFACE</span></div>
        <div className="operator-module-grid operator-module-grid-new">
          <ModuleCard icon="▣" title="Success / Failure" description="Cycle outcome and job diagnostics" status={jobStage === 'finished' ? 'SUCCESS' : 'STANDBY'} tone={jobStage === 'finished' ? 'success' : 'neutral'} onOpen={() => onOpen('OperationResult')} />
          <ModuleCard icon="⌁" title="Analytics" description="Cycle timing and production metrics" status={jobStatistics ? 'READY' : 'WAITING'} tone={jobStatistics ? 'info' : 'neutral'} onOpen={() => onOpen('Analytics')} />
        </div>
      </div>
    </section>
  );
}
