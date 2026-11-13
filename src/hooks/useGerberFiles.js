import { useState } from "react";
import JSZip from "jszip";
import { identifyLayers } from "../lib/gerber/identifyLayers.js";
import { stackupToSvg } from "../lib/gerber/stackupToSvg.js";
import { extractPadsMm, extractPadsWithPanel } from "../lib/gerber/extractPads.js";
import { analyzeFiducialsWithRails } from "../lib/gerber/fiducialDetection.js";
import { detectPcbOrigins } from "../lib/gerber/originDetection.js";
import { extractBoardOutline } from "../lib/gerber/boardOutline.js";
import { LayerDataExtractor } from "../lib/gerber/layerDataExtractor.js";
import { parsePnpCsv } from "../lib/gerber/pnpParser.js";

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
  const [csvComponents, setCsvComponents] = useState([]);

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
        if (csvComponents.length > 0) {
          newPads = csvComponents.filter(c => c.side === s);
        } else {
          newPads = processPads(extractPadsMm(currentLayers[idx].text).map(padCenter));
        }
        setPasteIdx(idx);
        setPads(newPads);
      } else {
        if (csvComponents.length > 0) {
          newPads = csvComponents.filter(c => c.side === s);
          setPads(newPads);
        } else {
          setPasteIdx(null);
          setPads([]);
        }
      }
    }
    await rebuild(currentLayers, s);
    return { newPads, newPasteIdx };
  };

  // Parses files and returns structured data; callers distribute to their own state setters.
  const parseFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return null;

    // Yield control so any UI updates / loading toasts render immediately
    await new Promise(resolve => setTimeout(resolve, 10));

    const read = [];
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        const zip = await JSZip.loadAsync(f);
        const entries = Object.values(zip.files).filter(ent => !ent.dir && !ent.name.startsWith('__MACOSX/'));
        for (const ent of entries) {
          const text = await ent.async("text");
          read.push({ name: ent.name, text });
        }
      } else {
        read.push({ name: f.name, text: await f.text() });
      }
    }

    // Separate PnP/CSV files from Gerber layers
    const csvFiles = read.filter(f => /\.(csv)$/i.test(f.name));
    const gerberFiles = read.filter(f => !/\.(csv|txt)$/i.test(f.name));

    const ls = identifyLayers(gerberFiles);
    const extractedData = LayerDataExtractor.extractLayerData(ls);

    let detectedPanelGrid = null;
    let parsedPads = [];
    let parsedPasteIdx = null;
    let parsedSide = "top";
    let loadedCsvComponents = [];

    if (csvFiles.length > 0) {
      const csvText = csvFiles[0].text;
      loadedCsvComponents = parsePnpCsv(csvText);
      if (loadedCsvComponents.length > 0) {
        console.log(`PnP Parser: Extracted ${loadedCsvComponents.length} components from CSV.`);
      }
    }

    let pi = ls.findIndex(x => x.type === "solderpaste" && x.side === "top");
    if (pi < 0) pi = ls.findIndex(x => x.type === "solderpaste");
    if (pi >= 0) {
      parsedPasteIdx = pi;
      const { pads: basePads, panel: panelGrid } = extractPadsWithPanel(ls[pi].text);
      detectedPanelGrid = panelGrid;
      parsedSide = ls[pi].side === 'bottom' ? 'bottom' : 'top';
      
      if (loadedCsvComponents.length > 0) {
        parsedPads = loadedCsvComponents.filter(c => c.side === parsedSide);
      } else {
        parsedPads = processPads(basePads.map(padCenter));
      }
    } else if (loadedCsvComponents.length > 0) {
      parsedSide = 'top';
      parsedPads = loadedCsvComponents.filter(c => c.side === parsedSide);
    } else {
      // Fallback: If no solderpaste layer, extract pads from copper layer
      let cuIdx = ls.findIndex(x => x.type === "copper" && x.side === "top");
      if (cuIdx < 0) cuIdx = ls.findIndex(x => x.type === "copper");
      if (cuIdx >= 0) {
        const { pads: basePads, panel: panelGrid } = extractPadsWithPanel(ls[cuIdx].text);
        detectedPanelGrid = panelGrid;
        parsedSide = ls[cuIdx].side === 'bottom' ? 'bottom' : 'top';
        parsedPads = processPads(basePads.map(padCenter));
      }
    }

    // Yield control before fiducials
    await new Promise(resolve => setTimeout(resolve, 0));

    const { localFiducials: detectedFiducials, railFiducials: detectedRailFiducials } = analyzeFiducialsWithRails(ls, parsedSide, parsedPads);

    const unrecognized = read.filter(r => !ls.some(l => l.filename === r.name));
    if (unrecognized.length > 0) console.warn('Unrecognized files (skipped):', unrecognized.map(r => r.name));

    let parsedOutline = null;
    const outlineLayer = ls.find(l =>
      l.filename.toLowerCase().includes('outline') || l.filename.toLowerCase().includes('edge')
    );
    if (outlineLayer) {
      parsedOutline = extractBoardOutline(outlineLayer.text) || null;
      if (parsedOutline) console.log(`PCB Board Size: ${parsedOutline.width}mm x ${parsedOutline.height}mm`);
    }

    const origins = detectPcbOrigins(ls);

    // Commit local state so UI updates immediately
    setLayers(ls);
    setLayerData(extractedData);
    setCsvComponents(loadedCsvComponents);
    setPads(parsedPads);
    setPasteIdx(parsedPasteIdx);
    setBoardOutline(parsedOutline);
    setSide(parsedSide);

    // Yield control before heavy SVG generation
    await new Promise(resolve => setTimeout(resolve, 10));
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
