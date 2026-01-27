export function convertGerberToGcode(gerberText, opts = {}) {
  const cfg = {
    flavor: 'grbl',          // 'grbl' | 'marlin' | 'creality'
    units: 'auto',

    // GRBL:
    travelZ: 3.0,
    workZ: -0.02,
    feedXY: 600,
    feedZ: 300,
    toolOn: 'M3',
    toolOff: 'M5',

    // Marlin (simple viewer/paste):
    layerZ: 0.2,
    ePerMm: 0.04,

    // Creality/Cura-friendly FDM (viewer):
    crealityZ: 0.2,          // layer height we "draw" at
    crealityTravelZ: 0.8,    // lift for travels
    crealityFeedXY: 1500,    // mm/min
    crealityFeedZ: 600,      // mm/min
    crealityEPerMm: 0.05,    // fake extrusion so the viewer shows the path

    // Coordinate transformation
    transform: null,         // transformation matrix from design to machine coordinates
    applyTransform: false,   // whether to apply transformation

    ...opts
  };

  const fmt = (n, d = 3) => (isFinite(n) ? Number(n).toFixed(d) : "0");
  const IN2MM = 25.4;

  // --- Parse parameter blocks first (as in your original)
  const paramBlocks = [];
  gerberText.replace(/%[^%]*%/g, (m) => { paramBlocks.push(m); return ''; });

  let fileUnits = 'mm';
  let zeroSupp = 'L';
  let xInt = 2, xDec = 4, yInt = 2, yDec = 4;

  for (const block of paramBlocks) {
    const mo = block.match(/%MO(IN|MM)\*%/i);
    if (mo) fileUnits = mo[1].toLowerCase() === 'in' ? 'in' : 'mm';
    const fs = block.match(/%FS([LT])([AI])X(\d)(\d)Y(\d)(\d)\*%/i);
    if (fs) { zeroSupp = fs[1].toUpperCase(); xInt=+fs[3]; xDec=+fs[4]; yInt=+fs[5]; yDec=+fs[6]; }
  }

  // Ops (D-codes etc.)
  const opsText = gerberText.replace(/%[^%]*%/g, '');
  const tokens = opsText.split('*').map(s => s.trim()).filter(Boolean);

  // Final working units for output
  let units = (cfg.units === 'auto') ? fileUnits : cfg.units;

  // State shared by all flavors
  let curX = 0, curY = 0, currentD = null, interp = 'G01';
  const parseCoord = (val, i, d, z = zeroSupp) => {
    if (val.includes('.')) return parseFloat(val);
    let sign = 1;
    if (val.startsWith('+')) val = val.slice(1);
    if (val.startsWith('-')) { sign = -1; val = val.slice(1); }
    const total = i + d;
    let s = z === 'L' ? val.padStart(total, '0') : val.padEnd(total, '0');
    return sign * parseFloat(`${s.slice(0,i)}.${s.slice(i)}`);
  };
  const parseXYIJ = (t, last) => {
    const m = {};
    t.replace(/([XYIJ])([+\-]?\d+(?:\.\d+)?)?/gi, (_, k, v) => { m[k.toUpperCase()] = v || ''; return ''; });
    let x = last.x, y = last.y, i = null, j = null;
    if (m.X !== undefined) x = parseCoord(m.X, xInt, xDec);
    if (m.Y !== undefined) y = parseCoord(m.Y, yInt, yDec);
    if (m.I !== undefined && m.I !== '') i = parseCoord(m.I, xInt, xDec);
    if (m.J !== undefined && m.J !== '') j = parseCoord(m.J, yInt, yDec);
    return { x, y, i, j };
  };

  // Helpers to get mm and apply coordinate transformation
  const applyCoordTransform = (pt) => {
    if (!cfg.applyTransform || !cfg.transform) return pt;
    const { a, b, c, d, tx, ty } = cfg.transform;
    return { x: a * pt.x + b * pt.y + tx, y: c * pt.x + d * pt.y + ty };
  };
  
  const mmX = (x) => units === 'in' ? x * IN2MM : x;
  const mmY = (y) => units === 'in' ? y * IN2MM : y;
  const dmm = (x0,y0,x1,y1) => Math.hypot(mmX(x1)-mmX(x0), mmY(y1)-mmY(y0));

  // ============================================================
  // NEW: Creality/Cura-friendly FDM flavor (for Creality Print)
  // Builds simple polylines from D01 draws and emits an FDM file
  // with E extrusion so the slicer viewer accepts it.
  // ============================================================
  if (cfg.flavor === 'creality') {
    // Build polylines from Gerber draw ops (D01). D02 breaks polyline.
    const polylines = [];
    let current = [];
    let last = { x: curX, y: curY };

    const pushPoint = (px, py) => {
      let X = mmX(px), Y = mmY(py);
      const transformed = applyCoordTransform({ x: X, y: Y });
      X = transformed.x; Y = transformed.y;
      if (!current.length) current.push({ x: X, y: Y });
      current.push({ x: X, y: Y });
    };
    const breakPolyline = () => {
      if (current.length > 1) polylines.push(current);
      current = [];
    };

    for (let raw of tokens) {
      const t = raw.replace(/\s+/g,''); if (!t || /^G0?4/i.test(t)) continue;
      if (/^G70$/i.test(t)) { units='in'; continue; }
      if (/^G71$/i.test(t)) { units='mm'; continue; }
      if (/^G0?1$/i.test(t)) { interp='G01'; continue; }
      if (/^G0?2$/i.test(t)) { interp='G02'; continue; }
      if (/^G0?3$/i.test(t)) { interp='G03'; continue; }

      const md = t.match(/D0?([123])$/i);
      if (md) currentD = +md[1];

      if (/[XY]/i.test(t)) {
        const { x, y } = parseXYIJ(t, last);
        if (currentD === 2 || currentD == null) {
          // rapid move: break polyline and move
          breakPolyline();
          last = { x, y };
          continue;
        }
        if (currentD === 1) {
          // draw: add a segment to polyline
          pushPoint(last.x, last.y);
          pushPoint(x, y);
          last = { x, y };
          continue;
        }
        if (currentD === 3) {
          // flash: make a tiny "tick" so viewer shows something
          breakPolyline();
          let X = mmX(x), Y = mmY(y);
          const transformed = applyCoordTransform({ x: X, y: Y });
          X = transformed.x; Y = transformed.y;
          polylines.push([{ x: X, y: Y }, { x: X + 0.2, y: Y }]);
          last = { x, y };
          continue;
        }
      }
    }
    breakPolyline();

    // Header compatible with Cura/Creality viewers
    const crealityHeader = (bounds) => {
      const { minX, minY, maxX, maxY, z = cfg.crealityZ } = bounds || {};
      return [
        ";FLAVOR:Marlin",
        ";Generated with pcb-offline (gerber→gcode creality flavor)",
        ";TIME:1",
        ";Filament used: 0.0001m",
        ";Layer height: 0.2",
        `;MINX:${fmt(minX ?? 0, 2)}`,
        `;MINY:${fmt(minY ?? 0, 2)}`,
        `;MINZ:${fmt(z, 2)}`,
        `;MAXX:${fmt(maxX ?? 100, 2)}`,
        `;MAXY:${fmt(maxY ?? 100, 2)}`,
        `;MAXZ:${fmt(z, 2)}`,
        "M140 S0",
        "M105",
        "M190 S0",
        "M104 S0",
        "M109 S0",
        "G21",
        "G90",
        "M82",
        "G92 E0",
        ";LAYER_COUNT:1",
        ";LAYER:0",
      ].join("\n");
    };

    // Compute bounds for header
    let minXb=Infinity, minYb=Infinity, maxXb=-Infinity, maxYb=-Infinity;
    for (const poly of polylines) {
      for (const p of poly) {
        if (p.x < minXb) minXb = p.x;
        if (p.x > maxXb) maxXb = p.x;
        if (p.y < minYb) minYb = p.y;
        if (p.y > maxYb) maxYb = p.y;
      }
    }
    if (!isFinite(minXb)) { minXb=0; minYb=0; maxXb=100; maxYb=100; }

    const g = [];
    g.push(crealityHeader({ minX: minXb, minY: minYb, maxX: maxXb, maxY: maxYb, z: cfg.crealityZ }));
    g.push(`G0 Z${fmt(cfg.crealityTravelZ)} F${fmt(cfg.crealityFeedZ,0)}`);
    g.push("G92 E0");

    let E = 0;
    for (const poly of polylines) {
      if (poly.length < 2) continue;
      const s = poly[0];
      // travel to start (no extrusion)
      g.push(`G0 X${fmt(s.x)} Y${fmt(s.y)} F${fmt(cfg.crealityFeedXY,0)}`);
      g.push(`G1 Z${fmt(cfg.crealityZ)} F${fmt(cfg.crealityFeedZ,0)}`);

      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        E += L * (cfg.crealityEPerMm || 0.05);
        g.push(`G1 X${fmt(b.x)} Y${fmt(b.y)} E${fmt(E,5)} F${fmt(cfg.crealityFeedXY,0)}`);
      }
      // lift for travel to next polyline
      g.push(`G1 Z${fmt(cfg.crealityTravelZ)} F${fmt(cfg.crealityFeedZ,0)}`);
    }
    // End
    g.push("M104 S0");
    g.push("M140 S0");
    g.push("M107");
    g.push("G92 E0");
    g.push("M84");

    return g.join("\n") + "\n";
  }

  // ============================================================
  // MARLIN flavor (your previous simple viewer/paste path)
  // ============================================================
  if (cfg.flavor === 'marlin') {
    const out = [];
    let E = 0;

    out.push(`;FLAVOR:Marlin`);
    out.push(`G90`); out.push(`G21`); out.push(`M82`); out.push(`G92 E0`);
    out.push(`G0 Z${fmt(cfg.layerZ,3)} F300`);

    for (let raw of tokens) {
      const t = raw.replace(/\s+/g,''); if (!t || /^G0?4/i.test(t)) continue;
      if (/^G0?1$/i.test(t)) { interp='G01'; continue; }
      if (/^G0?2$/i.test(t)) { interp='G02'; continue; }
      if (/^G0?3$/i.test(t)) { interp='G03'; continue; }
      const md = t.match(/D0?([123])$/i); if (md) currentD = +md[1];

      if (/[XY]/i.test(t)) {
        const { x, y } = parseXYIJ(t, { x: curX, y: curY });
        const X = mmX(x), Y = mmY(y);
        if (currentD === 2 || currentD == null) {
          out.push(`G0 X${fmt(X)} Y${fmt(Y)} F12000`);
          curX = x; curY = y; continue;
        }
        if (currentD === 1) {
          const X0 = mmX(curX), Y0 = mmY(curY);
          E += dmm(curX,curY,x,y) * (cfg.ePerMm || 0.04);
          out.push(`G1 X${fmt(X)} Y${fmt(Y)} E${fmt(E,5)} F${fmt(cfg.feedXY,0)}`);
          curX = x; curY = y; continue;
        }
        if (currentD === 3) {
          // flash -> tiny extrusion tick
          out.push(`G0 X${fmt(X)} Y${fmt(Y)} F12000`);
          E += 0.02 * (cfg.ePerMm || 0.04);
          out.push(`G1 X${fmt(X+0.01)} Y${fmt(Y)} E${fmt(E,5)} F${fmt(cfg.feedXY,0)}`);
          curX = x; curY = y; continue;
        }
      }
    }
    out.push(`G92 E0`); out.push(`M84`);
    return out.join('\n');
  }

  // ============================================================
  // GRBL flavor (your original CNC output)
  // ============================================================
  const out = [];
  const push = (s) => out.push(s);
  push(units === 'in' ? 'G20' : 'G21');
  push('G90'); push('G94'); push(`F${fmt(cfg.feedXY,2)}`); push(`G0 Z${fmt(cfg.travelZ,3)}`);

  const toolOn  = () => push(cfg.toolOn);
  const toolOff = () => push(cfg.toolOff);
  const plunge  = () => push(`G1 Z${fmt(cfg.workZ,3)} F${fmt(cfg.feedZ,2)}`);
  const retract = () => push(`G0 Z${fmt(cfg.travelZ,3)}`);
  const rapidXY = (x,y) => {
    let X = units==='in'?x*IN2MM:x, Y = units==='in'?y*IN2MM:y;
    const transformed = applyCoordTransform({ x: X, y: Y });
    push(`G0 X${fmt(transformed.x)} Y${fmt(transformed.y)}`);
  };
  const lineXY  = (x,y) => {
    let X = units==='in'?x*IN2MM:x, Y = units==='in'?y*IN2MM:y;
    const transformed = applyCoordTransform({ x: X, y: Y });
    push(`G1 X${fmt(transformed.x)} Y${fmt(transformed.y)}`);
  };
  const arcXYIJ = (code, x, y, i, j) => {
    let X = units==='in'?x*IN2MM:x, Y = units==='in'?y*IN2MM:y;
    let I = units==='in'?i*IN2MM:i, J = units==='in'?j*IN2MM:j;
    const transformed = applyCoordTransform({ x: X, y: Y });
    push(`${code} X${fmt(transformed.x)} Y${fmt(transformed.y)} I${fmt(I)} J${fmt(J)}`);
  };

  for (let raw of tokens) {
    const t = raw.replace(/\s+/g,''); if (!t || /^G0?4/i.test(t)) continue;
    if (/^G70$/i.test(t)) { units='in'; push('G20'); continue; }
    if (/^G71$/i.test(t)) { units='mm'; push('G21'); continue; }
    if (/^G0?1$/i.test(t)) { interp='G01'; continue; }
    if (/^G0?2$/i.test(t)) { interp='G02'; continue; }
    if (/^G0?3$/i.test(t)) { interp='G03'; continue; }
    const md = t.match(/D0?([123])$/i); if (md) currentD = +md[1];

    if (/[XY]/i.test(t)) {
      const { x, y, i, j } = parseXYIJ(t, { x: curX, y: curY });
      if (currentD === 2 || currentD == null) { rapidXY(x,y); curX=x; curY=y; continue; }
      if (currentD === 1) {
        rapidXY(curX,curY); plunge(); toolOn();
        if ((interp==='G02'||interp==='G03') && i!=null && j!=null) arcXYIJ(interp,x,y,i,j);
        else lineXY(x,y);
        toolOff(); retract(); curX=x; curY=y; continue;
      }
      if (currentD === 3) { rapidXY(x,y); plunge(); toolOn(); toolOff(); retract(); curX=x; curY=y; continue; }
    }
  }
  push(`G0 Z${fmt(cfg.travelZ,3)}`); push('G0 X0 Y0'); push(cfg.toolOff);
  return out.join('\n');
}
