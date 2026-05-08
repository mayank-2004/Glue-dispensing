import { useEffect, useRef, useState } from "react";
import "./Viewer.css";

export default function Viewer({
  svg,
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
        // Apply mirror transformation for bottom view
        // if (side === "bottom") {
        //   svgElement.style.transform = "scaleX(-1)";
        // } else {
        //   svgElement.style.transform = "";
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

  const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 1, 6));
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
              disabled={zoomLevel >= 6}
              title="Zoom In"
            >
              +
            </button>
          </div>
        </div>
      </div>
      {/* <div className="viewer" style={{ position: 'relative' }}>
        {side === 'bottom' && (
          <div style={{
            position: 'absolute',
            top: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(239, 68, 68, 0.9)',
            color: '#fff',
            padding: '8px 20px',
            borderRadius: '20px',
            fontWeight: 'bold',
            letterSpacing: '1px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
            zIndex: 10,
            pointerEvents: 'none',
            fontSize: '1.2rem',
            border: '2px solid #ffb3b3'
          }}>
            ⚠️ BOTTOM VIEW (Mirrored) ⚠️
          </div>
        )}
      </div> */}
      <div
        ref={canvasRef}
        className="canvas"
        onClick={handleCanvasClick}
        onMouseDown={onMouseDown}
      />
    </>
  );
}