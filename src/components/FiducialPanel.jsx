import React from "react";
import "./FiducialPanel.css";

export default function FiducialPanel({
  fiducials,
  activeId,
  setActiveId,
  pickMode,
  togglePickMode,
  onInputMachine,
  onClearMachine,
  onClearOne,
  onClearAll,
  onSolve2,
  onSolve3,
  transformSummary,
  applyTransform,
  setApplyTransform,
  onRedetectFiducials,
  onAutoAlign,
  onAutoDetectCamera,
  panelBoards = [],
  setPanelBoards,
  activeBoardIndex = 0,
  setActiveBoardIndex,
  boardOutline,
  panelInfo = null,
  panelRailFiducials = [],
  setPanelRailFiducials,
  panelXf = null,
  onSolvePanelXf,
}) {
  const ready2 = fiducials.filter(f => f.design && f.machine).length >= 2;
  const ready3 = fiducials.filter(f => f.design && f.machine).length >= 3;

  return (
    <div className="section">
      {/* Panel Size Calculation (Moved to Top) */}
      {(() => {
        let content;
        if (!boardOutline || !boardOutline.width || !boardOutline.height) {
          content = (
            <div style={{ fontSize: '0.9em', color: '#666', fontStyle: 'italic' }}>
              Waiting for Gerber board outline to compute true PCB size...
            </div>
          );
        } else {
          const width = boardOutline.width;
          const height = boardOutline.height;
          const diag = Math.hypot(width, height);

          content = (
            <div style={{ paddingBottom: 8 }}>
              <div className="flex-row" style={{ justifyContent: 'space-between', color: "black", display: "flex" }}>
                <span>W: <strong>{width.toFixed(2)} mm </strong></span>
                <span>H: <strong>{height.toFixed(2)} mm </strong></span>
                <span>Diag: <strong>{diag.toFixed(2)} mm</strong></span>
              </div>
            </div>
          );
        }

        return (
          <div className="info" style={{ marginBottom: 16, background: '#e3f2fd', border: '1px solid #90caf9' }}>
            <strong style={{ color: "black" }}>Detected PCB Size (Board Outline)</strong>
            {content}
          </div>
        );
      })()}

      {/* Alignment Capture Controls */}
      {/* {alignmentInfo && onCaptureAlignment && (
        <div className="box alignment-section" style={{ padding: 8, borderRadius: 8, marginBottom: 16, border: '1px solid #dee2e6', paddingTop: 8 }}>
          <legend style={{ fontSize: '0.9em', fontWeight: 'bold', marginBottom: 6 }}>Panel Alignment (Ref 1 & 2)</legend>
          <div className="flex-row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <button className={`btn sm ${alignmentInfo?.p1 ? 'secondary' : ''}`} onClick={() => onCaptureAlignment(1)}>
              {alignmentInfo?.p1 ? '✓ Ref 1 (BL)' : 'Set Ref 1 (BL)'}
            </button>
            <button className={`btn sm ${alignmentInfo?.p2 ? 'secondary' : ''}`} onClick={() => onCaptureAlignment(2)}>
              {alignmentInfo?.p2 ? '✓ Ref 2 (TR)' : 'Set Ref 2 (TR)'}
            </button>
          </div>
          <div style={{ fontSize: '0.8em', color: '#666' }}>
            <div>Ref 1: {alignmentInfo.p1 ? `${alignmentInfo.p1.x.toFixed(1)}, ${alignmentInfo.p1.y.toFixed(1)}` : '-'}</div>
            <div>Ref 2: {alignmentInfo.p2 ? `${alignmentInfo.p2.x.toFixed(1)}, ${alignmentInfo.p2.y.toFixed(1)}` : '-'}</div>
            {alignmentInfo.transform && (
              <div style={{ color: '#28a745', marginTop: 4, fontWeight: 'bold' }}>
                Aligned! θ: {(alignmentInfo.transform.theta * 180 / Math.PI).toFixed(2)}°
              </div>
            )}
          </div>
        </div>
      )} */}

      {/* {detectionResult !== null && (
        <div className={`info ${detectionResult.length === 0 ? 'warning' : 'success'}`} style={{ marginBottom: 12 }}>
          {detectionResult.length > 0 ? (
            <div>
              <strong>✓ Auto-detected {detectionResult.length} fiducial{detectionResult.length > 1 ? 's' : ''}</strong>
              <div style={{ fontSize: '0.9em', marginTop: 4 }}>
                {detectionResult.map(fid =>
                  `${fid.id}: ${fid.x.toFixed(2)}, ${fid.y.toFixed(2)}mm (${Math.round(fid.confidence * 100)}%)`
                ).join(' • ')}
              </div>
            </div>
          ) : (
            <div>
              <strong>⚠ No fiducials detected</strong>
              <div style={{ fontSize: '0.9em', marginTop: 4 }}>
                Please manually place fiducials or ensure your Gerber files contain fiducial markers (typically 1-3mm circular pads)
              </div>
            </div>
          )}
        </div>
      )} */}

      <div className="flex-row" style={{ gap: 8, alignItems: "center", marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #ccc' }}>
        <strong>Mapping:</strong>
        <select
          value={activeBoardIndex}
          onChange={(e) => setActiveBoardIndex(parseInt(e.target.value))}
          style={{ padding: '6px 12px', minWidth: 120, fontSize: '1.1em' }}
        >
          {panelBoards.map((b, idx) => (
            <option key={b.id} value={idx}>{b.name}</option>
          ))}
        </select>
        <button
          className="btn sm"
          onClick={() => {
            setPanelBoards(prev => {
              const newBoards = [...prev];
              const activeBoard = { ...newBoards[activeBoardIndex] };
              const fCount = activeBoard.fiducials.length;
              const newFid = {
                id: `F${fCount + 1}`,
                design: null,
                machine: null,
                color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`
              };
              activeBoard.fiducials = [...activeBoard.fiducials, newFid];
              newBoards[activeBoardIndex] = activeBoard;
              return newBoards;
            });
          }}
        >
          + Add Fiducial
        </button>
      </div>

      <div className="flex-row" style={{ gap: 8, alignItems: "center", marginBottom: 8 }}>
        <button className={`btn ${pickMode ? "" : "secondary"}`} onClick={togglePickMode} style={{ whiteSpace: "nowrap" }}>
          {pickMode ? "Pick/Drag fiducials: ON" : "Pick/Drag fiducials"}
        </button>
        <select value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value || null)} style={{ minWidth: 150, flex: 1 }}>
          <option value="">(select to arm)</option>
          {fiducials.map(f => <option key={f.id} value={f.id}>{f.id}</option>)}
          {panelRailFiducials.length > 0 && (
            <>
              <option disabled>── Rail ──</option>
              {panelRailFiducials.map(f => <option key={f.id} value={f.id}>{f.id} (Rail)</option>)}
            </>
          )}
        </select>
      </div>

      <div className="flex-row" style={{ gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <button className="btn secondary" onClick={onClearAll}>Clear all</button>
        {onRedetectFiducials && (
          <button className="btn" onClick={onRedetectFiducials} title="Re-analyze Gerber files for fiducials">
            🔍 Re-detect
          </button>
        )}
        <button className="btn" onClick={onAutoAlign} title="Auto-align machine coordinates from design">
          🎯 Auto-align
        </button>
        {onAutoDetectCamera && (
          <button className="btn" onClick={onAutoDetectCamera} title="Detect fiducials using camera">
            📷 Camera Detect
          </button>
        )}
      </div>

      <div className="flex-row" style={{ marginBottom: 12 }}>
        <label className="flex-row" style={{ gap: 6, whiteSpace: "nowrap", cursor: "pointer" }}>
          <input type="checkbox" checked={applyTransform} onChange={(e) => setApplyTransform(e.target.checked)} />
          Apply transform to outputs
        </label>
      </div>

      <table className="kv small">
        <thead>
          <tr>
            <th>Fiducial</th>
            <th>Design (mm)</th>
            <th>Machine (mm)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fiducials.map(f => (
            <tr key={f.id}>
              <td>
                <span style={{ display: "inline-block", width: 10, height: 10, background: f.color, borderRadius: 4, marginRight: 6 }} />
                <strong>{f.id}</strong>{activeId === f.id ? " (armed)" : ""}
                {f.confidence && <span style={{ fontSize: '0.8em', color: '#666' }}> ({Math.round(f.confidence * 100)}%)</span>}
              </td>
              <td>
                {f.design ? `X ${f.design.x}, Y ${f.design.y}` : <em>— click/drag on PCB —</em>}
              </td>
              <td>
                <div className="flex-row" style={{ gap: 6, alignItems: 'center' }}>
                  <input className="in sm" placeholder="Mx"
                    value={f.machine?.x ?? ""} onChange={(e) => onInputMachine(f.id, { x: parseFloat(e.target.value), y: f.machine?.y })} />
                  <input className="in sm" placeholder="My"
                    value={f.machine?.y ?? ""} onChange={(e) => onInputMachine(f.id, { x: f.machine?.x, y: parseFloat(e.target.value) })} />
                  {f.machine && onClearMachine && (
                    <button 
                      className="btn icon-btn" 
                      style={{ padding: '0px 6px', fontSize: '16px', background: 'transparent', border: 'none', color: '#ff4d4f', cursor: 'pointer', lineHeight: 1 }}
                      title="Clear Machine Coordinates" 
                      onClick={() => onClearMachine(f.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </td>
              <td><button className="btn secondary" onClick={() => onClearOne(f.id)}>Clear</button></td>  
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex-row" style={{ gap: 8 }}>
        <button className="btn" disabled={!ready2} onClick={onSolve2}>Solve (2-pt similarity)</button>
        <button className="btn secondary" disabled={!ready3} onClick={onSolve3}>Solve (3-pt affine)</button>
      </div>

      {transformSummary && (
        <div className="info" style={{ marginTop: 8 }}>
          <div><strong>Transform</strong>: {transformSummary.type}</div>
          {"thetaDeg" in transformSummary && <div>Rotation: {transformSummary.thetaDeg.toFixed(3)}°</div>}
          {"scale" in transformSummary && <div>Scale: {transformSummary.scale.toFixed(6)}×</div>}
          <div>tx: {(transformSummary.tx ?? 0).toFixed(3)} mm, ty: {(transformSummary.ty ?? 0).toFixed(3)} mm</div>
          {"rms" in transformSummary && <div>RMS error: {transformSummary.rms.toFixed(3)} mm</div>}
        </div>
      )}

      {/* Panel Rail Fiducials — shown whenever rail fiducials exist or a panel grid is detected */}
      {(panelRailFiducials.length > 0 || panelInfo) && (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #ff9800' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ color: '#ff9800', fontSize: '0.95em' }}>◆ Panel Rail Fiducials</strong>
            <span style={{ fontSize: '0.75em', color: '#888', fontStyle: 'italic' }}>global panel alignment</span>
          </div>

          <div style={{ fontSize: '0.82em', color: '#666', marginBottom: 10, padding: '6px 10px', background: '#fff8e1', border: '1px solid #ffe082', borderRadius: 4 }}>
            Rail fiducials align the <strong>entire panel</strong> to machine space. Measuring them once
            lets all boards dispense correctly without per-board fiducial capture.
            {panelXf && <span style={{ color: '#388e3c', fontWeight: 600 }}> ✓ Panel transform solved.</span>}
          </div>

          {panelRailFiducials.length === 0 ? (
            <div style={{ fontSize: '0.82em', color: '#aaa', fontStyle: 'italic', marginBottom: 8 }}>
              No rail fiducials detected from Gerber. Add them manually if your panel has rail marks.
              <button
                className="btn sm"
                style={{ marginLeft: 8 }}
                onClick={() => setPanelRailFiducials(prev => [
                  ...prev,
                  { id: `R${prev.length + 1}`, design: null, machine: null, color: '#ff9800', isRail: true }
                ])}
              >+ Add Rail Fiducial</button>
            </div>
          ) : (
            <>
              <table className="kv small" style={{ marginBottom: 8 }}>
                <thead>
                  <tr>
                    <th>Rail Fid</th>
                    <th>Design (mm)</th>
                    <th>Machine (mm)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {panelRailFiducials.map((f, idx) => (
                    <tr key={f.id}>
                      <td>
                        <span style={{ display: 'inline-block', width: 10, height: 10, background: f.color || '#ff9800', borderRadius: 2, marginRight: 6, transform: 'rotate(45deg)' }} />
                        <strong style={{ color: '#ff9800' }}>{f.id}</strong>
                      </td>
                      <td style={{ fontSize: '0.85em' }}>
                        {f.design ? `X ${f.design.x.toFixed(3)}, Y ${f.design.y.toFixed(3)}` : <em style={{ color: '#aaa' }}>— not set —</em>}
                      </td>
                      <td>
                        <div className="flex-row" style={{ gap: 6, alignItems: 'center' }}>
                          <input className="in sm" placeholder="Mx"
                            value={f.machine?.x ?? ''}
                            onChange={e => setPanelRailFiducials(prev => prev.map((r, i) => i === idx ? { ...r, machine: { x: parseFloat(e.target.value), y: r.machine?.y } } : r))}
                          />
                          <input className="in sm" placeholder="My"
                            value={f.machine?.y ?? ''}
                            onChange={e => setPanelRailFiducials(prev => prev.map((r, i) => i === idx ? { ...r, machine: { x: r.machine?.x, y: parseFloat(e.target.value) } } : r))}
                          />
                          {f.machine && (
                            <button className="btn icon-btn" style={{ padding: '0 6px', fontSize: 16, background: 'transparent', border: 'none', color: '#ff4d4f', cursor: 'pointer' }}
                              onClick={() => setPanelRailFiducials(prev => prev.map((r, i) => i === idx ? { ...r, machine: null } : r))}>×</button>
                          )}
                        </div>
                      </td>
                      <td>
                        <button className="btn secondary" style={{ fontSize: '0.8em' }}
                          onClick={() => setPanelRailFiducials(prev => prev.filter((_, i) => i !== idx))}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn"
                  style={{ background: '#ff9800', borderColor: '#ff9800' }}
                  disabled={panelRailFiducials.filter(f => f.design && f.machine).length < 2}
                  onClick={onSolvePanelXf}
                >
                  ◆ Solve Panel Transform
                </button>
                <button className="btn secondary" style={{ fontSize: '0.82em' }}
                  onClick={() => setPanelRailFiducials(prev => [
                    ...prev,
                    { id: `R${prev.length + 1}`, design: null, machine: null, color: '#ff9800', isRail: true }
                  ])}>+ Add</button>
              </div>

              {panelXf && (
                <div className="info" style={{ marginTop: 8, borderLeft: '3px solid #ff9800' }}>
                  <div><strong>Panel Transform</strong>: {panelXf.type}</div>
                  <div style={{ fontSize: '0.85em' }}>tx: {panelXf.tx.toFixed(3)} mm, ty: {panelXf.ty.toFixed(3)} mm</div>
                  {'scale' in panelXf && <div style={{ fontSize: '0.85em' }}>Scale: {panelXf.scale.toFixed(5)}×</div>}
                  {'theta' in panelXf && <div style={{ fontSize: '0.85em' }}>Rotation: {(panelXf.theta * 180 / Math.PI).toFixed(3)}°</div>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
