import { useEffect, useRef, useState } from "react";
import "./Viewer.css";

export default function Viewer({
  svg,
  // mirrorBottom, // Removed
  side,
  onClickSvg,
  onMouseDown,
  multiSelectMode,
  onToggleMultiSelect,
  selectedCount,
  onOptimize,
  onClearPath,
  hasPath
}) {
  const canvasRef = useRef(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  // Initialize SVG content
  useEffect(() => {
    if (canvasRef.current && svg) {
      const canvas = canvasRef.current;
      canvas.innerHTML = svg;

      const svgElement = canvas.querySelector("svg");
      if (svgElement) {
        svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svgElement.style.objectFit = "contain";
        // Apply mirror transformation if needed
        // User requested removal of mirrorBottom
        // if (mirrorBottom && side === "bottom") {
        //   svgElement.style.transform = "scaleX(-1)";
        // } else {
        svgElement.style.transform = "";
        // }
      }
    }
  }, [svg, side]);

  // Update SVG size when zoom changes
  useEffect(() => {
    if (canvasRef.current) {
      const svgElement = canvasRef.current.querySelector("svg");
      if (svgElement) {
        svgElement.style.width = `${zoomLevel * 100}%`;
        svgElement.style.height = `${zoomLevel * 100}%`;
      }
    }
  }, [zoomLevel, svg]); // Re-apply if SVG or zoom changes

  const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 1, 4));
  const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 1, 1));

  const handleCanvasClick = (evt) => {
    if (onClickSvg) {
      onClickSvg(evt);
    }
  };

  return (
    <>
      <div className="viewer-toolbar">
        <div className="viewer-zoom">
          <div className="viewer-btn-group">
            <button
              className={`viewer-btn ${multiSelectMode ? "active" : ""}`}
              onClick={onToggleMultiSelect}
              title={multiSelectMode ? "Exit selection mode" : "Select multiple pads"}
            >
              {multiSelectMode ? `✓ Done (${selectedCount})` : "Select Multiple Pads"}
            </button>

            {multiSelectMode && selectedCount > 1 && (
              <button
                className="viewer-btn"
                onClick={onOptimize}
                title="Reorder selected pads for shortest path"
                style={{ color: '#4ade80' }}
              >
                ⚡ Optimize
              </button>
            )}

            {multiSelectMode && hasPath && (
              <button
                className="viewer-btn"
                onClick={onClearPath}
                title="Clear current path and selection"
                style={{ color: '#f87171' }}
              >
                ✕ Clear
              </button>
            )}
          </div>
          <div className="viewer-btn-group">
            <div style={{ fontWeight: 'bold', fontSize: '14px', color: '#fff', paddingRight: '10px', borderRight: '1px solid var(--border-secondary)' }}>Zoom</div>
            <button
              className="viewer-btn"
              onClick={handleZoomOut}
              disabled={zoomLevel <= 1}
              title="Zoom Out"
            >
              -
            </button>
            <div className="viewer-readout" style={{ color: '#fff' }}>
              {zoomLevel}x
            </div>
            <button
              className="viewer-btn"
              onClick={handleZoomIn}
              disabled={zoomLevel >= 4}
              title="Zoom In"
            >
              +
            </button>
          </div>
        </div>
      </div>
      <div className="viewer">
        <div
          ref={canvasRef}
          className="canvas"
          onClick={handleCanvasClick}
          onMouseDown={onMouseDown}
        />
      </div>
    </>
  );
}