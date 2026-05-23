# OKR Report — Mayank Rathore | May 2026
**Period:** April 26, 2026 – May 22, 2026
**Project:** Autonomous PCB Glue Dispensing Machine

---

## Task 1 — Auto Fiducial Marking on Gerber SVG
**Theme:** PCB Setup & Vision | **Priority:** 1 | **Owner:** Mayank Rathore | **Project Stage:** 85%

### Sub Tasks
1. Automatically detects fiducial markers from the uploaded Gerber file without any manual input.
2. Visually marks fiducials on the SVG image of the PCB displayed in the app.
3. Integrated Python camera vision server (`server.py`) to handle detection logic.
4. Eliminates the need for the operator to manually identify or mark reference points on the board.
5. Acts as the foundation for all coordinate mapping and alignment operations in the machine.

### Baseline Measurement
- **Before:** No auto-detection — operator had to manually identify fiducial positions, which was slow and error-prone.
- **After:** Machine auto-identifies reference points, enabling accurate coordinate mapping without human input. This feature is the backbone of all alignment that follows.

### Employee Update
Working in current testing. Future modification needed: improve detection robustness under varying factory lighting conditions and different PCB finishes (HASL vs ENIG).

---

## Task 2 — Nozzle-Camera Offset Alignment Improvement
**Theme:** Dispensing Accuracy | **Priority:** 1 | **Owner:** Mayank Rathore | **Project Stage:** 90%

### Sub Tasks
1. Recalibrated the offset calculation between the camera crosshair and the actual nozzle tip position.
2. Nozzle now moves precisely to the center of each pad before dispensing glue.
3. Fixed dispensing offsets that were causing glue to land slightly off-center on pads.
4. Alignment is consistent across different pad sizes and zoom levels.
5. The camera and nozzle positions are now synchronized with sub-millimeter accuracy.

### Baseline Measurement
- **Before:** Glue was landing at a slightly off-center position (~±0.5mm offset) due to miscalibrated nozzle-camera offset.
- **After:** Glue lands precisely at pad center (~±0.1mm), which directly improves solder joint quality and reduces component misplacement during pick-and-place after dispensing.

### Employee Update
Working well. Future modification: may need a per-board fine-tune option since different PCBs can have minor offset variations depending on board thickness and fixture alignment.

---

## Task 3 — App UI Redesign & Enhancement
**Theme:** User Experience | **Priority:** 3 | **Owner:** Mayank Rathore | **Project Stage:** 80%

### Sub Tasks
1. Redesigned the overall layout of the app for better operator usability.
2. Improved panel organization — controls are grouped logically (jog, camera, dispensing).
3. Updated color scheme, fonts, and component styling for a professional look.
4. Key controls and status indicators made more prominent and easy to access.
5. CSS and layout reworked across multiple screens for visual consistency.

### Baseline Measurement
- **Before:** Cluttered and inconsistent UI made it hard for operators to locate controls quickly, increasing training time and risk of operator error.
- **After:** Clean, organized interface reduces operator confusion, speeds up setup, and provides better visual feedback on machine status. Directly improves production floor usability.

### Employee Update
UI looks significantly improved. Future modification: add tooltips on buttons and help text for first-time operators. Also plan to add a dark/light mode toggle.

---

## Task 4 — CSV Job Report Auto-Export
**Theme:** Data & Reporting | **Priority:** 2 | **Owner:** Mayank Rathore | **Project Stage:** 90%

### Sub Tasks
1. Automatically generates a CSV report when a dispensing job completes.
2. Report contains pad-by-pad dispensing details including position, type (dot/bead), and status.
3. File is downloadable from within the Electron app to the local system.
4. Enables quality tracking and full traceability of every production job.
5. Uses Electron IPC bridge (`main.js` + `preload.js`) to securely write the file to disk.

### Baseline Measurement
- **Before:** No job records were saved — if a job had issues, there was no data to analyze.
- **After:** Every completed job produces a traceable CSV report. Quality team can audit dispensed pads, identify skipped or failed pads, and track production output over time. Critical for production line accountability.

### Employee Update
Feature working successfully. Future modification: expand report to include timestamps per pad, glue volume estimates, pass/fail status per pad, and operator name field.

---

## Task 5 — Nozzle Purging, Pre-flight Checklist & Mid-Session Job Resume
**Theme:** Machine Reliability & Maintenance | **Priority:** 1 | **Owner:** Mayank Rathore | **Project Stage:** 85%

### Sub Tasks
1. Added automatic and manual nozzle purging/cleaning cycle before and during a job to prevent clogging.
2. Pre-flight checklist verifies all systems are ready before dispensing begins (serial port, camera, home position, pressure).
3. Job can be resumed from the exact pad where it was stopped — no need to restart from the beginning.
4. Prevents a clogged nozzle from ruining an entire production run mid-way.
5. Reworked pad extraction logic (`extractPads.js`) to support pause/resume state tracking.

