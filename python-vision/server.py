"""
Python Vision Co-Processor for Glue Dispensing Machine
=======================================================
Architecture: FastAPI server that exclusively owns the USB camera.
- Streams smooth MJPEG video to the React frontend at /video_feed
- Detects fiducials via Hough Circle Transform and calculates offsets
- Reports sharpness score for future Z-axis Auto-Focus logic
- Exposes REST API for React to trigger detection and read results
"""

import cv2
import numpy as np
import threading
import time
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────
CAMERA_INDEX = 1          # Change to 0 if the dispensing camera is the only webcam
FRAME_WIDTH  = 1280
FRAME_HEIGHT = 720
MJPEG_QUALITY = 85        # JPEG quality 0-100 (higher = better quality, more bandwidth)
DETECTION_INTERVAL = 0.5  # Seconds between vision analysis frames (not stream frames)

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
}

# ──────────────────────────────────────────────
# Camera capture (runs in a dedicated background thread)
# ──────────────────────────────────────────────
latest_frame = None
frame_lock = threading.Lock()
camera_thread_running = True

def camera_loop():
    """
    Continuously reads frames from the USB camera and stores the latest one.
    Runs in its own daemon thread so it never blocks the web server or the
    vision analysis thread.
    """
    global latest_frame
    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)  # CAP_DSHOW for Windows USB cameras
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  FRAME_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    cap.set(cv2.CAP_PROP_FPS, 30)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Minimize latency; only keep the most recent frame

    if not cap.isOpened():
        print(f"[Vision] ERROR: Could not open camera at index {CAMERA_INDEX}.")
        with state_lock:
            shared_state["camera_ok"] = False
        return

    print(f"[Vision] Camera opened on index {CAMERA_INDEX} ({FRAME_WIDTH}x{FRAME_HEIGHT})")

    while camera_thread_running:
        ret, frame = cap.read()
        if ret:
            with frame_lock:
                latest_frame = frame
            with state_lock:
                shared_state["frame_count"] += 1
        else:
            time.sleep(0.01)

    cap.release()
    print("[Vision] Camera released.")


def get_frame() -> np.ndarray | None:
    with frame_lock:
        return latest_frame.copy() if latest_frame is not None else None


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

        h, w = frame.shape[:2]
        cx, cy = w // 2, h // 2  # Crosshair centre in pixels

        # ── Sharpness (Laplacian Variance) ──────────────────────────
        gray        = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharpness   = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        # ── Fiducial Detection ───────────────────────────────────────
        detected_circles = []
        best_circle = None
        offset_dx = 0.0
        offset_dy = 0.0

        with state_lock:
            is_detecting = shared_state["detecting"]

        if is_detecting:
            # Blur to reduce noise before circle detection
            blurred = cv2.GaussianBlur(gray, (9, 9), 2)
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
                for (px, py, pr) in circles_np:
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
                            
                    dx_px = px - cx
                    dy_px = cy - py  # Invert Y: camera Y down → machine Y up
                    dx_mm = round(dx_px / PX_PER_MM, 4)
                    dy_mm = round(dy_px / PX_PER_MM, 4)
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

                    # --- ANTI-JITTER DEADBAND ---
                    # If the machine is stopped, HoughCircles might jitter by 1-5 pixels randomly.
                    # If the new circle is within 8 pixels of the previous one, freeze it!
                    if sticky_best_circle is not None:
                        dist = ((current_best["pixel_x"] - sticky_best_circle["pixel_x"])**2 + 
                                (current_best["pixel_y"] - sticky_best_circle["pixel_y"])**2)**0.5
                        
                        if dist < 8.0:
                            # Freeze! Use the old perfectly stable coordinates
                            best_circle = sticky_best_circle
                        else:
                            # Machine physically moved, update immediately
                            sticky_best_circle = current_best
                            best_circle = current_best
                    else:
                        sticky_best_circle = current_best
                        best_circle = current_best

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
    for c in circles:
        px, py, pr = c["pixel_x"], c["pixel_y"], c["radius"]
        is_best = (best_circle is not None and
                   px == best_circle["pixel_x"] and py == best_circle["pixel_y"])
        color     = (0, 255, 0) if is_best else (0, 150, 255)
        thickness = 2 if is_best else 1
        cv2.circle(out, (px, py), pr, color, thickness)
        cv2.circle(out, (px, py), 3, color, -1)

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


def generate_mjpeg():
    """
    Generator function that yields annotated JPEG frames in MJPEG multipart format.
    Crash-proof: any single bad frame is skipped rather than killing the whole stream.
    """
    encode_params = [cv2.IMWRITE_JPEG_QUALITY, MJPEG_QUALITY]
    FRAME_DELAY = 1.0 / 30  # Cap at 30fps to prevent CPU spikes

    while True:
        frame_start = time.time()
        try:
            frame = get_frame()
            if frame is None:
                time.sleep(0.033)
                continue

            annotated = annotate_frame(frame)
            ret, jpeg = cv2.imencode(".jpg", annotated, encode_params)
            if not ret or jpeg is None:
                time.sleep(0.033)
                continue

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" +
                jpeg.tobytes() +
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
# FastAPI App
# ──────────────────────────────────────────────
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    # Launch camera and vision background threads on startup
    cam_thread    = threading.Thread(target=camera_loop,  daemon=True)
    vision_thread = threading.Thread(target=vision_loop,  daemon=True)
    cam_thread.start()
    vision_thread.start()
    print("[Vision] Server ready — stream at http://localhost:8000/video_feed")
    yield
    # Shutdown: signal threads to stop
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
        return JSONResponse({"ok": shared_state["camera_ok"], "frames": shared_state["frame_count"]})


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
    M = cv2.moments(thresh)
    if M["m00"] == 0:
        return JSONResponse({"found": False, "error": "empty_moments"})

    centroid_x = x1 + M["m10"] / M["m00"]   # back to full-frame coordinates
    centroid_y = y1 + M["m01"] / M["m00"]

    dx_mm = round((centroid_x - cx_frame) / PX_PER_MM, 4)
    dy_mm = round((cy_frame - centroid_y) / PX_PER_MM, 4)  # invert Y: screen-down → machine-up

    return JSONResponse({
        "found": True,
        "offset_dx": dx_mm,
        "offset_dy": dy_mm,
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
    
    cx, cy = FRAME_WIDTH // 2, FRAME_HEIGHT // 2
    
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


@app.post("/api/set_px_per_mm/{value}")
def api_set_px_per_mm(value: float):
    """Allow React to update the px/mm calibration value at runtime."""
    global PX_PER_MM
    PX_PER_MM = value
    print(f"[Vision] px/mm updated to {PX_PER_MM}")
    return {"px_per_mm": PX_PER_MM}


# ──────────────────────────────────────────────
# Startup: launch background threads
# ──────────────────────────────────────────────

# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
