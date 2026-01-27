# 3-Axis Automated Glue Dispensing Robot Software

## 1. Project Overview
This software controls a 3-axis CNC-style robot for automated fluid dispensing (Glue, Solder Paste, Flux, etc.) on PCBs. It allows you to:
1.  **Import PCB Designs**: Load Gerber files directly.
2.  **Align**: Use a camera for "Vision Alignment" (Fiducial detection).
3.  **Plan**: Auto-generate G-code paths (Nearest Neighbor optimization) with collision avoidance.
4.  **Dispense**: accurate control of the dispensing valve via G-code.

## 2. Transition Roadmap: From Soldering to Dispensing
You are transitioning from a **Soldering Robot** (Heating Element + Wire Feeder) to a **Dispensing Robot** (Syringe + Valve/Piston).

### 2.1 Hardware Modifications
*   **Remove**: Soldering Iron Head and Solder Wire Feeder mechanism.
*   **Install**: 
    *   **Dispensing Head**: A syringe holder or a jet valve mounted on the Z-axis.
    *   **Actuator**:
        *   *Pneumatic System*: Requires a Solenoid Valve connected to a controller pin.
        *   *Motorized System*: A NEMA stepper motor pushing a plunger (Linear Actuator).

### 2.2 Firmware Requirements
The software generates the following G-code for dispensing:
*   **Move**: `G0`/`G1` for X/Y/Z motion.
*   **Trigger**: `M42 P4 S<val>` (Digital Write / PWM).
    *   **Critical**: Your robot controller firmware (Marlin/GRBL) must enable the dispense valve when it receives `M42`.
    *   *Alternative*: If using a Stepper Motor (Extruder), you must modify `src/lib/automation/dispensingSequence.js` to output `E` axis moves (e.g., `G1 E1.0`) instead of `M42`.

### 2.3 Software Configuration
No code changes are strictly required if you use a **Pneumatic/Solenoid** system.
*   **Adjust Settings**: In the "Pressure/Viscosity" panel:
    *   *High Pressure* = Stronger Glue.
    *   *Dwell Time* = Larger dots.

---

## 3. Project Structure Analysis
This is a **React + Vite + Electron** application.

### Root Directory
*   `electron/`: **Backend / Main Process**. Handles Serial Port communication (USB) and Window management.
*   `src/`: **Frontend / Renderer**. The React UI implementation.

### Source Code (`src/`) Breakdown

#### Core Logic (`src/lib/`)
| Folder | Purpose | Modification Needed for Glue? |
| :--- | :--- | :--- |
| **`libs/gerber/`** | Parses Gerber files, finds Pads. | **No**. Pads are same for Solder/Glue. |
| **`libs/motion/`** | `gcode.js`: Generates G0/G1 strings. | **No**. Motion is identical. |
| **`libs/automation/`** | `dispensingSequence.js`: The "Brain". | **Maybe**. Currently uses `M42` (Pin toggle). Edit this if you need `E-axis` extrusion. |
| **`libs/vision/`** | Camera alignment & Fiducial finding. | **No**. Vision is standard. |
| **`libs/collision/`** | Avoids hitting components on Z-travel. | **No**. Essential for nozzle safety. |

#### UI Components (`src/components/`)
| Component | Function |
| :--- | :--- |
| `App.jsx` | Main layout and state container. |
| `Viewer.jsx` | The interactive PCB visualizer (Canvas/SVG). |
| `SerialPanel.jsx` | Connect/Disconnect Robot, send manual G-code. |
| `CameraPanel.jsx` | Webcam feed + Alignment controls. |
| `AutomatedDispensingPanel.jsx` | **Main Control**: Sequence generation & Job Start. |
| `PressurePanel.jsx` | Settings for Glue "Shot Size" (Time/Pressure). |

---

## 4. Development & Installation

### Prerequisites
*   Node.js (v18+)
*   NPM

### Installation
```bash
npm install
```

### Running the App
```bash
# Run in Development Mode (Hot Reload)
npm run dev
```

### Building for Production
```bash
# Create Windows .exe
npm run build
```

## 5. Typical Workflow for Glue Dispensing

1.  **Load File**: Drag & Drop your PCB Gerber file (Paste Layer).
2.  **Select Pads**: The app auto-detects pads. You can manually exclude ones you don't want.
3.  **Vision Align (Optional)**:
    *   Jog robot to Fiducial 1 -> Click "Capture".
    *   Jog robot to Fiducial 2 -> Click "Capture".
    *   App calculates rotation/offset.
4.  **Set Parameters**:
    *   *Viscosity Profile*: Choose "Glue" (creates longer dwell times).
5.  **Generate Job**: Click "Generate Path".
    *   App creates G-code: `Move to Pad -> Z Down -> Trigger Valve (M42) -> Z Up`.
6.  **Run**: Click "Start Job".
