# Custom Feature Boards: Hardware Setup Guide

This document explains how to set up, configure, and wire the custom Arduino sketches designed to run on your separate feature boards. Because you are using standard GRBL for your primary motion control, these separate boards act as listeners and sensor modules that handle telemetry and advanced feedback.

---

## 1. Payload Manager Board (`payload_manager_board.ino`)
**Purpose:** Reads an HX711 Load Cell to measure the weight of the machine head. Responds to software `(SYNC_PAYLOAD)` requests.

* **Required Library:** `HX711 Arduino Library` by Bogdan Necula
* **Install Path:** Open Arduino IDE > **Sketch** > **Include Library** > **Manage Libraries...** > Search for "HX711" and click Install.
* **Pin Configuration:**
  * `LOADCELL_DOUT_PIN`: Default is **Pin 3** (Digital)
  * `LOADCELL_SCK_PIN`: Default is **Pin 2** (Digital)
* **Parameters to Calibrate:**
  * `CALIBRATION_FACTOR`: (Line 21) You must run a standard HX711 calibration sketch with a known weight (e.g., a 100g weight) to find the correct factor for your specific scale, then replace the `2280.f` value with your number.

---

## 2. Flux Tank Level Board (`flux_tank_board.ino`)
**Purpose:** Reads an HX711 Load Cell placed under the flux/glue tank to measure live gross weight. Streams the weight continuously to the software once per second.

* **Required Library:** `HX711 Arduino Library` by Bogdan Necula (Same as above)
* **Pin Configuration:**
  * `LOADCELL_DOUT_PIN`: Default is **Pin 3** (Digital)
  * `LOADCELL_SCK_PIN`: Default is **Pin 2** (Digital)
* **Parameters to Calibrate:**
  * `CALIBRATION_FACTOR`: (Line 20) Same as the payload board, calibrate this value using a known weight.
  * `READ_INTERVAL_MS`: (Line 23) Defaults to `1000` (1 second). Change this if you want the tank level to update faster or slower in the UI.

---

## 3. Advanced Fume Telemetry Board (`fume_telemetry_board.ino`)
**Purpose:** Monitors the Coolant relay pin to detect when standard GRBL turns the fume extractor ON. Once running, it reads analog sensors and streams real-time airflow and pump load back to the UI.

* **Required Library:** None (Uses standard Arduino analog/digital functions)
* **Pin Configuration:**
  * `EXTRACTOR_STATE_PIN`: Default is **Pin 2** (Digital). Wire this in parallel to your main GRBL Coolant Relay signal.
  * `AIRFLOW_SENSOR_PIN`: Default is **A0** (Analog).
  * `PUMP_LOAD_SENSOR_PIN`: Default is **A1** (Analog).
* **Parameters to Calibrate:**
  * **Relay Logic (Line 31):** `(digitalRead(EXTRACTOR_STATE_PIN) == LOW)` — Change `LOW` to `HIGH` depending on whether your relay triggers on an active-low or active-high signal.
  * **Airflow Math (Line 36):** `(rawAirflow / 1023.0) * 50.0` — Update `50.0` to the max Liters-Per-Minute limit of your specific analog airflow sensor datasheet.
  * **Load Math (Line 40):** `(rawLoad / 1023.0) * 100.0` — Update this math to correctly scale the 0-5V signal from your current/load sensor into a 0-100% value.

---

## 4. Tip Management Sensor Board (`tip_management_board.ino`)
**Purpose:** Reads a physical sensor on the dispensing head (e.g., optical break-beam, limit switch, or hall effect). Replies to `(VERIFY_TIP)` commands to confirm if a tool pickup or dropoff was successful.

* **Required Library:** None
* **Pin Configuration:**
  * `TIP_SENSOR_PIN`: Default is **Pin 4** (Digital). Connect your sensor between this pin and GND.
* **Parameters to Calibrate:**
  * **Sensor Logic (Line 32):** `(digitalRead(TIP_SENSOR_PIN) == LOW)` — If you are using a Normally Open (NO) switch wired to GND, `LOW` means the tip is present. If you are using an optical sensor or Normally Closed (NC) switch, you may need to change this to `HIGH`.

