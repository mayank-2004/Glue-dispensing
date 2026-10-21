import React from 'react';
import './OperatorAnalytics.css';

export default function OperatorAnalytics({ jobStatistics, operationReport, jobHistory = [], onOpen }) {
  const stats = jobStatistics || {};
  const totalPads = Number(stats.totalPads || 0);
  const distance = Number(stats.totalDistance || 0);
  const average = Number(stats.averageDistance || 0);
  const estimated = Number(stats.estimatedTime || 0);
  const hasData = Boolean(jobStatistics);

  // Take up to the last 7 runs from our database
  const recentRuns = jobHistory.slice(-7);
  const maxDuration = Math.max(10, ...recentRuns.map(r => parseFloat(r.jobDurationSec) || 0));
  const bars = Array.from({ length: 7 }).map((_, i) => {
    const runIndex = recentRuns.length - 7 + i;
    if (runIndex < 0) return null;
    const run = recentRuns[runIndex];
    return {
      label: `R${jobHistory.length - recentRuns.length + runIndex + 1}`,
      duration: parseFloat(run.jobDurationSec) || 0,
      height: Math.max(5, ((parseFloat(run.jobDurationSec) || 0) / maxDuration) * 100)
    };
  });

  return (
    <section className="operator-analytics">
      <div className="operator-page-heading">
        <div>
          <div className="operator-eyebrow">REPORTING / PERFORMANCE</div>
          <h1>Production Analytics</h1>
          <p>Current recipe metrics and machine utilization indicators.</p>
        </div>
        <span className="badge info">READ-ONLY VIEW</span>
      </div>
      <div className="analytics-stat-grid">
        <div>
          <span>COMPONENTS</span>
          <strong>{operationReport?.totalPads ?? (hasData ? totalPads : '—')}</strong>
          <small>{operationReport ? 'Last completed cycle' : hasData ? 'Current job sequence' : 'No job loaded'}</small>
        </div>
        <div>
          <span>PATH LENGTH</span>
          <strong>{operationReport ? `${operationReport.totalPads} pads` : hasData ? `${distance.toFixed(1)} mm` : '—'}</strong>
          <small>{operationReport ? 'Completed operation' : 'Planned travel distance'}</small>
        </div>
        <div>
          <span>GLUE USED</span>
          <strong>{operationReport?.totalVolUl ? `${operationReport.totalVolUl} µL` : '—'}</strong>
          <small>{operationReport ? 'Measured job report' : 'Available after completion'}</small>
        </div>
        <div>
          <span>CYCLE TIME</span>
          <strong>{operationReport?.jobDurationSec ? `${operationReport.jobDurationSec}s` : hasData ? `${estimated}s` : '—'}</strong>
          <small>{operationReport ? 'Actual duration' : 'Calculated estimate'}</small>
        </div>
      </div>
      <div className="analytics-grid">
        {/* <div className="operator-section analytics-chart">
          <div className="operator-section-heading">
            <span>CYCLE TREND</span>
            <span className="section-live">LAST 7 RUN WINDOWS</span>
          </div>
          <div className="analytics-bars">
            {bars.map((bar, index) => (
              <div className="analytics-bar-column" key={index} title={bar ? `${bar.duration}s` : 'No run'}>
                <div className="analytics-bar" style={{ height: bar ? `${bar.height}%` : '5%', opacity: bar ? 1 : 0.2 }}></div>
                <div className="bar-label">{bar ? bar.label : '-'}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="operator-section analytics-breakdown">
          <div className="operator-section-heading">
            <span>JOB BREAKDOWN</span>
            <span className="section-live">LIVE MODEL</span>
          </div>
          <div className="analytics-row">
            <span>Safe path moves</span>
            <strong>{stats.safePathsUsed ?? '—'}</strong>
          </div>
          <div className="analytics-row">
            <span>High-clearance moves</span>
            <strong>{stats.highClearancePaths ?? '—'}</strong>
          </div>
          <div className="analytics-row">
            <span>Success rate</span>
            <strong className="analytics-good">{hasData ? 'READY' : '—'}</strong>
          </div>
          <div className="analytics-row">
            <span>Downtime tracking</span>
            <strong>AVAILABLE</strong>
          </div>
        </div>
      </div>
      <div className="analytics-footer">
        <span>{hasData ? 'Metrics reflect the currently loaded dispensing sequence.' : 'Load a Gerber paste layer and calculate a dispensing sequence to populate analytics.'}</span>
        <div className="analytics-actions">
          <button className="btn sm secondary" onClick={() => onOpen('Dashboard')}>Return to Dashboard</button>
          <button className="btn sm primary" onClick={() => onOpen('AutomatedDispensingPanel')}>Open Operation Monitor</button>
        </div>
      </div>
    </section>
  );
}
