"""
Python Vision Co-Processor for Glue Dispensing Machine
=======================================================
Architecture: FastAPI server that exclusively owns the USB camera.
- Streams smooth MJPEG video to the React frontend at /video_feed
- Detects fiducials via Hough Circle Transform and calculates offsets
- Reports sharpness score for future Z-axis Auto-Focus logic
- Exposes REST API for React to trigger detection and read results
"""

import os
import sys

# Suppress low-level OpenCV C++ debug logs
os.environ["OPENCV_LOG_LEVEL"] = "ERROR"
os.environ["OPENCV_VIDEOIO_DEBUG"] = "0"

import cv2
import numpy as np
import threading
import time
import json
import itertools
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────
CAMERA_INDEX = 1 if os.name == 'nt' else 0  # 1 on Windows (laptop camera=0, USB=1), 0 on Linux/Raspberry Pi
FRAME_WIDTH  = 1280
FRAME_HEIGHT = 720
MJPEG_QUALITY = 68 if os.name != 'nt' else 85  # Optimized JPEG quality for Pi 4 CPU
DETECTION_INTERVAL = 0.25 if os.name != 'nt' else 0.4  # Fast detection response on Pi

# Hough Circle parameters — tune these for your fiducial size
HOUGH_DP          = 1.2
HOUGH_MIN_DIST    = 40    # Minimum px distance between circle centres
HOUGH_PARAM1      = 80    # Canny upper threshold
HOUGH_PARAM2      = 22    # Accumulator threshold (lowered to find smaller/dimmer fiducials)
HOUGH_MIN_RADIUS  = 10    # Min fiducial radius (tiny silver dots are small!)
HOUGH_MAX_RADIUS  = 80    # Max fiducial radius in pixels
PX_PER_MM         = 98.5  # Calibrated pixels-per-mm

# ──────────────────────────────────────────────
# Shared state (thread-safe via a lock)
# ──────────────────────────────────────────────
state_lock = threading.Lock()
shared_state = {
    "detecting":     False,    # Is active detection enabled?
    "circles":       [],       # List of detected circles [{x, y, r, offset_dx, offset_dy}]
    "best_circle":   None,     # The single best/nearest-to-crosshair circle
    "offset_dx":     0.0,      # mm offset to move camera crosshair onto best circle
    "offset_dy":     0.0,
    "sharpness":     0.0,      # Laplacian variance (higher = sharper = more in-focus)
    "frame_count":   0,
    "camera_ok":     True,
    "tried_indices": [],       # Populated if camera open failed — lists all indices tried
}

# ──────────────────────────────────────────────
# Lens distortion calibration state
# ──────────────────────────────────────────────
CALIBRATION_DIR  = os.path.join(os.path.dirname(__file__), "calibration_frames")
CALIBRATION_FILE = os.path.join(os.path.dirname(__file__), "lens_calibration.json")
CHESSBOARD_SIZE  = (9, 6)   # inner corners (columns, rows) on your printed pattern

calib_lock = threading.Lock()
calib_state = {
    "calibrated":    False,
    "camera_matrix": None,   # 3×3 np array, None until computed
    "dist_coeffs":   None,   # 1×5 np array, None until computed
    "captures":      0,      # number of accepted calibration frames
    "rms_error":     None,
}

def _load_calibration():
    """Try to restore lens calibration from the saved JSON file on disk."""
    if not os.path.exists(CALIBRATION_FILE):
        return
    try:
        with open(CALIBRATION_FILE, "r") as f:
            data = json.load(f)
        mtx = np.array(data["camera_matrix"], dtype=np.float64)
        dist = np.array(data["dist_coeffs"], dtype=np.float64)
        with calib_lock:
            calib_state["camera_matrix"] = mtx
            calib_state["dist_coeffs"]   = dist
            calib_state["calibrated"]    = True
            calib_state["rms_error"]     = data.get("rms_error")
            calib_state["captures"]      = data.get("captures", 0)
        print(f"[Calibration] Loaded from {CALIBRATION_FILE} (RMS={data.get('rms_error')})")
    except Exception as e:
        print(f"[Calibration] Load failed: {e}")

_load_calibration()

# ──────────────────────────────────────────────
# Camera capture (runs in a dedicated background thread)
# ──────────────────────────────────────────────
latest_frame = None
frame_lock = threading.Lock()
camera_thread_running = True
camera_cap = None          # Global reference so API endpoints can adjust camera properties

def camera_loop():
    """
    Continuously reads frames from the USB camera and stores the latest one.
    Runs in its own daemon thread so it never blocks the web server or the
    vision analysis thread.
    """
    global latest_frame, camera_cap
    _backend = cv2.CAP_DSHOW if os.name == 'nt' else cv2.CAP_V4L2

    # Helper to configure camera properties BEFORE reading frames
    def setup_cap(c):
        try:
            c.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            c.set(cv2.CAP_PROP_FRAME_WIDTH,  FRAME_WIDTH)
            c.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
            c.set(cv2.CAP_PROP_FPS, 30)
            # On Linux V4L2, keep standard buffer size (4) to prevent driver queue underflow stalls!
            # BUFFERSIZE=1 should only be used on Windows DSHOW.
            if os.name == 'nt':
                c.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            else:
                c.set(cv2.CAP_PROP_BUFFERSIZE, 4)
        except Exception as e:
            print(f"[Vision] Warning: Failed to set camera properties: {e}", flush=True)

    # On Linux/Pi, prioritize index 0, then even indices 2, 4 (capture nodes), then others
    if os.name == 'nt':
        indices_to_try = [CAMERA_INDEX] + [i for i in range(4) if i != CAMERA_INDEX]
    else:
        indices_to_try = [0, 2, 4, 1, 3]

    cap = None
    opened_index = None

    for idx in indices_to_try:
        try:
            print(f"[Vision] Trying camera index {idx}...", flush=True)
            candidate = cv2.VideoCapture(idx, _backend)
            if candidate is None or not candidate.isOpened():
                candidate = cv2.VideoCapture(idx)

            if candidate is not None and candidate.isOpened():
                # Configure format and dimensions BEFORE reading frames to prevent V4L2 pipeline stall
                setup_cap(candidate)
                ret, test_frame = candidate.read()
                if ret and test_frame is not None:
                    cap = candidate
                    opened_index = idx
                    print(f"[Vision] Camera successfully found and opened at index {idx}", flush=True)
                    break
                else:
                    candidate.release()
            else:
                if candidate is not None:
                    candidate.release()
        except Exception as e:
            print(f"[Vision] Exception trying index {idx}: {e}", flush=True)

    if cap is None or not cap.isOpened():
        print(f"[Vision] ERROR: No camera found on indices {indices_to_try}. Check USB connection and group permissions (sudo usermod -a -G video $USER).", flush=True)
        with state_lock:
            shared_state["camera_ok"] = False
            shared_state["tried_indices"] = indices_to_try
        return

    actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    actual_fps = int(cap.get(cv2.CAP_PROP_FPS))

    camera_cap = cap  # Expose to API endpoints for live property changes
    with state_lock:
        shared_state["camera_ok"] = True
        shared_state["actual_width"] = actual_w
        shared_state["actual_height"] = actual_h
    print(f"[Vision] Camera opened on index {opened_index}: requested {FRAME_WIDTH}x{FRAME_HEIGHT}, ACTUAL: {actual_w}x{actual_h} @ {actual_fps}fps", flush=True)

    consec_fails = 0
    while camera_thread_running:
        ret, frame = cap.read()
        if ret and frame is not None:
            consec_fails = 0
            with frame_lock:
                latest_frame = frame
            with state_lock:
                shared_state["frame_count"] += 1
        else:
            consec_fails += 1
            if consec_fails % 30 == 0:
                print(f"[Vision] Warning: Frame read returned False ({consec_fails} drops)", flush=True)
            if consec_fails > 60:
                # 2 seconds of consecutive drops: camera stalled, attempt driver reconnect
                print(f"[Vision] Camera feed stalled on index {opened_index}. Attempting reconnection...", flush=True)
                cap.release()
                time.sleep(0.3)
                rec = cv2.VideoCapture(opened_index, _backend)
                if not rec.isOpened():
                    rec = cv2.VideoCapture(opened_index)
                if rec.isOpened():
                    setup_cap(rec)
                    ret_test, _ = rec.read()
                    if ret_test:
                        cap = rec
                        camera_cap = cap
                        consec_fails = 0
                        print(f"[Vision] Camera restart succeeded!", flush=True)
                time.sleep(0.5)
            time.sleep(0.01)

    camera_cap = None
    cap.release()
    print("[Vision] Camera released.")


