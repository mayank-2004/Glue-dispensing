import "./LayerList.css";

export default function LayerList({ layers, layerData, onToggle }) {
  const sideIcon = (s) => s === "top" ? "⬆" : s === "bottom" ? "⬇" : "↔";

  const getLayerColor = (type, side) => {
    if (side === 'bottom') {
      if (type === 'soldermask') return '#4b0082'; // Indigo
      if (type === 'copper') return '#008080'; // Teal
      if (type === 'silkscreen') return '#f0e68c'; // Khaki
      if (type === 'solderpaste') return '#cd853f'; // Peru
    } else {
      if (type === 'soldermask') return '#006400'; // Dark Green
      if (type === 'copper') return '#cc0000'; // Red
      if (type === 'silkscreen') return '#ffffff'; // White
      if (type === 'solderpaste') return '#a9a9a9'; // Dark Gray
    }
    return '#ccc'; // Default
  };

  return (
    <ul className="layer-list" style={{ marginLeft: 8 }}>
      {layers.map((l, idx) => (
        <li key={l.filename}>
          <label title={l.filename}>
            <input type="checkbox" checked={l.enabled} onChange={() => onToggle(idx)} />
            <span className="color-dot" style={{
              display: 'inline-block',
              width: 12, height: 12,
              backgroundColor: getLayerColor(l.type, l.side),
              borderRadius: '50%',
              marginRight: 6,
              border: l.type === 'silkscreen' && l.side !== 'bottom' ? '1px solid #ccc' : 'none'
            }} />
            <span className="tags">{sideIcon(l.side)}</span>
            <span>{l.filename.replace(/^.*[\\\/]/, '')}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}
