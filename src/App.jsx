import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import "./App.css";

import LayerList from "./components/LayerList.jsx";
import Viewer from "./components/Viewer.jsx";
import CameraPanel from "./components/CameraPanel.jsx";
import SerialPanel from "./components/SerialPanel.jsx";
import BedCalibrationPanel, { getZOffsetForPoint } from "./components/BedCalibrationPanel.jsx";
import ComponentList from "./components/ComponentList.jsx";
import JogPanel from "./components/JogPanel.jsx";
import FiducialPanel from "./components/FiducialPanel.jsx";
import AutomatedDispensingPanel from "./components/AutomatedDispensingPanel.jsx";
import { analyzeFiducialsInLayers, analyzeFiducialsWithRails } from "./lib/gerber/fiducialDetection.js";
import { detectPcbOrigins } from "./lib/gerber/originDetection.js";
import { FiducialVisionDetector } from "./lib/vision/fiducialVision.js";
import { zipTextFiles, downloadBlob } from "./lib/zip/zipUtils.js";
import { fitSimilarity, fitAffine, fitTranslation, fitHomography, applyTransform, rmsError } from "./lib/utils/transform2d.js";
import { CollisionDetector } from "./lib/collision/collisionDetection.js";
import { PadDetector } from "./lib/vision/padDetection.js";
import { QualityController } from "./lib/quality/qualityControl.js";
import { NozzleMaintenanceManager } from "./lib/maintenance/nozzleMaintenance.js";
import { generatePath } from "./lib/motion/pathGeneration.js";
import { PasteVisualizer } from "./lib/paste/pasteVisualization.js";
import { DispensingSequencer } from "./lib/automation/dispensingSequence.js";
import { SafePathPlanner } from "./lib/automation/safePathPlanner.js";
import { extractPadsMm } from "./lib/gerber/extractPads.js";
import MaintenanceManager from "./components/MaintenanceManager.jsx";
import ToolOffsetCalibration from "./components/ToolOffsetCalibration.jsx";
import { useSerialMachine } from "./hooks/useSerialMachine.js";
import { useGerberFiles } from "./hooks/useGerberFiles.js";
import AppHeader from "./components/AppHeader.jsx";

function calculatePadCenter(p) {
  if (typeof p.x === "number" && typeof p.y === "number") {
    return { x: p.x, y: p.y, valid: true, method: 'gerber_flash_center', width: p.width, height: p.height };
  }
  return { x: 0, y: 0, valid: false, method: 'fallback' };
}

function padCenter(p) {
  const result = calculatePadCenter(p);
  return { ...p, x: result.x, y: result.y };
}

function processPads(points) {
  return points.map((pad, idx) => {
    const c = calculatePadCenter(pad);
    return { ...pad, x: c.x, y: c.y, id: pad.componentIdentifier || `P${idx + 1}`,
      width: pad.width || c.width || 1, height: pad.height || c.height || 1,
      centerValid: c.valid, centerMethod: c.method, originalPad: pad };
  });
}

function parseLengthToMm(lenStr = "") {
  const m = String(lenStr).match(/^([\d.]+)\s*(mm|in)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]); const unit = (m[2] || "mm").toLowerCase();
  return unit === "in" ? v * 25.4 : v;
}

