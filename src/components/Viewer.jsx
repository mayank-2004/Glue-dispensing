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
  onZoomOut
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (canvasRef.current) {
      const canvas = canvasRef.current;
      canvas.innerHTML = svg;
      console.log("SVG updated", svg);

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
    <div className={`viewer ${zoomEnabled ? "zoom-enabled" : ""} ${isZoomed ? "zoomed" : ""}`}>
      <div className="viewer-toolbar">
        {!isZoomed ? (
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
        )}
      </div>

      <div
        ref={canvasRef}
        className={`canvas ${zoomEnabled && !isZoomed ? "zoom-mode" : ""}`}
        onClick={handleCanvasClick}
        style={{
          cursor: zoomEnabled && !isZoomed ? "zoom-in" : "default"
        }}
      />
    </div>
  );
}