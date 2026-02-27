# Face Tracking with Position Prediction – ESP32 Wi-Fi Web Server

A real-time face-tracking pan/tilt system that:

* Detects faces with **OpenCV** (Haar cascade) or **cvzone / MediaPipe**.
* **Predicts** the next face position using **linear interpolation / regression** over a rolling history window, compensating for servo + network latency.
* Sends servo commands wirelessly over **Wi-Fi** to an **ESP32** running a lightweight **HTTP web server** (no USB cable needed).

---

## Repository Structure

```
.
├── facedetection.py              # Simple face detection (OpenCV, no servo)
├── facetracking.py               # Original face tracking (Arduino via PyFirmata)
├── facetracking_esp32.py         # ★ New: face tracking + prediction → ESP32 Wi-Fi
├── haarcascade_frontalface_default.xml
├── esp32_servo_server/
│   ├── esp32_servo_server.ino    # ★ ESP32 Arduino firmware (HTTP web server)
│   └── wiring_esp32.md           # ★ Wiring diagram & setup guide
└── README.md
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  PC / Laptop                                                    │
│                                                                 │
│  Camera → OpenCV frame → FaceDetector → (fx, fy)               │
│                                  │                              │
│                         PositionPredictor                       │
│                         (linear regression over last N frames)  │
│                                  │                              │
│                         (pred_x, pred_y)  ← predicted position  │
│                                  │                              │
│                         pixel_to_servo()  ← np.interp mapping   │
│                                  │                              │
│                         smooth_servo()    ← low-pass filter     │
│                                  │                              │
│                    HTTP GET /servo?x=…&y=…  (async thread)      │
└──────────────────────────────────┼──────────────────────────────┘
                                   │  Wi-Fi (same LAN)
┌──────────────────────────────────▼──────────────────────────────┐
│  ESP32                                                          │
│                                                                 │
│  WebServer (port 80)                                            │
│    /servo?x=<0-180>&y=<0-180>  → servoX.write() + servoY.write()│
│    /status                     → JSON current angles            │
│    /                           → HTML info page                 │
│                                                                 │
│  GPIO 13 → Servo X (Pan)                                        │
│  GPIO 12 → Servo Y (Tilt)                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Position Prediction (Interpolation)

The `PositionPredictor` class keeps a rolling buffer of the last **N** face-center
coordinates with timestamps.  On each frame it fits a **degree-1 polynomial
(linear regression)** to the history using `numpy.polyfit` and evaluates it
`PREDICT_STEPS` frames into the future.

This means the servo is commanded to move to **where the face will be**, not
where it currently is, effectively cancelling the combined latency of:

* HTTP round-trip over Wi-Fi (~10–50 ms)
* Servo mechanical response (~50–100 ms)

Tunable parameters in `facetracking_esp32.py`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `HISTORY_LEN` | 6 | Frames kept in the regression window |
| `PREDICT_STEPS` | 3 | Frames ahead to predict |
| `SMOOTH_ALPHA` | 0.35 | Low-pass filter blend (0 = no smoothing) |
| `SEND_INTERVAL` | 0.04 s | Minimum time between HTTP requests |

---

## Requirements

### Python (PC side)

```bash
pip install opencv-python cvzone mediapipe numpy requests
```

### Arduino / ESP32 (firmware side)

* **Arduino IDE** with the **esp32 by Espressif Systems** board package.
* **ESP32Servo** library (install via Library Manager).

See [`esp32_servo_server/wiring_esp32.md`](esp32_servo_server/wiring_esp32.md) for full setup instructions.

---

## Quick Start

### 1 – Flash the ESP32

1. Open `esp32_servo_server/esp32_servo_server.ino` in Arduino IDE.
2. Edit the Wi-Fi credentials:
   ```cpp
   const char* SSID     = "YOUR_WIFI_SSID";
   const char* PASSWORD = "YOUR_WIFI_PASSWORD";
   ```
3. Upload to the ESP32.
4. Open Serial Monitor (115200 baud) and note the IP address printed.

### 2 – Configure the Python script

Edit `facetracking_esp32.py`:

```python
ESP32_IP = "192.168.1.100"   # ← replace with your ESP32's IP
```

### 3 – Run

```bash
python facetracking_esp32.py
```

Press **`q`** to quit.

---

## ESP32 HTTP API

| Method | Endpoint | Parameters | Response |
|--------|----------|------------|----------|
| GET | `/servo` | `x` (0–180), `y` (0–180) | `{"status":"ok","x":90,"y":90}` |
| GET | `/status` | — | `{"status":"ok","x":90,"y":90}` |
| GET | `/` | — | HTML info page |

---

## Original Project (Arduino / PyFirmata)

The original `facetracking.py` uses **PyFirmata** over USB serial to an Arduino.
It is kept for reference.  The new `facetracking_esp32.py` is a drop-in
replacement that adds Wi-Fi communication and position prediction.

### Original Requirements

```
cvzone 1.4.1 (includes opencv and numpy)
pyfirmata
```

---

## Wiring

See [`esp32_servo_server/wiring_esp32.md`](esp32_servo_server/wiring_esp32.md) for the full wiring diagram, pin assignments, and Arduino IDE setup steps.