def get_effective_px_per_mm(w: int) -> float:
    """
    PX_PER_MM is calibrated at reference width 1280.
    If the camera negotiated 640 width on Linux, scale proportionally so physical mm is identical!
    """
    base_val = PX_PER_MM if PX_PER_MM > 40 else 98.5
    if w <= 0 or w == 1280:
        return base_val
    return base_val * (float(w) / 1280.0)


def get_frame() -> np.ndarray | None:
    with frame_lock:
        if latest_frame is None:
            return None
        frame = latest_frame.copy()
    with calib_lock:
        if calib_state["calibrated"] and calib_state["camera_matrix"] is not None:
            frame = cv2.undistort(frame, calib_state["camera_matrix"], calib_state["dist_coeffs"])
    return frame


# ──────────────────────────────────────────────
# Vision Analysis (runs in a dedicated background thread)
# ──────────────────────────────────────────────
def vision_loop():
    """
    Continuously analyses frames for fiducials and sharpness.
    Runs at DETECTION_INTERVAL rate (not at camera frame rate) to
    avoid consuming too much CPU during dispensing.
    """
    sticky_best_circle = None

    while camera_thread_running:
        frame = get_frame()
        if frame is None:
            time.sleep(DETECTION_INTERVAL)
            continue

        with state_lock:
            is_detecting = shared_state["detecting"]

        if not is_detecting:
            time.sleep(0.2)
            continue

        h, w = frame.shape[:2]
        cx, cy = w // 2, h // 2  # Crosshair centre in pixels

        # ── Sharpness (Optimized Laplacian on downscaled frame) ────
        gray        = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        small_gray  = cv2.resize(gray, (320, 180), interpolation=cv2.INTER_NEAREST)
        sharpness   = float(cv2.Laplacian(small_gray, cv2.CV_16S).var())

        # ── Fiducial Detection ───────────────────────────────────────
        detected_circles = []
        best_circle = None
        offset_dx = 0.0
        offset_dy = 0.0

        if is_detecting:
            # Optimize for Pi 4: Crop central 600x600 region where fiducials are positioned
            roi_w = min(600, w)
            roi_h = min(600, h)
            rx1 = (w - roi_w) // 2
            ry1 = (h - roi_h) // 2
            gray_crop = gray[ry1:ry1+roi_h, rx1:rx1+roi_w]
            blurred = cv2.GaussianBlur(gray_crop, (7, 7), 1.5)
            raw = cv2.HoughCircles(
                blurred,
                cv2.HOUGH_GRADIENT,
                dp=HOUGH_DP,
                minDist=HOUGH_MIN_DIST,
                param1=HOUGH_PARAM1,
                param2=HOUGH_PARAM2,
                minRadius=HOUGH_MIN_RADIUS,
                maxRadius=HOUGH_MAX_RADIUS
            )

            if raw is not None:
                circles_np = np.round(raw[0, :]).astype(int)
                # Convert pixel coordinates to machine-space mm offsets from crosshair
                for (cpx, cpy, pr) in circles_np:
                    px = int(cpx + rx1)
                    py = int(cpy + ry1)
                    # --- Filter 1: Solid Fill Check (Rejects Through-Holes) ---
                    box_size = int(pr * 2.5)
                    x1 = max(0, px - box_size)
                    y1 = max(0, py - box_size)
                    x2 = min(w, px + box_size)
                    y2 = min(h, py + box_size)
                    if x2 - x1 < 5 or y2 - y1 < 5: continue
                    
                    roi = gray[y1:y2, x1:x2]
                    roi_cx, roi_cy = px - x1, py - y1
                    
                    # --- Filter 1: Contiguous Area Profiling (Via & Silkscreen Rejection) ---
                    # Instead of thin discrete rings, we analyze thick, continuous zones to 
                    # guarantee we never 'miss' the shadow wall of a via hole.
                    
                    # Zone 1: Core (The fiducial dot or via hole)
                    core_mask = np.zeros_like(roi)
                    cv2.circle(core_mask, (roi_cx, roi_cy), pr, 255, -1)
                    
                    # Zone 2: Boundary (The immediate edge: clearance ring or via shadow wall)
                    boundary_mask = np.zeros_like(roi)
                    cv2.circle(boundary_mask, (roi_cx, roi_cy), int(pr * 1.3), 255, -1)
                    cv2.circle(boundary_mask, (roi_cx, roi_cy), pr, 0, -1)
                    
                    # Zone 3: Outer Area (The extended area: dark board or bright via pad)
                    outer_mask = np.zeros_like(roi)
                    cv2.circle(outer_mask, (roi_cx, roi_cy), int(pr * 2.5), 255, -1)
                    cv2.circle(outer_mask, (roi_cx, roi_cy), int(pr * 1.4), 0, -1)
                    
                    core_mean = cv2.mean(roi, mask=core_mask)[0]
                    boundary_mean = cv2.mean(roi, mask=boundary_mask)[0]
                    outer_mean = cv2.mean(roi, mask=outer_mask)[0]

                    # Inner core (central 40% of radius) — the key through-hole discriminator.
                    # A through-hole has a dark drill hole at its very centre; a solid fiducial pad
                    # is uniformly bright all the way to the centre.
                    inner_core_mask = np.zeros_like(roi)
                    cv2.circle(inner_core_mask, (roi_cx, roi_cy), max(2, int(pr * 0.40)), 255, -1)
                    inner_core_mean = cv2.mean(roi, mask=inner_core_mask)[0]

                    # CHECK 0: Ring/Donut Pattern — primary through-hole discriminator.
                    # Through-hole: inner_core (drill hole) is much darker than overall core (annular rim).
                    # Fiducial pad: inner_core ≈ core_mean (solid copper, uniform brightness centre-to-edge).
                    if inner_core_mean < core_mean - 20 and inner_core_mean < 115:
                        continue  # Ring pattern: through-hole (dark drill centre, bright annular rim)

                    # CHECK 1: The "Flatness" Rule (Rejects Vias)
                    # A via hole has depth. It casts a dark shadow (Boundary), and is surrounded
                    # by a bright copper pad (Outer). If Outer is brighter than Boundary, it's a Via!
                    # A real fiducial is flat, so brightness only decreases as you move outwards.
                    if outer_mean > boundary_mean + 15:
                        continue

                    # CHECK 2: Solder Mask Rule
                    # A true fiducial MUST be isolated on dark solder mask.
                    if outer_mean > 160:
                        continue

                    # CHECK 3: Core Brightness — lowered to 70 to allow for dimmer/smaller fiducials
                    # that may appear darker due to camera auto-exposure favouring bright through-holes.
                    if core_mean < 70:
                        continue

                    # CHECK 4: Strict Physical Size Constraint
                    # Most fiducials are ~1.0mm diameter (0.5mm radius).
                    # Reject microscopic curves (like silkscreen letters) and massive pads.
                    radius_mm = pr / PX_PER_MM
                    if radius_mm < 0.20 or radius_mm > 0.8:
                        continue

                    # --- Filter 2: Solid Fill Check (Rejects False Geometries) ---
                    # Bumpy, shiny solder has extreme bright spots (255) and dark shadows (120).
                    # We use Otsu's method to automatically find the perfect split between the
                    # silver metal foreground and the dark green board background.
                    blurred_roi = cv2.GaussianBlur(roi, (5, 5), 0)
                    _, thresh = cv2.threshold(blurred_roi, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

                    # Create a perfect circular mask for the detected area
                    mask = np.zeros_like(roi)
                    cv2.circle(mask, (roi_cx, roi_cy), pr, 255, -1)

                    # Count how much of the circle is actually filled with bright metal
                    filled_pixels = cv2.bitwise_and(thresh, mask)
                    fill_count = cv2.countNonZero(filled_pixels)
                    expected_area = np.pi * (pr * pr)

                    # A solid fiducial is mostly filled. A through-hole is hollow (e.g. 40-50% filled).
                    if expected_area == 0 or (fill_count / expected_area) < 0.65:
                        continue  # Reject hollow through-holes

                    # --- Filter 2: Strict Circularity Check (Rejects Trace Pads / Lollipops) ---
                    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    if not contours: continue

                    best_cnt = None
                    min_dist = float('inf')
                    for cnt in contours:
                        M = cv2.moments(cnt)
                        if M["m00"] == 0: continue
                        cx_cnt = int(M["m10"] / M["m00"])
                        cy_cnt = int(M["m01"] / M["m00"])
                        dist = (cx_cnt - roi_cx)**2 + (cy_cnt - roi_cy)**2
                        if dist < min_dist:
                            min_dist = dist
                            best_cnt = cnt

                    if best_cnt is None: continue

                    area = cv2.contourArea(best_cnt)
                    perimeter = cv2.arcLength(best_cnt, True)
                    if perimeter == 0 or area == 0: continue

                    # Relaxed slightly to 0.65 to allow for jagged edges caused by solder bumps
                    circularity = (4 * np.pi * area) / (perimeter * perimeter)
                    if circularity < 0.65:
                        continue  # Reject trace pads (they have a tail, ruining circularity)
                            
                    eff_px_mm = get_effective_px_per_mm(w)
                    dx_px = px - cx
                    dy_px = cy - py  # Invert Y: camera Y down → machine Y up
                    dx_mm = round(dx_px / eff_px_mm, 4)
                    dy_mm = round(dy_px / eff_px_mm, 4)
                    detected_circles.append({
                        "pixel_x": int(px), "pixel_y": int(py), "radius": int(pr),
                        "offset_dx": dx_mm, "offset_dy": dy_mm
                    })

                if detected_circles:
                    # Best circle = closest to the crosshair centre
                    current_best = min(
                        detected_circles,
                        key=lambda c: abs(c["offset_dx"]) + abs(c["offset_dy"])
                    )

                    # --- ANTI-JITTER EMA FILTER ---
                    # If the machine is stopped, HoughCircles might jitter by 1-5 pixels randomly.
                    # Instead of freezing the coordinates (which causes the green circle to detach 
                    # from the physical fiducial during machine motion), we use an Exponential 
                    # Moving Average (EMA) to smooth out the jitter while keeping the overlay 
                    # tightly glued to the moving fiducial.
                    if sticky_best_circle is not None:
                        dist = ((current_best["pixel_x"] - sticky_best_circle["pixel_x"])**2 + 
                                (current_best["pixel_y"] - sticky_best_circle["pixel_y"])**2)**0.5
                        
                        if dist < 20.0:
                            # Smooth tracking: 50% new frame, 50% history
                            alpha = 0.5
                            best_circle = {
                                "pixel_x": int(alpha * current_best["pixel_x"] + (1 - alpha) * sticky_best_circle["pixel_x"]),
                                "pixel_y": int(alpha * current_best["pixel_y"] + (1 - alpha) * sticky_best_circle["pixel_y"]),
                                "radius": int(alpha * current_best["radius"] + (1 - alpha) * sticky_best_circle["radius"])
                            }
                            # Recalculate offsets based on smoothed pixel
                            dx_px = best_circle["pixel_x"] - cx
                            dy_px = cy - best_circle["pixel_y"]
                            eff_px_mm = get_effective_px_per_mm(w)
                            best_circle["offset_dx"] = round(dx_px / eff_px_mm, 4)
                            best_circle["offset_dy"] = round(dy_px / eff_px_mm, 4)
                        else:
                            # Machine moved to a totally new fiducial, update immediately
                            best_circle = current_best
                    else:
                        best_circle = current_best

                    sticky_best_circle = best_circle
                    offset_dx = best_circle["offset_dx"]
                    offset_dy = best_circle["offset_dy"]
                else:
                    sticky_best_circle = None

        with state_lock:
            shared_state["circles"]     = detected_circles
            shared_state["best_circle"] = best_circle
            shared_state["offset_dx"]   = offset_dx
            shared_state["offset_dy"]   = offset_dy
            shared_state["sharpness"]   = round(sharpness, 2)

        time.sleep(DETECTION_INTERVAL)


# ──────────────────────────────────────────────
# Frame Annotator (draw overlays onto the live frame)
# ──────────────────────────────────────────────
def annotate_frame(frame: np.ndarray) -> np.ndarray:
    """
    Draws crosshair, detected fiducial circles, offset text, and sharpness
    score onto the frame before it is JPEG-encoded for streaming.
    """
    h, w = frame.shape[:2]
    cx, cy = w // 2, h // 2
    out = frame.copy()

    # ── Crosshair ─────────────────────────────────────────────────
    CROSS_COLOR = (0, 220, 255)   # Cyan
    CROSS_LEN   = 40
    CROSS_THICK = 2
    cv2.line(out, (cx - CROSS_LEN, cy), (cx + CROSS_LEN, cy), CROSS_COLOR, CROSS_THICK)
    cv2.line(out, (cx, cy - CROSS_LEN), (cx, cy + CROSS_LEN), CROSS_COLOR, CROSS_THICK)
    # Centre dot
    cv2.circle(out, (cx, cy), 4, CROSS_COLOR, -1)

    with state_lock:
        circles     = shared_state["circles"]
        best_circle = shared_state["best_circle"]
        offset_dx   = shared_state["offset_dx"]
        offset_dy   = shared_state["offset_dy"]
        sharpness   = shared_state["sharpness"]
        detecting   = shared_state["detecting"]

    # ── Detected Circles ──────────────────────────────────────────
    # Draw all alternative raw circles in orange
    for c in circles:
        px, py, pr = c["pixel_x"], c["pixel_y"], c["radius"]
        is_best = (best_circle is not None and
                   px == best_circle["pixel_x"] and py == best_circle["pixel_y"])
        # We handle best_circle separately below so EMA smoothed coords are drawn
        if not is_best:
            cv2.circle(out, (px, py), pr, (0, 150, 255), 1)
            cv2.circle(out, (px, py), 3, (0, 150, 255), -1)

    # Draw the primary tracking circle in green
    if best_circle is not None:
        bx, by, br = best_circle["pixel_x"], best_circle["pixel_y"], best_circle["radius"]
        cv2.circle(out, (bx, by), br, (0, 255, 0), 2)
        cv2.circle(out, (bx, by), 3, (0, 255, 0), -1)

    # ── Offset HUD ───────────────────────────────────────────────
    if detecting and best_circle:
        hud_txt = [
            f"TARGET",
            f"dx: {offset_dx:+.3f} mm",
            f"dy: {offset_dy:+.3f} mm",
        ]
        for i, line in enumerate(hud_txt):
            cv2.putText(out, line, (cx + 12, cy - 10 + i * 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2, cv2.LINE_AA)

    # ── Status Bar ───────────────────────────────────────────────
    bar_y = h - 12
    status = "DETECTING" if detecting else "IDLE"
    status_color = (0, 255, 80) if detecting else (180, 180, 180)
    cv2.putText(out, f"{status}  |  Sharpness: {sharpness:.0f}",
                (10, bar_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, status_color, 1, cv2.LINE_AA)

    return out


def make_placeholder_frame():
    """Generates a standard 1280x720 dark grey placeholder image with status text."""
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    frame[:] = (30, 30, 30) # Dark grey background

    # Title text
    font = cv2.FONT_HERSHEY_SIMPLEX
    title_text = "CAMERA FEED OFFLINE"
    title_sz = cv2.getTextSize(title_text, font, 1.2, 3)[0]
    tx = (1280 - title_sz[0]) // 2
    ty = (720 + title_sz[1]) // 2 - 20
    cv2.putText(frame, title_text, (tx, ty), font, 1.2, (80, 80, 240), 3, cv2.LINE_AA)

    # Subtitle text — show which indices were tried
    with state_lock:
        tried = shared_state.get("tried_indices", [])
    if tried:
        indices_str = ", ".join(str(i) for i in tried)
        sub_text = f"Tried camera indices: {indices_str}. Check USB connection."
    else:
        sub_text = "Waiting for camera... Check USB connection."
    sub_sz = cv2.getTextSize(sub_text, font, 0.65, 1)[0]
    sx = (1280 - sub_sz[0]) // 2
    sy = ty + 45
    cv2.putText(frame, sub_text, (sx, sy), font, 0.65, (120, 120, 120), 1, cv2.LINE_AA)

    # Hint text
    hint_text = "If camera is connected, set CAMERA_INDEX in python-vision/server.py"
    hint_sz = cv2.getTextSize(hint_text, font, 0.5, 1)[0]
    hx = (1280 - hint_sz[0]) // 2
    hy = sy + 32
    cv2.putText(frame, hint_text, (hx, hy), font, 0.5, (80, 80, 80), 1, cv2.LINE_AA)

    return frame


def generate_mjpeg():
    """
    Generator function that yields annotated JPEG frames in MJPEG multipart format.
    Crash-proof: any single bad frame is skipped rather than killing the whole stream.
    """
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, MJPEG_QUALITY]
    FRAME_DELAY = 1.0 / 22 if os.name != 'nt' else 1.0 / 30  # 22fps on Pi 4 keeps CPU cool & video fluid
    placeholder_frame = make_placeholder_frame()

    while True:
        frame_start = time.time()
        try:
            frame = get_frame()
            if frame is None:
                # Instead of silently looping and freezing the UI image tag,
                # yield a clean placeholder frame to maintain the aspect ratio.
                ret, jpeg = cv2.imencode(".jpg", placeholder_frame, encode_params)
                if ret and jpeg is not None:
                    data = jpeg.tobytes()
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(data)).encode('ascii') + b"\r\n\r\n" +
                        data +
                        b"\r\n"
                    )
                time.sleep(0.066) # slower refresh for placeholder to save CPU
                continue

            annotated = annotate_frame(frame)
            ret, jpeg = cv2.imencode(".jpg", annotated, encode_params)
            if not ret or jpeg is None:
                time.sleep(0.033)
                continue

            data = jpeg.tobytes()
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(data)).encode('ascii') + b"\r\n\r\n" +
                data +
                b"\r\n"
            )
        except Exception as e:
            # Log but DO NOT break — skip this frame and keep streaming
            print(f"[Stream] Frame error (skipped): {e}")
            time.sleep(0.033)
            continue

        # Maintain frame rate cap
        elapsed = time.time() - frame_start
        sleep_time = FRAME_DELAY - elapsed
        if sleep_time > 0:
            time.sleep(sleep_time)