export default function App() {
  const {
    isSerialConnected, machinePos,
    isEmergencyStopped,
    handleSerialConnect, handleSerialDisconnect,
    triggerEmergencyStop, resetEmergencyStop,
  } = useSerialMachine();

  const {
    layers, setLayers, side, setSide, svg,
    pads, setPads, pasteIdx, setPasteIdx,
    boardOutline, setBoardOutline, layerData,
    rebuild, toggleLayer: toggleLayerFn, changeSide: changeSideFn, parseFiles,
  } = useGerberFiles();

  const toggleLayer = (idx) => toggleLayerFn(idx, layers, side);

  const [, forceRender] = useState({});

  const [selectedMm, setSelectedMm] = useState(null);
  const [padDistances, setPadDistances] = useState([]);
  const [generatedPath, setGeneratedPath] = useState(null);
  const [pathType, setPathType] = useState('direct');

  const cameraPanelRef = useRef(null);

  const [fidPickMode, setFidPickMode] = useState(false);
  const [fidActiveId, setFidActiveId] = useState(null);
  const [panelBoards, setPanelBoards] = useState([
    {
      id: 1,
      name: 'Board 1',
      fiducials: [
        { id: "F1", design: null, machine: null, color: "#2ea8ff" },
        { id: "F2", design: null, machine: null, color: "#8e2bff" },
        { id: "F3", design: null, machine: null, color: "#00c49a" },
      ],
      xf: null
    }
  ]);
  const [activeBoardIndexState, _setActiveBoardIndex] = useState(0);
  const activeBoardIndexRef = useRef(0);
  const setActiveBoardIndex = useCallback((idx) => {
    activeBoardIndexRef.current = idx;
    _setActiveBoardIndex(idx);
  }, []);

  const fiducials = panelBoards[activeBoardIndexState]?.fiducials || [];
  const setFiducials = useCallback((updater) => {
    setPanelBoards(prev => {
      const idx = activeBoardIndexRef.current;
      const newBoards = [...prev];
      const activeBoard = { ...newBoards[idx] };
      activeBoard.fiducials = typeof updater === 'function' ? updater(activeBoard.fiducials) : updater;
      newBoards[idx] = activeBoard;
      return newBoards;
    });
  }, []);
  const [fiducialDetectionResult, setFiducialDetectionResult] = useState(null);
  const [originCandidates, setOriginCandidates] = useState([]);
  const [selectedOrigin, setSelectedOrigin] = useState(null);
  const [pcbOriginOffset, setPcbOriginOffset] = useState({ x: 0, y: 0 });

  const effectiveOrigin = useMemo(() => {
    if (!selectedOrigin) return null;
    return {
      ...selectedOrigin,
      x: selectedOrigin.x + (pcbOriginOffset?.x || 0),
      y: selectedOrigin.y + (pcbOriginOffset?.y || 0)
    };
  }, [selectedOrigin, pcbOriginOffset]);

  const [referencePoint, setReferencePoint] = useState(null);
  const [referenceType, setReferenceType] = useState('origin');

  const xf = panelBoards[activeBoardIndexState]?.xf || null;
  const setXf = useCallback((newXf) => {
    setPanelBoards(prev => {
      const idx = activeBoardIndexRef.current;
      const newBoards = [...prev];
      newBoards[idx] = { ...newBoards[idx], xf: typeof newXf === 'function' ? newXf(newBoards[idx].xf) : newXf };
      return newBoards;
    });
  }, []);

  const [applyXf, setApplyXf] = useState(false);
  const [panelInfo, setPanelInfo] = useState(null);
  const [panelRailFiducials, setPanelRailFiducials] = useState([]);
  const [panelXf, setPanelXf] = useState(null);
  const [activeComponent, setActiveComponent] = useState('SerialPanel')

  // Move nozzle to the PCB's Gerber origin point in machine coordinates
  const goToPcbOrigin = useCallback(async () => {
    if (!window.serial?.writeLine) {
      alert("Machine not connected.");
      return;
    }

    let targetX, targetY;

    if (xf && applyXf && selectedOrigin) {
      // Best case: fiducials solved — transform Gerber origin → machine coords
      const machineOrigin = applyTransform(xf, { x: selectedOrigin.x, y: selectedOrigin.y });
      targetX = machineOrigin.x;
      targetY = machineOrigin.y;
    } else if (pcbOriginOffset) {
      // Fallback: use manually entered origin offset
      targetX = pcbOriginOffset.x;
      targetY = pcbOriginOffset.y;
    } else {
      alert("No PCB origin set. Please solve fiducials or set an origin offset first.");
      return;
    }

    const confirmed = window.confirm(
      `Move nozzle to PCB Origin?\nTarget: X${targetX.toFixed(3)}, Y${targetY.toFixed(3)} mm`
    );
    if (!confirmed) return;

    await window.serial.writeLine(`G0 X${targetX.toFixed(3)} Y${targetY.toFixed(3)} F6000`);
  }, [xf, applyXf, selectedOrigin, pcbOriginOffset]);

  // Always-fresh ref so the homing callback (fired from SerialPanel timeout) gets current origin state
  const originStateRef = useRef({ xf, applyXf, selectedOrigin, pcbOriginOffset });
  useEffect(() => {
    originStateRef.current = { xf, applyXf, selectedOrigin, pcbOriginOffset };
  }, [xf, applyXf, selectedOrigin, pcbOriginOffset]);

  const [isHomed, setIsHomed] = useState(false);
  const [isJobRunning, setIsJobRunning] = useState(false);

  const handleHomingComplete = useCallback(async () => {
    setIsHomed(true);
    const { xf: curXf, applyXf: curApplyXf, selectedOrigin: curOrigin, pcbOriginOffset: curOffset } = originStateRef.current;
    let targetX, targetY;

    if (curXf && curApplyXf && curOrigin) {
      // Transform exists — map gerber origin → machine coords
      const mo = applyTransform(curXf, { x: curOrigin.x, y: curOrigin.y });
      targetX = mo.x; targetY = mo.y;
    } else if (curOrigin) {
      // Treat gerber origin coords as machine coords (best guess before first solve)
      targetX = curOrigin.x; targetY = curOrigin.y;
    } else if (curOffset && (curOffset.x !== 0 || curOffset.y !== 0)) {
      targetX = curOffset.x; targetY = curOffset.y;
    } else {
      console.log('[AutoMove] No PCB origin configured — skipping auto-move after homing.');
      return;
    }

    // Clamp to bed limits (235×235 mm)
    targetX = Math.max(0, Math.min(235, targetX));
    targetY = Math.max(0, Math.min(235, targetY));

    if (window.serial?.writeLine) {
      console.log(`[AutoMove] Homing done — moving to PCB origin X${targetX.toFixed(3)} Y${targetY.toFixed(3)}`);
      await window.serial.writeLine(`G90`);
      await window.serial.writeLine(`G0 X${targetX.toFixed(3)} Y${targetY.toFixed(3)} F3000`);

    }
  }, []);

  const [collisionDetector] = useState(() => new CollisionDetector());
  const [padDetector] = useState(() => new PadDetector());
  const [qualityController] = useState(() => new QualityController());
  const [maintenanceManager] = useState(() => new NozzleMaintenanceManager());
  const [fiducialVisionDetector] = useState(() => new FiducialVisionDetector());
  const [pasteVisualizer] = useState(() => new PasteVisualizer());
  const [dispensingSequencer] = useState(() => new DispensingSequencer());
  const [safePathPlanner] = useState(() => new SafePathPlanner());

  const [showPasteDots, setShowPasteDots] = useState(false);
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

  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedPadIndices, setSelectedPadIndices] = useState([]);

  const [alignment, setAlignment] = useState({ p1: null, p2: null, transform: null });
  const prevOriginLogRef = useRef(null);
  const prevActiveRefLogRef = useRef(null);

  const handleAlignmentCapture = useCallback((refIndex) => {
    const currentMPos = livePreview.machinePosition;
    if (!currentMPos) {
      alert("No machine position available. Connect machine first.");
      return;
    }

    setAlignment(prev => {
      const next = { ...prev };
      if (refIndex === 1) next.p1 = { ...currentMPos };
      if (refIndex === 2) next.p2 = { ...currentMPos };

      if (next.p1 && next.p2) {
        let width = 100, height = 100;

        if (boardOutline) {
          width = boardOutline.width;
          height = boardOutline.height;
        } else if (pads.length > 0) {
          const xs = pads.map(p => p.x);
          const ys = pads.map(p => p.y);
          width = Math.max(...xs) - Math.min(...xs);
          height = Math.max(...ys) - Math.min(...ys);
        }

        // Guard against degenerate dimensions
        if (width < 1 || height < 1) {
          console.warn("Alignment failed: board dimensions too small or undefined", { width, height });
          alert("Cannot compute alignment: board dimensions are invalid. Please load a board outline or paste layer first.");
          return prev;
        }
        const designPts = [
          { x: 0, y: 0 },
          { x: width, y: height }
        ];
        const machinePts = [
          next.p1,
          next.p2
        ];

        try {
          const T = fitSimilarity(designPts, machinePts);
          console.log("Panel Alignment Computed:", T);
          next.transform = T;
          setXf(T);
          setApplyXf(true);
        } catch (err) {
          console.error("Alignment failed:", err);
          next.transform = null;
          setXf(null);
          setApplyXf(false);
        }
      }
      return next;
    });
  }, [livePreview.machinePosition, boardOutline, pads]);

  const handleMachinePositionUpdate = useCallback((newPos) => {
    setLivePreview(prev => ({
      ...prev,
      machinePosition: newPos
    }));
  }, []);

  const handleFiducialsUpdate = useCallback((newFids) => {
    setFiducials(newFids);
  }, []);

  const [maintenanceAlert, setMaintenanceAlert] = useState(null);
  const [toolOffset, setToolOffset] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("toolOffset") || '{"dx": 0, "dy": 0');
    } catch (error) {
      return { dx: 0, dy: 0 };
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
    // Homography has no tx/ty — extract translation from last column of H matrix
    const tx = xf.type === "homography" ? xf.H?.[0]?.[2] : xf.tx;
    const ty = xf.type === "homography" ? xf.H?.[1]?.[2] : xf.ty;
    const out = { type: xf.type, tx: tx ?? 0, ty: ty ?? 0 };
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

  const FID_COLORS  = ["#2ea8ff", "#8e2bff", "#b7c400", "#ff6b35", "#9c27b0", "#25d9be"];
  const RAIL_COLORS = ["#ff9800", "#ff5722", "#ffc107", "#ff6d00"];

  // Full re-initialisation for a given side: re-detects fiducials, replaces the fiducial
  // table, clears machine coords and the transform. Called on side-switch and on file load.
  const reinitSideState = useCallback((s, currentLayers) => {
    if (!currentLayers || currentLayers.length === 0) return;

    const { localFiducials: detected, railFiducials: detectedRail } =
      analyzeFiducialsWithRails(currentLayers, s);

    setFiducialDetectionResult(detected.length > 0 ? detected : []);

    const makeBoardFids = (offsetX = 0, offsetY = 0) =>
      detected.length > 0
        ? detected.map((fid, idx) => ({
            id: fid.id || `F${idx + 1}`,
            design: { x: parseFloat((fid.x + offsetX).toFixed(4)), y: parseFloat((fid.y + offsetY).toFixed(4)) },
            machine: null, color: FID_COLORS[idx % FID_COLORS.length], confidence: fid.confidence,
          }))
        : [
            { id: 'F1', design: null, machine: null, color: '#2ea8ff' },
            { id: 'F2', design: null, machine: null, color: '#8e2bff' },
          ];

    const newRailFids = detectedRail.map((fid, idx) => ({
      id: fid.id || `R${idx + 1}`,
      design: { x: parseFloat(fid.x.toFixed(4)), y: parseFloat(fid.y.toFixed(4)) },
      machine: null, color: RAIL_COLORS[idx % RAIL_COLORS.length], isRail: true,
    }));

    setPanelBoards(prev => prev.map(board => ({
      ...board,
      fiducials: makeBoardFids(board.offsetX || 0, board.offsetY || 0),
      xf: null,
    })));

    setPanelRailFiducials(newRailFids);
    setFidActiveId(newRailFids[0]?.id ?? (detected[0]?.id || 'F1'));
    setXf(null);
    setPanelXf(null);
  }, [analyzeFiducialsWithRails]);

  const changeSide = (s, skip = false) => {
    changeSideFn(s, layers, skip);
    reinitSideState(s, layers);
  };

  const pickFiles = async (e) => handleFiles(e.target.files);
  const onDrop = async (e) => { e.preventDefault(); await handleFiles(e.dataTransfer.files); };

  async function handleFiles(fileList) {
    const result = await parseFiles(fileList);
    const { detectedFiducials, detectedRailFiducials, detectedPanelGrid, origins } = result;

    setFiducialDetectionResult(detectedFiducials);

    const fidColors = ["#2ea8ff", "#8e2bff", "#b7c400", "#ff6b35", "#9c27b0", "#25d9be"];
    const railColors = ["#ff9800", "#ff5722", "#ffc107", "#ff6d00"];

    const makeBoardFiducials = (offsetX = 0, offsetY = 0) =>
      detectedFiducials.length > 0
        ? detectedFiducials.map((fid, idx) => ({
            id: fid.id || `F${idx + 1}`,
            design: { x: parseFloat((fid.x + offsetX).toFixed(4)), y: parseFloat((fid.y + offsetY).toFixed(4)) },
            machine: null, color: fidColors[idx % fidColors.length], confidence: fid.confidence,
          }))
        : [
            { id: "F1", design: null, machine: null, color: "#2ea8ff" },
            { id: "F2", design: null, machine: null, color: "#8e2bff" },
          ];

    const autoRailFids = detectedRailFiducials.map((fid, idx) => ({
      id: fid.id || `R${idx + 1}`,
      design: { x: parseFloat(fid.x.toFixed(4)), y: parseFloat(fid.y.toFixed(4)) },
      machine: null, color: railColors[idx % railColors.length], isRail: true,
    }));
    setPanelRailFiducials(autoRailFids);
    setFidActiveId(autoRailFids[0]?.id ?? null); // default arm to R1 on every Gerber load
    setPanelXf(null);

    if (detectedPanelGrid && (detectedPanelGrid.dimX > 1 || detectedPanelGrid.dimY > 1)) {
      const { dimX, dimY, stepX, stepY } = detectedPanelGrid;
      const boards = [];
      let bid = 1;
      for (let j = 0; j < dimY; j++) {
        for (let i = 0; i < dimX; i++) {
          const ox = parseFloat((i * stepX).toFixed(4));
          const oy = parseFloat((j * stepY).toFixed(4));
          const defaultXf = { type: 'translation', a: 1, b: 0, c: 0, d: 1, tx: ox, ty: oy };
          const label = dimY > 1 ? `Board R${j + 1}C${i + 1}` : `Board ${i + 1}`;
          boards.push({ id: bid++, name: label, offsetX: ox, offsetY: oy, fiducials: makeBoardFiducials(ox, oy), xf: defaultXf });
        }
      }
      setPanelBoards(boards);
      _setActiveBoardIndex(0);
      setPanelInfo(detectedPanelGrid);
      setApplyXf(true);
    } else {
      setPanelBoards([{ id: 1, name: 'Board 1', fiducials: makeBoardFiducials(), xf: null }]);
      _setActiveBoardIndex(0);
      setPanelInfo(null);
      if (!detectedFiducials.length) setFiducialDetectionResult([]);
    }

    if (origins.length > 0) {
      const origin = { ...origins[0], id: 'O1' };
      setOriginCandidates(origins);
      setSelectedOrigin(origin);
      setPcbOriginOffset({ x: origin.x, y: origin.y });
    } else {
      setOriginCandidates([]);
    }

    setSelectedMm(null);
    setXf(null);
    if (!detectedPanelGrid) setApplyXf(false);
    setFidPickMode(false);
    queueMicrotask(() => { updateOverlay(); });
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

    const geom = getSvgGeom(); if (!geom) return;

    const mmToCurrentUnits = (ptMm) => {
      // Y: FLIP — Gerber Y grows up, SVG Y grows down
      const yUnits = (2 * geom.minY + geom.vbH) - (ptMm.y / geom.mmPerUnit);
      // X: pcb-stackup mirrors the bottom SVG, so we mirror the coordinate to match
      const xRaw = ptMm.x / geom.mmPerUnit;
      const xUnits = side === 'bottom'
        ? (2 * geom.minX + geom.vbW) - xRaw
        : xRaw;
      return { x: xUnits, y: yUnits, r: 1 / geom.mmPerUnit, _vb: geom };
    };

    if (livePreview.isActive) {
      const glive = ensureGroup("overlay-live");

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

        const animate = document.createElementNS(NS, "animate");
        animate.setAttribute("attributeName", "r");
        animate.setAttribute("values", `${u.r * 1.0};${u.r * 1.4};${u.r * 1.0}`);
        animate.setAttribute("dur", "1.5s");
        animate.setAttribute("repeatCount", "indefinite");
        currentCircle.appendChild(animate);

        glive.appendChild(currentCircle);

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

      if (livePreview.machinePosition) {
        const u = mmToCurrentUnits(livePreview.machinePosition);
        const crossSize = u.r * 0.8;
        const hLine = document.createElementNS(NS, "line");
        hLine.setAttribute("x1", u.x - crossSize);
        hLine.setAttribute("y1", u.y);
        hLine.setAttribute("x2", u.x + crossSize);
        hLine.setAttribute("y2", u.y);
        hLine.setAttribute("stroke", "#007bff");
        hLine.setAttribute("stroke-width", u.r * 0.1);
        glive.appendChild(hLine);

        const vLine = document.createElementNS(NS, "line");
        vLine.setAttribute("x1", u.x);
        vLine.setAttribute("y1", u.y - crossSize);
        vLine.setAttribute("x2", u.x);
        vLine.setAttribute("y2", u.y + crossSize);
        vLine.setAttribute("stroke", "#007bff");
        vLine.setAttribute("stroke-width", u.r * 0.1);
        glive.appendChild(vLine);

        const centerDot = document.createElementNS(NS, "circle");
        centerDot.setAttribute("cx", u.x);
        centerDot.setAttribute("cy", u.y);
        centerDot.setAttribute("r", u.r * 0.2);
        centerDot.setAttribute("fill", "#007bff");
        glive.appendChild(centerDot);
      }
    } else {
      ensureGroup("overlay-live");
    }

    const activeRef = referencePoint || selectedOrigin;
    if (activeRef) {
      const prev = prevActiveRefLogRef.current;
      const hasChanged = !prev || prev.id !== activeRef.id || Math.abs(prev.x - activeRef.x) > 0.001 || Math.abs(prev.y - activeRef.y) > 0.001;

      if (hasChanged) {
        console.log('Drawing activeRef:', activeRef, 'coordinates:', { x: activeRef.x, y: activeRef.y });
        prevActiveRefLogRef.current = { ...activeRef };
      }
      const uh = mmToCurrentUnits({ x: activeRef.x, y: activeRef.y });
      const isOrigin = activeRef === selectedOrigin;
      const color = isOrigin ? "rgba(196, 42, 193, 1)" : (activeRef.color || "#2ea8ff");
      const label = isOrigin ? "ORIGIN" : `${activeRef.id || 'FIDUCIAL'}`;
      const size = uh.r * 1.5;
      const l1 = document.createElementNS(NS, "line");
      l1.setAttribute("x1", uh.x - size); l1.setAttribute("y1", uh.y);
      l1.setAttribute("x2", uh.x + size); l1.setAttribute("y2", uh.y);
      l1.setAttribute("stroke", color); l1.setAttribute("stroke-width", uh.r * 0.2);
      gm.appendChild(l1);

      const l2 = document.createElementNS(NS, "line");
      l2.setAttribute("x1", uh.x); l2.setAttribute("y1", uh.y - size);
      l2.setAttribute("x2", uh.x); l2.setAttribute("y2", uh.y + size);
      l2.setAttribute("stroke", color); l2.setAttribute("stroke-width", uh.r * 0.2);
      gm.appendChild(l2);

      drawCircle(gm, uh.x, uh.y, uh.r, isOrigin ? "rgba(0,180,0,0.25)" : hexToRgba(color, 0.25), color);
      drawText(gm, uh.x + uh.r * 1.6, uh.y - uh.r * 0.8, label, uh.r * 1.0, color);
    }

    if (selectedPadIndices.length > 0) {

      selectedPadIndices.forEach(idx => {
        const pad = pads[idx];
        if (!pad) return;

        const pt = { x: pad.x, y: pad.y };
        const u = mmToCurrentUnits(pt);
        if (!inView(u)) return;

        const r = u.r * (Math.max(pad.width || 1, pad.height || 1) * 0.6);
        const sel = document.createElementNS(NS, "circle");
        sel.setAttribute("cx", u.x); sel.setAttribute("cy", u.y);
        sel.setAttribute("r", r * 1.1);
        sel.setAttribute("fill", "none");
        sel.setAttribute("stroke", "#FFA500");
        sel.setAttribute("stroke-width", u.r * 0.3);
        sel.setAttribute("stroke-dasharray", "4,2");
        gm.appendChild(sel);

        drawText(gm, u.x + r, u.y - r, `#${idx + 1}`, r * 0.5, "#FFA500");
      });
    }

    if (selectedMm) {
      const origin = selectedOrigin;
      let searchCoords = selectedMm;

      if (origin) {
        searchCoords = {
          x: selectedMm.x + origin.x,
          y: selectedMm.y - origin.y
        };
      }

      const selectedPad = selectedMm.originalPad || pads.find(p => Math.abs(p.x - searchCoords.x) < 0.1 && Math.abs(p.y - searchCoords.y) < 0.1);
      if (selectedPad) {

        const markerCoords = { x: selectedPad.x, y: selectedPad.y };
        const u = mmToCurrentUnits(markerCoords);

        // Retrieve actual pad dimensions, if available (fallback to 0 so we just draw 1 dot if unknown)
        const padWidth = selectedPad.width || 0;
        const padHeight = selectedPad.height || 0;

        // Enhanced center marking with validation indicator
        const centerColor = selectedPad.centerValid ? "#00ff00" : "#ff6600";
        const centerCoords = mmToCurrentUnits(selectedMm);

        // Fix: Increase radius so it is actually visible to the user
        const absoluteDotRadius = 0.5 / geom.mmPerUnit;

        // Draw the highlight ring that the user is missing!
        const r = u.r * (Math.max(padWidth || 1, padHeight || 1) * 0.8);
        const sel = document.createElementNS(NS, "circle");
        sel.setAttribute("cx", u.x); sel.setAttribute("cy", u.y);
        sel.setAttribute("r", r * 1.5 + absoluteDotRadius * 2);
        sel.setAttribute("fill", "none");
        sel.setAttribute("stroke", "#ff00ff");
        sel.setAttribute("stroke-width", u.r * 0.3);
        sel.setAttribute("stroke-dasharray", "4,2");
        gm.appendChild(sel);

        const centerDot = document.createElementNS(NS, "circle");
        centerDot.setAttribute("cx", centerCoords.x);
        centerDot.setAttribute("cy", centerCoords.y);
        centerDot.setAttribute("r", absoluteDotRadius); // Visible dot
        centerDot.setAttribute("fill", centerColor);
        centerDot.setAttribute("stroke", "#ffffff");
        centerDot.setAttribute("stroke-width", absoluteDotRadius * 0.2); // Crisp border
        gm.appendChild(centerDot);

        if (showPasteDots) {
          const dotRadiusMm = nozzleDia * 0.4;
          const dotRadiusSvg = dotRadiusMm / geom.mmPerUnit;
          const spacingMm = dotRadiusMm * 2.5;
          const spacingSvg = spacingMm / geom.mmPerUnit;

          let dotsX = 1;
          let dotsY = 1;

          if (padWidth > 0 && padHeight > 0) {
            // Strictly calculate how many dot centers can fit within the pad's inner bounds
            const availableXMm = padWidth - (dotRadiusMm * 2);
            const availableYMm = padHeight - (dotRadiusMm * 2);

            dotsX = availableXMm >= 0 ? Math.floor(availableXMm / spacingMm) + 1 : 1;
            dotsY = availableYMm >= 0 ? Math.floor(availableYMm / spacingMm) + 1 : 1;
          }

          const startX = centerCoords.x - ((dotsX - 1) * spacingSvg) / 2;
          const startY = centerCoords.y - ((dotsY - 1) * spacingSvg) / 2;

          let dotIndex = 1;
          for (let row = 0; row < dotsY; row++) {
            for (let col = 0; col < dotsX; col++) {
              const dotX = startX + col * spacingSvg;
              const dotY = startY + row * spacingSvg;

              const pasteCircle = document.createElementNS(NS, "circle");
              pasteCircle.setAttribute("cx", dotX);
              pasteCircle.setAttribute("cy", dotY);
              pasteCircle.setAttribute("r", dotRadiusSvg);
              pasteCircle.setAttribute("fill", "rgba(0, 255, 0, 0.7)");
              pasteCircle.setAttribute("stroke", "#00ff00ff");
              pasteCircle.setAttribute("stroke-width", dotRadiusSvg * 0.1);
              gm.appendChild(pasteCircle);

              const dotText = document.createElementNS(NS, "text");
              dotText.setAttribute("x", dotX);
              dotText.setAttribute("y", dotY + dotRadiusSvg * 0.25);
              dotText.setAttribute("text-anchor", "middle");
              dotText.setAttribute("font-size", dotRadiusSvg * 0.8);
              dotText.setAttribute("fill", "#ffffff");
              dotText.setAttribute("font-weight", "bold");
              dotText.textContent = dotIndex++;
              gm.appendChild(dotText);
            }
          }
        }
      }
    }

    if (dispensingSequence && dispensingSequence.length > 0 && selectedPadIndices.length > 0) {
      const gs = ensureGroup("overlay-sequence");
      if (activeRef) {
        const start = mmToCurrentUnits({ x: activeRef.x, y: activeRef.y });
        const end = mmToCurrentUnits({ x: dispensingSequence[0].x, y: dispensingSequence[0].y });

        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", start.x); line.setAttribute("y1", start.y);
        line.setAttribute("x2", end.x); line.setAttribute("y2", end.y);

        line.setAttribute("stroke", "#ccff00");
        line.setAttribute("stroke-width", start.r * 0.5);
        line.setAttribute("stroke-opacity", "0.8");
        gs.appendChild(line);
      }

      if (dispensingSequence.length > 1) {
        for (let i = 0; i < dispensingSequence.length - 1; i++) {
          const p1 = dispensingSequence[i];
          const p2 = dispensingSequence[i + 1];

          const start = mmToCurrentUnits({ x: p1.x, y: p1.y });
          const end = mmToCurrentUnits({ x: p2.x, y: p2.y });

          const line = document.createElementNS(NS, "line");
          line.setAttribute("x1", start.x); line.setAttribute("y1", start.y);
          line.setAttribute("x2", end.x); line.setAttribute("y2", end.y);

          line.setAttribute("stroke", "#ccff00");
          line.setAttribute("stroke-width", start.r * 0.5);
          line.setAttribute("stroke-opacity", "0.8");
          gs.appendChild(line);
        }
      }
    } else {
      ensureGroup("overlay-sequence");
    }

    if (generatedPath && activeRef && (selectedMm || multiSelectMode)) {
      const gp = ensureGroup("overlay-path");

      generatedPath.segments.forEach((segment, idx) => {
        const start = mmToCurrentUnits(segment.start);
        const end = mmToCurrentUnits(segment.end);

        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", start.x); line.setAttribute("y1", start.y);
        line.setAttribute("x2", end.x); line.setAttribute("y2", end.y);

        const color = segment.type === 'lift' ? '#00ff00' :
          segment.type === 'travel' ? '#00ccff' :
            segment.type === 'lower' ? '#ff9900' : '#ffff00';

        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", start.r * 0.6);

        line.setAttribute("stroke-dasharray", segment.type === 'travel' ? "4,2" : "none");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("opacity", "0.9");
        gp.appendChild(line);
      });

      if (generatedPath.points) {
        generatedPath.points.forEach((point, idx) => {
          if (point.type === 'waypoint') {
            const up = mmToCurrentUnits(point);
            drawCircle(gp, up.x, up.y, up.r * 0.5, "rgba(255,255,0,0.5)", "#ffff00");
          }
        });
      }

      if (selectedMm && generatedPath.totalDistance !== undefined) {
        const start = mmToCurrentUnits({ x: activeRef.x, y: activeRef.y });
        const end = mmToCurrentUnits(selectedMm);
        const midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2 - start.r * 0.6;
        drawText(gp, midX, midY, `${generatedPath.totalDistance.toFixed(3)} mm`, start.r * 1.2, "#222", "#fffb");
      }
    } else {
      ensureGroup("overlay-path");
    }

    if (!multiSelectMode && activeRef && selectedMm) {
      const uh = mmToCurrentUnits({ x: activeRef.x, y: activeRef.y });
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
      drawText(gm, midX, midY, `${dist.toFixed(3)} mm`, uh.r * 1.2, "#222", "#fffb");
    }

    const gf = ensureGroup("overlay-fids");
    panelBoards.forEach((board, bIdx) => {
      const isBoardActive = bIdx === activeBoardIndexState;
      board.fiducials.forEach(f => {
        if (!f.design) return;
        if (activeRef && f.id === activeRef.id && isBoardActive) return;

        const u = mmToCurrentUnits(f.design);
        if (u.x >= geom.minX && u.x <= (geom.minX + geom.vbW) &&
          u.y >= geom.minY && u.y <= (geom.minY + geom.vbH)) {

          const opacity = isBoardActive ? 0.20 : 0.05;
          const label = isBoardActive ? f.id : `${board.name} ${f.id}`;

          drawCircle(gf, u.x, u.y, u.r, hexToRgba(f.color, opacity), f.color);
        }
      });
    });

    // Draw Gerber-detected fiducials — both sides (mmToCurrentUnits handles bottom X-mirror)
    const ggf = ensureGroup("overlay-gerber-fids");
    if (fiducialDetectionResult && fiducialDetectionResult.length > 0) {
      fiducialDetectionResult.forEach((fid) => {
        const u = mmToCurrentUnits({ x: fid.x, y: fid.y });
        const fidColor = '#00e5ff';
        const ringR = u.r * 1.5;
        const crossSize = u.r * 2.2;

        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('cx', u.x); ring.setAttribute('cy', u.y);
        ring.setAttribute('r', ringR);
        ring.setAttribute('fill', 'rgba(0,229,255,0.15)');
        ring.setAttribute('stroke', fidColor);
        ring.setAttribute('stroke-width', u.r * 0.2);
        ggf.appendChild(ring);

        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', u.x); dot.setAttribute('cy', u.y);
        dot.setAttribute('r', u.r * 0.3);
        dot.setAttribute('fill', fidColor);
        ggf.appendChild(dot);

        const hLine = document.createElementNS(NS, 'line');
        hLine.setAttribute('x1', u.x - crossSize); hLine.setAttribute('y1', u.y);
        hLine.setAttribute('x2', u.x + crossSize); hLine.setAttribute('y2', u.y);
        hLine.setAttribute('stroke', fidColor); hLine.setAttribute('stroke-width', u.r * 0.15);
        ggf.appendChild(hLine);

        const vLine = document.createElementNS(NS, 'line');
        vLine.setAttribute('x1', u.x); vLine.setAttribute('y1', u.y - crossSize);
        vLine.setAttribute('x2', u.x); vLine.setAttribute('y2', u.y + crossSize);
        vLine.setAttribute('stroke', fidColor); vLine.setAttribute('stroke-width', u.r * 0.15);
        ggf.appendChild(vLine);

        drawText(ggf, u.x + u.r * 2.4, u.y - u.r * 0.6, fid.id, u.r * 1.0, fidColor, 'rgba(0,0,0,0.7)');
      });
    }

    // Draw panel rail fiducials — same crosshair style as local fiducials, orange colour
    const ggr = ensureGroup("overlay-rail-fids");
    if (panelRailFiducials.length > 0) {
      panelRailFiducials.forEach(fid => {
        if (!fid.design) return;
        const u = mmToCurrentUnits({ x: fid.design.x, y: fid.design.y });
        const color = fid.color || '#ff9800';
        const ringR = u.r * 1.5;
        const crossSize = u.r * 2.2;

        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('cx', u.x); ring.setAttribute('cy', u.y);
        ring.setAttribute('r', ringR);
        ring.setAttribute('fill', 'rgba(255,152,0,0.15)');
        ring.setAttribute('stroke', color);
        ring.setAttribute('stroke-width', u.r * 0.2);
        ggr.appendChild(ring);

        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', u.x); dot.setAttribute('cy', u.y);
        dot.setAttribute('r', u.r * 0.3);
        dot.setAttribute('fill', color);
        ggr.appendChild(dot);

        const hLine = document.createElementNS(NS, 'line');
        hLine.setAttribute('x1', u.x - crossSize); hLine.setAttribute('y1', u.y);
        hLine.setAttribute('x2', u.x + crossSize); hLine.setAttribute('y2', u.y);
        hLine.setAttribute('stroke', color); hLine.setAttribute('stroke-width', u.r * 0.15);
        ggr.appendChild(hLine);

        const vLine = document.createElementNS(NS, 'line');
        vLine.setAttribute('x1', u.x); vLine.setAttribute('y1', u.y - crossSize);
        vLine.setAttribute('x2', u.x); vLine.setAttribute('y2', u.y + crossSize);
        vLine.setAttribute('stroke', color); vLine.setAttribute('stroke-width', u.r * 0.15);
        ggr.appendChild(vLine);

        drawText(ggr, u.x + u.r * 2.4, u.y - u.r * 0.6, `${fid.id} (Rail)`, u.r * 1.0, color, 'rgba(0,0,0,0.7)');
      });
    }

    if (selectedOrigin) {
      const go = ensureGroup("overlay-origin");
      const uo = mmToCurrentUnits({ x: selectedOrigin.x, y: selectedOrigin.y });

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
      drawText(go, uo.x + uo.r * 1.8, uo.y - uo.r * 0.8, "ORIGIN (0,0)", uo.r * 1.0, "#ff4500");
    } else {
      ensureGroup("overlay-origin");
    }

    if (xf) {
      const grect = ensureGroup("overlay-ghost");

      // Fix: Draw the actual board outline in DESIGN SPACE (no machine transform).
      // The xf transform is design→machine. The SVG viewer is in design space.
      // Applying xf here shifts the overlay by the full machine offset (~70mm) — wrong!
      // Instead, draw boardOutline (already in design mm) directly on the SVG.
      let boardCorners;
      if (boardOutline) {
        const { minX, minY, width, height } = boardOutline;
        boardCorners = [
          { x: minX, y: minY },
          { x: minX + width, y: minY },
          { x: minX + width, y: minY + height },
          { x: minX, y: minY + height },
        ];
      } else {
        // Fallback: use viewBox corners in design mm (no transform applied)
        boardCorners = [
          { x: geom.minX * geom.mmPerUnit, y: geom.minY * geom.mmPerUnit },
          { x: (geom.minX + geom.vbW) * geom.mmPerUnit, y: geom.minY * geom.mmPerUnit },
          { x: (geom.minX + geom.vbW) * geom.mmPerUnit, y: (geom.minY + geom.vbH) * geom.mmPerUnit },
          { x: geom.minX * geom.mmPerUnit, y: (geom.minY + geom.vbH) * geom.mmPerUnit },
        ];
      }

      const poly = document.createElementNS(NS, "polyline");
      // Map design-space mm → SVG display units (no xf applied)
      const pts = boardCorners.map(mmToCurrentUnits).map(u => `${u.x},${u.y}`).join(" ");
      poly.setAttribute("points", pts + " " + pts.split(" ")[0]);
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", "#00c4ff");
      poly.setAttribute("stroke-width", (1 / geom.mmPerUnit) * 0.25);
      poly.setAttribute("stroke-dasharray", "6,6");
      grect.appendChild(poly);
    } else {
      ensureGroup("overlay-ghost");
    }
  }, [multiSelectMode, selectedMm, fiducials, xf, selectedOrigin, generatedPath, pads, getSvgEl, getSvgGeom, livePreview, dispensingSequence, showPasteDots, nozzleDia, side, boardOutline, fiducialDetectionResult]);

  const hexToRgba = (hex, a = 0.3) => {
    const h = hex.replace("#", "");
    const bigint = parseInt(h, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r},${g},${b},${a})`;
  };

  useEffect(() => { updateOverlay(); }, [updateOverlay]);
  useEffect(() => { updateOverlay(); }, [panelRailFiducials]);

  useEffect(() => {
    const refPoint = referencePoint || selectedOrigin;
    if (refPoint && pads.length > 0) {
      const distances = pads.map(pad => {
        const trueCenterY = pad.y;
        let dx, dy;
        if (refPoint === selectedOrigin) {
          dx = pad.x - selectedOrigin.x;
          dy = trueCenterY - selectedOrigin.y;
        } else {
          dx = pad.x - refPoint.x;
          dy = trueCenterY - refPoint.y;
        }

        const dist = Math.hypot(dx, dy);

        return {
          ...pad,
          distance: dist,
          dx,
          dy,
          transformedX: pad.x - (selectedOrigin?.x || 0),
          transformedY: trueCenterY - (selectedOrigin?.y || 0),
          trueCenterY: trueCenterY
        };
      });
      setPadDistances(distances);
    } else {
      setPadDistances(pads);
    }
  }, [referencePoint, selectedOrigin, pads]);

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

  useEffect(() => {
    const refPoint = referencePoint || selectedOrigin;

    const padsToUse = selectedPadIndices.length > 0
      ? selectedPadIndices.map(i => pads[i]).filter(Boolean)
      : pads;

    if (refPoint && padsToUse.length > 0) {
      if (useSafePathPlanning) {
        const safeSeq = safePathPlanner.calculateSafeSequence(refPoint, padsToUse, boardOutline, componentHeights);
        setSafeSequence(safeSeq);
        setDispensingSequence(safeSeq);

        let segments = [];
        safeSeq.forEach(pad => {
          if (pad.safePath && pad.safePath.segments) {
            segments.push(...pad.safePath.segments);
          }
        });
        setGeneratedPath({ segments });

        const stats = {
          totalPads: safeSeq.length,
          totalDistance: safeSeq.reduce((sum, pad) => sum + (pad.pathDistance || 0), 0).toFixed(3),
          estimatedTime: Math.ceil(safeSeq.length * 3 + safeSeq.reduce((sum, pad) => sum + (pad.pathDistance || 0), 0) / 50),
          averageDistance: safeSeq.length > 0 ? (safeSeq.reduce((sum, pad) => sum + (pad.pathDistance || 0), 0) / safeSeq.length).toFixed(3) : "0.000",
          safePathsUsed: safeSeq.filter(p => !p.requiresHighClearance).length,
          highClearancePaths: safeSeq.filter(p => p.requiresHighClearance).length
        };
        setJobStatistics(stats);
      } else {
        const sequence = dispensingSequencer.calculateOptimalSequence(refPoint, padsToUse, {
          nozzleDia: parseFloat(nozzleDia) || 0.8,
          enableMultiDot: true
        });
        setDispensingSequence(sequence);
        setSafeSequence([]);

        let segments = [];
        let curr = refPoint;
        sequence.forEach(pad => {
          segments.push({
            start: { x: curr.x, y: curr.y, z: 0 },
            end: { x: pad.x, y: pad.y, z: 0 },
            type: 'travel'
          });
          curr = pad;
        });
        setGeneratedPath({ segments });

        const stats = dispensingSequencer.calculateJobStatistics(refPoint, sequence);
        setJobStatistics(stats);
      }
    } else {
      setDispensingSequence([]);
      setSafeSequence([]);
      setJobStatistics(null);
    }
  }, [referencePoint, selectedOrigin, pads, selectedPadIndices, dispensingSequencer, safePathPlanner, useSafePathPlanning, boardOutline, componentHeights]);

  const getEventMm = (evt) => {
    const svgEl = getSvgEl(); if (!svgEl) return null;
    const geom = getSvgGeom(); if (!geom) return null;
    const pt = svgEl.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    const innerNode = svgEl.querySelector('g') || svgEl;
    const ctm = innerNode.getScreenCTM(); if (!ctm) return null;
    const local = pt.matrixTransform(ctm.inverse());

    // Y: inverse of the Y-flip applied in mmToCurrentUnits
    const mmY = (2 * geom.minY + geom.vbH - local.y) * geom.mmPerUnit;
    // X: inverse of the bottom X-mirror applied in mmToCurrentUnits
    const mmX = side === 'bottom'
      ? (2 * geom.minX + geom.vbW - local.x) * geom.mmPerUnit
      : local.x * geom.mmPerUnit;
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

      const distanceToCenter = Math.hypot(clickMm.x - pad.x, clickMm.y - pad.y);

      const withinBounds = clickMm.x >= pad.x - halfWidth &&
        clickMm.x <= pad.x + halfWidth &&
        clickMm.y >= pad.y - halfHeight &&
        clickMm.y <= pad.y + halfHeight;

      if (withinBounds && distanceToCenter < minDistance) {
        minDistance = distanceToCenter;
        bestMatch = {
          pad: i,
          pos: {
            x: pad.x,
            y: pad.y,
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

  const handleFiducialMouseDown = (e) => {
    if (!fidPickMode) return;

    const svgEl = getSvgEl();
    if (!svgEl) return;

    const mm = getEventMm(e); if (!mm) return;

    let targetId = null;
    let targetIsRail = false;
    let best = { id: null, d: Infinity, isRail: false };

    // Check local fiducials
    for (const f of fiducials) {
      if (!f.design) continue;
      const d = Math.hypot(f.design.x - mm.x, f.design.y - mm.y);
      if (d < best.d) best = { id: f.id, d, isRail: false };
    }

    // Check rail fiducials
    for (const f of panelRailFiducials) {
      if (!f.design) continue;
      const d = Math.hypot(f.design.x - mm.x, f.design.y - mm.y);
      if (d < best.d) best = { id: f.id, d, isRail: true };
    }

    if (best.d <= 2) {
      targetId = best.id;
      targetIsRail = best.isRail;
    } else if (fidActiveId) {
      targetId = fidActiveId;
      targetIsRail = panelRailFiducials.some(f => f.id === fidActiveId);
    }

    if (targetId) {
      if (targetIsRail) {
        setPanelRailFiducials(prev => prev.map(f => f.id === targetId ? { ...f, design: mm } : f));
      } else {
        setFiducials(prev => prev.map(f => f.id === targetId ? { ...f, design: mm } : f));
      }
      setDragFid(targetId);
    }
  };

  // Effect to handle global mouse move/up for dragging (local + rail fiducials)
  useEffect(() => {
    if (!fidPickMode) return;

    const onMove = (e) => {
      if (!dragFid) return;
      const mm = getEventMm(e); if (!mm) return;
      const isRail = panelRailFiducials.some(f => f.id === dragFid);
      if (isRail) {
        setPanelRailFiducials(prev => prev.map(f => f.id === dragFid ? { ...f, design: mm } : f));
      } else {
        setFiducials(prev => prev.map(f => f.id === dragFid ? { ...f, design: mm } : f));
      }
    };

    const onUp = () => setDragFid(null);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fidPickMode, dragFid, fiducials, panelRailFiducials, getSvgEl]);

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
      const prev = prevOriginLogRef.current;
      const hasChanged = !prev || Math.abs(prev.x - selectedOrigin.x) > 0.001 || Math.abs(prev.y - selectedOrigin.y) > 0.001;

      if (hasChanged) {
        console.log('Origin changed, updating overlay:', selectedOrigin);
        prevOriginLogRef.current = { ...selectedOrigin };
        setTimeout(() => updateOverlay(), 300);
      }
    }
  }, [selectedOrigin, updateOverlay]);

  const handleCanvasClick = useCallback((evt) => {
    if (fidPickMode) return;

    const mm = getEventMm(evt);
    if (!mm) return;

    const boundsSvg = getSvgEl();
    const geom = getSvgGeom();
    if (geom) {
      const widthMm = geom.vbW * geom.mmPerUnit;
      const heightMm = geom.vbH * geom.mmPerUnit;
      if (mm.x < 0 || mm.x > widthMm || mm.y < 0 || mm.y > heightMm) {
        console.log('Click outside board bounds ignored:', mm);
        return;
      }
    }

    const hit = isClickInsidePad(mm);

    if (!hit) {
      if (!multiSelectMode) {
        setSelectedMm(null);
        setSelectedPadIndices([]);
      }
      return;
    }

    if (multiSelectMode) {
      setSelectedPadIndices(prev => {
        if (prev.includes(hit.pad)) {
          return prev.filter(i => i !== hit.pad);
        } else {
          return [...prev, hit.pad];
        }
      });
      return;
    }

    // Clear previous multi-selection
    setSelectedPadIndices([hit.pad]);

    // Transform pad coordinates relative to origin
    const origin = selectedOrigin;
    let padCenter;

    if (origin) {
      padCenter = {
        x: hit.pos.x,
        y: hit.pos.y,
        centerValid: hit.pos.centerValid,
        centerMethod: hit.pos.centerMethod,
        originalPad: pads[hit.pad]
      };
      console.log('🔄 Coordinate selection:', {
        originalPad: { x: hit.pos.x, y: hit.pos.y },
        origin: { x: origin.x, y: origin.y },
        selectedMm: padCenter,
        note: 'Storing absolute coordinates for overlay. Distances calculated in UI.'
      });
    } else {
      padCenter = {
        x: hit.pos.x,
        y: hit.pos.y,
        centerValid: hit.pos.centerValid,
        centerMethod: hit.pos.centerMethod,
        originalPad: pads[hit.pad]
      };
    }

    console.log('Pad selection details:', {
      clickMm: mm,
      hitPad: hit.pad + 1,
      hitPos: hit.pos,
      padCenter,
      distanceToCenter: hit.distanceToCenter
    });

    if (!hit.pos.centerValid) {
      console.warn('Pad center calculation may be inaccurate:', hit.pos.centerMethod);
    }
    setSelectedMm(padCenter);

    const refPoint = referencePoint || selectedOrigin;
    let distInfo = "";
    if (refPoint) {
      const dx = padCenter.x - refPoint.x;
      const dy = padCenter.y - refPoint.y;
      const dist = Math.hypot(dx, dy);
      const refName = refPoint === selectedOrigin ? 'PCB Origin' : `Fiducial ${refPoint.id || ''}`;
      distInfo = `\n\nDistance from ${refName}: ${dist.toFixed(3)} mm (ΔX: ${dx.toFixed(2)}, ΔY: ${dy.toFixed(2)})`;
    }

    if (window.serial && window.serial.writeLine && xf && applyXf) {
      setTimeout(() => {
        const targetMachine = applyTransform(xf, padCenter);
        const move = window.confirm(
          `Pad Selected.${distInfo}\n\n` +
          `Drive camera perfectly to this pad now?\n` +
          `Machine Target: X${targetMachine.x.toFixed(3)} Y${targetMachine.y.toFixed(3)}`
        );

        if (move) {
          window.serial.writeLine(`G0 X${targetMachine.x.toFixed(3)} Y${targetMachine.y.toFixed(3)} F3000`);

          window.dispatchEvent(new CustomEvent('camera-auto-align-pad', {
            detail: { targetMachine, padCenter }
          }));
        }
      }, 50);
    }
  }, [
    fidPickMode,
    multiSelectMode,
    selectedOrigin,
    pads,
    getEventMm
  ]);

  const onInputMachine = (id, partial) => {
    setFiducials(prev => prev.map(f => f.id === id ? { ...f, machine: { x: (partial.x ?? f.machine?.x ?? null), y: (partial.y ?? f.machine?.y ?? null) } } : f));
  };
  const onClearMachine = (id) => setFiducials(prev => prev.map(f => f.id === id ? { ...f, machine: null } : f));
  const onClearOne = (id) => setFiducials(prev => prev.map(f => f.id === id ? { ...f, design: null, machine: null } : f));
  const onClearAll = () => { setFiducials(prev => prev.map(f => ({ ...f, design: null, machine: null }))); setXf(null); };

  // Auto-advance arm dropdown after each successful fiducial save.
  // Sequence: rail fiducials first (R1→R2→…), then local fiducials (F1→F2→…).
  // Skips slots that already have a machine coord; disarms when all are filled.
  const onAdvanceArmedFid = useCallback((justSavedId) => {
    setFidActiveId(currentId => {
      const sequence = [
        ...panelRailFiducials.map(f => ({ ...f, _isRail: true })),
        ...fiducials.map(f => ({ ...f, _isRail: false })),
      ];
      const justSavedIdx = sequence.findIndex(f => f.id === justSavedId);
      if (justSavedIdx === -1) return currentId;
      const nextFid = sequence.slice(justSavedIdx + 1).find(f => !f.machine);
      return nextFid ? nextFid.id : null;
    });
  }, [panelRailFiducials, fiducials]);

  const onSolve2 = () => {
    const P = fiducials.filter(f => f.design && f.machine);
    if (P.length < 2) return;
    const T = fitSimilarity(P.map(f => f.design), P.map(f => f.machine));
    setXf(T);
  };
  const onSolve3 = () => {
    const P = fiducials.filter(f => f.design && f.machine);
    if (P.length < 3) return;
    const T = P.length >= 4
      ? fitHomography(P.map(f => f.design), P.map(f => f.machine))
      : fitAffine(P.map(f => f.design), P.map(f => f.machine));
    setXf(T);
  };

  const onSolvePanelXf = () => {
    const P = panelRailFiducials.filter(f => f.design && f.machine);
    if (P.length < 2) return;
    const T = P.length >= 4
      ? fitHomography(P.map(f => f.design), P.map(f => f.machine))
      : P.length >= 3
        ? fitAffine(P.map(f => f.design), P.map(f => f.machine))
        : fitSimilarity(P.map(f => f.design), P.map(f => f.machine));
    setPanelXf(T);
  };

  // ── Auto-solve board transform once ALL detected fiducials have machine coords ──
  // Fires after each camera snap; only commits when every fiducial with a design
  // coord has also been detected (machine coord present).
  // Per user requirement: applyXf is enabled first, then the matrix is evaluated.
  useEffect(() => {
    const withDesign = fiducials.filter(f => f.design);
    if (withDesign.length < 2) return;                       // need at least 2 points
    if (!withDesign.every(f => f.machine)) return;           // not all detected yet — wait
    const T = withDesign.length >= 4
      ? fitHomography(withDesign.map(f => f.design), withDesign.map(f => f.machine))
      : withDesign.length >= 3
        ? fitAffine(withDesign.map(f => f.design), withDesign.map(f => f.machine))
        : fitSimilarity(withDesign.map(f => f.design), withDesign.map(f => f.machine));
    setApplyXf(true);  // check "Apply transform to output" first
    setXf(T);
    console.log(`[AutoSolve] Board transform computed (${withDesign.length} pts, applyXf enabled)`);
  }, [fiducials]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-solve panel rail transform once ALL rail fiducials have machine coords ──
  useEffect(() => {
    const withDesign = panelRailFiducials.filter(f => f.design);
    if (withDesign.length < 2) return;
    if (!withDesign.every(f => f.machine)) return;
    const T = withDesign.length >= 4
      ? fitHomography(withDesign.map(f => f.design), withDesign.map(f => f.machine))
      : withDesign.length >= 3
        ? fitAffine(withDesign.map(f => f.design), withDesign.map(f => f.machine))
        : fitSimilarity(withDesign.map(f => f.design), withDesign.map(f => f.machine));
    setPanelXf(T);
    console.log(`[AutoSolve] Panel rail transform computed (${withDesign.length} pts)`);
  }, [panelRailFiducials]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRedetectFiducials = () => {
    if (layers.length === 0) return;
    reinitSideState(side, layers);
  };

  const onAutoAlign = () => {
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

    const validFiducials = alignedFiducials.filter(f => f.design && f.machine);
    if (validFiducials.length === 1) {
      const T = fitTranslation(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
      setXf(T);
    } else if (validFiducials.length === 2) {
      const T = fitSimilarity(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
      setXf(T);
    } else if (validFiducials.length >= 4) {
      const T = fitHomography(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
      setXf(T);
    } else if (validFiducials.length >= 3) {
      const T = fitAffine(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
      setXf(T);
    }
  };

  const onAutoDetectCamera = async () => {
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
        design: fiducials[idx]?.design || null,
        machine: detected.machine,
        color: colors[idx % colors.length],
        confidence: detected.confidence,
        autoDetected: true
      }));

      while (updatedFiducials.length < 3) {
        updatedFiducials.push({
          id: `F${updatedFiducials.length + 1}`,
          design: null,
          machine: null,
          color: colors[updatedFiducials.length % colors.length]
        });
      }

      setFiducials(updatedFiducials);

      const validFiducials = updatedFiducials.filter(f => f.design && f.machine);
      if (validFiducials.length === 1) {
        const T = fitTranslation(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
        setXf(T);
      } else if (validFiducials.length === 2) {
        const T = fitSimilarity(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
        setXf(T);
      } else if (validFiducials.length >= 4) {
        const T = fitHomography(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
        setXf(T);
      } else if (validFiducials.length >= 3) {
        const T = fitAffine(validFiducials.map(f => f.design), validFiducials.map(f => f.machine));
        setXf(T);
      }
    };

    return () => {
      delete window.updateFiducialsFromCamera;
    };
  }, [fiducials]);

  // Workflow steps (replaces old componentNavItems)
  const workflowSteps = [
    { id: 'SerialPanel', num: '1', label: 'Connect', sub: 'Serial / Machine' },
    { id: 'Viewer', num: '2', label: 'Load PCB', sub: 'Gerber / Layers' },
    { id: 'JogPanel', num: '3', label: 'Jog', sub: 'Manual Positioning' },
    { id: 'FiducialPanel', num: '4', label: 'Fiducials', sub: 'Alignment & Solve' },
    { id: 'CameraPanel', num: '5', label: 'Camera', sub: 'Vision Servo' },
    { id: 'BedCalibration', num: '6', label: 'Calibrate', sub: 'Bed Leveling' },
    { id: 'AutomatedDispensingPanel', num: '7', label: 'Dispense', sub: 'Run Job' },
  ];

  // Step done heuristics
  const stepDone = (id) => {
    if (id === 'SerialPanel') return isSerialConnected;
    if (id === 'Viewer') return layers.length > 0;
    if (id === 'FiducialPanel') return fiducials.some(f => f.machine);
    return false;
  };

  const mPos = livePreview.machinePosition || machinePos || { x: 0, y: 0, z: 0 };

  return (
    <div id="root" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>

      {/* ── TOP HEADER BAR ─────────────────────────────────── */}
      <AppHeader
        mPos={mPos}
        isSerialConnected={isSerialConnected}
        isEmergencyStopped={isEmergencyStopped}
        onStop={triggerEmergencyStop}
        onReset={resetEmergencyStop}
      />

      {/* ── BODY: Sidebar + Content ─────────────────────────── */}
      <div className="app-body">
        <aside className="sidebar">

          {/* Workflow Steps */}
          <div className="sidebar-workflow">
            <div className="sidebar-section-label">Workflow</div>
            {workflowSteps.map((step, i) => (
              <div key={step.id}>
                <button
                  className={`step-btn ${activeComponent === step.id ? 'active' : ''} ${stepDone(step.id) ? 'done' : ''}`}
                  onClick={() => setActiveComponent(step.id)}
                >
                  {activeComponent === step.id && <span className="step-active-bar" />}
                  <span className="step-num">
                    {stepDone(step.id) ? '✓' : step.num}
                  </span>
                  <div>
                    <div className="step-label">{step.label}</div>
                    <div className="step-sublabel">{step.sub}</div>
                  </div>
                </button>
                {i < workflowSteps.length - 1 && <div className="workflow-step-connector" />}
              </div>
            ))}
          </div>

          {/* Scrollable controls area */}
          <div className="sidebar-controls">

            {/* File input (hidden) */}
            <input
              type="file"
              id="fileInput"
              multiple
              accept=".zip,.grb,.gbr,.cmp,.sol,.drd,.exc,.txt"
              onChange={pickFiles}
              className="d-none"
            />

            <div className="section">
              <h3>View Controls</h3>
              <div className="row">
                <button className={`btn ${side === 'top' ? 'active' : ''}`} onClick={() => changeSide("top")}>Top</button>
                <button className={`btn ${side === 'bottom' ? 'active' : ''}`} onClick={() => changeSide("bottom")}>Bottom</button>
              </div>

              <div style={{ marginTop: 8 }}>
                <select value={pasteIdx ?? ""} onChange={(e) => {
                  const idx = e.target.value === "" ? null : +e.target.value;
                  setPasteIdx(idx);
                  if (idx != null) {
                    const selectedLayer = layers[idx];
                    if (selectedLayer.type === "solderpaste") {
                      const padData = extractPadsMm(selectedLayer.text).map(padCenter);
                      setPads(processPads(padData));
                      console.log('Solderpaste layer loaded:', padData.length, 'pads');
                      if (selectedLayer.side === 'top') { changeSide('top', true); }
                      else if (selectedLayer.side === 'bottom') { changeSide('bottom', true); }
                    } else { setPads([]); }
                  } else setPads([]);
                  setSelectedMm(null);
                }}>
                  <option value="">(Select Paste Layer)</option>
                  {layers.map((l, i) => {
                    if (l.type === "solderpaste") {
                      return <option key={l.filename} value={i}>{l.filename} ({l.side})</option>;
                    }
                    return null;
                  })}
                </select>
              </div>
            </div>{/* end View Controls section */}

            <div className="section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <h3>Layers</h3>
              <LayerList layers={layers} layerData={layerData} onToggle={toggleLayer} />
            </div>


            <ToolOffsetCalibration
              toolOffset={maintenanceManager.getToolOffset()}
              setToolOffset={(o) => {
                maintenanceManager.setToolOffset(o);
                forceRender({});
              }}
              machinePosition={livePreview.machinePosition}
              isConnected={isSerialConnected}
              onAutoDetect={async () => {
                if (cameraPanelRef.current) {
                  return await cameraPanelRef.current.autoDetectTarget();
                }
                return false;
              }}
            />

            <div className="section">
              <h3>Components</h3>
              <ComponentList
                components={padDistances}
                onFocus={(pad) => {
                  setSelectedMm({ x: pad.x, y: pad.y, centerValid: pad.centerValid, centerMethod: pad.centerMethod, originalPad: pad });
                }}
                onItemClick={(pad, index) => {
                  if (multiSelectMode) {
                    setSelectedPadIndices(prev => {
                      const s = [...prev];
                      const ei = s.indexOf(index);
                      if (ei >= 0) s.splice(ei, 1); else s.push(index);
                      return s;
                    });
                  } else {
                    setSelectedPadIndices([index]);
                    setSelectedMm({ x: pad.x, y: pad.y, centerValid: pad.centerValid, centerMethod: pad.centerMethod, originalPad: pad });
                  }
                }}
                multiSelectMode={multiSelectMode}
                selectedIndices={selectedPadIndices}
              />
            </div>

            <div className="section">
              <h3>PCB Origin</h3>
              {selectedOrigin && (
                <div style={{ marginBottom: 8, padding: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 4, fontSize: '0.75rem' }}>
                  <strong style={{ color: 'var(--accent-primary)' }}>{selectedOrigin.description}</strong><br />
                  <span style={{ color: 'var(--text-secondary)' }}>Gerber: ({selectedOrigin.x.toFixed(1)}, {selectedOrigin.y.toFixed(1)}) mm</span>
                </div>
              )}
              <button className="btn primary" onClick={() => {
                if (!selectedOrigin) { alert("Please load a Gerber file first."); return; }
                if (!livePreview.machinePosition) { alert("Machine position unknown."); return; }
                const lmp = livePreview.machinePosition;
                const tOff = maintenanceManager.getToolOffset();
                setPcbOriginOffset({ x: -(lmp.x + (tOff?.dx || 0)), y: -(lmp.y + (tOff?.dy || 0)) });
              }} style={{ width: '100%', marginBottom: 6 }}>
                🎯 Set Camera Origin Here
              </button>
              <div className="flex-row">
                <button className="btn sm" style={{ flex: 1 }} onClick={onDetectOrigins} disabled={layers.length === 0}>Detect Origins</button>
                <button className="btn sm" style={{ flex: 1 }} onClick={() => { setSelectedOrigin(null); setPcbOriginOffset({ x: 0, y: 0 }); }}>Clear</button>
              </div>
            </div>

            <div className="section">
              <h3>Reference Point</h3>
              <div className="flex-row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <label><input type="radio" name="refType" checked={referenceType === 'origin'} onChange={() => { setReferenceType('origin'); setReferencePoint(null); }} /> Gerber Origin</label>
                  <label><input type="radio" name="refType" checked={referenceType === 'fiducial'} onChange={() => setReferenceType('fiducial')} /> Fiducial</label>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button className="btn sm" disabled={!isSerialConnected || (referenceType === 'fiducial' && !referencePoint)}
                    onClick={async () => {
                      let t = null;
                      if (referenceType === 'origin') {
                        if (applyXf && xf && selectedOrigin) t = applyTransform(xf, { x: selectedOrigin.x, y: selectedOrigin.y });
                        else if (pcbOriginOffset?.x || pcbOriginOffset?.y) t = { x: pcbOriginOffset.x, y: pcbOriginOffset.y };
                        else { alert("No PCB origin mapped."); return; }
                      } else if (referenceType === 'fiducial' && referencePoint) {
                        const fid = fiducials.find(f => f.id === referencePoint.id);
                        if (fid?.machine) t = { x: fid.machine.x, y: fid.machine.y };
                        else if (applyXf && xf && fid?.design) t = applyTransform(xf, { x: fid.design.x, y: fid.design.y });
                        else { alert(`Fiducial ${referencePoint.id} has no machine coordinate.`); return; }
                      }
                      if (t && confirm(`Move to X${t.x.toFixed(3)} Y${t.y.toFixed(3)}?`)) {
                        await window.serial?.writeLine(`G1 X${t.x.toFixed(3)} Y${t.y.toFixed(3)} F${speedSettings?.travelSpeed || 6000}`);
                      }
                    }}>Move To</button>
                  <button className="btn sm" disabled={!isSerialConnected}
                    onClick={async () => {
                      if (confirm("Set Work Zero (G92 X0 Y0)?")) {
                        const lmp = livePreview.machinePosition;
                        if (!lmp) { alert("Machine position unknown."); return; }
                        const shiftX = -lmp.x, shiftY = -lmp.y;
                        await window.serial.writeLine("G92 X0 Y0");
                        setPcbOriginOffset({ x: 0, y: 0 });
                        setFiducials(prev => prev.map(f => f.machine ? { ...f, machine: { x: f.machine.x + shiftX, y: f.machine.y + shiftY } } : f));
                        setXf(null); setApplyXf(false);
                        alert("Machine Zero Set!");
                      }
                    }}>Set Zero</button>
                </div>
              </div>
              {referenceType === 'fiducial' && (
                <select style={{ marginTop: 6 }} value={referencePoint?.id || ''} onChange={(e) => {
                  const fid = fiducials.find(f => f.id === e.target.value && f.design);
                  setReferencePoint(fid ? { x: fid.design.x, y: fid.design.y, id: fid.id } : null);
                }}>
                  <option value="">(select fiducial)</option>
                  {fiducials.filter(f => f.design).map(f => (
                    <option key={f.id} value={f.id}>{f.id} ({f.design.x.toFixed(2)}, {f.design.y.toFixed(2)})</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </aside>

        {/* ── MAIN CONTENT ───────────────────────────────────── */}
        <div className="main">

          {/* Breadcrumb strip */}
          <div className="breadcrumb-bar">
            <span className="breadcrumb-step">Workflow</span>
            <span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-step active">
              {workflowSteps.find(s => s.id === activeComponent)?.label ?? activeComponent}
            </span>
            <span className="breadcrumb-desc">
              {workflowSteps.find(s => s.id === activeComponent)?.sub}
            </span>
          </div>

          <div className="content-area">
            <div style={{ display: activeComponent === 'SerialPanel' ? 'block' : 'none', width: '100%', height: '100%' }}>
              <div className="panel full-height">
                <div className="panel-header">
                  <h3 className="panel-title">MACHINE CONTROL</h3>
                </div>
                <div style={{ padding: 12 }}>
                  <SerialPanel
                    isConnected={isSerialConnected}
                    onConnect={() => { handleSerialConnect(true); setIsHomed(false); }}
                    onDisconnect={() => { handleSerialDisconnect(); setIsHomed(false); }}
                    onHomingComplete={handleHomingComplete}
                    dispensingSequence={dispensingSequence}
                    jobStatistics={jobStatistics}
                    pressureSettings={pressureSettings}
                    speedSettings={speedSettings}
                    referencePoint={referencePoint}
                    selectedOrigin={effectiveOrigin}
                    fiducials={fiducials}
                    onInputMachine={onInputMachine}
                    onAutoAlign={onAutoAlign}
                    onSolve2={onSolve2}
                    onSolve3={onSolve3}
                    xf={xf}
                    applyXf={applyXf}
                    onJobStart={(gcode) => {
                      console.log('Dispensing job started via SerialPanel');
                      maintenanceManager.recordDispense();
                    }}
                    onJobComplete={() => {
                      console.log('Dispensing job completed');
                      alert('Dispensing job completed successfully!');
                    }}
                    onMachinePositionUpdate={handleMachinePositionUpdate}
                    machinePosition={machinePos}
                  />
                </div>
              </div>
            </div>

            <div style={{ display: activeComponent === 'JogPanel' ? 'block' : 'none', width: '100%', height: '100%' }}>
              <div className="panel">
                <div className="panel-header">
                  <h3 className="panel-title">MANUAL JOG</h3>
                </div>
                <div style={{ padding: 12 }}>
                  <JogPanel
                    isConnected={isSerialConnected}
                    machinePosition={livePreview.machinePosition}
                  />
                </div>
              </div>
            </div>

            <div style={{ display: activeComponent === 'Viewer' ? 'block' : 'none', width: '100%', height: '100%' }}>
              <div className="viewer-container">
                <Viewer
                  svg={svg}
                  side={side}
                  onClickSvg={handleCanvasClick}
                  onMouseDown={handleFiducialMouseDown}
                  multiSelectMode={multiSelectMode}
                  onToggleMultiSelect={() => {
                    if (!multiSelectMode) setSelectedMm(null);
                    setMultiSelectMode(prev => !prev);
                  }}
                  selectedCount={selectedPadIndices.length}
                  onOptimize={() => {
                    if (selectedPadIndices.length < 2) return;
                    const refPoint = referencePoint || effectiveOrigin || { x: 0, y: 0 };
                    const currentPads = selectedPadIndices.map(i => pads[i]);
                    const sortedPads = dispensingSequencer.calculateOptimalSequence(refPoint, currentPads, {
                      nozzleDia: parseFloat(nozzleDia) || 0.8,
                      enableMultiDot: true
                    });
                    const sortedIndices = sortedPads.map(p => pads.findIndex(orig => orig === p || (orig.x === p.x && orig.y === p.y)));
                    setSelectedPadIndices(sortedIndices);
                  }}
                  onClearPath={() => {
                    setSelectedPadIndices([]);
                    setMultiSelectMode(false);
                    setGeneratedPath(null);
                  }}
                  hasPath={selectedPadIndices.length > 0}
                  pickMode={fidPickMode}
                  onTogglePickMode={() => setFidPickMode(v => !v)}
                />

                {(referencePoint || effectiveOrigin) && selectedMm && (
                  <div className="distance-info">
                    <div className="row">
                      <span className="badge active">FROM: {referencePoint ? `FID ${referencePoint.id}` : 'ORIGIN'}</span>
                    </div>
                    <div className="kvs">
                      <span>DX: <span className="lcd-text">{(selectedMm.x - (referencePoint || effectiveOrigin).x).toFixed(3)}mm </span></span>
                      <span>DY: <span className="lcd-text">{(selectedMm.y - (referencePoint || effectiveOrigin).y).toFixed(3)}mm </span></span>
                      <span>DIST: <span className="lcd-text">{Math.hypot(selectedMm.x - (referencePoint || effectiveOrigin).x, selectedMm.y - (referencePoint || effectiveOrigin).y).toFixed(3)}mm</span></span>
                    </div>
                  </div>
                )}
                <label style={{ marginLeft: 8, fontSize: 12 }}>
                  <input type="checkbox" checked={showPasteDots} onChange={(e) => setShowPasteDots(e.target.checked)} />
                  Show Paste Dots
                </label>
              </div>
            </div>

            {
              maintenanceAlert && (
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
              )
            }

            <div style={{ display: activeComponent === 'FiducialPanel' ? 'block' : 'none', width: '100%', height: '100%' }}>
              {side === 'bottom' && (
                <div style={{ margin: '0 0 10px 0', padding: '8px 12px', background: 'rgba(255,152,0,0.12)', border: '1px solid #ff9800', borderRadius: 6, fontSize: '0.83em' }}>
                  <span style={{ color: '#ffb74d', fontWeight: 600 }}>⟳ Bottom Side</span>
                  <span style={{ color: '#90a4ae', marginLeft: 8 }}>SVG is X-mirrored. Click fiducials on the flipped view — design coords are stored in Gerber space and the transform will account for the mirror automatically.</span>
                </div>
              )}
              {panelInfo && (
                <div style={{ margin: '0 0 10px 0', padding: '8px 12px', background: 'rgba(56,139,253,0.1)', border: '1px solid #388bfd', borderRadius: 6, fontSize: '0.83em', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ color: '#79c0ff', fontWeight: 600 }}>
                    Panel: {panelInfo.dimX}×{panelInfo.dimY} grid ({panelBoards.length} boards) — step {panelInfo.stepX}×{panelInfo.stepY} mm
                  </span>
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
                  onClearMachine={onClearMachine}
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
                  alignmentInfo={alignment}
                  onCaptureAlignment={handleAlignmentCapture}
                  boardOutline={boardOutline}
                  panelBoards={panelBoards}
                  setPanelBoards={setPanelBoards}
                  activeBoardIndex={activeBoardIndexState}
                  setActiveBoardIndex={setActiveBoardIndex}
                  panelInfo={panelInfo}
                  panelRailFiducials={panelRailFiducials}
                  setPanelRailFiducials={setPanelRailFiducials}
                  panelXf={panelXf}
                  onSolvePanelXf={onSolvePanelXf}
                />
                {effectiveOrigin && selectedMm && xf && applyXf && (
                  <div style={{ padding: 8, background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: 4, marginTop: 8 }}>
                    <small><strong>Transform Verification:</strong></small>
                    <div style={{ fontSize: '0.8em', fontFamily: 'monospace' }}>
                      Origin: {effectiveOrigin.x.toFixed(3)}, {effectiveOrigin.y.toFixed(3)} → {verifyTransform(effectiveOrigin).x.toFixed(3)}, {verifyTransform(effectiveOrigin).y.toFixed(3)}
                    </div>
                    <div style={{ fontSize: '0.8em', fontFamily: 'monospace' }}>
                      Target: {selectedMm.x.toFixed(3)}, {selectedMm.y.toFixed(3)} → {verifyTransform(selectedMm).x.toFixed(3)}, {verifyTransform(selectedMm).y.toFixed(3)}
                    </div>
                  </div>
                )}
              </div>
              <button
                className="btn"
                onClick={goToPcbOrigin}
                disabled={!isSerialConnected || (!xf && !pcbOriginOffset)}
                title="Move nozzle to PCB Gerber Origin"
              >
                🎯 Go to PCB Origin
              </button>
            </div>

            <div style={{ display: activeComponent === 'CameraPanel' ? 'block' : 'none', width: '100%', height: '100%' }}>
              <CameraPanel
                ref={cameraPanelRef}
                fiducials={fiducials}
                xf={xf}
                applyXf={applyXf}
                selectedDesign={selectedOrigin ? selectedOrigin : (selectedMm ? { x: selectedMm.x, y: selectedMm.y } : null)}
                effectiveOrigin={effectiveOrigin}
                toolOffset={maintenanceManager.getToolOffset()}
                setToolOffset={(o) => maintenanceManager.setToolOffset(o)}
                pixelsPerMm={maintenanceManager.getPixelsPerMm()}
                setPixelsPerMm={(val) => {
                  maintenanceManager.setPixelsPerMm(val);
                  if (typeof forceRender === 'function') forceRender({});
                }}
                padDetector={padDetector}
                qualityController={qualityController}
                onCaptureAlignment={handleAlignmentCapture}
                alignmentInfo={alignment}
                machinePosition={livePreview.machinePosition}
                fiducialVisionDetector={fiducialVisionDetector}
                layerData={layerData}
                onUpdateFiducials={handleFiducialsUpdate}
                activeBoardName={panelBoards[activeBoardIndexState]?.name || 'Unknown Board'}
                panelBoards={panelBoards}
                setPanelBoards={setPanelBoards}
                pads={pads}
                gerberFiducials={fiducialDetectionResult || []}
                fidActiveId={fidActiveId}
                panelRailFiducials={panelRailFiducials}
                setPanelRailFiducials={setPanelRailFiducials}
                onAdvanceArmedFid={onAdvanceArmedFid}
                panelXf={panelXf}
                side={side}
                isJobRunning={isJobRunning}
              />
            </div>

            <div style={{ display: activeComponent === 'BedCalibration' ? 'block' : 'none', width: '100%', height: '100%' }}>
              <div className="panel">
                <div className="panel-header">
                  <h3 className="panel-title">PCB SURFACE LEVELING</h3>
                </div>
                <div style={{ padding: 12 }}>
                  <BedCalibrationPanel
                    machinePosition={livePreview.machinePosition || machinePos}
                    boardOutline={boardOutline}
                    xf={xf}
                    applyXf={applyXf}
                    isConnected={isSerialConnected}
                    onSetPcbOrigin={(machineOrigin) => {
                      setPcbOriginOffset({ x: -machineOrigin.x, y: -machineOrigin.y });
                      if (selectedOrigin) setSelectedOrigin(prev => prev ? { ...prev } : null);
                    }}
                  />
                </div>
              </div>
            </div>

            <div style={{ display: activeComponent === 'AutomatedDispensingPanel' ? 'block' : 'none', width: '100%', height: '100%' }}>
              <AutomatedDispensingPanel
                side={side}
                dispensingSequencer={dispensingSequencer}
                dispensingSequence={dispensingSequence}
                safeSequence={safeSequence}
                jobStatistics={jobStatistics}
                referencePoint={referencePoint}
                selectedOrigin={effectiveOrigin}
                pressureSettings={pressureSettings}
                speedSettings={speedSettings}
                boardOutline={boardOutline}
                useSafePathPlanning={useSafePathPlanning}
                setUseSafePathPlanning={setUseSafePathPlanning}
                toolOffset={maintenanceManager.getToolOffset()}
                componentHeights={componentHeights}
                setComponentHeights={setComponentHeights}
                fiducials={fiducials}
                onInputMachine={onInputMachine}
                onAutoAlign={onAutoAlign}
                onSolve2={onSolve2}
                onSolve3={onSolve3}
                panelBoards={panelBoards}
                setPanelBoards={setPanelBoards}
                activeBoardIndex={activeBoardIndexState}
                setActiveBoardIndex={setActiveBoardIndex}
                panelInfo={panelInfo}
                panelXf={panelXf}
                xf={xf}
                applyXf={applyXf}
                isConnected={isSerialConnected}
                isHomed={isHomed}
                machinePosition={machinePos}
                onStartJob={(gcode, mode) => {
                  setIsJobRunning(true);
                  maintenanceManager.recordDispense();
                }}
                onDownloadGCode={(gcode) => {
                  const blob = new Blob([gcode.join('\n')], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `dispensing-${Date.now()}.gcode`;
                  a.click();
                }}
                onJobComplete={() => {
                  setIsJobRunning(false);
                }}
                layerData={layerData}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
