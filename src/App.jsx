import { useEffect, useState, useCallback, useMemo } from "react";
import JSZip from "jszip";
import "./App.css";

import LayerList from "./components/LayerList.jsx";
import Viewer from "./components/Viewer.jsx";
import CameraPanel from "./components/CameraPanel.jsx";
import SerialPanel from "./components/SerialPanel.jsx";
import ComponentList from "./components/ComponentList.jsx";
// import LinearMovePanel from "./components/LinearMovePanel.jsx";
// import OpenCVFiducialPanel from "./components/OpenCVFiducialPanel.jsx";
import FiducialPanel from "./components/FiducialPanel.jsx";
import PressurePanel from "./components/PressurePanel.jsx";
import SpeedPanel from "./components/SpeedPanel.jsx";
import AutomatedDispensingPanel from "./components/AutomatedDispensingPanel.jsx";
import LivePreview from "./components/LivePreview.jsx";
// import { loadOpenCV } from './lib/vision/opencvLoader.js';
import { identifyLayers } from "./lib/gerber/identifyLayers.js";
import { stackupToSvg } from "./lib/gerber/stackupToSvg.js";
import { extractPadsMm } from "./lib/gerber/extractPads.js";
import { analyzeFiducialsInLayers } from "./lib/gerber/fiducialDetection.js";
import { detectPcbOrigins } from "./lib/gerber/originDetection.js";
import { FiducialVisionDetector } from "./lib/vision/fiducialVision.js";
import { zipTextFiles, downloadBlob } from "./lib/zip/zipUtils.js";
import { fitSimilarity, fitAffine, applyTransform, rmsError } from "./lib/utils/transform2d.js";
import { CollisionDetector } from "./lib/collision/collisionDetection.js";
import { PadDetector } from "./lib/vision/padDetection.js";
import { QualityController } from "./lib/quality/qualityControl.js";
import { NozzleMaintenanceManager } from "./lib/maintenance/nozzleMaintenance.js";
import { generatePath } from "./lib/motion/pathGeneration.js";
import { PressureController, VISCOSITY_TYPES } from "./lib/pressure/pressureControl.js";
import { SpeedProfileManager } from "./lib/speed/speedProfiles.js";
import { PasteVisualizer } from "./lib/paste/pasteVisualization.js";
import { extractBoardOutline } from "./lib/gerber/boardOutline.js";
import { DispensingSequencer } from "./lib/automation/dispensingSequence.js";
import { SafePathPlanner } from "./lib/automation/safePathPlanner.js";
import { BatchProcessor } from "./lib/batch/batchProcessor.js";
import { BatchExecutor } from "./lib/batch/batchExecutor.js";
import { LayerDataExtractor } from "./lib/gerber/layerDataExtractor.js";
import { debugCoordinateConversion } from "./lib/debug/coordinateDebug.js";
import BatchPanel from "./components/BatchPanel.jsx";

function calculatePadCenter(p) {
  // For Gerber-extracted pads, x,y coordinates ARE the center (flash coordinates)
  if (typeof p.x === "number" && typeof p.y === "number") {
    return {
      x: p.x,
      y: p.y,
      valid: true,
      method: 'gerber_flash_center',
      width: p.width || 1,
      height: p.height || 1
    };
  }

  // Fallback for invalid data
  return { x: 0, y: 0, valid: false, method: 'fallback' };
}

// Legacy wrapper for compatibility
function padCenter(p) {
  const result = calculatePadCenter(p);
  return { x: result.x, y: result.y };
}

function processPads(points) {
  return points.map((pad, idx) => {
    const centerInfo = calculatePadCenter(pad);
    return {
      x: centerInfo.x,
      y: centerInfo.y,
      id: `P${idx + 1}`,
      width: centerInfo.width || pad.width || 1,
      height: centerInfo.height || pad.height || 1,
      centerValid: centerInfo.valid,
      centerMethod: centerInfo.method,
      originalPad: pad
    };
  });
}

function parseLengthToMm(lenStr = "") {
  const m = String(lenStr).match(/^([\d.]+)\s*(mm|in)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]); const unit = (m[2] || "mm").toLowerCase();
  return unit === "in" ? v * 25.4 : v;
}

