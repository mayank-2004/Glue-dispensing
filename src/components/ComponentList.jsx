import "./ComponentList.css";

export default function ComponentList({ components, onFocus, onItemClick, multiSelectMode, selectedIndices }) {
  return (
    <div className="card components">
      {components.length === 0 ? (
        <div>No components inferred yet.</div>
      ) : (
        <ul className="comp-list">
          {components.map((c, i) => {
            const isSelected = selectedIndices?.includes(i);
            return (
              <li
                key={i}
                className={`comp-item ${isSelected ? 'selected' : ''}`}
                onClick={() => onItemClick && onItemClick(c, i)}
                style={{ cursor: 'pointer' }}
              >
                <div className="comp-meta">
                  {multiSelectMode && (
                    <div style={{ marginRight: 8, display: 'flex', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        style={{ width: 16, height: 16, cursor: 'pointer' }}
                      />
                    </div>
                  )}
                  <span className="comp-name">
                    {c.id || `Comp #${i + 1}`}
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
                  <button
                    className="btn secondary"
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent row click
                      onFocus(c);
                    }}
                  >
                    Focus
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
