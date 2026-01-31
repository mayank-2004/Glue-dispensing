import { useEffect, useRef } from "react";
import "./Viewer.css";

export default function Viewer({
  svg,
  mirrorBottom,
  side,
  onClickSvg,
  zoomEnabled,
  isZoomed,
  onToggleZoom,
  onZoomOut,
  onMouseDown,
  zoomViewBox,
  multiSelectMode,
  onToggleMultiSelect,
  selectedCount,
  onOptimize
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      canvas.innerHTML = svg;

      const svgElement = canvas.querySelector("svg");
      if (svgElement) {
        // Store original viewBox if not already stored or if SVG changed
        if (!svgElement.hasAttribute('data-original-viewbox')) {
          svgElement.setAttribute('data-original-viewbox', svgElement.getAttribute('viewBox') || '');
        }

        svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svgElement.style.width = "100%";
        svgElement.style.height = "100%";
        svgElement.style.objectFit = "contain";

        // Apply Zoom
        if (isZoomed && zoomViewBox) {
          svgElement.setAttribute('viewBox', zoomViewBox);
        } else {
          // Restore original if exists
          const orig = svgElement.getAttribute('data-original-viewbox');
          if (orig) svgElement.setAttribute('viewBox', orig);
        }

        // Apply mirror transformation if needed
        if (mirrorBottom && side === "bottom") {
          svgElement.style.transform = "scaleX(-1)";
        } else {
          svgElement.style.transform = "";
        }
      }
    }
  }, [svg, mirrorBottom, side, isZoomed, zoomViewBox]);

  const handleCanvasClick = (evt) => {
    if (onClickSvg) {
      onClickSvg(evt);
    }
  };

  return (
    <div className={`viewer ${zoomEnabled ? "zoom-enabled" : ""} ${isZoomed ? "zoomed" : ""}`}>
      <div className="viewer-toolbar">
        {/* {!isZoomed ? (
          <button
            className={`zoom-btn ${zoomEnabled ? "on" : ""}`}
            onClick={onToggleZoom}
            title={zoomEnabled ? "Exit zoom mode" : "Enter zoom mode"}
          >
            {zoomEnabled ? "🔍 ON" : "🔍 OFF"}
          </button>
        ) : (
          <button
            className="zoom-btn"
            onClick={onZoomOut}
            title="Zoom out to full view"
          >
            ⬅ Zoom Out
          </button>
        )} */}
        <button
          className={`zoom-btn ${multiSelectMode ? "on" : ""}`}
          onClick={onToggleMultiSelect}
          title={multiSelectMode ? "Exit selection mode" : "Select multiple pads"}
          style={{ marginLeft: 8, backgroundColor: multiSelectMode ? "#ff9800" : "" }}
        >
          {multiSelectMode ? `✓ Done (${selectedCount})` : "Select Pads"}
        </button>
        {multiSelectMode && selectedCount > 1 && (
          <button
            className="zoom-btn"
            onClick={onOptimize}
            title="Reorder selected pads for shortest path"
            style={{ marginLeft: 8, backgroundColor: "#28a745" }}
          >
            ⚡ Optimize Path
          </button>
        )}
      </div>

      <div
        ref={canvasRef}
        className={`canvas ${zoomEnabled && !isZoomed ? "zoom-mode" : ""}`}
        onClick={handleCanvasClick}
        onMouseDown={onMouseDown}
        style={{
          cursor: zoomEnabled && !isZoomed ? "zoom-in" : "default"
        }}
      />
    </div>
  );
}