### Baseline Measurement
- **Before:** No pre-checks meant jobs could fail mid-way due to unverified conditions (e.g., camera not ready, nozzle clogged). A stopped job meant restarting entirely from scratch.
- **After:** Pre-flight checklist catches issues before they cause failures. Nozzle purging improves glue consistency across a run. Job resume saves operator time and glue material.

### Employee Update
All three features working in production testing. Future modification: add a visual nozzle health indicator and automatic purge scheduling based on time elapsed or number of pads dispensed.

---

## Task 6 — Panel Rail Fiducial Detection & 2D Coordinate Transformation
**Theme:** PCB Setup & Vision | **Priority:** 1 | **Owner:** Mayank Rathore | **Project Stage:** 85%

### Sub Tasks
1. Camera detects fiducials located on the panel rail (outer frame/edges of multi-PCB panel boards).
2. Applies a 2D coordinate transformation (rotation + translation) to correct for board misalignment.
3. Handles cases where the board is placed slightly rotated or shifted in the machine fixture.
4. Ensures accurate dispensing even if board placement is not perfectly aligned each time.
5. Supports panel PCB manufacturing workflows where multiple boards are on one panel.

### Baseline Measurement
- **Before:** Board had to be placed very precisely in the machine fixture — even 1–2mm misalignment caused dispensing errors across all pads.
- **After:** Machine automatically detects misalignment via panel fiducials and corrects all pad coordinates mathematically, reducing setup precision requirement and improving yield on production panels.

### Employee Update
Detection and transformation working correctly. Future modification: test with more diverse panel configurations (2×2, 3×2 panels) and add support for boards with only 2 fiducials instead of 3.

---

## Task 7 — Smart Glue Dispensing — DOT vs BEAD Mode Based on Pad Size
**Theme:** Dispensing Intelligence | **Priority:** 1 | **Owner:** Mayank Rathore | **Project Stage:** 80%

### Sub Tasks
1. System reads pad dimensions from the Gerber file data for each individual pad.
2. Small pads (below threshold size) automatically receive a single DOT of glue.
3. Large or elongated pads automatically receive a BEAD (line) of glue along their length.
4. Eliminates over-gluing on small pads and under-gluing on large pads.
5. Dispensing speed, pressure, and duration parameters are adjusted per dispensing mode.

### Baseline Measurement
- **Before:** All pads received the same dispensing pattern regardless of size — small pads got too much glue (overflow, bridging risk) and large pads got too little (poor component hold).
- **After:** Glue amount is proportional to pad size, improving SMD component placement accuracy, reducing glue waste, and lowering the risk of solder bridging.

### Employee Update
Working for standard pad sizes. Future modification: allow user-configurable size thresholds for DOT vs BEAD switching, and add a third mode for very large pads (multi-bead pattern).

---

## Task 8 — Auto Jog Through Board Fiducials on Connection Setup
**Theme:** Machine Automation | **Priority:** 1 | **Owner:** Mayank Rathore | **Project Stage:** 85%

### Sub Tasks
1. On machine connection (serial port + camera ready), automatically jogs to each fiducial position on the board.
2. Camera captures and verifies each fiducial location automatically without the operator jogging manually.
3. Establishes accurate coordinate mapping between the PCB design coordinates and machine motion axes.
4. Reduces setup time from a manual ~5-minute process to a fully automatic sub-1-minute sequence.
5. Uses a 2D transform utility (`transform2d.js`) to calculate corrected pad positions for the entire board.

### Baseline Measurement
- **Before:** Operator had to manually jog to each fiducial, visually confirm it under the camera, and press confirm — slow (~5 min) and subject to human alignment error.
- **After:** The entire coordinate setup sequence runs automatically on connection, saving ~4–5 minutes per board setup and removing human alignment error from the process.

### Employee Update
Auto jogging working smoothly in testing. Future modification: add a fail-safe behavior if the camera cannot find the fiducial at the expected position (alert operator + retry logic).

---

## Task 9 — Board Pre-check, Job Parameter Save/Load & Camera Light Control
**Theme:** Machine Reliability & Usability | **Priority:** 2 | **Owner:** Mayank Rathore | **Project Stage:** 80%

### Sub Tasks
1. Board presence and rough alignment is verified before the job starts — prevents machine from running empty.
2. Job parameters (speed, pressure, height offsets, thresholds) can be saved to a file and reloaded in future sessions.
3. Camera light gain and brightness are now adjustable directly from the UI for different lighting environments.
4. Repeat production of the same PCB type becomes faster — load saved parameters and start immediately.
5. Light control improves fiducial and pad detection accuracy in bright or dim factory conditions.

### Baseline Measurement
- **Before:** All parameters had to be re-entered every session from scratch (slow, error-prone). Camera had fixed lighting that didn't adapt to the factory environment.
- **After:** One-time parameter setup can be saved and instantly reloaded for repeat jobs, cutting per-job setup time significantly. Adjustable lighting improves vision reliability across different environments.

### Employee Update
Save/Load and light control working. Board check implemented and tested. Future modification: support multiple saved parameter profiles (one per PCB type) and add a profile name/description field for easy identification.

---

*Report generated: May 22, 2026*
