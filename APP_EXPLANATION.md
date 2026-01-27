# PCB Solder Paste Dispensing Application - Complete Feature Explanation

## Overview
This is a comprehensive offline application for automated solder paste dispensing on PCBs using a 3-axis machine. It processes Gerber files, generates G-code for automated dispensing, provides camera-based alignment, and manages batch processing.

---

## Application Architecture

### Technology Stack
- **Frontend**: React 19 with Vite
- **Desktop App**: Electron
- **Serial Communication**: SerialPort for machine control
- **Gerber Processing**: pcb-stackup, gerber-parser, whats-that-gerber
- **File Handling**: JSZip for ZIP file extraction

---

## Core Components

### 1. **Main Application (App.jsx)**
The central component that orchestrates all functionality:
- Manages application state (layers, pads, fiducials, settings)
- Coordinates between UI panels and library modules
- Handles file loading and processing
- Manages coordinate transformations and path planning

### 2. **Viewer Component (Viewer.jsx)**
Interactive PCB visualization:
- Displays Gerber layers as SVG
- Supports top/bottom side viewing
- Mirror mode for bottom side
- Click-to-select pad functionality
- Overlay rendering for fiducials, paths, and live preview

### 3. **Layer Management (LayerList.jsx)**
- Lists all loaded Gerber layers
- Toggle layer visibility
- Identifies layer types (copper, soldermask, drill, paste, etc.)
- Shows layer metadata

---

## Major Feature Modules

### 1. **Gerber File Processing**

#### **Layer Identification** (`lib/gerber/identifyLayers.js`)
- Automatically identifies layer types from filenames
- Recognizes standard naming conventions (GTL, GBL, GTS, GBS, etc.)
- Categorizes layers: copper, soldermask, drill, paste, outline, etc.

#### **Pad Extraction** (`lib/gerber/extractPads.js`)
- Parses Gerber files to extract pad positions
- Handles both flash (D03) and draw operations
- Extracts pad dimensions from aperture definitions
- Supports circular and rectangular pads
- Parses aperture macros for complex shapes
- Converts between inches and millimeters

#### **Board Outline Detection** (`lib/gerber/boardOutline.js`)
- Extracts PCB board dimensions
- Calculates board center and bounds
- Used for collision detection and path planning

#### **SVG Generation** (`lib/gerber/stackupToSvg.js`)
- Converts Gerber layers to SVG for visualization
- Supports multi-layer stackup rendering
- Handles layer ordering and transparency

---

### 2. **Fiducial Detection & Alignment**

#### **Automatic Fiducial Detection** (`lib/gerber/fiducialDetection.js`)
- Scans Gerber files for fiducial markers
- Identifies fiducials by size (typically 0.5-5mm)
- Scores candidates based on:
  - Circular aperture type
  - Size (prefers 1-2mm)
  - Spatial distribution
  - Typical count (2-4 fiducials)
- Merges fiducials from multiple layers
- Provides confidence scores

#### **Fiducial Panel** (`components/FiducialPanel.jsx`)
- Manual fiducial placement by clicking on PCB
- Drag-and-drop fiducial positioning
- Machine coordinate input for each fiducial
- Supports 2-point similarity transform
- Supports 3-point affine transform
- Visual feedback with color-coded fiducials
- Auto-align feature for quick setup

#### **Coordinate Transformation** (`lib/utils/transform2d.js`)
- **Similarity Transform**: Translation, rotation, and uniform scaling (2+ fiducials)
- **Affine Transform**: Full 6-parameter transformation (3+ fiducials)
- Calculates RMS error for transform quality
- Applies transforms to convert design coordinates to machine coordinates

#### **Origin Detection** (`lib/gerber/originDetection.js`)
- Automatically detects PCB origin (typically top-left corner)
- Supports multiple origin candidates
- Provides confidence scores
- Used as reference point for coordinate transformation

---

### 3. **Path Planning & Motion Control**

#### **Dispensing Sequence** (`lib/automation/dispensingSequence.js`)
- **Nearest Neighbor Algorithm**: Calculates optimal pad dispensing order
- Minimizes total travel distance
- Generates complete G-code for dispensing job
- Calculates job statistics (total distance, estimated time)

#### **Path Generation** (`lib/motion/pathGeneration.js`)
- **Direct Path**: Straight line movement
- **Safe Path**: Lift-move-lower sequence to avoid obstacles
- **Optimized Path**: Waypoint-based obstacle avoidance
- **Zig-Zag Path**: Incremental X/Y movements

#### **Safe Path Planning** (`lib/automation/safePathPlanner.js`)
- **3D Collision Avoidance**: Plans paths considering component heights
- Analyzes paths for obstacles
- Generates safe Z-height movements
- Supports high-clearance paths for tall components
- Discretizes paths into small segments for collision checking

