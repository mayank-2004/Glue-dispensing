import { useMemo, useState } from "react";
import "./MotionPanel.css";
import { defaultAxisMap, defaultFeeds, header, home, setWorkZero, moveAbs, jogRel } from "../lib/motion/gcode.js";

export default function MotionPanel({ onSendLines }) {
  const [axisMap, setAxisMap] = useState(defaultAxisMap);
  const [feeds, setFeeds] = useState(defaultFeeds);

  const [abs, setAbs] = useState({ x: 0, y: 0, z: 0, r: 0 });
  const [step, setStep] = useState({ xy: 1, z: 0.2, r: 5 });
  const [feed, setFeed] = useState(1500);

  const canSend = typeof onSendLines === "function";

  const kbd = useMemo(() => ({
    jogX: (s) => onSend(move(jogRel({ dx: +s, feed }, axisMap))),
    jogY: (s) => onSend(move(jogRel({ dy: +s, feed }, axisMap))),
    jogZ: (s) => onSend(move(jogRel({ dz: +s, feed: Math.min(feed, feeds.work.Z) }, axisMap))),
    jogR: (s) => onSend(move(jogRel({ dr: +s, feed: Math.min(feed, feeds.work.R) }, axisMap))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [axisMap, feed, feeds]);

  function onSend(lines) {
    if (!lines?.length) return;
    if (canSend) {
      onSendLines(lines);
    } else {
      const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "motion.gcode";
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  function move(lines) {
    // prepend a clean header only if we suspect a fresh start (tiny heuristic)
    return [...header({ units: "mm", absolute: true }), ...lines];
  }

  return (
    <div className="section">
      <h3>Motion (XYZ + Rotation)</h3>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => onSend(move(home({ x:true,y:true,z:true, r:false }, axisMap)))}>Home X/Y/Z</button>
        <button className="btn secondary" onClick={() => onSend(setWorkZero({ x:0,y:0,z:0,r:0 }, axisMap))}>Set Work Zero (G92)</button>
      </div>

      <div className="grid-2" style={{ marginTop: 8 }}>
        <fieldset className="card">
          <legend>Jog</legend>
          <div className="row wrap" style={{ gap: 8 }}>
            <label>Step XY
              <input className="in sm" type="number" step="0.1" value={step.xy}
                     onChange={(e)=>setStep(s=>({...s, xy:+e.target.value||0}))}/>
            </label>
            <label>Step Z
              <input className="in sm" type="number" step="0.05" value={step.z}
                     onChange={(e)=>setStep(s=>({...s, z:+e.target.value||0}))}/>
            </label>
            <label>Step R (deg)
              <input className="in sm" type="number" step="1" value={step.r}
                     onChange={(e)=>setStep(s=>({...s, r:+e.target.value||0}))}/>
            </label>
            <label>Feed (mm/min)
              <input className="in sm" type="number" step="10" value={feed}
                     onChange={(e)=>setFeed(+e.target.value||0)}/>
            </label>
          </div>

          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            <button className="btn" onClick={()=>kbd.jogY(+step.xy)}>+Y</button>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={()=>kbd.jogX(-step.xy)}>-X</button>
              <button className="btn" onClick={()=>kbd.jogX(+step.xy)}>+X</button>
            </div>
            <button className="btn" onClick={()=>kbd.jogY(-step.xy)}>-Y</button>
          </div>

          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button className="btn" onClick={()=>kbd.jogZ(+step.z)}>+Z</button>
            <button className="btn" onClick={()=>kbd.jogZ(-step.z)}>-Z</button>
            <button className="btn" onClick={()=>kbd.jogR(+step.r)}>+R</button>
            <button className="btn" onClick={()=>kbd.jogR(-step.r)}>-R</button>
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Move (Absolute)</legend>
          <div className="row wrap" style={{ gap: 8 }}>
            <label>X <input className="in sm" type="number" step="0.01" value={abs.x} onChange={(e)=>setAbs({...abs, x:+e.target.value})}/></label>
            <label>Y <input className="in sm" type="number" step="0.01" value={abs.y} onChange={(e)=>setAbs({...abs, y:+e.target.value})}/></label>
            <label>Z <input className="in sm" type="number" step="0.01" value={abs.z} onChange={(e)=>setAbs({...abs, z:+e.target.value})}/></label>
            <label>R° <input className="in sm" type="number" step="0.1"  value={abs.r} onChange={(e)=>setAbs({...abs, r:+e.target.value})}/></label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <button className="btn" onClick={() => onSend(move(moveAbs({ ...abs, feed }, axisMap)))}>Go</button>
            {!canSend && <span className="muted">No serial detected: file will download instead.</span>}
          </div>
        </fieldset>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary>Axis Map (advanced)</summary>
        <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
          <label>Rot. Axis Letter
            <select className="in sm" value={axisMap.R}
                    onChange={(e)=>setAxisMap(a=>({...a, R: e.target.value}))}>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
              <option value="E">E (if using extruder channel)</option>
            </select>
          </label>
        </div>
      </details>
    </div>
  );
}
