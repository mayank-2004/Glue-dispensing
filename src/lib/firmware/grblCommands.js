/**
 * grblCommands.js
 * ───────────────
 * Single source of truth for all GRBL firmware commands used in this app.
 * Import `fw` wherever you need to send a command — never hard-code raw
 * strings in UI or hook files.
 *
 * Usage:
 *   import { fw } from '../lib/firmware/grblCommands.js';
 *   await window.serial.writeLine(fw.home);          // "$H"
 *   await window.serial.write(fw.reset);             // "\x18"  (byte, no newline)
 */

export const fw = {
  // ── Real-time commands (single-byte, sent via write(), NOT writeLine()) ──
  /** Soft reset — clears alarm and flushes planner buffer */
  reset:          '\x18',
  /** Feed hold — pauses motion immediately */
  pause:          '!',
  /** Cycle start / resume after feed hold */
  resume:         '~',

  // ── Real-time status query ───────────────────────────────────────────────
  /** Request status report: <Idle|MPos:x,y,z|FS:f,s|...> */
  statusQuery:    '?',

  // ── Alarm & unlock ───────────────────────────────────────────────────────
  /** Kill alarm lock — must be sent after any ALARM state before moving */
  unlock:         '$X',

  // ── Homing ───────────────────────────────────────────────────────────────
  /** Home all configured axes */
  home:           '$H',
  /** Home X axis only */
  homeX:          '$HX',
  /** Home Y axis only */
  homeY:          '$HY',
  /** Home Z axis only */
  homeZ:          '$HZ',

  // ── Motion settings (GRBL $ parameters) ─────────────────────────────────
  /** Set X-axis max rate (mm/min). Usage: fw.maxRateX(value) */
  maxRateX:       (mmMin) => `$110=${mmMin}`,
  /** Set Y-axis max rate (mm/min). */
  maxRateY:       (mmMin) => `$111=${mmMin}`,
  /** Set Z-axis max rate (mm/min). */
  maxRateZ:       (mmMin) => `$112=${mmMin}`,
  /** Set X-axis acceleration (mm/s²). */
  accelX:         (mmS2)  => `$120=${mmS2}`,
  /** Set Y-axis acceleration (mm/s²). */
  accelY:         (mmS2)  => `$121=${mmS2}`,
  /** Set Z-axis acceleration (mm/s²). */
  accelZ:         (mmS2)  => `$122=${mmS2}`,

  // ── Dispenser / valve output ─────────────────────────────────────────────
  /** Turn ON the dispenser/valve. Duty 0-255 via S parameter. */
  dispenserOn:    (duty = 255) => `M106 S${Math.min(255, Math.max(0, Math.round(duty)))}`,
  /** Turn OFF the dispenser/valve output. */
  dispenserOff:   'M107',

  // ── Probe ────────────────────────────────────────────────────────────────
  /**
   * GRBL probing: poll '?' and check for 'Pn:Z' in the response to detect
   * Z-probe triggered. SerialPanel fires DOM event 'endstop-z-probe-triggered'
   * when it sees 'Pn:Z' in a status line.
   */
  probeQuery:     '?',

  // ── Auxiliary / coolant outputs ──────────────────────────────────────────
  auxOn:          'M8',
  auxOff:         'M9',

  // ── General G-code (firmware-agnostic) ──────────────────────────────────
  absMode:        'G90',
  relMode:        'G91',
  unitsMm:        'G21',
  unitsIn:        'G20',

  // ── Feature M-codes (Mapped to standard GRBL outputs for separate boards) ──
  fume: {
    on:           'M8',       // Standard Coolant Flood ON
    off:          'M9',       // Standard Coolant OFF
  },
  flux: {
    cleanStart:   'M3',       // Spindle CW (Pump Forward)
    flushFwd:     'M3 S255',  // Full speed forward
    flushRev:     'M4 S255',  // Full speed reverse
    cleanEnd:     'M5',       // Spindle Stop
    dispense:     'M3 S255',  // Dispense forward
    dispenseOff:  'M5',       // Stop
  },
  tipCleaner: {
    cleanStart:   'M3',       // Standard Spindle ON
    cleanEnd:     'M5',       // Standard Spindle OFF
  },
  payload: {
    query:        '?',        // Standard GRBL Status Query
    set:          (kg)   => `(PAYLOAD:${parseFloat(kg).toFixed(2)})`, // Standard G-code comment
  },
};

/**
 * Detect GRBL boot greeting line.
 * GRBL sends "Grbl X.Xx ['$' for help]" on power-up/reset.
 */
export function isGrblBoot(line) {
  const t = line.trim();
  return /^Grbl\s+\d+\.\d+/i.test(t)    // standard: "Grbl 1.1h ['$' for help]"
      || /^\[MSG:.*\]/i.test(t)           // GRBL-HAL extended messages
      || /^ok$/i.test(t);                 // fallback: first 'ok'
}

/**
 * Parse a GRBL real-time status response.
 * Example: <Idle|MPos:10.000,20.000,-5.000|FS:0,0|Pn:Z>
 * Returns { state, x, y, z, probeTriggered } or null.
 */
export function parseGrblStatus(line) {
  const m = line.match(/<([^|>]+)\|MPos:([-\d.]+),([-\d.]+),([-\d.]+)/);
  if (!m) return null;
  return {
    state:          m[1],
    x:              parseFloat(m[2]),
    y:              parseFloat(m[3]),
    z:              parseFloat(m[4]),
    probeTriggered: line.includes('Pn:Z'),
  };
}

/**
 * Detect GRBL error / alarm lines.
 * Returns { isError, isAlarm, code, raw } or null.
 */
export function parseGrblError(line) {
  const err   = line.match(/^error:(\d+)/i);
  const alarm = line.match(/^ALARM:(\d+)/i);
  if (err)   return { isError: true,  isAlarm: false, code: parseInt(err[1]),   raw: line.trim() };
  if (alarm) return { isError: false, isAlarm: true,  code: parseInt(alarm[1]), raw: line.trim() };
  return null;
}
