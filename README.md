# Industrial Automated Glue Dispensing Robot Software

## 1. Project Overview
This is a high-performance **React + Electron** application for controlling a 3-axis CNC glue dispensing robot. It is designed for industrial-grade PCB assembly, featuring advanced computer vision alignment, smart dispensing profiles, and batch processing capabilities.

## 2. Key Features

### 🎯 precision Alignment & Vision
*   **Fiducial Detection**: Automatically detects circular fiducials on the PCB using computer vision (OpenCV).
*   **Multi-Point Alignment**: accurate "Similarity" and "Affine" variable transforms to compensate for PCB rotation, scale, and shear.
*   **Panelized Support**: Detects and aligns entire panels of boards.

### 🚀 Smart Dispensing
*   **Dynamic Speed Profiles**: Automatically adjusts machine speeds based on pad size:
    *   *Micro Pads* (<0.5mm): Slow, precise movements (6000mm/min travel).
    *   *Large Pads* (>4mm): High-speed operation (12000mm/min travel).
*   **Geometric Volume Mapping**: Parses native Gerber shapes (Circle, Rectangle, Obround) to mathematically calculate true pad surface area (mm²).
*   **Proportional Dwell Control**: Linearly scales the glue dispense dwell time exactly proportional to the physical pad area, ensuring perfect fluid volume control.
*   **Path Optimization**: Uses "Nearest Neighbor" and collision-aware routing to minimize travel time.

### 🏭 Production Batch Processing
*   **Job Queues**: Create batches to process multiple boards in sequence.
*   **Auto-Cycle**: Load a board, run the job, and automatically prompt for the next one.
*   **Analytics**: Tracks successful/failed boards, pads dispensed, and cycle times.

### 🖥️ Industrial UI
*   **Interactive Viewer**: 
    *   SVG-based real-time visualization of Gerber files.
    *   Multi-select support for custom path planning.
    *   Live machine position tracking.
*   **Dedicated Control Panels**:
    *   **Automated Panel**: Main workflow controller featuring a Live **Dispense Sequence Preview** (visually confirms calculated mathematical pad areas and dwell timings before execution).
    *   **Manual Jog**: Precise axis control with Z-axis safety.
    *   **Serial Terminal**: Direct G-code communication.

## 3. Workflow Guide

### Step 1: Import Design
1.  Drag & Drop your **Gerber Paste Layer** (.GBR / .GTP) into the viewer.
2.  The app automatically extracts pad coordinates and dimensions.

### Step 2: Alignment (Critical)
1.  Go to **Fiducial Panel**.
2.  Select **Fiducial 1** in the list.
3.  Jog the machine camera to the physical fiducial location.
4.  Click **Capture**.
5.  Repeat for **Fiducial 2**.
6.  The system calculates the transformation matrix. **Green status** indicates good alignment.

### Step 3: Configuration
1.  **Pressure Panel**: Select your glue viscosity (e.g., "Solder Paste Type 4", "Red Glue").
    *   *Tip*: Use "Advanced" to manually tweak PSI/Dwell if needed.
2.  **Speed Panel**: Enable "Auto-adjust speeds" for best performance.
    *   Use the **Global Multiplier** slider to slow down the machine safely for testing.

### Step 4: Execution
*   **Single Board**: Click "Start Job" in the Automated Panel.
*   **Batch Run**: 
    1.  Go to **Batch Panel**.
    2.  Create a "New Batch".
    3.  Click "Add Current Board".
    4.  Start Batch.

## 4. Hardware Requirements
*   **Controller**: Marlin/GRBL based 3-axis CNC controller.
*   **Dispenser**:
    *   **Pneumatic**: Solenoid valve triggered by `M42` / `M106`.
    *   **Motorized**: Stepper-driven extruder via `E` axis.
*   **Camera**: Down-looking USB camera mounted on the Z-head.

## 5. Development

### Installation
```bash
npm install
```

### Running Locally
```bash
npm run dev
```

### Building for Production
```bash
npm run build
```
