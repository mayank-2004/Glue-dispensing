import { useState } from "react";
import JSZip from "jszip";
import { identifyLayers } from "../lib/gerber/identifyLayers.js";
import { stackupToSvg } from "../lib/gerber/stackupToSvg.js";
import { extractPadsMm, extractPadsWithPanel } from "../lib/gerber/extractPads.js";
import { analyzeFiducialsWithRails } from "../lib/gerber/fiducialDetection.js";
import { detectPcbOrigins } from "../lib/gerber/originDetection.js";
import { extractBoardOutline } from "../lib/gerber/boardOutline.js";
import { LayerDataExtractor } from "../lib/gerber/layerDataExtractor.js";

function padCenter(p) {
  if (typeof p.x === "number" && typeof p.y === "number") return p;
  return { ...p, x: 0, y: 0 };
}

function processPads(points) {
  return points.map((pad, idx) => ({
    ...pad,
    x: pad.x,
    y: pad.y,
    id: pad.componentIdentifier || `P${idx + 1}`,
    width: pad.width || 1,
    height: pad.height || 1,
    centerValid: typeof pad.x === "number",
    centerMethod: typeof pad.x === "number" ? 'gerber_flash_center' : 'fallback',
    originalPad: pad,
  }));
}

export function useGerberFiles() {
  const [layers, setLayers] = useState([]);
  const [side, setSide] = useState("top");
  const [svg, setSvg] = useState("");
  const [pads, setPads] = useState([]);
  const [pasteIdx, setPasteIdx] = useState(null);
  const [boardOutline, setBoardOutline] = useState(null);
  const [layerData, setLayerData] = useState({});

  const rebuild = async (nextLayers, s) => {
    const ssvg = await stackupToSvg(nextLayers, s);
    setSvg(ssvg);
    return ssvg;
  };

  const toggleLayer = async (idx, currentLayers, currentSide) => {
    const next = currentLayers.map((l, i) => (i === idx ? { ...l, enabled: !l.enabled } : l));
    setLayers(next);
    await rebuild(next, currentSide);
    return next;
  };

  const changeSide = async (s, currentLayers, skipPadSwitch = false) => {
    setSide(s);
    let newPads = null;
    let newPasteIdx = null;
    if (!skipPadSwitch) {
      const idx = currentLayers.findIndex(x => x.type === "solderpaste" && x.side === s);
      if (idx >= 0) {
        newPasteIdx = idx;
        newPads = processPads(extractPadsMm(currentLayers[idx].text).map(padCenter));
        setPasteIdx(idx);
        setPads(newPads);
      } else {
        setPasteIdx(null);
        setPads([]);
      }
    }
    await rebuild(currentLayers, s);
    return { newPads, newPasteIdx };
  };

  // Parses files and returns structured data; callers distribute to their own state setters.
  const parseFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    const zips = files.filter(f => /\.zip$/i.test(f.name));
    let expanded = files.filter(f => !/\.zip$/i.test(f.name));
    for (const zipFile of zips) {
      const zip = await JSZip.loadAsync(zipFile);
      for (const ent of Object.values(zip.files).filter(f => !f.dir)) {
        expanded.push(new File([await ent.async("text")], ent.name, { type: "text/plain" }));
      }
    }

    const read = await Promise.all(expanded.map(async f => ({ name: f.name, text: await f.text() })));
    const ls = identifyLayers(read);
    const extractedData = LayerDataExtractor.extractLayerData(ls);

    let detectedPanelGrid = null;
    let parsedPads = [];
    let parsedPasteIdx = null;
    let parsedSide = "top";

    let pi = ls.findIndex(x => x.type === "solderpaste" && x.side === "top");
    if (pi < 0) pi = ls.findIndex(x => x.type === "solderpaste");
    if (pi >= 0) {
      parsedPasteIdx = pi;
      const { pads: basePads, panel: panelGrid } = extractPadsWithPanel(ls[pi].text);
      detectedPanelGrid = panelGrid;
      parsedPads = processPads(basePads.map(padCenter));
      parsedSide = ls[pi].side === 'bottom' ? 'bottom' : 'top';
    }

    const { localFiducials: detectedFiducials, railFiducials: detectedRailFiducials } = analyzeFiducialsWithRails(ls);

    const unrecognized = read.filter(r => !ls.some(l => l.filename === r.name));
    if (unrecognized.length > 0) console.warn('Unrecognized files (skipped):', unrecognized.map(r => r.name));
    if (detectedFiducials.length > 0) {
      console.log(`%c✅ FIDUCIALS FOUND: ${detectedFiducials.length}`, 'color:#4ade80;font-weight:bold');
    } else {
      console.warn('❌ NO FIDUCIALS DETECTED');
    }

    let parsedOutline = null;
    const outlineLayer = ls.find(l =>
      l.filename.toLowerCase().includes('outline') || l.filename.toLowerCase().includes('edge')
    );
    if (outlineLayer) {
      parsedOutline = extractBoardOutline(outlineLayer.text) || null;
      if (parsedOutline) console.log(`PCB Board Size: ${parsedOutline.width}mm x ${parsedOutline.height}mm`);
    }

    const origins = detectPcbOrigins(ls);

    // Commit local state
    setLayers(ls);
    setLayerData(extractedData);
    setPads(parsedPads);
    setPasteIdx(parsedPasteIdx);
    setBoardOutline(parsedOutline);
    setSide(parsedSide);
    await rebuild(ls, parsedSide);

    return {
      layers: ls,
      layerData: extractedData,
      pads: parsedPads,
      pasteIdx: parsedPasteIdx,
      boardOutline: parsedOutline,
      side: parsedSide,
      detectedFiducials,
      detectedRailFiducials,
      detectedPanelGrid,
      origins,
    };
  };

  return {
    layers, setLayers,
    side, setSide,
    svg,
    pads, setPads,
    pasteIdx, setPasteIdx,
    boardOutline, setBoardOutline,
    layerData,
    rebuild,
    toggleLayer,
    changeSide,
    parseFiles,
  };
}
