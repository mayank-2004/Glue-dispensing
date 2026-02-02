import { useEffect, useRef } from "react";
import "./Viewer.css";

export default function Viewer({
  svg,
  mirrorBottom,
  side,
  onClickSvg,
  onMouseDown,
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
        svgElement.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svgElement.style.width = "100%";
        svgElement.style.height = "100%";
        svgElement.style.objectFit = "contain";

        // Apply mirror transformation if needed
        if (mirrorBottom && side === "bottom") {
          svgElement.style.transform = "scaleX(-1)";
        } else {
          svgElement.style.transform = "";
        }
      }
    }
  }, [svg, mirrorBottom, side]);

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