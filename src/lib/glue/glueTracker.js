/**
 * glueTracker.js
 *
 * Calculates per-pad glue volume from pad dimensions and tracks
 * cumulative consumption against a user-defined cartridge stock.
 *
 * Volume model (cylindrical dot approximation):
 *   A pad of W × H mm receives a grid of dots each of diameter = nozzleDia.
 *   Each dot volume ≈ (4/3)π(r)³  (hemisphere deposit).
 *   Total volume = numDots × dotVolume × coverageFactor
 *
 * Units: mm³  (1 mm³ ≈ 1 µL for incompressible paste/glue)
 */

// ─── Dot-grid helpers ────────────────────────────────────────────────────────

/**
 * Count how many dots fit on a pad given nozzle diameter.
 * Mirrors the logic in PasteVisualizer and App.jsx overlay.
 */
export function dotCountForPad(pad, nozzleDia) {
  const nd = nozzleDia || 0.6;
  const w = pad.width  || 1.0;
  const h = pad.height || 1.0;
  if (w < nd || h < nd) return 1;           // pad smaller than nozzle → single dot
  const spacing = nd * 0.7;
  const dotsX = Math.max(1, Math.floor(w / spacing));
  const dotsY = Math.max(1, Math.floor(h / spacing));
  return dotsX * dotsY;
}

/**
 * Volume of a single dispensed dot (hemisphere model), mm³.
 */
export function dotVolumeMm3(nozzleDia, gapMm = 0.1) {
  // Effective radius accounts for spread at the dispense gap
  const r = (nozzleDia / 2) * 1.15;   // 15% spread factor
  return (2 / 3) * Math.PI * r * r * r;
}

/**
 * Total glue volume for one pad, mm³.
 */
export function padVolumeMm3(pad, nozzleDia, gapMm = 0.1) {
  const dots = dotCountForPad(pad, nozzleDia);
  return dots * dotVolumeMm3(nozzleDia, gapMm);
}

// ─── Pad area (used for dwell-time scaling) ──────────────────────────────────

export function padAreaMm2(pad) {
  const w = pad.width  || 1.0;
  const h = pad.height || 1.0;
  if (pad.shape === 'Circle') return Math.PI * (w / 2) ** 2;
  return w * h;
}

// ─── Job-level summary ───────────────────────────────────────────────────────

/**
 * Annotate every pad in the sequence with its glue volume,
 * then return a full job summary.
 *
 * @param {Array}  pads        - dispensing sequence (each has width, height, shape)
 * @param {number} nozzleDia   - mm
 * @param {number} stockMm3    - cartridge stock in mm³ (user-entered)
 * @param {number} usedMm3     - already consumed from previous jobs (persisted)
 * @returns {{ annotated, totalVolMm3, totalVolUl, remainMm3, remainUl,
 *             remainPct, perPad, willRunOut, runOutAfterPad }}
 */
export function buildJobGlueSummary(pads, nozzleDia, stockMm3 = Infinity, usedMm3 = 0) {
  let cumulative = usedMm3;
  let runOutAfterPad = -1;

  const annotated = pads.map((pad, idx) => {
    const vol = padVolumeMm3(pad, nozzleDia);
    const dots = dotCountForPad(pad, nozzleDia);
    cumulative += vol;
    const remaining = Math.max(0, stockMm3 - cumulative);
    if (runOutAfterPad < 0 && cumulative > stockMm3) runOutAfterPad = idx;
    return {
      ...pad,
      glue: {
        dots,
        volMm3:    parseFloat(vol.toFixed(4)),
        volUl:     parseFloat(vol.toFixed(4)),       // mm³ ≡ µL
        cumMm3:    parseFloat(cumulative.toFixed(4)),
        remainMm3: parseFloat(remaining.toFixed(4)),
      }
    };
  });

  const jobVol  = cumulative - usedMm3;
  const remainAfterJob = Math.max(0, stockMm3 - cumulative);

  return {
    annotated,
    totalVolMm3:   parseFloat(jobVol.toFixed(4)),
    totalVolUl:    parseFloat(jobVol.toFixed(4)),
    remainMm3:     parseFloat(remainAfterJob.toFixed(4)),
    remainUl:      parseFloat(remainAfterJob.toFixed(4)),
    remainPct:     stockMm3 === Infinity ? null : parseFloat(((remainAfterJob / stockMm3) * 100).toFixed(1)),
    willRunOut:    runOutAfterPad >= 0,
    runOutAfterPad,
    perPad:        annotated.map(p => p.glue),
  };
}

// ─── Persistence helpers (localStorage) ─────────────────────────────────────

const STOCK_KEY   = 'glueStockMm3';
const USED_KEY    = 'glueUsedMm3';
const REFILL_KEY  = 'glueRefillLog';

export const GlueStore = {
  getStock:  ()  => { try { return parseFloat(localStorage.getItem(STOCK_KEY)  || '5000'); } catch { return 5000; } },
  getUsed:   ()  => { try { return parseFloat(localStorage.getItem(USED_KEY)   || '0');    } catch { return 0;    } },
  setStock:  (v) => localStorage.setItem(STOCK_KEY,  String(parseFloat(v) || 0)),
  addUsed:   (v) => {
    const cur = GlueStore.getUsed();
    localStorage.setItem(USED_KEY, String(parseFloat((cur + v).toFixed(4))));
  },
  resetUsed: ()  => localStorage.setItem(USED_KEY, '0'),
  refill:    (newStockMm3) => {
    GlueStore.setStock(newStockMm3);
    GlueStore.resetUsed();
    const log = GlueStore.getRefillLog();
    log.push({ ts: new Date().toISOString(), stockMm3: newStockMm3 });
    localStorage.setItem(REFILL_KEY, JSON.stringify(log.slice(-20)));
  },
  getRefillLog: () => { try { return JSON.parse(localStorage.getItem(REFILL_KEY) || '[]'); } catch { return []; } },
};