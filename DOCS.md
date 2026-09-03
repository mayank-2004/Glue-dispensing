# Glue Dispensing Robot — Developer Documentation

> Industrial-grade PCB glue dispensing controller built on React + Electron.  
> Controls a 3-axis CNC machine via G-code over serial, with computer vision alignment and automated job execution.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Project Structure](#3-project-structure)
4. [Core Data Flow](#4-core-data-flow)
5. [Module Reference](#5-module-reference)
   - [Gerber Processing](#51-gerber-processing)
   - [Coordinate Transform](#52-coordinate-transform)
   - [G-Code Generation](#53-g-code-generation)
   - [Dispensing Sequencer](#54-dispensing-sequencer)
   - [Vision System](#55-vision-system)
   - [Serial Communication](#56-serial-communication-ipc)
   - [Glue Tracking](#57-glue-tracking)
   - [Nozzle Maintenance](#58-nozzle-maintenance)
   - [Safety Interlock System](#59-safety-interlock-system)
   - [Flux Spraying Mechanism](#510-flux-spraying-mechanism)
   - [Fume Extraction System](#511-fume-extraction-system)
   - [Automatic Tip Changing](#512-automatic-tip-changing)
   - [Automatic Tip Cleaning Mechanism](#513-automatic-tip-cleaning-mechanism)
   - [Quick Tip Rotation Mechanism](#514-quick-tip-rotation-mechanism)
6. [Component Reference](#6-component-reference)
7. [State Architecture](#7-state-architecture)
8. [Electron IPC API](#8-electron-ipc-api)
9. [Machine Control Protocol](#9-machine-control-protocol)
10. [Job Execution Pipeline](#10-job-execution-pipeline)
11. [Vision Server (Python)](#11-vision-server-python)
12. [Hardware Setup](#12-hardware-setup)
13. [Development Guide](#13-development-guide)
14. [Configuration & Persistence](#14-configuration--persistence)

---

## 1. Architecture Overview

The application is structured as a **three-process system**:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ELECTRON MAIN PROCESS  (electron/main.js)                          │
│  ─ Owns the BrowserWindow                                           │
│  ─ Manages serial port (node-serialport)                            │
│  ─ Spawns & supervises the Python vision server                     │
│  ─ Exposes IPC handlers to the renderer                             │
└────────────────────┬───────────────────────────────┬────────────────┘
                     │ contextBridge (preload.js)     │ HTTP localhost:8000
                     ▼                                ▼
┌─────────────────────────────┐      ┌───────────────────────────────┐
│  REACT RENDERER             │      │  PYTHON VISION SERVER         │
│  (Vite + React 19)          │      │  (FastAPI + OpenCV)           │
│  ─ All UI panels            │      │  ─ Fiducial detection         │
│  ─ State management         │      │  ─ Board presence check       │
│  ─ G-code construction      │      │  ─ Glue dot QC inspection     │
│  ─ Job orchestration        │      │  ─ Lens calibration           │
└─────────────────────────────┘      └───────────────────────────────┘
```

The renderer never touches the filesystem or serial port directly — it communicates exclusively through the `window.serial` and `window.ipcRenderer` bridges exposed by the preload script.

---

## 2. Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Desktop shell | Electron 28 | Native window, serial access, process management |
| Frontend | React 19 + Vite 5 | UI, state, job logic |
| Styling | Plain CSS + CSS Variables | Industrial HMI design system |
| Serial | `serialport` (Node.js) | USB/UART machine communication |
| Gerber parsing | `gerber-parser`, `pcb-stackup`, `whats-that-gerber` | Layer identification, SVG rendering |
| Vision backend | Python 3 + FastAPI + OpenCV | Camera-based fiducial & QC detection |
| Archive | JSZip | ZIP Gerber bundle extraction |
| Fonts | Inter + JetBrains Mono (Google Fonts) | UI + numeric readouts |

---

## 3. Project Structure

```
glue-dispensing/
├── electron/
│   ├── main.js          # Main process: window, serial IPC, vision server lifecycle
│   └── preload.js       # contextBridge: exposes window.serial and window.ipcRenderer
│
├── python-vision/
│   └── server.py        # FastAPI server — vision endpoints
│
├── src/
│   ├── main.jsx         # React entry point
│   ├── App.jsx          # Root component — owns global state, fiducials, transform
│   ├── App.css          # Layout (header / sidebar / viewer)
│   ├── index.css        # Design system — CSS custom properties, base components
│   ├── Toast.jsx        # Global toast notification context
│   │
│   ├── components/
│   │   ├── AppHeader.jsx              # Top bar: DRO readout, status pills, E-stop
│   │   ├── AutomatedDispensingPanel.jsx  # Main job controller (largest component)
│   │   ├── CameraPanel.jsx            # Live camera, nozzle offset, tool calibration
│   │   ├── FiducialPanel.jsx          # Board alignment, fiducial pair editor
│   │   ├── JogPanel.jsx               # Manual XYZ jog control
│   │   ├── SerialPanel.jsx            # Port selector, G-code console
│   │   ├── Viewer.jsx                 # SVG PCB canvas with zoom + pad selection
│   │   ├── LayerList.jsx              # Gerber layer toggle list
│   │   ├── ComponentList.jsx          # Pad list, sorted by distance
│   │   ├── GlueGauge.jsx              # Glue stock gauge + per-pad volume table
│   │   ├── MaintenanceManager.jsx     # Nozzle health ring + cleaning alerts
│   │   └── BedCalibrationPanel.jsx    # Multi-point Z-height mesh calibration
│   │
│   └── lib/
│       ├── gerber/
│       │   ├── extractPads.js         # Parse Gerber → pad list [{id,x,y,w,h,shape}]
│       │   ├── identifyLayers.js      # Map filenames → layer types (GTL, GBL, etc.)
│       │   ├── fiducialDetection.js   # Score & rank fiducial candidates from Gerber
│       │   ├── boardOutline.js        # Extract PCB boundary from Edge.Cuts layer
│       │   ├── stackupToSvg.js        # Render multi-layer stackup as SVG string
│       │   └── originDetection.js     # Detect PCB origin corner candidates
│       │
│       ├── motion/
│       │   ├── gcode.js               # G-code builders: moveAbs, jogRel, dispensePoint, dispenseBead
│       │   └── pathGeneration.js      # Direct / safe / zig-zag path strategies
│       │
│       ├── automation/
│       │   ├── dispensingSequence.js  # Nearest-neighbor sort, dwell/pressure calc, job runner
│       │   └── safePathPlanner.js     # 3D obstacle-aware path planning
│       │
│       ├── utils/
│       │   ├── transform2d.js         # fitSimilarity, fitAffine, applyTransform
│       │   └── tsp.js                 # Travelling-salesman nearest-neighbor heuristic
│       │
│       ├── glue/
│       │   └── glueTracker.js         # GlueStore (stock), buildJobGlueSummary (per-pad µL)
│       │
│       ├── vision/
│       │   ├── fiducialVision.js      # In-browser fiducial detector (canvas + CCA)
│       │   └── padDetection.js        # Vision-guided pad detection
│       │
│       ├── maintenance/
│       │   └── nozzleMaintenance.js   # Wear tracking, quality scoring, cleaning reminders
│       │
│       ├── batch/
│       │   ├── batchProcessor.js      # Board queue management
│       │   └── batchExecutor.js       # Sequential board execution
│       │
│       └── collision/
│           └── collisionDetection.js  # Nozzle path clearance checking
```

---

## 4. Core Data Flow

### File Load → Pad Extraction

```
User drops Gerber ZIP
        │
        ▼
JSZip.loadAsync()
        │
        ▼
identifyLayers()          ← maps each file to: copper/paste/mask/drill/outline
        │
        ▼
extractPads()             ← parses paste layer → [{id, x, y, width, height, shape, area}]
        │
        ▼
fiducialDetection()       ← scores Gerber features → [{id, design:{x,y}, machine:null}]
        │
        ▼
stackupToSvg()            ← renders visible layers → SVG string → Viewer
```

### Alignment → Transform

```
Operator jogs machine to each fiducial
        │
        ▼ (captured via FiducialPanel)
fiducials[i].machine = { x, y }     ← set from machinePosition prop
        │
        ▼
fitSimilarity(designPts, machinePts) ← 2-point: translation + rotation + scale
  OR  fitAffine(designPts, machinePts) ← 3-point: full 6-parameter affine
        │
        ▼
xf = { a, b, c, d, tx, ty }        ← stored in App.jsx state, passed as prop
        │
        ▼
applyTransform(xf, pad)             ← maps every design pad → machine coordinate
```

### Job Execution

```
operator clicks "Start Job"
        │
        ▼
computePreflightChecks()    ← serial connected, homed, sequence loaded, xf solved
        │
        ▼
runDispenseLoop()           ← async generator over activeSequence
  for each pad:
    ├─ applyTransform(xf, pad)          → machine XY
    ├─ getZOffsetForPoint(x, y)         → bed mesh Z correction
    ├─ calculateDwellTime(pad)          → ms proportional to pad area
    ├─ calculatePadPressure(pad)        → PSI scaled by pad area
    ├─ dispensePoint() or dispenseBead() → G-code array
    └─ serial.writeMany(lines)          → sent to machine via IPC
        │
        ▼
post-job: spcAppend(), saveJobLog(), setJobStage('finished')
```

---

## 5. Module Reference

### 5.1 Gerber Processing

#### `lib/gerber/extractPads.js`

Parses a raw Gerber string and returns a normalized pad array.

```js
extractPads(gerberString: string): Pad[]

interface Pad {
  id:       string    // e.g. "PAD_042"
  x:        number    // design-space mm (Gerber origin)
  y:        number
  width:    number    // mm
  height:   number    // mm
  shape:    'circle' | 'rect' | 'obround' | 'macro'
  area:     number    // mm² — used for dwell/pressure scaling
  rotation: number    // degrees
}
```

**Parser pipeline:**
1. Tokenize Gerber commands (`D01`/`D02`/`D03`, `G36`/`G37`)
2. Build aperture table from `ADD` commands (circle, rectangle, obround, macro)
3. Walk flashes (`D03`) and regions to emit pad records
4. Convert from Gerber native units (inches or mm) to mm

#### `lib/gerber/identifyLayers.js`

Maps filenames to canonical layer types using a scored rule table.

```js
identifyLayer(filename: string): LayerType
// 'copper-top' | 'copper-bottom' | 'paste-top' | 'paste-bottom'
// 'mask-top' | 'mask-bottom' | 'drill' | 'outline' | 'unknown'
```

Recognized extensions/patterns: `.GTL`, `.GBL`, `.GTP`, `.GBP`, `.GTS`, `.GBS`, `.DRL`, `.GKO`, `.GM1`, `-F.Cu`, `-B.Cu`, `-F.Paste`, etc.

---

### 5.2 Coordinate Transform

**File:** `lib/utils/transform2d.js`

All machine positioning is built on a 2D affine transform:

```
[ x' ]   [ a  b  tx ] [ x ]
[ y' ] = [ c  d  ty ] [ y ]
[ 1  ]   [ 0  0   1 ] [ 1 ]
```

```js
// 2-point similarity (rotation + scale + translation, no shear)
fitSimilarity(
  designPts: {x,y}[],
  machinePts: {x,y}[]
): Transform | null

// 3-point affine (full 6-parameter, handles shear/stretch)
fitAffine(
  designPts: {x,y}[],
  machinePts: {x,y}[]
): Transform | null

// Apply transform to a single point
applyTransform(xf: Transform, pt: {x,y}): {x,y}
```

**RMS error** is computed after every solve and shown in the FiducialPanel as an alignment quality indicator. Values below 0.1 mm are considered good.

---

### 5.3 G-Code Generation

**File:** `lib/motion/gcode.js`

All G-code is constructed as pure functions returning `string[]`. No side effects.

```js
// Move to absolute position
moveAbs({ x, y, z, r, feed }, axisMap?): string[]
// → ["G1 X100.000 Y50.000 F1500"]

// Relative jog (atomic: G91 → move → G90 in one write)
jogRel({ dx, dy, dz, dr, feed }, axisMap?): string[]
// → ["G91\nG1 X5 F2000\nG90"]

// Dispense a dot at (x, y)
dispensePoint({ x, y, zWork, zSafe, feedXY, feedZ,
                pressure, dwellMs, pwmDuty }): string[]
// → travel to (x,y,zSafe) → lower to zWork → M106 S255 → G4 Pms → M107 → retract

// Dispense a linear bead (for large/oblong pads)
dispenseBead({ x, y, beadLength, beadAxis,
               zWork, zSafe, feedXY, feedZ, feedBead,
               pressure, pwmDuty }): string[]

// Dwell
dwell(ms: number): string[]
// → ["G4 P150"]

// Home axes
home({ x, y, z, r }?): string[]
// → ["G28 X Y Z"]
```

**Valve control:** uses `M106 S{pwmDuty}` (fan/relay ON) and `M107` (OFF), mapped to the Ender-3 part cooling fan output which drives a relay connected to the 983A dispenser trigger input.

---

### 5.4 Dispensing Sequencer

**File:** `lib/automation/dispensingSequence.js`

```js
class DispensingSequencer {
  // Nearest-neighbor TSP sort of pad array
  sortByNearestNeighbor(pads: Pad[], startPt?): Pad[]

  // Dwell time proportional to pad area
  // area < 0.5 mm² → baseDwell * 0.7
  // area > 5 mm²   → baseDwell * 2.0 (capped)
  calculateDwellTime(pad: Pad, { customDwellTime }): number  // ms

  // Pressure scaled by pad area
  // small pads → base - 5 PSI (prevent over-fill)
  // large pads → base + 5 PSI (ensure coverage)
  calculatePadPressure(pad: Pad, { customPressure }): number  // PSI
}
```

The sequencer is instantiated once in `App.jsx` and passed as a prop to `AutomatedDispensingPanel`.

---

### 5.5 Vision System

#### In-Browser (JavaScript) — `lib/vision/fiducialVision.js`

Runs entirely in the renderer process via the HTML5 Canvas API. No WebAssembly or native modules.

**Pipeline:**
```
Camera frame (ImageData)
        │
        ▼ 1. Grayscale conversion  (luminance = 0.299R + 0.587G + 0.114B)
        │
        ▼ 2. Rule-based binarization
        │     ─ Reject high-saturation green (soldermask)
        │     ─ Keep bright HASL/gold pads
        │
        ▼ 3. Connected Component Analysis (flood-fill CCA)
        │     ─ Labels distinct white blobs
        │
        ▼ 4. Feature extraction per blob
        │     ─ Bounding box, radius, circularity, inertia ratio
        │
        ▼ 5. Multi-stage filtering
        │     ─ Aspect ratio check (circularity > 0.7)
        │     ─ "Dark ring" structural isolation (pad surrounded by darker pixels)
        │     ─ Size range filter (0.5–5 mm equivalent at current zoom)
        │
        ▼ 6. Select candidate closest to UI crosshair
        │
        ▼ G-code offset: G91 G0 X{dx} Y{dy} F{feed}
```

#### Python Backend — `python-vision/server.py`

FastAPI server started by Electron in production. Endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check — returns `{"status":"ok"}` |
| `POST` | `/api/detect_fiducial` | Detect fiducial in camera frame, return `{x,y,confidence}` |
| `GET` | `/api/check_board_present` | Check if a PCB is visible, return `{present,confidence,reason}` |
| `GET` | `/api/check_glue_dot` | Inspect dispensed dot, return `{passed,diameter_mm,confidence}` |
| `POST` | `/api/calibration/capture` | Capture a chessboard frame for lens calibration |
| `POST` | `/api/calibration/compute` | Compute lens distortion coefficients |
| `GET` | `/api/calibration/status` | Return calibration state and RMS error |

The renderer polls `http://localhost:8000/` every 2 seconds until it responds before marking vision as ready.

---

### 5.6 Serial Communication (IPC)

**File:** `electron/main.js`

All serial access is gated in the main process. The renderer calls through the preload bridge:

```js
// Preload exposes:
window.serial = {
  list()                          // → SerialPortInfo[]
  open({ path, baudRate })        // → true | throws
  close()                         // → true
  writeLine(line: string)         // → true | throws
  sendGcode(text: string)         // → true  (sanitizes, filters non-G/M lines)
  writeMany({ lines, delayMs })   // → true  (sends array with inter-line delay)
  onData(cb)                      // register data listener
  onDisconnect(cb)                // register disconnect listener
  onPortAppeared(cb)              // register reconnect listener
}
```

**Auto-reconnect flow:**
1. Cable pull triggers port `close` event → main emits `serial:disconnected` → renderer shows toast
2. `startPortWatcher()` polls `SerialPort.list()` every 2 s
3. When port reappears → main emits `serial:port-appeared` → renderer auto-reconnects

**Keep-alive:** A `?` status query is sent every 30 s to prevent Windows from USB-suspending the port.

---

### 5.7 Glue Tracking

**File:** `lib/glue/glueTracker.js`

```js
// Persistent glue stock (localStorage)
GlueStore.getStock(): number          // µL remaining
GlueStore.setStock(ul: number): void
GlueStore.deduct(ul: number): void

// Build per-pad volume summary for a job
buildJobGlueSummary(pads: Pad[], { nozzleDia, dwellMs }): GlueSummary

interface GlueSummary {
  totalVolUl: number
  annotated: Array<{
    pad: Pad
    glue: { volUl: number, dotDiamMm: number }
  }>
}
```

Volume model: `V = π × (nozzleDia/2)² × dotHeight` where `dotHeight` is estimated from dwell time and calibrated flow rate. The GlueGauge component renders this as a radial gauge and a scrollable per-pad table.

---

### 5.8 Nozzle Maintenance

**File:** `lib/maintenance/nozzleMaintenance.js`

```js
class NozzleMaintenanceManager {
  recordDispense(count: number): void
  recordCleaning(): void
  getStatus(): {
    dotsDispensed: number
    hoursSinceClean: number
    qualityScore: number   // 0–1 (degrades with use)
    wearLevel: 'good' | 'warn' | 'critical'
    needsCleaning: boolean
  }
}
```

The `MaintenanceManager` component renders a color ring (green → amber → red) around the nozzle icon in the dispensing panel, and triggers a toast alert when cleaning is required.

---

### 5.9 Safety Interlock System

**File:** `hooks/useSafetySystem.js`

A centralized emergency halt and fault tracking system. It listens for hardware faults emitted by `useSerialMachine` (e.g., `ALARM:`, `E-STOP:`, `FUME_FAIL:`) and maps them to severity levels (`INFO`, `WARNING`, `CRITICAL`, `EMERGENCY`).

When a `CRITICAL` or `EMERGENCY` fault occurs:
- The UI injects a persistent `SafetyBanner` at the top of the app.
- A `safety-halt` event is dispatched.
- `AutomatedDispensingPanel` listens for this event, unwinds the dispensing loop instantly via `cancelJobRef`, and saves the current pad count so the job can be safely resumed later.

---

### 5.10 Flux Spraying Mechanism

**File:** `hooks/useFluxManager.js` & `components/FluxPanel.jsx`

Manages a secondary flux spray mechanism attached to the CNC head, communicating via custom serial telemetry.
- **Telemetry Parsing:** Parses `FLUX_LEVEL:*` and `FLUX_DISPENSE:*` events from the embedded controller to track tank levels and spray success/failure.
- **Job Integration:** Evaluates flux levels during the job preflight checks. If the tank is empty, the job is blocked. If it empties mid-job, the operator is paused.
- **Maintenance:** Tracks dispensing cycles and prompts the operator to perform a nozzle flush/clean sequence via M-codes (`M700`/`M710`) to prevent clogging.

---

### 5.11 Fume Extraction System

**File:** `hooks/useFumeManager.js` & `components/FumePanel.jsx`

Manages a 24V DC HEPA-filtered vacuum extraction system.
- **Auto-Start/Stop:** Extracts fumes automatically when a job starts, and runs a configurable "post-run" cooldown timer to clear residual fumes after the job ends.
- **Monitoring:** Parses `FUME_STATUS:*` serial telemetry to track airflow (LPM), pump load, and filter lifespan (operating hours).
- **Fault Handling:** Ties into the safety system. If the extraction fails or the HEPA filter is fully blocked, dispensing is prevented.

---

### 5.12 Automatic Tip Changing

**File:** `hooks/useTipManager.js` & `components/TipManagementPanel.jsx`

Allows the machine to swap tool heads automatically.
- **Calibration:** Uses `G10 L2 P1` workspace offsets (or `M218` tool offsets) to account for differing tip lengths and X/Y offsets, ensuring the needle tip always aligns exactly with the camera-calibrated origin.
- **Rack Management:** Manages an array of slots (4–8 slots) in a physical tip rack.
- **Tool Change Sequence:** Dispatches G-code macros (`T0`, `T1`, etc.) to physically park the old tip and pick up the new one, verifying success via `TIP_STATUS` feedback from the embedded controller.

---

### 5.13 Automatic Tip Cleaning Mechanism

**File:** `hooks/useTipCleanerManager.js` & `components/TipCleanerPanel.jsx`

Manages a servo-actuated bucket and air jet system to clean the dispensing tip.
- **Interval Tracking:** Tracks pads dispensed during jobs against a configurable threshold. When the limit is reached, it automatically interrupts the job, dispatches a tip clean sequence (via M-code), and resumes the job.
- **Preflight & Safety:** Blocks the job start if a mandatory clean is pending or if the mechanical servo/air-jet system reports a fault.
- **Telemetry:** Parses `TIP_CLEAN:START/DONE/FAIL` events to sync state and record detailed event logs.

---

### 5.14 Quick Tip Rotation Mechanism

**File:** `hooks/useTipRotationManager.js` & `components/TipRotationPanel.jsx`

Controls a small stepper motor that rotates the soldering iron tip from 0° to 180° to achieve the optimal soldering angle for each operation.

- **Homing & Zero Reference:** Before any angle command can be accepted, the axis must be homed (`M731`). Homing establishes the physical 0° position using the embedded endstop, after which the motor encoder tracks all subsequent movements. The UI shows a persistent "Not Homed" warning until this is done and provides a recalibration button (Home → move to default recipe angle) for when the angle drifts.
- **Recipe Angle Storage:** A `defaultSolderAngle` setting is persisted in `localStorage`. When a job starts, `AutomatedDispensingPanel` reads this value and automatically commands `M730 R{angle}`, rotating the tip to the configured recipe angle before the first pad is dispensed.
- **Status Visibility:** The Dashboard metric card and the panel badge reflect the live state — `IDLE`, `HOMING`, `ROTATING`, `TARGET_REACHED`, or `FAULT` — so operators always understand why a job may be waiting for the mechanism.
- **Preflight Guard:** Jobs are blocked if the axis is in FAULT state or has not been homed.
- **Serial Protocol:**
  - `M730 R{angle}` — command rotation to `angle` degrees (0–180)
  - `M731` — home the rotation axis to 0°
  - Firmware replies: `TIP_ROT:HOMING`, `TIP_ROT:HOMED`, `TIP_ROT:MOVING R45`, `TIP_ROT:REACHED R45`, `TIP_ROT:FAULT {reason}`

---

## 6. Component Reference

### `App.jsx`

Root component. Owns all shared state and passes it downward as props.

**Key state:**
```
layers[]          — loaded Gerber layers
pads[]            — extracted pad list (design coords)
fiducials[]       — [{id, design:{x,y}, machine:{x,y}}]
xf                — computed transform matrix (null until solved)
applyXf           — boolean flag (transform enabled)
machinePosition   — {x,y,z} — updated from serial data lines
isConnected       — serial port open
isHomed           — machine has been G28'd
panelBoards[]     — array of sub-boards for panelized PCBs
panelXf           — global panel transform
```

### `AutomatedDispensingPanel.jsx`

The main workflow controller. ~3 200 lines. Manages all dispensing stages:

```
idle → preflight → homing → purging → loading → registering
     → probing → dispensing → finished
```

Key internal state:
- `jobStage` — current stage string
- `activeSequence` — sorted pad array for current run
- `jobProgress` — `{current, total}`
- `currentPadInfo` — live pad feedback `{pressure, dwellMs, volumeUl}`
- `jobReport` — post-job summary `{totalPads, totalVolUl, jobDurationSec}`
- `boardConfirmed` — auto-set to `true` when `xf` is solved (board seen by camera)
- `dotCheckResults[]` — per-pad QC results from vision API

### `FiducialPanel.jsx`

Board alignment editor. Renders a table of fiducial pairs with:
- Click-to-set design position (from Viewer click event)
- Machine coordinate capture from current `machinePosition`
- Solve buttons (2-point similarity / 3-point affine)
- RMS error display and color-coded quality badge

### `CameraPanel.jsx`

Wraps the browser `getUserMedia` video stream. Provides:
- Live crosshair overlay for nozzle centering
- Fiducial snap: calls `FiducialVisionDetector` on each frame, jogs machine to center
- Tool offset calibration (camera-to-nozzle pixel→mm mapping)
- Lens distortion calibration (HTTP to Python backend)

### `SerialPanel.jsx`

Port management and G-code terminal.
- `window.serial.list()` → port dropdown
- Manual G-code input with history
- Macro buttons: `G28`, `G92 X0 Y0 Z0`, `M84`, custom sequences
- Live console output (raw serial data lines)

### `JogPanel.jsx`

Manual machine movement.
- XY D-pad (3×3 grid, circular layout) + separate Z column
- Step size: 0.01 / 0.1 / 1 / 10 / 50 mm
- Feed rate input
- Safe-Z move to machine coordinate

---

## 7. State Architecture

There is no global state manager (no Redux, no Zustand). State flows via React props and callbacks.

```
App.jsx  (source of truth)
   │
   ├─ props down ──────────────────────────────────────────────
   │     fiducials, xf, applyXf, machinePosition, isConnected,
   │     isHomed, pads, panelBoards, panelXf, toolOffset
   │
   └─ callbacks up ────────────────────────────────────────────
         onInputMachine(fidId, {x,y})   → set fiducial.machine
         onSolve2() / onSolve3()        → compute + set xf
         onAutoAlign()                  → vision-snap all fiducials
         onJobComplete()                → trigger batch advance
```

**LocalStorage keys** (see §14 for full list):

| Key | Type | Owner |
|---|---|---|
| `resumeFromPad` | `number` | AutomatedDispensingPanel |
| `axisLimits` | `{maxX,maxY,maxZ}` | AutomatedDispensingPanel |
| `calibCaptures` | `Capture[]` | AutomatedDispensingPanel |
| `nozzleDia` | `number` | AutomatedDispensingPanel |
| `glueStock` | `number` | GlueStore |
| `spcDotQuality` | `{jobs[]}` | AutomatedDispensingPanel |
| `glueRecipes` | `Record<name,Recipe>` | AutomatedDispensingPanel |

---

## 8. Electron IPC API

All handlers are defined in `electron/main.js`. Called from preload via `ipcRenderer.invoke()`.

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `serial:list` | R→M | — | `SerialPortInfo[]` |
| `serial:open` | R→M | `{path, baudRate}` | `true` |
| `serial:close` | R→M | — | `true` |
| `serial:writeLine` | R→M | `string` | `true` |
| `serial:sendGcode` | R→M | `string` | `true` |
| `serial:writeMany` | R→M | `{lines[], delayMs}` | `true` |
| `serial:data` | M→R | `string` (raw line) | — |
| `serial:disconnected` | M→R | — | — |
| `serial:port-appeared` | M→R | `{path, baudRate}` | — |
| `vision:status` | R→M | — | `{ready, startupError}` |
| `vision:ready` | M→R | — | — |
| `vision:stopped` | M→R | `{code, error}` | — |
| `fs:saveJobLog` | R→M | `{filename, content}` | `{ok, path}` |
| `app:quit` | R→M | — | — |

---

## 9. Machine Control Protocol

### Target Firmware

Marlin 2.x or GRBL 1.1 (both speak the same G-code subset used here).

### Valve Trigger (Glue Dispenser 983A)

```
App (M106 S255) → Ender-3 fan output pin → 4.7kΩ resistor → MOSFET gate
                                                              │
                                                              ▼
                                                   MOSFET drain → 983A trigger input
                                                   MOSFET source → GND (common)
```

- `M106 S255` — fan pin HIGH → MOSFET ON → 983A opens valve → glue flows
- `M107` — fan pin LOW → MOSFET OFF → 983A closes valve → glue stops
- `pwmDuty` (0–255) controls `M106 S{n}` for variable flow rate

### Coordinate System

```
G21        ; mm units
G90        ; absolute mode
G28 X Y Z  ; home (run once per session)
G92 X0 Y0  ; set work origin at current position (after jogging to board corner)
```

All pad coordinates in the job are in work-space mm after transform.

---

## 10. Job Execution Pipeline

```
runDispenseLoop() in AutomatedDispensingPanel.jsx
│
├─ for each board in panelBoards:
│   │
│   ├─ [optional] Dynamic Vision Correction
│   │     ─ Move camera to each fiducial's predicted position
│   │     ─ Call window.__SNAP_FIDUCIAL_MACHINE_COORD__()  (from CameraPanel)
│   │     ─ Re-solve transform with fresh machine coordinates
│   │
│   └─ for each pad in activeSequence:
│       │
│       ├─ applyTransform(boardXf, pad)         → {mx, my}
│       ├─ idwCorrect(mx, my, calibCaptures)    → {dx, dy} fine-tune offset
│       ├─ getZOffsetForPoint(mx, my)           → dz  (bed mesh)
│       ├─ calculateDwellTime(pad, opts)        → dwellMs
│       ├─ calculatePadPressure(pad, opts)      → psi
│       ├─ pad.area >= beadAreaThreshold?
│       │     dispenseBead(...)                 → string[]
│       │   : dispensePoint(...)               → string[]
│       ├─ serial.writeMany(gcode)
│       ├─ [optional] fetch('/api/check_glue_dot') → QC result
│       ├─ setCurrentPadInfo({pressure, dwellMs, volumeUl})
│       └─ setJobProgress({current, total})
│
└─ post-job:
    ├─ spcAppend(dotCheckResults)
    ├─ fs:saveJobLog (CSV)
    ├─ nozzleMaintenance.recordDispense(totalPads)
    └─ setJobStage('finished')
```

**Resume after interruption:** `resumeFromPad` (localStorage) saves the last completed index. On next run the operator can skip already-dispensed pads.

---

## 11. Vision Server (Python)

### Startup

In development: started separately via `npm run dev` (concurrently script).  
In production: `main.js` spawns `python server.py` as a child process with `-u` (unbuffered stdout).

Electron health-polls `http://localhost:8000/` every 2 seconds (max 40 s) to detect readiness, independent of stdout buffering. Falls back to stderr parsing for uvicorn startup messages.

### Key Endpoints

**`POST /api/detect_fiducial`**

```json
Request:  { "frame": "<base64 JPEG>" }
Response: { "found": true, "x": 320, "y": 240, "confidence": 0.91 }
```

Uses OpenCV `HoughCircles` + template matching against known fiducial patterns.

**`GET /api/check_glue_dot`**

```json
Response: {
  "passed": true,
  "diameter_mm": 0.62,
  "confidence": 0.87,
  "padIndex": 14
}
```

Compares observed dot diameter against expected value (nozzle diameter × 1.3). Used by the SPC (Statistical Process Control) system.

**`GET /api/check_board_present`**

```json
Response: {
  "present": true,
  "confidence": 0.95,
  "std_dev": 12.4,
  "reason": "High contrast PCB detected in frame center"
}
```

When `present: true`, `AutomatedDispensingPanel` automatically sets `boardConfirmed = true`.

---

## 12. Hardware Setup

### Minimum Required

| Component | Spec |
|---|---|
| 3-axis CNC / 3D printer | Marlin or GRBL firmware, USB serial |
| Pneumatic glue dispenser | 983A or equivalent with 3.5mm trigger input |
| USB camera | Any `getUserMedia`-compatible webcam |
| PC | Windows 10/11 or Linux, Node.js 18+, Python 3.9+ |

### Tested Configuration

- **CNC:** Creality Ender-3 (Creality v1.1.x board, Marlin 2.0)
- **Dispenser:** 983A pneumatic controller
- **Valve trigger circuit:**
  ```
  Ender-3 FAN+ (24V) ─── R1 (10kΩ) ─┐
                                      ├── Gate of IRF540N MOSFET
  Ender-3 FAN- (PWM) ─── R2 (10kΩ) ─┘
                                      └── R3 (10kΩ) pull-down to GND
  MOSFET Drain ──── 983A Trigger Signal
  MOSFET Source ─── GND (common with Ender-3 and 983A)
  ```
- **G-code valve commands:** `M106 S255` (open) / `M107` (close)

### Firmware Requirements

- `M42` or `M106`/`M107` must be enabled in Marlin `Configuration_adv.h`
- `EMERGENCY_PARSER` recommended for reliable E-stop response
- Baud rate: 115200 (default, configurable in Serial panel)

---

## 13. Development Guide

### Prerequisites

```bash
node >= 18
python >= 3.9
pip install fastapi uvicorn opencv-python-headless numpy
```

### Install & Run

```bash
# Install JS dependencies
npm install

# Development mode (Vite dev server + Electron + Python vision server)
npm run dev

# Build production bundle
npm run build

# Package Electron app
npm run dist
```

### Environment

| Mode | Electron `isDev` | Vite URL | Vision server |
|---|---|---|---|
| `npm run dev` | `true` | `http://localhost:5173` | Started manually / by concurrently |
| Packaged | `false` | `dist/index.html` (file://) | Spawned by Electron main process |

### Adding a New IPC Channel

1. Add handler in `electron/main.js`:
   ```js
   ipcMain.handle('my:channel', async (e, payload) => { ... });
   ```
2. Expose in `electron/preload.js` via `contextBridge.exposeInMainWorld`
3. Call from renderer: `await window.ipcRenderer.invoke('my:channel', payload)`

### Adding a New Vision Endpoint

1. Add route in `python-vision/server.py`
2. Call from renderer with `fetch('http://localhost:8000/api/my-endpoint')`
3. Handle `vision:stopped` event to show degraded-mode UI if server is offline

---

## 14. Configuration & Persistence

All user settings are stored in `localStorage`. There is no external config file.

| Key | Default | Description |
|---|---|---|
| `nozzleDia` | `0.6` | Nozzle diameter (mm) — affects volume estimates |
| `axisLimits` | `{maxX:300,maxY:300,maxZ:50}` | Software travel limits (mm) |
| `resumeFromPad` | `0` | Index of first unfinished pad (job resume) |
| `calibCaptures` | `[]` | Fine-tune correction vectors from "Capture True Center" |
| `glueStock` | `5000` | Remaining glue stock (µL) |
| `spcDotQuality` | `{jobs:[]}` | Rolling 60-job SPC dataset |
| `glueRecipes` | `{}` | Named dispense recipes (pressure + dwell presets) |
| `baseDwellTime` | `120` | Default dwell time (ms) |
| `localPressure` | `25` | Base dispense pressure (PSI) displayed to operator |
| `beadAreaThreshold` | `2.0` | mm² above which bead mode is used instead of dot |
| `beadFeedRate` | `500` | Feed rate during bead sweep (mm/min) |
| `enableDotVerification` | `false` | Enable post-dispense QC camera check |
| `purgeEnabled` | `false` | Run nozzle purge before first pad |
| `purgeDurationMs` | `2000` | Purge duration |
| `enableSurfaceProbe` | `false` | Use Z-probe for surface height detection |

**Job log files** are saved to `Documents/GlueJobLogs/` via the `fs:saveJobLog` IPC channel as CSV with columns: `Board, Components, Volume_uL, Duration_s, DotsFailed, DotsChecked, PassRate, AvgDiameter_mm, Time`.

---

*Documentation reflects codebase state as of June 2026.*