#### **G-Code Generation** (`lib/motion/gcode.js`)
- Standard G-code commands (G0, G1, G28, G92, etc.)
- Supports multiple axis mappings
- Feed rate control
- Work coordinate system (G92)
- Home positioning (G28)

---

### 4. **Pressure Control**

#### **Pressure Controller** (`lib/pressure/pressureControl.js`)
- **Viscosity Presets**:
  - Low (Flux): 15 PSI, 80ms dwell
  - Medium (Standard): 25 PSI, 120ms dwell
  - High (Thick): 40 PSI, 180ms dwell
- **Pad-Based Adjustments**:
  - Small pads (<0.5mm²): Higher pressure, shorter dwell
  - Large pads (>10mm²): Lower pressure, longer dwell
- Generates pressure control G-code (M42 commands)

#### **Pressure Panel** (`components/PressurePanel.jsx`)
- Viscosity selection
- Custom pressure and dwell time settings
- Real-time optimal settings calculation for selected pad
- Preset information display

---

### 5. **Speed Profiles**

#### **Speed Profile Manager** (`lib/speed/speedProfiles.js`)
- **Profile Categories**:
  - Micro pads (<0.5mm²): Slower speeds, precise control
  - Small pads (0.5-2mm²): Moderate speeds
  - Medium pads (2-10mm²): Standard speeds
  - Large pads (>10mm²): Faster speeds
- **Speed Parameters**:
  - Travel speed (between pads)
  - Approach speed (lowering to pad)
  - Dispense speed (during dispensing)
  - Retract speed (lifting from pad)
- Auto-adjustment based on pad size and viscosity

#### **Speed Panel** (`components/SpeedPanel.jsx`)
- Enable/disable auto-adjustment
- Global speed multiplier (0.5x - 2.0x)
- Profile statistics for loaded pads
- Detailed profile information

---

### 6. **Camera Vision System**

#### **Camera Panel** (`components/CameraPanel.jsx`)
- Live camera feed from webcam
- **Homography Calibration**: Maps camera pixels to machine coordinates
  - Requires 4+ point pairs (fiducial positions)
  - Calculates perspective transformation matrix
- **Overlay System**:
  - Predicted tool position overlay
  - Fiducial markers overlay
  - Measurement mode for error checking
- **Tool Offset**: Compensates for camera-to-nozzle offset

#### **Vision Features** (`lib/vision/`)
- **Fiducial Vision Detector**: Camera-based fiducial detection
- **Pad Detector**: Vision-guided pad detection
- **Quality Controller**: Paste quality analysis
  - Coverage analysis
  - Volume estimation
  - Pass/fail criteria

---

### 7. **Collision Detection**

#### **Collision Detector** (`lib/collision/collisionDetection.js`)
- Checks nozzle path for component collisions
- Interpolates paths into small segments
- Calculates clearance distances
- Generates safe paths with intermediate waypoints
- Updates component database dynamically

---

### 8. **Batch Processing**

#### **Batch Processor** (`lib/batch/batchProcessor.js`)
- **Batch Creation**: Create batches for multiple boards
- **Board Management**: Add/remove boards from batches
- **Status Tracking**: 
  - Pending, running, paused, completed, failed
  - Per-board status tracking
- **Statistics**: Total pads, completed pads, time estimates

#### **Batch Executor** (`lib/batch/batchExecutor.js`)
- Executes batch jobs sequentially
- Handles board positioning
- Manages job progression
- Error handling and recovery

#### **Batch Panel** (`components/BatchPanel.jsx`)
- Create new batches
- Add current board to batch
- Start/pause/resume batch processing
- View batch status and progress
- Delete batches

---

### 9. **Automated Dispensing**

#### **Automated Dispensing Panel** (`components/AutomatedDispensingPanel.jsx`)
- **Single Board Mode**: Process one board at a time
- **Batch Mode**: Process multiple boards in sequence
- **Path Planning Mode Selection**:
  - Simple nearest neighbor
  - Safe path planning with collision avoidance
- **Job Statistics Display**:
  - Total pads
  - Total distance
  - Estimated time
  - Average distance per pad
- **G-Code Generation**: Downloads complete G-code files

---

### 10. **Serial Communication**

#### **Serial Panel** (`components/SerialPanel.jsx`)
- **Port Management**:
  - Auto-detect serial ports
  - Baud rate selection (default 115200)
  - Connect/disconnect functionality
- **G-Code Transmission**:
  - Send individual G-code lines
  - Upload and send G-code files
  - Real-time console output
- **Job Control**:
  - Start automated dispensing job
  - Stop job (emergency stop)
  - Progress tracking
  - Machine status monitoring (idle/busy/error)

---

### 11. **Component Management**