export default function App() {
  const [layers, setLayers] = useState([]);
  const [side, setSide] = useState("top");
  const [mirrorBottom, setMirrorBottom] = useState(true);
  const [svg, setSvg] = useState("");

  const [pads, setPads] = useState([]);
  const [pasteIdx, setPasteIdx] = useState(null);

  const [selectedMm, setSelectedMm] = useState(null);
  const [padDistances, setPadDistances] = useState([]);
  const [generatedPath, setGeneratedPath] = useState(null);
  const [pathType, setPathType] = useState('direct');

  // const [opencvReady, setOpencvReady] = useState(false);
  // const [cameraStream, setCameraStream] = useState(null);

  const [fidPickMode, setFidPickMode] = useState(false);
  const [fidActiveId, setFidActiveId] = useState(null);
  const [fiducials, setFiducials] = useState([
    { id: "F1", design: null, machine: null, color: "#2ea8ff" },
    { id: "F2", design: null, machine: null, color: "#8e2bff" },
    { id: "F3", design: null, machine: null, color: "#00c49a" },
  ]);
  const [fiducialDetectionResult, setFiducialDetectionResult] = useState(null);
  const [originCandidates, setOriginCandidates] = useState([]);
  const [selectedOrigin, setSelectedOrigin] = useState(null);
  const [referencePoint, setReferencePoint] = useState(null); 
  const [referenceType, setReferenceType] = useState('origin'); 
  const [xf, setXf] = useState(null);
  const [applyXf, setApplyXf] = useState(false);

  // New feature states
  const [collisionDetector] = useState(() => new CollisionDetector());
  const [padDetector] = useState(() => new PadDetector());
  const [qualityController] = useState(() => new QualityController());

  const [maintenanceManager] = useState(() => new NozzleMaintenanceManager());
  const [fiducialVisionDetector] = useState(() => new FiducialVisionDetector());
  const [pressureController] = useState(() => new PressureController());
  const [speedProfileManager] = useState(() => new SpeedProfileManager());
  const [pasteVisualizer] = useState(() => new PasteVisualizer());
  const [dispensingSequencer] = useState(() => new DispensingSequencer());
  const [safePathPlanner] = useState(() => new SafePathPlanner());
  const [batchProcessor] = useState(() => new BatchProcessor());
  const [batchExecutor] = useState(() => new BatchExecutor(null, dispensingSequencer, pressureController, speedProfileManager));
  const [currentBatchId, setCurrentBatchId] = useState(null);
  const [currentBatch, setCurrentBatch] = useState(null);
  const [layerData, setLayerData] = useState({});
  const [showPasteDots, setShowPasteDots] = useState(false);
  const [boardOutline, setBoardOutline] = useState(null);
  const [dispensingSequence, setDispensingSequence] = useState([]);
  const [safeSequence, setSafeSequence] = useState([]);
  const [jobStatistics, setJobStatistics] = useState(null);
  const [useSafePathPlanning, setUseSafePathPlanning] = useState(true);
  const [componentHeights, setComponentHeights] = useState([]);
  const [livePreview, setLivePreview] = useState({
    isActive: false,
    currentPadIndex: -1,
    machinePosition: null,
    completedPads: []
  });

  // useEffect(() => {
  //   // Initialize OpenCV on app load
  //   loadOpenCV()
  //     .then(() => {
  //       setOpencvReady(true);
  //       console.log('✅ OpenCV loaded and ready');
  //     })
  //     .catch(err => {
  //       console.error('❌ OpenCV load failed:', err);
  //     });
  // }, []);

  // // Add OpenCV detection callback
  // const handleOpenCVDetection = (detectedFiducials) => {
  //   console.log('OpenCV detected fiducials:', detectedFiducials);

  //   // Convert to your fiducial format
  //   const colors = ["#2ea8ff", "#8e2bff", "#00c49a"];
  //   const autoFiducials = detectedFiducials.slice(0, 3).map((fid, idx) => ({
  //     id: `F${idx + 1}`,
  //     design: {
  //       x: fid.x, // Convert from pixels to mm if needed
  //       y: fid.y
  //     },
  //     machine: null,
  //     color: colors[idx],
  //     confidence: fid.confidence,
  //     autoDetected: true,
  //     detectionMethod: 'opencv'
  //   }));

  //   setFiducials(autoFiducials);
  //   alert(`✅ OpenCV detected ${detectedFiducials.length} fiducials!`);
  // };

  // Update current batch when selection changes
  useEffect(() => {
    if (currentBatchId && batchProcessor) {
      setCurrentBatch(batchProcessor.getBatch(currentBatchId));
    } else {
      setCurrentBatch(null);
    }
  }, [currentBatchId, batchProcessor]);

  // Batch processing handlers
  const handleBatchSelect = (batchId) => {
    setCurrentBatchId(batchId);
  };

  const handleStartBatch = async (batchId) => {
    const batch = batchProcessor.getBatch(batchId);
    if (!batch) return;

    if (batch.status === 'paused') {
      // Resume paused batch
      return handleResumeBatch(batchId);
    }

    // Start new batch
    const success = await batchProcessor.startBatch(batchId);
    if (success) {
      console.log('Batch started:', batchId);
      try {
        await batchExecutor.executeBatch(batch, batchProcessor);
        console.log('Batch execution completed');
      } catch (error) {
        console.error('Batch execution failed:', error);
        alert('Batch execution failed: ' + error.message);
      }
    }
  };

  const handlePauseBatch = (batchId) => {
    batchProcessor.pauseBatch(batchId);
  };

  const handleResumeBatch = async (batchId) => {
    const success = batchProcessor.resumeBatch(batchId);
    if (success) {
      try {
        const batch = batchProcessor.getBatch(batchId);
        await batchExecutor.executeBatch(batch, batchProcessor);
        console.log('Batch execution resumed and completed');
      } catch (error) {
        console.error('Batch resume failed:', error);
        alert('Batch resume failed: ' + error.message);
      }
    }
  };

  const handleAddCurrentBoard = (batchId) => {
    if (!pads.length) {
      alert('No pads loaded. Please load a PCB file first.');
      return;
    }

    const board = {
      name: `Board ${Date.now()}`,
      pads: pads,
      fiducials: fiducials,
      settings: {
        pressure: pressureSettings,
        speed: speedSettings
      },
      position: { x: 0, y: 0, rotation: 0 }
    };

    batchProcessor.addBoard(batchId, board);
    alert('Board added to batch!');
  };

  const handleDeleteBatch = (batchId) => {
    if (currentBatchId === batchId) {
      setCurrentBatchId(null);
    }
  };

  // Live preview control functions
  const startLivePreview = () => {
    setLivePreview({
      isActive: true,
      currentPadIndex: 0,
      machinePosition: { x: 0, y: 0, z: 6 },
      completedPads: []
    });
  };

  const updateLivePreview = (padIndex, machinePos = null) => {
    setLivePreview(prev => ({
      ...prev,
      currentPadIndex: padIndex,
      machinePosition: machinePos || prev.machinePosition,
      completedPads: dispensingSequence.slice(0, padIndex)
    }));
  };

  const stopLivePreview = () => {
    setLivePreview({
      isActive: false,
      currentPadIndex: -1,
      machinePosition: null,
      completedPads: []
    });
  };
  // const [visionEnabled, setVisionEnabled] = useState(false);
  // const [qualityEnabled, setQualityEnabled] = useState(false);
  const [maintenanceAlert, setMaintenanceAlert] = useState(null);
  const [toolOffset, setToolOffset] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("toolOffset") || '{"dx": 0, "dy": 0');
    } catch (error) {
      return { dx: 0, dy: 0 };
    }
  });

  const [pcbOriginOffset, setPcbOriginOffset] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("pcbOriginOffset") || '{"x": 0, "y": 0');
    } catch (error) {
      return { x: 0, y: 0 };
    }
  });

  useEffect(() => {
    localStorage.setItem("toolOffset", JSON.stringify(toolOffset));
  }, [toolOffset]);

  useEffect(() => {
    localStorage.setItem("pcbOriginOffset", JSON.stringify(pcbOriginOffset));
  }, [pcbOriginOffset]);
  useEffect(() => {
    maintenanceManager.setReminderCallback((alert) => {
      setMaintenanceAlert(alert);
    });
  }, [maintenanceManager]);



  const [nozzleDia, setNozzleDia] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("nozzleDia") || "0.6");
    } catch (error) {
      return 0.6;
    }
  });

  const [pressureSettings, setPressureSettings] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("pressureSettings") || '{"viscosity": "medium", "customPressure": 25, "customDwellTime": 120}');
    } catch (error) {
      return { viscosity: "medium", customPressure: 25, customDwellTime: 120 };
    }
  });

  const [speedSettings, setSpeedSettings] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("speedSettings") || '{"autoAdjust": true, "globalMultiplier": 1.0}');
    } catch (error) {
      return { autoAdjust: true, globalMultiplier: 1.0 };
    }
  });

  useEffect(() => {
    localStorage.setItem("nozzleDia", JSON.stringify(nozzleDia));
  }, [nozzleDia]);

  useEffect(() => {
    localStorage.setItem("pressureSettings", JSON.stringify(pressureSettings));
  }, [pressureSettings]);

  useEffect(() => {
    localStorage.setItem("speedSettings", JSON.stringify(speedSettings));
  }, [speedSettings]);

  const transformSummary = useMemo(() => {
    if (!xf) return null;
    const out = { type: xf.type, tx: xf.tx, ty: xf.ty };
    if (xf.type === "similarity") {
      out.thetaDeg = xf.theta * 180 / Math.PI;
      out.scale = xf.scale;
    }
    const pairs = fiducials.filter(f => f.design && f.machine);
    if (pairs.length >= 2) {
      out.rms = rmsError(xf, pairs.map(f => f.design), pairs.map(f => f.machine));
    }
    return out;
  }, [xf, fiducials]);

  // Verify coordinate transformation
  const verifyTransform = useCallback((designPt) => {
    if (!xf || !applyXf) return designPt;
    const transformed = applyTransform(xf, designPt);
    console.log(`Transform verification: Design(${designPt.x.toFixed(3)}, ${designPt.y.toFixed(3)}) → Machine(${transformed.x.toFixed(3)}, ${transformed.y.toFixed(3)})`);
    return transformed;
  }, [xf, applyXf]);

  const pickFiles = async (e) => handleFiles(e.target.files);
  const onDrop = async (e) => { e.preventDefault(); await handleFiles(e.dataTransfer.files); };

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    const zips = files.filter(f => /\.zip$/i.test(f.name));
    let expanded = files.filter(f => !/\.zip$/i.test(f.name));

    for (const zipFile of zips) {
      const zip = await JSZip.loadAsync(zipFile);
      const entries = Object.values(zip.files).filter(f => !f.dir);
      for (const ent of entries) {
        const text = await ent.async("text");
        expanded.push(new File([text], ent.name, { type: "text/plain" }));
      }
    }

    const read = await Promise.all(expanded.map(async f => ({ name: f.name, text: await f.text() })));
    const ls = identifyLayers(read);
    setLayers(ls);

    // Extract useful data from each layer
    const extractedData = LayerDataExtractor.extractLayerData(ls);
    setLayerData(extractedData);
    console.log('Extracted layer data:', extractedData);

    const pi = ls.findIndex(x => x.type === "solderpaste");
    setPasteIdx(pi >= 0 ? pi : null);
    if (pi >= 0) {
      const padData = extractPadsMm(ls[pi].text).map(padCenter);
      setPads(processPads(padData));
    } else setPads([]);

    // Detect fiducials automatically
    const detectedFiducials = analyzeFiducialsInLayers(ls);
    setFiducialDetectionResult(detectedFiducials);

    // Detect board outline if available
    const outlineLayer = ls.find(l => l.filename.toLowerCase().includes('outline') || l.filename.toLowerCase().includes('edge'));
    if (outlineLayer) {
      const outline = extractBoardOutline(outlineLayer.text);
      setBoardOutline(outline);
      console.log('Board outline detected:', outline);
    }

    // Detect origin candidates
    const origins = detectPcbOrigins(ls);
    console.log('Detected origins:', origins);
    setOriginCandidates(origins);
    if (origins.length > 0) {
      const origin = { ...origins[0], id: 'O1' };
      console.log('Setting selected origin:', origin);
      setSelectedOrigin(origin); // Auto-select bottom-left origin
      setPcbOriginOffset({ x: origin.x, y: origin.y });
    }

    if (detectedFiducials.length > 0) {
      // Auto-populate fiducials with detected positions
      const colors = ["#2ea8ff", "#8e2bff", "#00c49a", "#ff6b35", "#9c27b0", "#4caf50"];
      const autoFiducials = detectedFiducials.map((fid, idx) => ({
        id: fid.id,
        design: { x: fid.x, y: fid.y },
        machine: null,
        color: colors[idx % colors.length],
        confidence: fid.confidence
      }));

      // Fill remaining slots with empty fiducials
      while (autoFiducials.length < 3) {
        autoFiducials.push({
          id: `F${autoFiducials.length + 1}`,
          design: null,
          machine: null,
          color: colors[autoFiducials.length % colors.length]
        });
      }

      setFiducials(autoFiducials);
    } else {
      // No fiducials detected, use default empty ones
      setFiducials([
        { id: "F1", design: null, machine: null, color: "#2ea8ff" },
        { id: "F2", design: null, machine: null, color: "#8e2bff" },
        { id: "F3", design: null, machine: null, color: "#00c49a" },
      ]);
      setFiducialDetectionResult([]);
    }

    await rebuild(ls, side);

    setSelectedMm(null);
    setXf(null); setApplyXf(false);
    setFidPickMode(false); setFidActiveId(null);
    // Don't clear origin candidates and selectedOrigin here - they were just set above

    queueMicrotask(() => { updateOverlay(); });

    queueMicrotask(() => { updateOverlay(); });
  }

  async function rebuild(nextLayers = layers, s = side) {
    const ssvg = await stackupToSvg(nextLayers, s);
    setSvg(ssvg);
  }

  const toggleLayer = async (idx) => {
    const next = layers.map((l, i) => (i === idx ? { ...l, enabled: !l.enabled } : l));
    setLayers(next); await rebuild(next, side);
  };
  const changeSide = async (s) => {
    setSide(s);
    await rebuild(layers, s);
  };

  async function exportAllSvgsZip() {
    const outputs = [];
    for (const l of layers) {
      const only = [{ filename: l.filename, text: l.text, enabled: true }];
      const ssvg = await stackupToSvg(only, l.side || "top");
      const base = l.filename.replace(/\.[^.]+$/, "");
      outputs.push({ name: `${base}.svg`, text: ssvg });
    }
    const blob = await zipTextFiles(outputs);
    downloadBlob("layers_svg.zip", blob);
  }


  const NS = "http://www.w3.org/2000/svg";
  const getSvgEl = useCallback(() => document.querySelector(".viewer .canvas svg"), []);
  const getCanvas = useCallback(() => document.querySelector(".viewer .canvas"), []);

  const getSvgGeom = useCallback(() => {
    const svgEl = getSvgEl(); if (!svgEl) return null;

    const vb = svgEl.getAttribute('viewBox'); if (!vb) return null;
    const [minX, minY, vbW, vbH] = vb.split(/\s+/).map(Number);

    const toMm = (val) => {
      if (!val) return null;
      const m = String(val).match(/^([\d.]+)\s*(mm|in|px)?$/i);
      if (!m) return null;
      const v = parseFloat(m[1]);
      const u = (m[2] || 'px').toLowerCase();
      if (u === 'mm') return v;
      if (u === 'in') return v * 25.4;
      if (u === 'px') return (v / 96) * 25.4;
      return null;
    };

    let mmPerUnit = 1;
    const wMm = toMm(svgEl.getAttribute('width'));
    if (wMm && vbW) mmPerUnit = wMm / vbW;
    else {
      const hMm = toMm(svgEl.getAttribute('height'));
      if (hMm && vbH) mmPerUnit = hMm / vbH;
    }

    return { svgEl, minX, minY, vbW, vbH, mmPerUnit };
  }, [getSvgEl]);

  const mmToUnits = useCallback((ptMm) => {
    const g = getSvgGeom(); if (!g) return null;
    return {
      x: ptMm.x / g.mmPerUnit + g.minX,
      y: ptMm.y / g.mmPerUnit + g.minY,
      r: 1 / g.mmPerUnit,
      _vb: g
    };
  }, [getSvgGeom]);

  function ensureGroup(id) {
    const svgEl = getSvgEl(); if (!svgEl) return null;
    let g = svgEl.querySelector('#' + id);
    if (!g) {
      g = document.createElementNS(NS, "g");
      g.setAttribute("id", id);
      g.setAttribute("pointer-events", "none");
      svgEl.appendChild(g);
    }
    while (g.firstChild) g.removeChild(g.firstChild);
    return g;
  }

  const inView = (u) => {
    if (!u || !u._vb) return false;
    const { minX, minY, vbW, vbH } = u._vb;
    return u.x >= minX && u.x <= (minX + vbW) && u.y >= minY && u.y <= (minY + vbH);
  }

  const drawCircle = (g, x, y, r, fill, stroke) => {
    const c1 = document.createElementNS(NS, "circle");
    c1.setAttribute("cx", x); c1.setAttribute("cy", y); c1.setAttribute("r", r * 1.2);
    c1.setAttribute("fill", fill); g.appendChild(c1);
    const c2 = document.createElementNS(NS, "circle");
    c2.setAttribute("cx", x); c2.setAttribute("cy", y); c2.setAttribute("r", r);
    c2.setAttribute("fill", "none"); c2.setAttribute("stroke", stroke); c2.setAttribute("stroke-width", r * 0.25);
    g.appendChild(c2);
  };

  const drawText = (g, x, y, text, size, fill = "#000", stroke = "#fff") => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("fill", fill); t.setAttribute("font-size", String(size));
    t.setAttribute("paint-order", "stroke"); t.setAttribute("stroke", stroke);
    t.setAttribute("stroke-width", String(size * 0.2)); t.textContent = String(text || '');
    g.appendChild(t);
  };

  const updateOverlay = useCallback(() => {
    const gm = ensureGroup("overlay-markers"); if (!gm) return;
    const svgEl = getSvgEl(); if (!svgEl) return;

    // Always get fresh geometry from current viewBox
    const geom = getSvgGeom(); if (!geom) return;

    // Helper to convert mm to current viewBox units with consistent coordinate system
    const mmToCurrentUnits = (ptMm) => {
      const result = {
        x: ptMm.x / geom.mmPerUnit + geom.minX,
        y: ptMm.y / geom.mmPerUnit + geom.minY,
        r: 1 / geom.mmPerUnit
      };

      console.log('mmToCurrentUnits conversion:', {
        input: ptMm,
        output: result,
        geom: { minX: geom.minX, minY: geom.minY, mmPerUnit: geom.mmPerUnit }
      });
      return result;
    };

    // Draw live preview overlays
    if (livePreview.isActive) {
      const glive = ensureGroup("overlay-live");

      // Draw completed pads (green)
      livePreview.completedPads.forEach(pad => {
        const u = mmToCurrentUnits({ x: pad.x, y: pad.y });
        const completedCircle = document.createElementNS(NS, "circle");
        completedCircle.setAttribute("cx", u.x);
        completedCircle.setAttribute("cy", u.y);
        completedCircle.setAttribute("r", u.r * 0.8);
        completedCircle.setAttribute("fill", "rgba(40, 167, 69, 0.7)");
        completedCircle.setAttribute("stroke", "#28a745");
        completedCircle.setAttribute("stroke-width", u.r * 0.1);
        glive.appendChild(completedCircle);

        // Add checkmark
        const checkmark = document.createElementNS(NS, "text");
        checkmark.setAttribute("x", u.x);
        checkmark.setAttribute("y", u.y + u.r * 0.3);
        checkmark.setAttribute("text-anchor", "middle");
        checkmark.setAttribute("font-size", u.r * 0.8);
        checkmark.setAttribute("fill", "white");
        checkmark.setAttribute("font-weight", "bold");
        checkmark.textContent = "✓";
        glive.appendChild(checkmark);
      });

      // Draw current pad (pulsing orange)
      if (livePreview.currentPadIndex >= 0 && dispensingSequence[livePreview.currentPadIndex]) {
        const currentPad = dispensingSequence[livePreview.currentPadIndex];
        const u = mmToCurrentUnits({ x: currentPad.x, y: currentPad.y });

        const currentCircle = document.createElementNS(NS, "circle");
        currentCircle.setAttribute("cx", u.x);
        currentCircle.setAttribute("cy", u.y);
        currentCircle.setAttribute("r", u.r * 1.2);
        currentCircle.setAttribute("fill", "rgba(255, 193, 7, 0.8)");
        currentCircle.setAttribute("stroke", "#ffc107");
        currentCircle.setAttribute("stroke-width", u.r * 0.15);

        // Add pulsing animation
        const animate = document.createElementNS(NS, "animate");
        animate.setAttribute("attributeName", "r");
        animate.setAttribute("values", `${u.r * 1.0};${u.r * 1.4};${u.r * 1.0}`);
        animate.setAttribute("dur", "1.5s");
        animate.setAttribute("repeatCount", "indefinite");
        currentCircle.appendChild(animate);

        glive.appendChild(currentCircle);

        // Add "DISPENSING" label
        const label = document.createElementNS(NS, "text");
        label.setAttribute("x", u.x);
        label.setAttribute("y", u.y - u.r * 1.8);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", u.r * 0.6);
        label.setAttribute("fill", "#dc3545");
        label.setAttribute("font-weight", "bold");
        label.textContent = "DISPENSING";
        glive.appendChild(label);
      }

      // Draw machine position (blue crosshair)
      if (livePreview.machinePosition) {
        const u = mmToCurrentUnits(livePreview.machinePosition);
        const crossSize = u.r * 0.8;

        // Horizontal line
        const hLine = document.createElementNS(NS, "line");
        hLine.setAttribute("x1", u.x - crossSize);
        hLine.setAttribute("y1", u.y);
        hLine.setAttribute("x2", u.x + crossSize);
        hLine.setAttribute("y2", u.y);
        hLine.setAttribute("stroke", "#007bff");
        hLine.setAttribute("stroke-width", u.r * 0.1);
        glive.appendChild(hLine);

        // Vertical line
        const vLine = document.createElementNS(NS, "line");
        vLine.setAttribute("x1", u.x);
        vLine.setAttribute("y1", u.y - crossSize);
        vLine.setAttribute("x2", u.x);
        vLine.setAttribute("y2", u.y + crossSize);
        vLine.setAttribute("stroke", "#007bff");
        vLine.setAttribute("stroke-width", u.r * 0.1);
        glive.appendChild(vLine);

        // Center dot
        const centerDot = document.createElementNS(NS, "circle");
        centerDot.setAttribute("cx", u.x);
        centerDot.setAttribute("cy", u.y);
        centerDot.setAttribute("r", u.r * 0.2);
        centerDot.setAttribute("fill", "#007bff");
        glive.appendChild(centerDot);
      }
    } else {
      // Clear live preview overlays when not active
      ensureGroup("overlay-live");
    }

    // Draw reference point (origin or fiducial)
    const activeRef = referencePoint || selectedOrigin;
    if (activeRef) {
      console.log('Drawing activeRef:', activeRef, 'coordinates:', { x: activeRef.x, y: activeRef.y });
      const uh = mmToCurrentUnits({ x: activeRef.x, y: activeRef.y });
      const isOrigin = activeRef === selectedOrigin;
      const color = isOrigin ? "#0a0" : "#ff6600";
      const label = isOrigin ? "TOP-LEFT ORIGIN" : `REF: ${activeRef.id || 'FIDUCIAL'}`;
      drawCircle(gm, uh.x, uh.y, uh.r, isOrigin ? "rgba(0,180,0,0.25)" : "rgba(255,102,0,0.25)", color);
      drawText(gm, uh.x + uh.r * 1.6, uh.y - uh.r * 0.8, label, uh.r * 1.0, color);
    }

    if (selectedMm) {
      // Find the selected pad using original coordinates (before transformation)
      const origin = selectedOrigin;
      let searchCoords = selectedMm;

      // If we have an origin, reverse the transformation to find the original pad
      if (origin) {
        searchCoords = {
          x: selectedMm.x + origin.x, // Reverse: add back origin.x
          y: selectedMm.y - origin.y  // Reverse: subtract back origin.y
        };
      }

      // Use stored original pad reference if available
      const selectedPad = selectedMm.originalPad || pads.find(p => Math.abs(p.x - searchCoords.x) < 0.1 && Math.abs(p.y - searchCoords.y) < 0.1);
      if (selectedPad) {

        // Use original pad coordinates for drawing the marker (not transformed coordinates)
        const markerCoords = { x: selectedPad.x, y: selectedPad.y };
        console.log('Drawing overlay for selected pad:', {
          selectedMm,
          selectedPad,
          markerCoords,
          centerMethod: selectedPad.centerMethod
        });
        const u = mmToCurrentUnits(markerCoords);
        console.log('Converted to SVG units:', u);

        // Calculate marker radius based on actual pad dimensions
        const padWidth = selectedPad.width || 1.0;
        const padHeight = selectedPad.height || 1.0;
        const maxDimension = Math.max(padWidth, padHeight);

        // Marker radius should be slightly larger than the pad (110% of max dimension)
        const markerRadius = (maxDimension * 1) / geom.mmPerUnit;

        // Red circle ring removed

        // Enhanced center marking with validation indicator
        const crossSize = (maxDimension * 0.4) / geom.mmPerUnit;
        const centerColor = selectedPad.centerValid ? "#00ff00" : "#ff6600";

        // Use the selectedMm coordinates directly (they already contain the center position)
        const centerCoords = mmToCurrentUnits(selectedMm);

        // Calculate pad dimensions for paste dots
        const padWidthSvg = padWidth / geom.mmPerUnit;
        const padHeightSvg = padHeight / geom.mmPerUnit;

        // Crosshair lines - both using calculated center position
        const hLine = document.createElementNS(NS, "line");
        hLine.setAttribute("x1", centerCoords.x - crossSize);
        hLine.setAttribute("y1", centerCoords.y);
        hLine.setAttribute("x2", centerCoords.x + crossSize);
        hLine.setAttribute("y2", centerCoords.y);
        hLine.setAttribute("stroke", centerColor);
        hLine.setAttribute("stroke-width", markerRadius * 0.08);
        gm.appendChild(hLine);

        const vLine = document.createElementNS(NS, "line");
        vLine.setAttribute("x1", centerCoords.x);
        vLine.setAttribute("y1", centerCoords.y - crossSize);
        vLine.setAttribute("x2", centerCoords.x);
        vLine.setAttribute("y2", centerCoords.y + crossSize);
        vLine.setAttribute("stroke", centerColor);
        vLine.setAttribute("stroke-width", markerRadius * 0.08);
        gm.appendChild(vLine);

        // Center dot at calculated center position
        const centerDot = document.createElementNS(NS, "circle");
        centerDot.setAttribute("cx", centerCoords.x);
        centerDot.setAttribute("cy", centerCoords.y);
        centerDot.setAttribute("r", markerRadius * 0.2);
        centerDot.setAttribute("fill", centerColor);
        centerDot.setAttribute("stroke", "#ffffff");
        centerDot.setAttribute("stroke-width", markerRadius * 0.05);
        gm.appendChild(centerDot);

        // Validation ring at calculated center position
        const validationRing = document.createElementNS(NS, "circle");
        validationRing.setAttribute("cx", centerCoords.x);
        validationRing.setAttribute("cy", centerCoords.y);
        validationRing.setAttribute("r", markerRadius * 0.35);
        validationRing.setAttribute("fill", "none");
        validationRing.setAttribute("stroke", centerColor);
        validationRing.setAttribute("stroke-width", markerRadius * 0.04);
        validationRing.setAttribute("stroke-dasharray", selectedPad.centerValid ? "none" : "2,2");
        gm.appendChild(validationRing);

        // Draw paste visualization dots if enabled
        if (showPasteDots) {
          const dotRadius = (nozzleDia * 0.4) / geom.mmPerUnit;
          const spacing = dotRadius * 2.5; // Space between dot centers

          // Calculate grid dimensions to fill the pad
          const dotsX = Math.max(1, Math.floor(padWidthSvg / spacing));
          const dotsY = Math.max(1, Math.floor(padHeightSvg / spacing));

          // Calculate starting position to center the grid
          const startX = centerCoords.x - ((dotsX - 1) * spacing) / 2;
          const startY = centerCoords.y - ((dotsY - 1) * spacing) / 2;

          let dotIndex = 1;
          for (let row = 0; row < dotsY; row++) {
            for (let col = 0; col < dotsX; col++) {
              const dotX = startX + col * spacing;
              const dotY = startY + row * spacing;

              const pasteCircle = document.createElementNS(NS, "circle");
              pasteCircle.setAttribute("cx", dotX);
              pasteCircle.setAttribute("cy", dotY);
              pasteCircle.setAttribute("r", dotRadius);
              pasteCircle.setAttribute("fill", "rgba(0, 255, 0, 0.7)");
              pasteCircle.setAttribute("stroke", "#00ff00ff");
              pasteCircle.setAttribute("stroke-width", dotRadius * 0.1);
              gm.appendChild(pasteCircle);

              // Add dot number
              const dotText = document.createElementNS(NS, "text");
              dotText.setAttribute("x", dotX);
              dotText.setAttribute("y", dotY + dotRadius * 0.25);
              dotText.setAttribute("text-anchor", "middle");
              dotText.setAttribute("font-size", dotRadius * 0.8);
              dotText.setAttribute("fill", "#ffffff");
              dotText.setAttribute("font-weight", "bold");
              dotText.textContent = dotIndex++;
              gm.appendChild(dotText);
            }
          }
        }
      }
    }

    // Draw generated path
    if (generatedPath && activeRef && selectedMm) {
      const gp = ensureGroup("overlay-path");

      // Draw path segments
      generatedPath.segments.forEach((segment, idx) => {
        const start = mmToCurrentUnits(segment.start);
        const end = mmToCurrentUnits(segment.end);

        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", start.x); line.setAttribute("y1", start.y);
        line.setAttribute("x2", end.x); line.setAttribute("y2", end.y);

        // Different colors for different segment types
        const color = segment.type === 'lift' ? '#00ff00' :
          segment.type === 'travel' ? '#0080ff' :
            segment.type === 'lower' ? '#ff8000' : '#ff0';

        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", start.r * 0.3);
        line.setAttribute("stroke-dasharray", segment.type === 'travel' ? "4,2" : "none");
        gp.appendChild(line);
      });

      // Draw waypoints
      generatedPath.points.forEach((point, idx) => {
        if (point.type === 'waypoint') {
          const up = mmToCurrentUnits(point);
          drawCircle(gp, up.x, up.y, up.r * 0.5, "rgba(255,165,0,0.3)", "#ffa500");
        }
      });

      // Draw distance label
      const start = mmToCurrentUnits({ x: activeRef.x, y: activeRef.y });
      const end = mmToCurrentUnits(selectedMm);
      const midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2 - start.r * 0.6;
      drawText(gp, midX, midY, `${generatedPath.totalDistance.toFixed(2)} mm`, start.r * 1.2, "#222", "#fffb");
    } else if (activeRef && selectedMm) {
      // Fallback to simple line if no path generated
      const uh = mmToCurrentUnits({ x: activeRef.x, y: activeRef.y });
      // Find selected pad and calculate center position for yellow line endpoint
      const origin = selectedOrigin;
      let searchCoords = selectedMm;
      if (origin) {
        searchCoords = {
          x: selectedMm.x + origin.x,
          y: selectedMm.y - origin.y
        };
      }
      const uf = mmToCurrentUnits(selectedMm);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", uh.x);
      line.setAttribute("y1", uh.y);
      line.setAttribute("x2", uf.x);
      line.setAttribute("y2", uf.y);
      line.setAttribute("stroke", "#ff0");
      line.setAttribute("stroke-width", uh.r * 0.15);
      line.setAttribute("stroke-dasharray", `${uh.r * 0.8},${uh.r * 0.6}`);
      gm.appendChild(line);

      const dx = selectedMm.x - activeRef.x;
      const dy = selectedMm.y - activeRef.y;
      const dist = Math.hypot(dx, dy);
      console.log('Distance calculation:', { dx, dy, dist, selectedMm, activeRef });
      const midX = (uh.x + uf.x) / 2, midY = (uh.y + uf.y) / 2 - uh.r * 0.6;
      drawText(gm, midX, midY, `${dist.toFixed(2)} mm`, uh.r * 1.2, "#222", "#fffb");
    }

    const gf = ensureGroup("overlay-fids");
    fiducials.forEach(f => {
      if (!f.design) return;
      const u = mmToCurrentUnits(f.design);
      if (u.x >= geom.minX && u.x <= (geom.minX + geom.vbW) &&
        u.y >= geom.minY && u.y <= (geom.minY + geom.vbH)) {
        drawCircle(gf, u.x, u.y, u.r, hexToRgba(f.color, 0.20), f.color);
        drawText(gf, u.x + u.r * 1.2, u.y - u.r * 0.8, f.id, u.r * 1.1, f.color);
      }
    });

    // Draw selected origin point
    if (selectedOrigin) {
      console.log('Drawing origin overlay:', selectedOrigin);
      const go = ensureGroup("overlay-origin");
      const uo = mmToCurrentUnits({ x: selectedOrigin.x, y: selectedOrigin.y });
      console.log('Origin units:', uo, 'geom:', geom);

      // Always draw origin, ignore bounds check for debugging
      const size = uo.r * 1.5;
      const cross1 = document.createElementNS(NS, "line");
      cross1.setAttribute("x1", uo.x - size); cross1.setAttribute("y1", uo.y);
      cross1.setAttribute("x2", uo.x + size); cross1.setAttribute("y2", uo.y);
      cross1.setAttribute("stroke", "#ff4500"); cross1.setAttribute("stroke-width", uo.r * 0.3);
      go.appendChild(cross1);

      const cross2 = document.createElementNS(NS, "line");
      cross2.setAttribute("x1", uo.x); cross2.setAttribute("y1", uo.y - size);
      cross2.setAttribute("x2", uo.x); cross2.setAttribute("y2", uo.y + size);
      cross2.setAttribute("stroke", "#ff4500"); cross2.setAttribute("stroke-width", uo.r * 0.3);
      go.appendChild(cross2);

      drawCircle(go, uo.x, uo.y, uo.r * 0.8, "rgba(255,69,0,0.15)", "#ff4500");
      drawText(go, uo.x + uo.r * 1.8, uo.y - uo.r * 0.8, "TOP-LEFT", uo.r * 1.0, "#ff4500");
      console.log('Origin marker drawn at:', uo.x, uo.y);
    } else {
      console.log('No selectedOrigin to draw');
    }

    if (xf) {
      const grect = ensureGroup("overlay-ghost");
      const board = [
        { x: geom.minX * geom.mmPerUnit, y: geom.minY * geom.mmPerUnit },
        { x: (geom.minX + geom.vbW) * geom.mmPerUnit, y: geom.minY * geom.mmPerUnit },
        { x: (geom.minX + geom.vbW) * geom.mmPerUnit, y: (geom.minY + geom.vbH) * geom.mmPerUnit },
        { x: geom.minX * geom.mmPerUnit, y: (geom.minY + geom.vbH) * geom.mmPerUnit },
      ];
      const poly = document.createElementNS(NS, "polyline");
      const pts = board.map(p => applyTransform(xf, p)).map(mmToCurrentUnits).map(u => `${u.x},${u.y}`).join(" ");
      poly.setAttribute("points", pts + " " + pts.split(" ")[0]);
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", "#00c4ff");
      poly.setAttribute("stroke-width", (1 / geom.mmPerUnit) * 0.25);
      poly.setAttribute("stroke-dasharray", "6,6");
      grect.appendChild(poly);
    } else {
      ensureGroup("overlay-ghost");
    }
  }, [selectedMm, fiducials, xf, selectedOrigin, generatedPath, pads, getSvgEl, getSvgGeom, livePreview, dispensingSequence, showPasteDots, nozzleDia]);

  const hexToRgba = (hex, a = 0.3) => {
    const h = hex.replace("#", "");
    const bigint = parseInt(h, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r},${g},${b},${a})`;
  };

  useEffect(() => { updateOverlay(); }, [updateOverlay]);

  useEffect(() => {
    const refPoint = referencePoint || selectedOrigin;
    if (refPoint && pads.length > 0) {
      const distances = pads.map(pad => {
        // Step 1: Calculate TRUE CENTER of the pad (same as handleCanvasClick)
        const padHeight = pad.height || 1.0;
        const trueCenterY = pad.y + (padHeight / 2);  // Add half height to get center

        // Step 2: Apply coordinate transformation relative to origin
        const origin = selectedOrigin;
        let transformedPadCenter;

        if (origin) {
          // Apply transformation using TRUE CENTER coordinates
          transformedPadCenter = {
            x: pad.x - origin.x,
            y: trueCenterY + origin.y  // Use trueCenterY instead of pad.y
          };
        } else {
          // No origin, use center coordinates
          transformedPadCenter = {
            x: pad.x,
            y: trueCenterY
          };
        }

        // Step 3: Calculate distance from reference to pad CENTER
        const dx = transformedPadCenter.x - refPoint.x;
        const dy = transformedPadCenter.y - refPoint.y;
        const dist = Math.hypot(dx, dy);

        console.log(`Pad ${pad.id} CENTER: Original(${pad.x.toFixed(2)}, ${pad.y.toFixed(2)}) + height/2(${(padHeight / 2).toFixed(2)}) → Center(${pad.x.toFixed(2)}, ${trueCenterY.toFixed(2)}) → Transformed(${transformedPadCenter.x.toFixed(2)}, ${transformedPadCenter.y.toFixed(2)}) → Distance: ${dist.toFixed(2)}mm`);

        return {
          ...pad,
          distance: dist,  // Distance to CENTER point
          dx,
          dy,
          transformedX: transformedPadCenter.x,
          transformedY: transformedPadCenter.y,
          trueCenterY: trueCenterY  // Store center Y for reference
        };
      });
      setPadDistances(distances);
    } else {
      setPadDistances(pads);
    }
  }, [referencePoint, selectedOrigin, pads]);

  // Generate path when reference point and target change
  useEffect(() => {
    const refPoint = referencePoint || selectedOrigin;
    if (refPoint && selectedMm) {
      const path = generatePath(refPoint, selectedMm, pads, {
        pathType,
        avoidPads: pathType !== 'direct',
        safeHeight: 2
      });
      setGeneratedPath(path);
    } else {
      setGeneratedPath(null);
    }
  }, [referencePoint, selectedOrigin, selectedMm, pads, pathType]);

  // Generate dispensing sequence when reference point or pads change
  useEffect(() => {
    const refPoint = referencePoint || selectedOrigin;
    if (refPoint && pads.length > 0) {
      if (useSafePathPlanning) {
        // Use safe path planning with collision avoidance
        const safeSeq = safePathPlanner.calculateSafeSequence(refPoint, pads, boardOutline, componentHeights);
        setSafeSequence(safeSeq);
        setDispensingSequence(safeSeq);

        const stats = {
          totalPads: safeSeq.length,
          totalDistance: safeSeq.reduce((sum, pad) => sum + (pad.pathDistance || 0), 0).toFixed(2),
          estimatedTime: Math.ceil(safeSeq.length * 3 + safeSeq.reduce((sum, pad) => sum + (pad.pathDistance || 0), 0) / 50),
          averageDistance: (safeSeq.reduce((sum, pad) => sum + (pad.pathDistance || 0), 0) / safeSeq.length).toFixed(2),
          safePathsUsed: safeSeq.filter(p => !p.requiresHighClearance).length,
          highClearancePaths: safeSeq.filter(p => p.requiresHighClearance).length
        };
        setJobStatistics(stats);
      } else {
        // Use simple nearest neighbor
        const sequence = dispensingSequencer.calculateOptimalSequence(refPoint, pads);
        setDispensingSequence(sequence);
        setSafeSequence([]);

        const stats = dispensingSequencer.calculateJobStatistics(refPoint, sequence);
        setJobStatistics(stats);
      }
    } else {
      setDispensingSequence([]);
      setSafeSequence([]);
      setJobStatistics(null);
    }
  }, [referencePoint, selectedOrigin, pads, dispensingSequencer, safePathPlanner, useSafePathPlanning, boardOutline, componentHeights]);

  const getEventMm = (evt) => {
    const svgEl = getSvgEl(); if (!svgEl) return null;
    const geom = getSvgGeom(); if (!geom) return null;
    const pt = svgEl.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svgEl.getScreenCTM(); if (!ctm) return null;
    const local = pt.matrixTransform(ctm.inverse());
    const mmX = (local.x - geom.minX) * geom.mmPerUnit;
    const mmY = (local.y - geom.minY) * geom.mmPerUnit;
    console.log('Click conversion:', {
      clientX: evt.clientX,
      clientY: evt.clientY,
      localX: local.x,
      localY: local.y,
      mmX,
      mmY,
      geom: { minX: geom.minX, minY: geom.minY, mmPerUnit: geom.mmPerUnit }
    });
    return { x: mmX, y: mmY };
  };

  function isClickInsidePad(clickMm) {
    if (pads.length === 0) {
      console.warn('No pads loaded. Please select a paste layer from the dropdown.');
      return null;
    }

    let bestMatch = null;
    let minDistance = Infinity;

    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      const halfWidth = (pad.width || 1) / 2;
      const halfHeight = (pad.height || 1) / 2;

      // Calculate distance from click to pad center
      const distanceToCenter = Math.hypot(clickMm.x - pad.x, clickMm.y - pad.y);

      // Check if click is within pad boundaries
      const withinBounds = clickMm.x >= pad.x - halfWidth &&
        clickMm.x <= pad.x + halfWidth &&
        clickMm.y >= pad.y - halfHeight &&
        clickMm.y <= pad.y + halfHeight;

      if (withinBounds && distanceToCenter < minDistance) {
        minDistance = distanceToCenter;
        bestMatch = {
          pad: i,
          pos: {
            x: pad.x, // Always use calculated center
            y: pad.y, // Always use calculated center
            width: pad.width,
            height: pad.height,
            centerValid: pad.centerValid,
            centerMethod: pad.centerMethod
          },
          distanceToCenter
        };
      }
    }

    return bestMatch;
  }

  const [dragFid, setDragFid] = useState(null);
  useEffect(() => {
    const svgEl = getSvgEl(); if (!svgEl || !fidPickMode) return;

    const onDown = (e) => {
      const mm = getEventMm(e); if (!mm) return;
      let targetId = null;
      let best = { id: null, d: Infinity };
      for (const f of fiducials) {
        if (!f.design) continue;
        const d = Math.hypot(f.design.x - mm.x, f.design.y - mm.y);
        if (d < best.d) { best = { id: f.id, d }; }
      }
      if (best.d <= 2) targetId = best.id;
      else if (fidActiveId) targetId = fidActiveId;

      if (targetId) {
        setFiducials(prev => prev.map(f => f.id === targetId ? { ...f, design: mm } : f));
        setDragFid(targetId);
      }
    };
    const onMove = (e) => {
      if (!dragFid) return;
      const mm = getEventMm(e); if (!mm) return;
      setFiducials(prev => prev.map(f => f.id === dragFid ? { ...f, design: mm } : f));
    };
    const onUp = () => setDragFid(null);

    svgEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      svgEl.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fidPickMode, fidActiveId, dragFid, fiducials, getSvgEl]);

  useEffect(() => {
    const svgEl = document.querySelector(".viewer .canvas svg");
    if (!svgEl) return;

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "viewBox") {
          updateOverlay();
          break;
        }
      }
    });

    obs.observe(svgEl, { attributes: true, attributeFilter: ["viewBox"] });
    return () => obs.disconnect();
  }, [svg, updateOverlay]);


  // Update overlay when origin changes
  useEffect(() => {
    if (selectedOrigin) {
      console.log('Origin changed, updating overlay:', selectedOrigin);
      setTimeout(() => updateOverlay(), 100); // Small delay to ensure SVG is ready
    }
  }, [selectedOrigin, updateOverlay]);



  const handleCanvasClick = useCallback((evt) => {
    if (fidPickMode) return;

    // Debug coordinate conversion
    const svgEl = getSvgEl();
    if (svgEl) {
      debugCoordinateConversion(evt, svgEl, null);
    }

    const mm = getEventMm(evt);
    if (!mm) return;

    const hit = isClickInsidePad(mm);

    // Only process clicks inside actual pad boundaries
    if (!hit) {
      // Clear selection when clicking outside pads
      setSelectedMm(null);
      return;
    }


    // Transform pad coordinates relative to origin
    const origin = selectedOrigin;
    let padCenter;

    if (origin) {
      // Apply coordinate transformation and vertical center adjustment
      const padHeight = hit.pos.height || 1.0;
      const trueCenterY = hit.pos.y + (padHeight / 2);
      padCenter = {
        x: hit.pos.x - origin.x,
        y: trueCenterY + origin.y,
        centerValid: hit.pos.centerValid,
        centerMethod: hit.pos.centerMethod,
        originalPad: pads[hit.pad] // Store reference to original pad
      };
      console.log('🔄 Coordinate transformation applied:', {
        originalPad: { x: hit.pos.x, y: hit.pos.y },
        origin: { x: origin.x, y: origin.y },
        transformedPad: padCenter,
        calculation: `x: ${hit.pos.x} - ${origin.x} = ${padCenter.x}, y: ${hit.pos.y} + ${origin.y} = ${padCenter.y}`
      });
    } else {
      // No origin available, use original coordinates with vertical center adjustment
      const padHeight = hit.pos.height || 1.0;
      const trueCenterY = hit.pos.y + (padHeight / 2);
      padCenter = {
        x: hit.pos.x,
        y: trueCenterY,
        centerValid: hit.pos.centerValid,
        centerMethod: hit.pos.centerMethod,
        originalPad: pads[hit.pad] // Store reference to original pad
      };
    }

    console.log('Pad selection details:', {
      clickMm: mm,
      hitPad: hit.pad,
      hitPos: hit.pos,
      padCenter,
      distanceToCenter: hit.distanceToCenter
    });

    // Validate center calculation
    if (!hit.pos.centerValid) {
      console.warn('Pad center calculation may be inaccurate:', hit.pos.centerMethod);
    }

    // Show distance from reference point to clicked pad
    const refPoint = referencePoint || selectedOrigin;
    if (refPoint) {
      const dx = padCenter.x - refPoint.x;
      const dy = padCenter.y - refPoint.y;
      const dist = Math.hypot(dx, dy);
      const refName = refPoint === selectedOrigin ? 'Top-Left Origin' : `Fiducial ${refPoint.id || ''}`;
      const show = window.confirm(
        `Distance from ${refName}:\n` +
        `ΔX: ${dx.toFixed(2)} mm\n` +
        `ΔY: ${dy.toFixed(2)} mm\n` +
        `Distance: ${dist.toFixed(2)} mm\n\n` +
        `Show measurement line?`
      );
      if (show) {
        setSelectedMm(padCenter);
      }
    } else {
      setSelectedMm(padCenter);
    }
  }, [
    fidPickMode,
    selectedOrigin,
    pads,
    getEventMm
  ]);

  const onInputMachine = (id, partial) => {
    setFiducials(prev => prev.map(f => f.id === id ? { ...f, machine: { x: (partial.x ?? f.machine?.x ?? null), y: (partial.y ?? f.machine?.y ?? null) } } : f));
  };
  const onClearOne = (id) => setFiducials(prev => prev.map(f => f.id === id ? { ...f, design: null, machine: null } : f));
  const onClearAll = () => { setFiducials(prev => prev.map(f => ({ ...f, design: null, machine: null }))); setXf(null); };

  const onSolve2 = () => {
    const P = fiducials.filter(f => f.design && f.machine);
    if (P.length < 2) return;
    const T = fitSimilarity(P.map(f => f.design), P.map(f => f.machine));
    setXf(T);
  };
  const onSolve3 = () => {
    const P = fiducials.filter(f => f.design && f.machine);
    if (P.length < 3) return;
    const T = fitAffine(P.map(f => f.design), P.map(f => f.machine));
    setXf(T);
  };

  const onRedetectFiducials = () => {
    if (layers.length === 0) return;

    // Re-run fiducial detection
    const detectedFiducials = analyzeFiducialsInLayers(layers);
    setFiducialDetectionResult(detectedFiducials);

    if (detectedFiducials.length > 0) {
      // Auto-populate fiducials with detected positions
      const colors = ["#2ea8ff", "#8e2bff", "#00c49a", "#ff6b35", "#9c27b0", "#4caf50"];
      const autoFiducials = detectedFiducials.map((fid, idx) => ({
        id: fid.id,
        design: { x: fid.x, y: fid.y },
        machine: null,
        color: colors[idx % colors.length],
        confidence: fid.confidence
      }));

      // Fill remaining slots with empty fiducials
      while (autoFiducials.length < 3) {
        autoFiducials.push({
          id: `F${autoFiducials.length + 1}`,
          design: null,
          machine: null,
          color: colors[autoFiducials.length % colors.length]
        });
      }

      setFiducials(autoFiducials);
    } else {
      // No fiducials detected, keep current fiducials but clear design positions
      setFiducials(prev => prev.map(f => ({ ...f, design: null })));
    }

    // Clear transform since fiducials changed
    setXf(null);
  };

  const onAutoAlign = () => {
    // Auto-populate machine coordinates from design coordinatesc
    const alignedFiducials = fiducials.map(f => {
      if (f.design && f.design.x !== null && f.design.y !== null) {
        return {
          ...f,
          machine: {
            x: f.design.x + (pcbOriginOffset?.x || 0) + (toolOffset?.dx || 0),
            y: f.design.y + (pcbOriginOffset?.y || 0) + (toolOffset?.dy || 0)
          }
        };
      }
      return f;
    });

    setFiducials(alignedFiducials);

    // Auto-solve transformation if we have enough fiducials
    const validFiducials = alignedFiducials.filter(f => f.design && f.machine);
    if (validFiducials.length >= 2) {
      const T = fitSimilarity(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
      setXf(T);
    }
  };

  const onAutoDetectCamera = async () => {
    // This will be called from CameraPanel when fiducials are detected
    console.log('Camera-based fiducial detection initiated');
  };

  const onDetectOrigins = () => {
    if (layers.length === 0) return;

    const origins = detectPcbOrigins(layers);
    setOriginCandidates(origins);

    if (origins.length > 0) {
      const origin = { ...origins[0], id: 'O1' };
      setSelectedOrigin(origin);
      setPcbOriginOffset({ x: origin.x, y: origin.y });
    } else {
      setSelectedOrigin(null);
    }
  };
  useEffect(() => {
    window.updateFiducialsFromCamera = (detectedFiducials) => {
      const colors = ["#2ea8ff", "#8e2bff", "#00c49a", "#ff6b35", "#9c27b0", "#4caf50"];

      const updatedFiducials = detectedFiducials.map((detected, idx) => ({
        id: detected.id || `F${idx + 1}`,
        design: fiducials[idx]?.design || null, // Keep existing design coordinates
        machine: detected.machine,
        color: colors[idx % colors.length],
        confidence: detected.confidence,
        autoDetected: true
      }));

      // Fill remaining slots
      while (updatedFiducials.length < 3) {
        updatedFiducials.push({
          id: `F${updatedFiducials.length + 1}`,
          design: null,
          machine: null,
          color: colors[updatedFiducials.length % colors.length]
        });
      }

      setFiducials(updatedFiducials);

      // Auto-solve if we have enough data
      const validFiducials = updatedFiducials.filter(f => f.design && f.machine);
      if (validFiducials.length >= 2) {
        const T = fitSimilarity(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
        setXf(T);
      }
    };

    return () => {
      delete window.updateFiducialsFromCamera;
    };
  }, [fiducials]);

  return (
    <div className="wrap" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <aside className="sidebar">
        <div className="header" >
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="btn">
              Open Gerbers / ZIP
              <input type="file" multiple onChange={pickFiles}
                accept=".zip,.gbr,.grb,.gtl,.gbl,.gts,.gbs,.gto,.gbo,.gtp,.gbp,.gbc,.gm1,.drl,.txt,.nc" />
            </label>
            {/* <button className="btn secondary" onClick={exportAllSvgsZip} disabled={layers.length === 0}>Download SVGs (ZIP)</button> */}
          </div>
        </div>

        <div className="section Board-section">
          <h3 style={{ color: '#007bff', padding: '8px 12px', borderBottom: '2px solid #007bff' }}>Board View</h3>
          <div className="flex-row">
            <button className="btn secondary" onClick={() => changeSide("top")}>Top</button>
            <button className="btn secondary" onClick={() => changeSide("bottom")}>Bottom</button>
            <label><input type="checkbox" checked={mirrorBottom} onChange={(e) => setMirrorBottom(e.target.checked)} /> Mirror bottom</label>
          </div>
          <LayerList layers={layers} layerData={layerData} onToggle={toggleLayer} />
        </div>



        <div className="section Components-section">
          <h3 style={{ color: '#007bff', padding: '8px 12px', borderBottom: '2px solid #007bff' }}>Components</h3>
          <div className="flex-row" style={{ marginLeft: 8 }}>
            <select value={pasteIdx ?? ""} onChange={(e) => {
              const idx = e.target.value === "" ? null : +e.target.value;
              setPasteIdx(idx);
              if (idx != null) {
                const selectedLayer = layers[idx];

                if (selectedLayer.type === "solderpaste") {
                  // Use solderpaste layer - contains only actual pad areas for dispensing
                  const padData = extractPadsMm(selectedLayer.text).map(padCenter);
                  setPads(processPads(padData));
                  console.log('Solderpaste layer loaded:', padData.length, 'pads');
                } else {
                  setPads([]);
                }
              } else setPads([]);
              setSelectedMm(null);
            }}>
              <option value="">(select solderpaste layer)</option>
              {layers.map((l, i) => {
                if (l.type === "solderpaste") {
                  return <option key={l.filename} value={i}>{l.filename} (solderpaste)</option>;
                }
                return null;
              })}
            </select>
          </div>
          <ComponentList
            components={padDistances}
            onFocus={(pad) => {
              // Calculate TRUE CENTER of the pad
              const padHeight = pad.height || 1.0;
              const trueCenterY = pad.y + (padHeight / 2);

              // Use transformed CENTER coordinates
              const origin = selectedOrigin;
              let displayCoords;

              if (pad.transformedX !== undefined && pad.transformedY !== undefined) {
                // Use pre-calculated transformed CENTER coordinates
                displayCoords = {
                  x: pad.transformedX,
                  y: pad.transformedY,
                  centerValid: pad.centerValid,
                  centerMethod: pad.centerMethod,
                  originalPad: pad
                };
              } else if (origin) {
                // Calculate transformation using TRUE CENTER on the fly
                displayCoords = {
                  x: pad.x - origin.x,
                  y: trueCenterY + origin.y,  // Use trueCenterY
                  centerValid: pad.centerValid,
                  centerMethod: pad.centerMethod,
                  originalPad: pad
                };
              } else {
                // No transformation needed, use CENTER
                displayCoords = {
                  x: pad.x,
                  y: trueCenterY,  // Use trueCenterY
                  centerValid: pad.centerValid,
                  centerMethod: pad.centerMethod,
                  originalPad: pad
                };
              }

              console.log('ComponentList Focus to CENTER:', {
                original: { x: pad.x, y: pad.y },
                center: { x: pad.x, y: trueCenterY },
                transformed: displayCoords,
                distance: pad.distance
              });

              setSelectedMm(displayCoords);
            }}
          />

          <div className="section Origin-section">
            <h3 style={{ color: '#007bff', padding: '8px 12px', borderBottom: '2px solid #007bff' }}>PCB Origin</h3>
            {selectedOrigin && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ padding: 8, background: '#e3effaff', borderRadius: 4 }}>
                  <strong>{selectedOrigin.description}</strong><br />
                  <small>Position: ({selectedOrigin.x.toFixed(2)}, {selectedOrigin.y.toFixed(2)}) mm</small>
                  <small>Confidence: {(selectedOrigin.confidence * 100).toFixed(0)}%</small>
                </div>
              </div>
            )}
            <div className="flex-row" style={{ marginLeft: 8 }}>
              <label>X (mm) <input type="number" step="0.1" value={pcbOriginOffset?.x || 0}
                onChange={(e) => setPcbOriginOffset({ x: +e.target.value || 0, y: pcbOriginOffset?.y || 0 })}
                style={{ width: 80 }} /></label>
              <label>Y (mm) <input type="number" step="0.1" value={pcbOriginOffset?.y || 0}
                onChange={(e) => setPcbOriginOffset({ x: pcbOriginOffset?.x || 0, y: +e.target.value || 0 })}
                style={{ width: 80 }} /></label>
            </div>
            <div className="flex-row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn sm secondary" onClick={onDetectOrigins} disabled={layers.length === 0}>
                🎯 Detect Origins
              </button>
              <button className="btn sm secondary" onClick={() => {
                // Test origin at top-left corner
                const testOrigin = { id: 'O1', x: 0, y: 0, confidence: 0.9, description: 'Top-left corner (test)' };
                setSelectedOrigin(testOrigin);
                console.log('Set test origin (top-left):', testOrigin);
                setTimeout(() => updateOverlay(), 100);
              }}>
                Test Origin (Top-Left)
              </button>
              <button className="btn sm secondary" onClick={() => {
                setSelectedOrigin(null);
                setPcbOriginOffset({ x: 0, y: 0 });
              }}>
                Clear
              </button>
            </div>
            <small>Machine coordinates where PCB top-left corner (0,0) is located</small>
          </div>

          <div className="section Reference-section" style={{ marginTop: 16 }}>
            <h4 style={{ color: '#007bff', margin: '8px 0' }}>Reference Point</h4>
            <div className="flex-row" style={{ marginLeft: 8, gap: 8 }}>
              <label>
                <input type="radio" name="refType" checked={referenceType === 'origin'}
                  onChange={() => {
                    setReferenceType('origin');
                    setReferencePoint(null);
                  }} />
                Top-Left Origin
              </label>
              <label>
                <input type="radio" name="refType" checked={referenceType === 'fiducial'}
                  onChange={() => setReferenceType('fiducial')} />
                Fiducial
              </label>
            </div>
            {referenceType === 'fiducial' && (
              <div className="flex-row" style={{ marginLeft: 8, marginTop: 8 }}>
                <select value={referencePoint?.id || ''} onChange={(e) => {
                  const fidId = e.target.value;
                  const fid = fiducials.find(f => f.id === fidId && f.design);
                  setReferencePoint(fid ? { x: fid.design.x, y: fid.design.y, id: fid.id } : null);
                }}>
                  <option value="">(select fiducial)</option>
                  {fiducials.filter(f => f.design).map(f => (
                    <option key={f.id} value={f.id}>{f.id} ({f.design.x.toFixed(1)}, {f.design.y.toFixed(1)})</option>
                  ))}
                </select>
              </div>
            )}
            <small>Reference point for measuring distances to pads</small>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="section"><h3>Preview</h3></div>

        <Viewer
          svg={svg}
          mirrorBottom={mirrorBottom}
          side={side}
          onClickSvg={handleCanvasClick}
        />

        {(referencePoint || selectedOrigin) && selectedMm && (
          <div className="distance-info">
            <span className="badge">Path from {referencePoint ? `Fiducial ${referencePoint.id}` : 'Top-Left Origin'}</span>
            <div className="kvs">
              <span>ΔX: {(selectedMm.x - (referencePoint || selectedOrigin).x).toFixed(2)} mm</span>
              <span>ΔY: {(selectedMm.y - (referencePoint || selectedOrigin).y).toFixed(2)} mm</span>
              <span><strong>2D: {Math.hypot(selectedMm.x - (referencePoint || selectedOrigin).x, selectedMm.y - (referencePoint || selectedOrigin).y).toFixed(2)} mm</strong></span>
              {generatedPath && <span>3D Path: {generatedPath.totalDistance.toFixed(2)} mm</span>}
              <span style={{ color: selectedMm.centerValid ? '#28a745' : '#ffc107' }}>Center: ({selectedMm.x.toFixed(3)}, {selectedMm.y.toFixed(3)}) {selectedMm.centerValid ? '✓' : '⚠️'}</span>
              {selectedMm.centerMethod && <span style={{ fontSize: '0.8em', color: '#666' }}>Method: {selectedMm.centerMethod}</span>}
            </div>
            <div className="path-controls" style={{ marginTop: 8 }}>
              <select value={pathType} onChange={(e) => setPathType(e.target.value)} style={{ fontSize: 12 }}>
                <option value="direct">Direct Path</option>
                <option value="safe">Safe Path (Lift)</option>
                <option value="optimized">Optimized Path</option>
                <option value="zigzag">Zig-Zag Path</option>
              </select>
              <label style={{ marginLeft: 8, fontSize: 12 }}>
                <input type="checkbox" checked={showPasteDots} onChange={(e) => setShowPasteDots(e.target.checked)} />
                Show Paste Dots
              </label>
              {generatedPath && (
                <small style={{ marginLeft: 8, color: '#666' }}>
                  {generatedPath.type} • {generatedPath.segments.length} segments
                </small>
              )}
            </div>
          </div>
        )}

        <div className="fiducial-panel">
          <FiducialPanel
            fiducials={fiducials}
            activeId={fidActiveId}
            setActiveId={setFidActiveId}
            pickMode={fidPickMode}
            togglePickMode={() => setFidPickMode(v => !v)}
            onInputMachine={onInputMachine}
            onClearOne={onClearOne}
            onClearAll={onClearAll}
            onSolve2={onSolve2}
            onSolve3={onSolve3}
            transformSummary={transformSummary}
            applyTransform={applyXf}
            setApplyTransform={setApplyXf}
            detectionResult={fiducialDetectionResult}
            onRedetectFiducials={onRedetectFiducials}
            onAutoAlign={onAutoAlign}
            onAutoDetectCamera={onAutoDetectCamera}
          />
          {selectedOrigin && selectedMm && xf && applyXf && (
            <div style={{ padding: 8, background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: 4, marginTop: 8 }}>
              <small><strong>Transform Verification:</strong></small>
              <div style={{ fontSize: '0.8em', fontFamily: 'monospace' }}>
                Origin: {selectedOrigin.x.toFixed(3)}, {selectedOrigin.y.toFixed(3)} → {verifyTransform(selectedOrigin).x.toFixed(3)}, {verifyTransform(selectedOrigin).y.toFixed(3)}
              </div>
              <div style={{ fontSize: '0.8em', fontFamily: 'monospace' }}>
                Target: {selectedMm.x.toFixed(3)}, {selectedMm.y.toFixed(3)} → {verifyTransform(selectedMm).x.toFixed(3)}, {verifyTransform(selectedMm).y.toFixed(3)}
              </div>
            </div>
          )}
        </div>

        {maintenanceAlert && (
          <div className="maintenance-alert" style={{
            position: 'fixed', top: 20, right: 20, background: '#ff6b35', color: 'white',
            padding: 16, borderRadius: 8, zIndex: 1000, maxWidth: 300
          }}>
            <h4>🔧 Nozzle Maintenance Required</h4>
            <p>{maintenanceAlert.type === 'cleaning_reminder' ?
              `Dispenses: ${maintenanceAlert.dispenseCount}, Hours: ${Math.round(maintenanceAlert.hoursSinceLastCleaning)}` :
              'Cleaning completed'}
            </p>
            <div className="flex-row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn sm" onClick={() => {
                maintenanceManager.markCleaned();
                setMaintenanceAlert(null);
              }}>Mark Cleaned</button>
              <button className="btn sm secondary" onClick={() => setMaintenanceAlert(null)}>Dismiss</button>
            </div>
          </div>
        )}

        <div className="panels">
          <BatchPanel
            batchProcessor={batchProcessor}
            currentBatch={currentBatch}
            onBatchSelect={handleBatchSelect}
            onStartBatch={handleStartBatch}
            onPauseBatch={handlePauseBatch}
            onAddBoard={handleAddCurrentBoard}
            onDeleteBatch={handleDeleteBatch}
          />
          <LivePreview
            dispensingSequence={dispensingSequence}
            isJobRunning={livePreview.isActive}
            currentPadIndex={livePreview.currentPadIndex}
            machinePosition={livePreview.machinePosition}
            onUpdateOverlay={updateOverlay}
          />
          <AutomatedDispensingPanel
            dispensingSequencer={dispensingSequencer}
            dispensingSequence={dispensingSequence}
            safeSequence={safeSequence}
            jobStatistics={jobStatistics}
            referencePoint={referencePoint}
            selectedOrigin={selectedOrigin}
            pressureSettings={pressureSettings}
            speedSettings={speedSettings}
            boardOutline={boardOutline}
            useSafePathPlanning={useSafePathPlanning}
            setUseSafePathPlanning={setUseSafePathPlanning}
            componentHeights={componentHeights}
            setComponentHeights={setComponentHeights}
            safePathPlanner={safePathPlanner}
            onStartJob={(gcode, sequence) => {
              console.log('Starting automated dispensing job:', { gcode, sequence });
            }}
            batchProcessor={batchProcessor}
            currentBatch={currentBatch}
            onStartBatch={handleStartBatch}
            layerData={layerData}
          />
          <CameraPanel
            fiducials={fiducials}
            xf={xf}
            applyXf={applyXf}
            selectedDesign={selectedMm}
            toolOffset={toolOffset}
            setToolOffset={(setToolOffset)}
            nozzleDia={nozzleDia}
            setNozzleDia={setNozzleDia}
            padDetector={padDetector}
            qualityController={qualityController}
            fiducialVisionDetector={fiducialVisionDetector}
            layerData={layerData}
          />
          {/* <OpenCVFiducialPanel
            onFiducialsDetected={handleOpenCVDetection}
            cameraStream={cameraStream}
          /> */}
          <PressurePanel
            pressureController={pressureController}
            pressureSettings={pressureSettings}
            setPressureSettings={setPressureSettings}
            selectedPad={selectedMm ? pads.find(p => Math.abs(p.x - selectedMm.x) < 0.1 && Math.abs(p.y - selectedMm.y) < 0.1) : null}
          />
          <SpeedPanel
            speedProfileManager={speedProfileManager}
            speedSettings={speedSettings}
            referencePoint={referencePoint}
            selectedOrigin={selectedOrigin}
            setSpeedSettings={setSpeedSettings}
            selectedPad={selectedMm ? pads.find(p => Math.abs(p.x - selectedMm.x) < 0.1 && Math.abs(p.y - selectedMm.y) < 0.1) : null}
            pressureSettings={pressureSettings}
            pads={pads}
          />

          {/* <LinearMovePanel
            homeDesign={selectedOrigin ? { x: selectedOrigin.x, y: selectedOrigin.y } : null}
            focusDesign={selectedMm}
            xf={xf}
            applyXf={applyXf}
            components={pads}
            axisLetter="A"
            collisionDetector={collisionDetector}
            maintenanceManager={maintenanceManager}
            pressureController={pressureController}
            pressureSettings={pressureSettings}
            speedProfileManager={speedProfileManager}
            speedSettings={speedSettings}
            referencePoint={referencePoint}
            selectedOrigin={selectedOrigin}
            dispensingSequencer={dispensingSequencer}
            dispensingSequence={dispensingSequence}
            safeSequence={safeSequence}
            jobStatistics={jobStatistics}
            boardOutline={boardOutline}
            safePathPlanner={safePathPlanner}
            useSafePathPlanning={useSafePathPlanning}
          /> */}
          <SerialPanel 
            dispensingSequence={dispensingSequence}
            jobStatistics={jobStatistics}
            pressureSettings={pressureSettings}
            speedSettings={speedSettings}
            referencePoint={referencePoint}
            selectedOrigin={selectedOrigin}
            onJobStart={(gcode) => {
              console.log('Dispensing job started via SerialPanel');
              maintenanceManager.recordDispense();
            }}
            onJobComplete={() => {
              console.log('Dispensing job completed');
              alert('Dispensing job completed successfully!');
            }}
          />
        </div>
      </main>
    </div>
  );
}
