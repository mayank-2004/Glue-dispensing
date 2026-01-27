import "./ComponentList.css";

export default function ComponentList({ components, onFocus }) {
  return (
    <div className="card components">
      {components.length === 0 ? (
        <div>No components inferred yet.</div>
      ) : (
        <ul className="comp-list">
          {components.map((c, i) => (
            <li key={i} className="comp-item">
              <div className="comp-meta">
                <span className="comp-name">
                  {c.id || `Comp #${i + 1}`}
                  {c.source && (
                    <small style={{ marginLeft: 4, color: '#666' }}>
                      ({c.source === 'combined' ? '📍+🎯' : 
                        c.source === 'soldermask' ? '📍' : 
                        c.source === 'solderpaste' ? '🎯' : c.source})
                    </small>
                  )}
                </span>
                {c.distance !== undefined && (
                  <span className="comp-distance">{c.distance.toFixed(2)} mm</span>
                )}
                {c.needsPaste === false && (
                  <small style={{ color: '#999' }}>No paste</small>
                )}
                {c.pasteOrder && (
                  <small style={{ color: '#007bff' }}>Order: {c.pasteOrder}</small>
                )}
              </div>

              <div className="comp-actions">
                <button className="btn secondary" onClick={() => onFocus(c)}>
                  Focus
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