#### **Component List** (`components/ComponentList.jsx`)
- Lists all pads/components
- Sorted by distance from reference point
- Click to focus on component
- Shows pad dimensions and positions
- Displays transformed coordinates

---

### 12. **Live Preview**

#### **Live Preview Component** (`components/LivePreview.jsx`)
- Real-time visualization of dispensing progress
- Shows current pad being dispensed
- Marks completed pads
- Displays machine position
- Updates overlay dynamically

---

## Workflow

### Typical Workflow:

1. **Load PCB Files**:
   - Upload Gerber files (individual files or ZIP)
   - Application automatically identifies layers
   - Extracts pads from solderpaste layer

2. **Setup Reference System**:
   - Detect or manually set PCB origin
   - Detect fiducials automatically or place manually
   - Input machine coordinates for fiducials
   - Calculate coordinate transformation

3. **Configure Dispensing**:
   - Select paste viscosity
   - Adjust pressure and dwell time
   - Configure speed profiles
   - Set nozzle diameter

4. **Camera Calibration** (Optional):
   - Position camera over PCB
   - Calibrate homography with 4+ point pairs
   - Verify alignment accuracy

5. **Path Planning**:
   - Select path planning mode (simple or safe)
   - Review dispensing sequence
   - Check job statistics

6. **Execute Job**:
   - Connect to machine via serial
   - Start automated dispensing
   - Monitor progress in real-time
   - Handle errors and maintenance alerts

---

## Advanced Features

### 1. **Nozzle Maintenance** (`lib/maintenance/nozzleMaintenance.js`)
- Tracks dispensing count
- Monitors hours since last cleaning
- Provides maintenance reminders
- Records cleaning events

### 2. **Quality Control** (`lib/quality/qualityControl.js`)
- Analyzes paste coverage
- Estimates paste volume
- Provides pass/fail criteria
- Stores quality metrics

### 3. **Paste Visualization** (`lib/paste/pasteVisualization.js`)
- Visualizes paste dots on pads
- Shows dispensing pattern
- Calculates optimal dot spacing
- Considers nozzle diameter

### 4. **Coordinate Debugging** (`lib/debug/coordinateDebug.js`)
- Detailed coordinate conversion logging
- Verifies transformation accuracy
- Helps troubleshoot alignment issues

---

## Key Algorithms

### 1. **Nearest Neighbor Path Optimization**
- Greedy algorithm that finds closest unvisited pad
- Minimizes total travel distance
- O(n²) complexity for n pads

### 2. **Safe Path Planning**
- 3D path analysis with height consideration
- Path discretization for collision checking
- Dynamic safe height calculation
- Waypoint generation for obstacle avoidance

### 3. **Fiducial Detection**
- Multi-criteria scoring system
- Spatial distribution analysis
- Size-based filtering
- Layer priority weighting

### 4. **Homography Calculation**
- 4-point algorithm for perspective transformation
- Least squares solution for over-determined systems
- RMS error calculation for quality assessment

---

## Configuration & Settings

### Persistent Storage (localStorage):
- Tool offset (camera-to-nozzle)
- PCB origin offset
- Nozzle diameter
- Pressure settings
- Speed settings
- Camera calibration pairs
- Homography matrix

### Default Values:
- Safe height: 5-6mm
- Travel speed: 3000 mm/min
- Dispensing speed: 600 mm/min
- Nozzle diameter: 0.6mm
- Default pressure: 25 PSI
- Default dwell: 120ms

---

## Machine Control Commands

### G-Code Commands Used:
- `G21`: Set units to millimeters
- `G90`: Absolute positioning
- `G28`: Home all axes
- `G92`: Set work coordinate system
- `G0/G1`: Linear movement
- `G4`: Dwell/pause
- `M42`: I/O control (pressure control)
- `M84`: Disable steppers

---

## Error Handling

- Invalid Gerber files
- Missing fiducials
- Serial communication failures
- Camera access issues
- Coordinate transformation errors
- Collision detection warnings
- Maintenance reminders

---

## Future Enhancements (Commented Code)

- OpenCV integration for advanced vision
- Linear move panel with manual control
- Enhanced path optimization algorithms
- Real-time quality monitoring
- Advanced batch scheduling

---

## Summary

This application provides a complete solution for automated solder paste dispensing:
- **File Processing**: Gerber parsing, layer identification, pad extraction
- **Alignment**: Fiducial detection, coordinate transformation, origin detection
- **Path Planning**: Optimal sequencing, collision avoidance, safe path generation
- **Machine Control**: G-code generation, serial communication, job execution
- **Vision System**: Camera calibration, overlay visualization, quality control
- **Batch Processing**: Multi-board management, progress tracking, error handling

The application is designed for precision work with 3-axis dispensing machines, providing both automated and manual control options with extensive customization capabilities.

