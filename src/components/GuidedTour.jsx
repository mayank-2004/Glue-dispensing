import React, { useState, useEffect, useRef } from 'react';
import './GuidedTour.css';

export default function GuidedTour({
  isConnected,
  isHomed,
  hasFileLoaded,
  hasFiducialsSet,
  isJobRunning,
  jobStage
}) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [animationClass, setAnimationClass] = useState('');
  const timerRef = useRef(null);

  // Determine current step based on logic
  useEffect(() => {
    let step = 1;
    if (!isConnected) {
      step = 1;
    } else if (isConnected && !isHomed) {
      step = 2;
    } else if (isConnected && isHomed && !hasFileLoaded) {
      step = 3;
    } else if (isConnected && isHomed && hasFileLoaded && !hasFiducialsSet) {
      step = 4;
    } else if (isConnected && isHomed && hasFileLoaded && hasFiducialsSet && !isJobRunning && jobStage !== 'finished') {
      step = 5;
    } else if (isJobRunning) {
      step = 6;
    } else if (jobStage === 'finished') {
      step = 7;
    }

    if (step !== currentStep) {
      // trigger bounce
      setAnimationClass('');
      setTimeout(() => {
        setCurrentStep(step);
        setAnimationClass('step-pop');
      }, 50);
    }
  }, [isConnected, isHomed, hasFileLoaded, hasFiducialsSet, isJobRunning, jobStage, currentStep]);

  const stepsData = {
    1: { icon: "🔴", title: "Step 1", desc: "User connects the machine via the Serial Panel.", border: 'var(--status-err)' },
    2: { icon: "🎯", title: "Step 2", desc: "Home the machine to establish coordinates.", border: 'var(--status-warn)' },
    3: { icon: "📂", title: "Step 3", desc: "Upload Gerber/CSV file.", border: 'var(--status-busy)' },
    4: { icon: "📸", title: "Step 4", desc: "Start to move head to the fiducials of PCB. After detecting all fiducials, it enables all checkboxes and applies transform automatically.", border: 'var(--accent-secondary)' },
    5: { icon: "🟢", title: "Step 5", desc: "Check all pre-flights there and start the job.", border: 'var(--status-ok)' },
    6: { icon: <span className="spin-fast">🤖</span>, title: "Job Running", desc: "Dispensing in progress. Please standby...", border: 'var(--status-busy)' },
    7: { icon: "✅", title: "Job Finished!", desc: "The automated dispensing cycle is complete.", border: 'var(--status-ok)' },
  };

  const current = stepsData[currentStep] || stepsData[1];

  return (
    <div className={`guided-tour-overlay ${isVisible ? 'visible' : ''} ${animationClass}`} style={{ borderColor: current.border }}>
      <div className="tour-icon-box" style={{ background: `${current.border}22` }}>
        {current.icon}
      </div>
      <div className="tour-text-box">
        <div className="tour-title">{current.title}</div>
        <div className="tour-desc">{current.desc}</div>
      </div>
    </div>
  );
}