# ──────────────────────────────────────────────
# Camera thread management helpers
# ──────────────────────────────────────────────

# ──────────────────────────────────────────────
# FastAPI App
# ──────────────────────────────────────────────
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    cam_thread    = threading.Thread(target=camera_loop,  daemon=True)
    vision_thread = threading.Thread(target=vision_loop,  daemon=True)
    cam_thread.start()
    vision_thread.start()
    print("[Vision] Server ready — stream at http://localhost:8000/video_feed")
    yield
    global camera_thread_running
    camera_thread_running = False

app = FastAPI(title="Glue Dispenser Vision Server", lifespan=lifespan)

# Allow requests from the Electron/Vite dev server on localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Electron file:// and http://localhost:5173
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ────────────────────────────────────────────────────────
class VisionData(BaseModel):
    offset_dx: float
    offset_dy: float
    radius: float

class PadQuery(BaseModel):
    width_mm: float
    height_mm: float

# ── Routes ────────────────────────────────────────────────────────

@app.get("/")
def root_status():
    """Root health check to prevent 404 logs from network probes."""
    return {"status": "ok", "service": "pcb-vision"}

@app.get("/video_feed")
def video_feed():
    """MJPEG stream endpoint — point <img src="http://localhost:8000/video_feed" /> at this."""
    return StreamingResponse(
        generate_mjpeg(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


@app.get("/api/status")
def api_status():
    """Health check — React polls this to know the server is alive."""
    with state_lock:
        return JSONResponse({
            "ok": True,
            "camera_ok": shared_state["camera_ok"],
            "frames": shared_state["frame_count"]
        })


@app.post("/api/start_detect")
def api_start_detect():
    """Tell Python to start running the Hough circle detection loop."""
    with state_lock:
        shared_state["detecting"] = True
    print("[Vision] Detection STARTED")
    return {"detecting": True}


@app.post("/api/stop_detect")
def api_stop_detect():
    """Stop fiducial detection (don't waste CPU during free-running dispensing)."""
    with state_lock:
        shared_state["detecting"] = False
        shared_state["circles"]   = []
        shared_state["best_circle"] = None
        shared_state["offset_dx"] = 0.0
        shared_state["offset_dy"] = 0.0
    print("[Vision] Detection STOPPED")
    return {"detecting": False}


@app.get("/api/vision_data")
def api_vision_data():
    """
    Returns the latest detection result in one JSON payload.
    React polls this after triggering a detection to get the offset to jog.
    """
    with state_lock:
        return JSONResponse({
            "detecting":   shared_state["detecting"],
            "offset_dx":   shared_state["offset_dx"],   # mm to move X to centre fiducial
            "offset_dy":   shared_state["offset_dy"],   # mm to move Y to centre fiducial
            "sharpness":   shared_state["sharpness"],
            "circles":     shared_state["circles"],
            "best_circle": shared_state["best_circle"],
            "camera_ok":   shared_state["camera_ok"],
        })


@app.get("/api/snap_offset")
def api_snap_offset():
    """
    Subpixel-accurate fiducial centre offset using a FRESH camera frame.
    Unlike /api/vision_data (which is polled/cached), this grabs the newest frame
    right now, crops a tight ROI around the already-detected circle, and computes
    the brightness centroid via Otsu thresholding — more accurate than HoughCircles
    integer rounding. One call → one precise jog → crosshair lands on centre.
    """
    with state_lock:
        bc = shared_state["best_circle"]
    if bc is None:
        return JSONResponse({"found": False, "error": "no_detection"})

    frame = get_frame()
    if frame is None:
        return JSONResponse({"found": False, "error": "no_frame"})

    h, w = frame.shape[:2]
    cx_frame, cy_frame = w // 2, h // 2

    px, py, pr = bc["pixel_x"], bc["pixel_y"], bc["radius"]

    # Tight ROI centred on the detected circle — keeps Otsu's threshold clean
    margin = pr + 10
    x1 = max(0, px - margin)
    y1 = max(0, py - margin)
    x2 = min(w, px + margin)
    y2 = min(h, py + margin)

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    roi  = gray[y1:y2, x1:x2]
    if roi.size == 0:
        return JSONResponse({"found": False, "error": "empty_roi"})

    # Otsu isolates the bright copper pad from dark solder mask
    blurred_roi = cv2.GaussianBlur(roi, (3, 3), 0)
    _, thresh = cv2.threshold(blurred_roi, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Brightness centroid — subpixel-accurate centre of the copper region
    eff_px_mm = get_effective_px_per_mm(w)
    M = cv2.moments(thresh)
    if M["m00"] == 0:
        # Graceful fallback: Use Hough circle center instead of failing
        dx_mm = bc.get("offset_dx", round((px - cx_frame) / eff_px_mm, 4))
        dy_mm = bc.get("offset_dy", round((cy_frame - py) / eff_px_mm, 4))
    else:
        centroid_x = x1 + M["m10"] / M["m00"]   # back to full-frame coordinates
        centroid_y = y1 + M["m01"] / M["m00"]
        dx_mm = round((centroid_x - cx_frame) / eff_px_mm, 4)
        dy_mm = round((cy_frame - centroid_y) / eff_px_mm, 4)  # invert Y: screen-down → machine-up

    return JSONResponse({
        "found": True,
        "offset_dx": dx_mm,
        "offset_dy": dy_mm,
    })


@app.post("/api/find_component_center")
@app.get("/api/find_component_center")
def api_find_component_center():
    """
    Detects the true center of the electronic component currently under the camera crosshair.
    Accurately handles 2-pad discrete components (resistors, capacitors, inductors),
    4-pad ICs/optocouplers/arrays, and single pads.
    Distinguishes solid metallic solder pads from white silkscreen text/markings and solder mask.
    Returns offset_dx and offset_dy in mm to jog the machine so the crosshair lands dead center.
    """
    frame = get_frame()
    if frame is None:
        return JSONResponse({"found": False, "error": "Camera offline"})

    h, w = frame.shape[:2]
    cx, cy = w / 2.0, h / 2.0

    # Inpaint any existing crosshair or annotation lines (e.g. yellow) so they don't corrupt contours
    b_ch, g_ch, r_ch = cv2.split(frame)
    is_yellow = (r_ch > 150) & (g_ch > 150) & (b_ch < 100)
    cleaned = frame.copy()
    if np.any(is_yellow):
        cleaned = cv2.inpaint(frame, is_yellow.astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)

    # 1. Mask out green solder mask (PCB substrate)
    hsv = cv2.cvtColor(cleaned, cv2.COLOR_BGR2HSV)
    h_ch, s_ch, v_ch = cv2.split(hsv)
    is_green = (h_ch >= 33) & (h_ch <= 88) & (s_ch >= 28)

    # 2. Non-substrate features (metallic pads, silkscreen, vias, copper)
    non_mask = (~is_green) & (v_ch > 60)

    # 3. Morphological cleanup:
    # 1-pixel erosion cleanly severs touching silkscreen boundary lines from solder pads
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    eroded = cv2.erode(non_mask.astype(np.uint8) * 255, kernel, iterations=1)
    mask = cv2.morphologyEx(eroded, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return JSONResponse({"found": False, "error": "No contours found"})

    # Filter contours: pads are solid geometric shapes (solidity >= 0.60)
    # Silkscreen text (e.g. 'C15', 'L2', 'R2', 'VO1') and line boxes have low solidity or extreme aspect ratio
    min_area_px = 40   # Supports tiny SMD pads down to 0201/0402
    max_area_px = 24000  # Avoid large component outlines, board perimeters or ground pours
    all_cnts = []

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area_px or area > max_area_px:
            continue
        x, y, cw, ch = cv2.boundingRect(cnt)
        hull = cv2.convexHull(cnt)
        solidity = area / max(1.0, cv2.contourArea(hull))
        aspect = max(cw, ch) / max(1.0, min(cw, ch))

        if solidity < 0.60:
            continue  # Hollow silkscreen stroke or text
        if solidity < 0.82 and aspect > 3.5:
            continue  # Thin silkscreen border line

        M = cv2.moments(cnt)
        if M["m00"] == 0:
            continue
        mcx = M["m10"] / M["m00"]
        mcy = M["m01"] / M["m00"]
        dist = float(np.hypot(mcx - cx, mcy - cy))
        all_cnts.append({
            "cnt": cnt,
            "area": area,
            "cx": mcx,
            "cy": mcy,
            "w": cw,
            "h": ch,
            "solidity": solidity,
            "dist": dist
        })

    if not all_cnts:
        return JSONResponse({"found": False, "error": "No valid pads near crosshair"})

    # Dominant pad size filtering:
    # Eliminates tiny silkscreen text strokes and marks when dominant component pads are larger
    near = [c for c in all_cnts if c["dist"] < 2.0 * PX_PER_MM]
    max_area = max([c["area"] for c in near]) if near else max([c["area"] for c in all_cnts])
    min_comp_area = max(45.0, max_area * 0.18)
    pads = [c for c in all_cnts if c["area"] >= min_comp_area]
    if not pads:
        pads = all_cnts

    # Sort pads by proximity to current camera crosshair
    pads.sort(key=lambda p: p["dist"])

    # ── Category 1: Multi-pin ICs (QFN, QFP, SOIC, TSSOP with 5+ pins) ──
    if len(pads) >= 5:
        ic_pads = [p for p in pads if p["dist"] < 3.2 * PX_PER_MM]
        if len(ic_pads) >= 5:
            med_area = float(np.median([p["area"] for p in ic_pads]))
            homo_pads = [p for p in ic_pads if 0.35 * med_area <= p["area"] <= 2.8 * med_area]
            if len(homo_pads) >= 5:
                ic_cx = float(np.mean([p["cx"] for p in homo_pads]))
                ic_cy = float(np.mean([p["cy"] for p in homo_pads]))
                dist_c = float(np.hypot(ic_cx - cx, ic_cy - cy))
                if dist_c < 2.5 * PX_PER_MM:
                    dx_px = ic_cx - cx
                    dy_px = cy - ic_cy
                    return JSONResponse({
                        "found": True,
                        "comp_type": "ic_multi_pin",
                        "offset_dx": round(float(dx_px / PX_PER_MM), 4),
                        "offset_dy": round(float(dy_px / PX_PER_MM), 4),
                        "pixel_dx": round(float(dx_px), 1),
                        "pixel_dy": round(float(dy_px), 1),
                        "dist_mm": round(float(np.hypot(dx_px, dy_px) / PX_PER_MM), 4),
                        "pads_detected": len(homo_pads)
                    })

    # ── Category 2: 4-pad components (ICs / optocouplers / crystals / quad arrays) ──
    best_quad = None
    best_quad_score = float("inf")
    if len(pads) >= 4:
        for q in itertools.combinations(pads[:8], 4):
            areas = [p["area"] for p in q]
            if max(areas) / max(1.0, min(areas)) < 2.6:
                q_cx = sum(p["cx"] for p in q) / 4.0
                q_cy = sum(p["cy"] for p in q) / 4.0
                dist_to_center = float(np.hypot(q_cx - cx, q_cy - cy))
                if dist_to_center < 2.5 * PX_PER_MM and dist_to_center < best_quad_score:
                    # Symmetry validation: opposite pairs of pads in a true IC must share centroid within 16 px
                    pts = [(p["cx"], p["cy"]) for p in q]
                    best_sym = float("inf")
                    for (i1, i2), (i3, i4) in [((0, 1), (2, 3)), ((0, 2), (1, 3)), ((0, 3), (1, 2))]:
                        m1 = ((pts[i1][0] + pts[i2][0]) / 2.0, (pts[i1][1] + pts[i2][1]) / 2.0)
                        m2 = ((pts[i3][0] + pts[i4][0]) / 2.0, (pts[i3][1] + pts[i4][1]) / 2.0)
                        diff = float(np.hypot(m1[0] - m2[0], m1[1] - m2[1]))
                        if diff < best_sym:
                            best_sym = diff
                    if best_sym < 16.0:
                        best_quad_score = dist_to_center
                        best_quad = (q_cx, q_cy)

    # ── Category 3: 3-pad components (SOT-23 / SOT-89 / SOT-223 / SOT-323 transistors, diodes, regulators) ──
    best_triplet = None
    best_triplet_score = float("inf")
    if len(pads) >= 3:
        for t in itertools.combinations(pads[:6], 3):
            areas = [p["area"] for p in t]
            if max(areas) / max(1.0, min(areas)) < 3.2:
                t_cx = sum(p["cx"] for p in t) / 3.0
                t_cy = sum(p["cy"] for p in t) / 3.0
                dist_to_center = float(np.hypot(t_cx - cx, t_cy - cy))
                p_dists = [
                    np.hypot(t[0]["cx"] - t[1]["cx"], t[0]["cy"] - t[1]["cy"]),
                    np.hypot(t[1]["cx"] - t[2]["cx"], t[1]["cy"] - t[2]["cy"]),
                    np.hypot(t[0]["cx"] - t[2]["cx"], t[0]["cy"] - t[2]["cy"])
                ]
                max_d_mm = max(p_dists) / PX_PER_MM
                if 0.35 <= max_d_mm <= 4.8 and dist_to_center < 2.5 * PX_PER_MM and dist_to_center < best_triplet_score:
                    best_triplet_score = dist_to_center
                    best_triplet = (t_cx, t_cy)

    # ── Category 4: 2-pad discrete components (resistors, capacitors, inductors, LEDs, diodes) ──
    best_pair = None
    best_pair_score = float("inf")
    for i in range(min(6, len(pads))):
        for j in range(i + 1, min(7, len(pads))):
            p1, p2 = pads[i], pads[j]
            area_ratio = max(p1["area"], p2["area"]) / max(1.0, min(p1["area"], p2["area"]))
            if area_ratio < 3.0:
                pad_dist_mm = float(np.hypot(p1["cx"] - p2["cx"], p1["cy"] - p2["cy"]) / PX_PER_MM)
                if 0.20 <= pad_dist_mm <= 8.5:
                    mid_x = (p1["cx"] + p2["cx"]) / 2.0
                    mid_y = (p1["cy"] + p2["cy"]) / 2.0
                    dist_to_center = float(np.hypot(mid_x - cx, mid_y - cy))
                    if dist_to_center < 3.5 * PX_PER_MM and dist_to_center < best_pair_score:
                        best_pair_score = dist_to_center
                        best_pair = (mid_x, mid_y)

    # Hierarchy: prioritize multi-pin IC / quad symmetry / triplet / pair / single
    if best_quad and (not best_pair or best_quad_score < best_pair_score * 0.75):
        comp_cx, comp_cy = best_quad
        comp_type = "quad"
    elif best_triplet and (not best_pair or best_triplet_score < best_pair_score * 0.65):
        comp_cx, comp_cy = best_triplet
        comp_type = "sot23_triplet"
    elif best_pair:
        comp_cx, comp_cy = best_pair
        comp_type = "pair"
    else:
        # Fall back to most solid pad near crosshair
        solid_pads = [p for p in pads if p["solidity"] > 0.80]
        target = solid_pads[0] if solid_pads else pads[0]
        comp_cx, comp_cy = target["cx"], target["cy"]
        comp_type = "single"

    eff_px_mm = get_effective_px_per_mm(w)
    dx_px = comp_cx - cx
    dy_px = cy - comp_cy  # Camera image Y is inverted relative to machine coordinates (down -> up)
    offset_dx = round(float(dx_px / eff_px_mm), 4)
    offset_dy = round(float(dy_px / eff_px_mm), 4)

    return JSONResponse({
        "found": True,
        "comp_type": comp_type,
        "offset_dx": offset_dx,
        "offset_dy": offset_dy,
        "pixel_dx": round(float(dx_px), 1),
        "pixel_dy": round(float(dy_px), 1),
        "dist_mm": round(float(np.hypot(offset_dx, offset_dy)), 4),
        "pads_detected": len(pads)
    })


@app.post("/api/find_pad")
async def find_pad(query: PadQuery):
    frame = get_frame()
    if frame is None:
        return {"found": False, "error": "Camera offline"}
    
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    
    # Pads are bright metallic rectangles on a dark green board
    # Otsu's method perfectly separates the two distinct colors
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    expected_w_px = query.width_mm * PX_PER_MM
    expected_h_px = query.height_mm * PX_PER_MM
    expected_area = expected_w_px * expected_h_px
    
    h, w = frame.shape[:2]
    cx, cy = w // 2, h // 2
    
    best_cnt = None
    min_dist = float('inf')
    best_cx = 0
    best_cy = 0
    
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if expected_area > 0:
            # Allow 30% to 300% area match (solder mask layers and varying lighting change apparent sizes)
            if area < expected_area * 0.3 or area > expected_area * 3.0:
                continue
                
        M = cv2.moments(cnt)
        if M["m00"] == 0: continue
        cx_cnt = int(M["m10"] / M["m00"])
        cy_cnt = int(M["m01"] / M["m00"])
        
        # The pad must be somewhat near the center (e.g., within 5mm) to avoid snapping to neighboring pads
        dist = np.hypot(cx_cnt - cx, cy_cnt - cy)
        if dist > (5.0 * PX_PER_MM):
            continue
            
        if dist < min_dist:
            min_dist = dist
            best_cnt = cnt
            best_cx = cx_cnt
            best_cy = cy_cnt
            
    if best_cnt is not None:
        dx_px = best_cx - cx
        dy_px = cy - best_cy
        return {
            "found": True,
            "offset_dx": round(dx_px / PX_PER_MM, 4),
            "offset_dy": round(dy_px / PX_PER_MM, 4)
        }
        
    return {"found": False}


@app.get("/api/check_glue_dot")
def api_check_glue_dot():
    """
    Detect whether a glue dot is present at the camera crosshair centre.
    Called by the dispense loop after each pad to verify the dot was deposited.
    Strategy: glue dots appear as a raised shiny blob — brighter than the board
    and roughly circular. We compare a tight centre ROI against the board baseline
    using Otsu thresholding, then check blob size and circularity.
    Returns: { found, confidence, area_mm2, diameter_mm }
    """
    frame = get_frame()
    if frame is None:
        return JSONResponse({"found": False, "error": "no_frame"})

    h, w = frame.shape[:2]
    cx, cy = w // 2, h // 2

    # Crop a 12mm square region centred on crosshair — generous enough to catch
    # any glue dot within the pad area regardless of minor placement error
    search_radius_px = int(6.0 * PX_PER_MM)
    x1 = max(0, cx - search_radius_px)
    y1 = max(0, cy - search_radius_px)
    x2 = min(w, cx + search_radius_px)
    y2 = min(h, cy + search_radius_px)

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    roi = gray[y1:y2, x1:x2]
    if roi.size == 0:
        return JSONResponse({"found": False, "error": "empty_roi"})

    # Otsu's threshold: separates glue dot (bright reflective blob) from board background
    blurred = cv2.GaussianBlur(roi, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return JSONResponse({"found": False, "confidence": 0.0, "area_mm2": 0.0, "diameter_mm": 0.0})

    # Find the largest blob near the crosshair centre (within 3mm)
    roi_cx = x2 - x1  # roi centre in roi coords
    roi_cy = y2 - y1
    max_search_px = int(3.0 * PX_PER_MM)

    best = None
    best_area = 0
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 50:  # discard noise
            continue
        M = cv2.moments(cnt)
        if M["m00"] == 0:
            continue
        cx_cnt = int(M["m10"] / M["m00"])
        cy_cnt = int(M["m01"] / M["m00"])
        dist = np.hypot(cx_cnt - roi_cx // 2, cy_cnt - roi_cy // 2)
        if dist > max_search_px:
            continue
        if area > best_area:
            best_area = area
            best = cnt

    if best is None:
        return JSONResponse({"found": False, "confidence": 0.0, "area_mm2": 0.0, "diameter_mm": 0.0})

    # Circularity check — glue dots are roughly round
    perimeter = cv2.arcLength(best, True)
    circularity = (4 * np.pi * best_area / (perimeter * perimeter)) if perimeter > 0 else 0

    area_mm2 = round(best_area / (PX_PER_MM ** 2), 4)
    diameter_mm = round(2 * np.sqrt(best_area / np.pi) / PX_PER_MM, 3)

    # Confidence: blend circularity and size reasonableness (0.1–10 mm² is normal for a glue dot)
    size_score = min(1.0, area_mm2 / 0.5) if area_mm2 < 10 else max(0.0, 1.0 - (area_mm2 - 10) / 10)
    confidence = round((circularity * 0.5 + size_score * 0.5), 3)

    found = circularity > 0.3 and area_mm2 > 0.05

    return JSONResponse({
        "found": found,
        "confidence": confidence,
        "area_mm2": area_mm2,
        "diameter_mm": diameter_mm,
        "circularity": round(circularity, 3),
    })


@app.post("/api/set_px_per_mm/{value}")
def api_set_px_per_mm(value: float):
    """Allow React to update the px/mm calibration value at runtime."""
    global PX_PER_MM
    PX_PER_MM = value
    print(f"[Vision] px/mm updated to {PX_PER_MM}")
    return {"px_per_mm": PX_PER_MM}


# ──────────────────────────────────────────────
# Lens distortion calibration endpoints
# ──────────────────────────────────────────────

@app.post("/api/calibration/capture")
def api_calibration_capture():
    """
    Save the current camera frame as a calibration image.
    The caller should show a printed 9×6 chessboard to the camera, move it to
    different positions/angles, then POST here once per position.
    OpenCV will try to locate the inner corners — the frame is only accepted if
    the full pattern is found.
    """
    frame = get_frame()
    if frame is None:
        return JSONResponse({"ok": False, "error": "no_frame"})

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    ret, corners = cv2.findChessboardCorners(gray, CHESSBOARD_SIZE, None)
    if not ret:
        return JSONResponse({"ok": False, "error": "chessboard_not_found", "captures": calib_state["captures"]})

    os.makedirs(CALIBRATION_DIR, exist_ok=True)
    idx = calib_state["captures"] + 1
    path = os.path.join(CALIBRATION_DIR, f"calib_{idx:03d}.jpg")
    cv2.imwrite(path, frame)
    with calib_lock:
        calib_state["captures"] = idx
    print(f"[Calibration] Captured frame {idx}: {path}")
    return JSONResponse({"ok": True, "captures": idx, "path": path})


@app.post("/api/calibration/compute")
def api_calibration_compute():
    """
    Run full OpenCV camera calibration using all previously captured frames.
    Requires ≥10 frames for a reliable result.  Saves the calibration matrix
    to lens_calibration.json and activates undistortion immediately.
    """
    if not os.path.exists(CALIBRATION_DIR):
        return JSONResponse({"ok": False, "error": "no_frames_captured"})

    image_files = sorted(f for f in os.listdir(CALIBRATION_DIR) if f.endswith(".jpg"))
    if len(image_files) < 6:
        return JSONResponse({"ok": False, "error": f"need ≥6 frames, have {len(image_files)}"})

    obj_points = []  # 3D points in real-world space
    img_points = []  # 2D points in image plane
    objp = np.zeros((CHESSBOARD_SIZE[0] * CHESSBOARD_SIZE[1], 3), np.float32)
    objp[:, :2] = np.mgrid[0:CHESSBOARD_SIZE[0], 0:CHESSBOARD_SIZE[1]].T.reshape(-1, 2)

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
    accepted = 0

    for fname in image_files:
        img = cv2.imread(os.path.join(CALIBRATION_DIR, fname))
        if img is None:
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        ret, corners = cv2.findChessboardCorners(gray, CHESSBOARD_SIZE, None)
        if not ret:
            continue
        corners2 = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)
        obj_points.append(objp)
        img_points.append(corners2)
        accepted += 1

    if accepted < 6:
        return JSONResponse({"ok": False, "error": f"only {accepted} usable frames after re-detection"})

    h, w = img.shape[:2]
    rms, mtx, dist, _, _ = cv2.calibrateCamera(obj_points, img_points, (w, h), None, None)

    # Persist to disk
    data = {
        "camera_matrix": mtx.tolist(),
        "dist_coeffs":   dist.tolist(),
        "rms_error":     round(float(rms), 4),
        "captures":      accepted,
    }
    with open(CALIBRATION_FILE, "w") as f:
        json.dump(data, f)

    with calib_lock:
        calib_state["camera_matrix"] = mtx
        calib_state["dist_coeffs"]   = dist
        calib_state["calibrated"]    = True
        calib_state["rms_error"]     = data["rms_error"]
        calib_state["captures"]      = accepted

    print(f"[Calibration] Computed from {accepted} frames. RMS={rms:.4f}. Saved to {CALIBRATION_FILE}")
    return JSONResponse({"ok": True, "rms_error": data["rms_error"], "frames_used": accepted})


@app.get("/api/calibration/status")
def api_calibration_status():
    """Return current calibration state (calibrated, rms_error, captures)."""
    with calib_lock:
        return JSONResponse({
            "calibrated": calib_state["calibrated"],
            "rms_error":  calib_state["rms_error"],
            "captures":   calib_state["captures"],
        })


@app.post("/api/calibration/reset")
def api_calibration_reset():
    """Clear saved calibration data and captured frames."""
    import shutil
    if os.path.exists(CALIBRATION_DIR):
        shutil.rmtree(CALIBRATION_DIR)
    if os.path.exists(CALIBRATION_FILE):
        os.remove(CALIBRATION_FILE)
    with calib_lock:
        calib_state["calibrated"]    = False
        calib_state["camera_matrix"] = None
        calib_state["dist_coeffs"]   = None
        calib_state["captures"]      = 0
        calib_state["rms_error"]     = None
    print("[Calibration] Reset — all calibration data cleared.")
    return JSONResponse({"ok": True})


@app.get("/api/check_board_present")
def api_check_board_present():
    """
    Snap the current camera frame and decide whether a PCB is likely present.

    Method: compare the std-dev of pixel intensities in the centre region of
    the frame against a threshold.  An empty, uniform machine bed has low
    std-dev (< ~18).  A PCB with copper traces, solder mask and pads produces
    high contrast → high std-dev (> ~28).

    Returns:
        present   : bool   – best guess
        confidence: float  – 0-1 (higher = more certain)
        std_dev   : float  – raw grayscale std-dev of the centre crop
        reason    : str    – human-readable explanation
    """
    frame = get_frame()
    if frame is None:
        return JSONResponse({
            "present": False, "confidence": 0.0,
            "std_dev": 0.0, "reason": "Camera not available"
        })

    h, w = frame.shape[:2]
    # Analyse only the centre 60% of the frame to ignore rig borders
    x1, y1 = int(w * 0.2), int(h * 0.2)
    x2, y2 = int(w * 0.8), int(h * 0.8)
    crop = cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)

    std_dev   = float(np.std(crop))
    mean_val  = float(np.mean(crop))

    # Thresholds tuned for typical FR4 PCB under white-light / ring-light
    EMPTY_MAX = 18.0   # below this → almost certainly empty bed
    BOARD_MIN = 28.0   # above this → PCB almost certainly present

    if std_dev >= BOARD_MIN:
        present    = True
        confidence = min(1.0, (std_dev - BOARD_MIN) / 20.0 + 0.75)
        reason     = f"High contrast detected (σ={std_dev:.1f}) — board likely present"
    elif std_dev <= EMPTY_MAX:
        present    = False
        confidence = min(1.0, (EMPTY_MAX - std_dev) / 10.0 + 0.6)
        reason     = f"Low contrast (σ={std_dev:.1f}, mean={mean_val:.0f}) — bed appears empty"
    else:
        present    = std_dev >= (EMPTY_MAX + BOARD_MIN) / 2
        confidence = 0.4
        reason     = f"Ambiguous (σ={std_dev:.1f}) — check camera position or lighting"

    return JSONResponse({
        "present":    present,
        "confidence": round(confidence, 2),
        "std_dev":    round(std_dev, 2),
        "reason":     reason,
    })


# ──────────────────────────────────────────────────────────────────────────────
# Option A: Camera exposure / gain / brightness control
#   Sliders in CameraPanel.jsx call these endpoints to adjust how the camera
#   sees the PCB without needing any additional hardware.
#   This directly improves fiducial detection under varying ambient lighting.
# ──────────────────────────────────────────────────────────────────────────────

class CameraSettingsModel(BaseModel):
    auto_exposure: bool  = None   # True = let camera auto-expose, False = manual
    exposure:      float = None   # Manual exposure (DirectShow log scale: -13 to -1)
    gain:          float = None   # Sensor gain 0–255
    brightness:    float = None   # Image brightness 0–255

@app.post("/api/camera/settings")
def api_set_camera_settings(s: CameraSettingsModel):
    """Apply exposure / gain / brightness to the live camera capture object."""
    if camera_cap is None:
        return JSONResponse({"ok": False, "error": "Camera not running"}, status_code=503)

    if s.auto_exposure is not None:
        # DirectShow: 0.75 = auto, 0.25 = manual
        camera_cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75 if s.auto_exposure else 0.25)

    if s.exposure is not None and not (s.auto_exposure is True):
        camera_cap.set(cv2.CAP_PROP_EXPOSURE, s.exposure)

    if s.gain is not None:
        camera_cap.set(cv2.CAP_PROP_GAIN, s.gain)

    if s.brightness is not None:
        camera_cap.set(cv2.CAP_PROP_BRIGHTNESS, s.brightness)

    return JSONResponse({"ok": True})


@app.get("/api/camera/settings")
def api_get_camera_settings():
    """Read current camera property values."""
    if camera_cap is None:
        return JSONResponse({"ok": False, "error": "Camera not running"}, status_code=503)

    return JSONResponse({
        "ok":           True,
        "auto_exposure": camera_cap.get(cv2.CAP_PROP_AUTO_EXPOSURE),
        "exposure":      camera_cap.get(cv2.CAP_PROP_EXPOSURE),
        "gain":          camera_cap.get(cv2.CAP_PROP_GAIN),
        "brightness":    camera_cap.get(cv2.CAP_PROP_BRIGHTNESS),
    })


# ──────────────────────────────────────────────
# Camera device selection (index + resolution)
# ──────────────────────────────────────────────



# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
