import { useEffect, useRef } from "react";
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

  useEffect(() => {
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      canvas.innerHTML = svg;

      const svgElement = canvas.querySelector("svg");
      if (svgElement) {
        svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svgElement.style.width = "100%";
        svgElement.style.height = "100%";
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

  const handleCanvasClick = (evt) => {
    if (onClickSvg) {
      onClickSvg(evt);
    }
  };

  return (
    <>
      <div className="viewer-toolbar">
        <button
          className={`zoom-btn ${multiSelectMode ? "on" : ""}`}
          onClick={onToggleMultiSelect}
          title={multiSelectMode ? "Exit selection mode" : "Select multiple pads"}
          style={{ marginLeft: 8, backgroundColor: multiSelectMode ? "rgba(234, 179, 8, 0.2)" : "", color: multiSelectMode ? "#facc15" : "", border: multiSelectMode ? "1px solid rgba(234, 179, 8, 0.4)" : "" }}
        >
          {multiSelectMode ? `✓ Done (${selectedCount})` : "Select Pads"}
        </button>
        {multiSelectMode && selectedCount > 1 && (
          <button
            className="zoom-btn"
            onClick={onOptimize}
            title="Reorder selected pads for shortest path"
            style={{ marginLeft: 8, backgroundColor: "rgba(34, 197, 94, 0.2)", color: "#4ade80", border: "1px solid rgba(34, 197, 94, 0.4)" }}
          >
            ⚡ Optimize Path
          </button>
        )}
        {hasPath && (
          <button
            className="zoom-btn"
            onClick={onClearPath}
            title="Clear current path and selection"
            style={{ marginLeft: 8, backgroundColor: "rgba(239, 68, 68, 0.2)", color: "#f87171", border: "1px solid rgba(239, 68, 68, 0.4)" }}
          >
            ✕ Clear Path
          </button>
        )}
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