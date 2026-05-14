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

  // Fit SVG to canvas and apply zoom
  const applySvgSize = (svgEl, zoom) => {
    if (!svgEl) return;
    // At zoom 1× the SVG fills 100% of the canvas (CSS handles contain).
    // At higher zoom levels we scale it up so the user can scroll/inspect details.
    svgEl.style.width  = zoom === 1 ? '100%' : `${zoom * 100}%`;
    svgEl.style.height = zoom === 1 ? '100%' : `${zoom * 100}%`;
    svgEl.style.minWidth  = '';
    svgEl.style.minHeight = '';
  };

  // Initialize SVG content
  useEffect(() => {
    if (canvasRef.current && svg) {
      const canvas = canvasRef.current;
      canvas.innerHTML = svg;

      const svgEl = canvas.querySelector('svg');
      if (svgEl) {
        svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        applySvgSize(svgEl, zoomLevel);
      }
    }
  }, [svg, side]);

  const prevZoomRef = useRef(1);

  // Update size when zoom changes
  useEffect(() => {
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      const svgEl = canvas.querySelector('svg');
      if (svgEl) {
        const prevZoom = prevZoomRef.current;
        // Calculate the current vertical center point of the scroll view
        const centerScrollY = canvas.scrollTop + canvas.clientHeight / 2;
        const zoomRatio = zoomLevel / prevZoom;

        applySvgSize(svgEl, zoomLevel);

        // Adjust scroll position after layout updates to keep the zoom vertically centered
        requestAnimationFrame(() => {
          canvas.scrollTop = centerScrollY * zoomRatio - canvas.clientHeight / 2;
        });
      }
      prevZoomRef.current = zoomLevel;
    }
  }, [zoomLevel]);

  const handleZoomIn  = () => setZoomLevel(prev => Math.min(prev + 0.5, 8));
  const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 0.5, 0.5));
  const handleZoomReset = () => setZoomLevel(1);

  const handleCanvasClick = (evt) => {
    if (onClickSvg) {
      onClickSvg(evt);
    }
  };

  return (
    <div className="viewer">
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
              disabled={zoomLevel <= 0.5}
              title="Zoom Out"
            >
              -
            </button>
            <div className="viewer-readout" style={{ color: '#fff' }}>
              {zoomLevel === 1 ? 'Fit' : `${zoomLevel}x`}
            </div>
            <button
              className="viewer-btn"
              onClick={handleZoomIn}
              disabled={zoomLevel >= 8}
              title="Zoom In"
            >
              +
            </button>
            <button
              className="viewer-btn"
              onClick={handleZoomReset}
              title="Reset to fit"
              style={{ color: zoomLevel !== 1 ? '#00c8d7' : undefined }}
            >
              Fit
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
    </div>
  );
}