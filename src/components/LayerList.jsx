import "./LayerList.css";

export default function LayerList({ layers, onToggle }) {
  const sideIcon = (s) => s === "top" ? "⬆" : s === "bottom" ? "⬇" : "↔";
  const typeEmoji = (t) => ({
    copper:"🟠", soldermask:"🟢", silkscreen:"⚪", solderpaste:"⚫", drill:"🕳", outline:"🟦", drawing:"📄"
  }[t] || "📄");

  return (
    <ul className="layer-list" style={{ marginLeft: 8 }}>
      {layers.map((l, idx)=>(
        <li key={l.filename}>
          <label title={l.filename}>
            <input type="checkbox" checked={l.enabled} onChange={()=>onToggle(idx)} />
            <span className="tags">{typeEmoji(l.type)} {sideIcon(l.side)}</span>
            <span>{l.filename}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}
