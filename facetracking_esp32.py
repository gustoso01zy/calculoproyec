"""
Face Tracking with Position Prediction (Interpolation) + ESP32 Wi-Fi Web Server
================================================================================
Replaces the PyFirmata/Arduino serial connection with HTTP requests to an
ESP32 running a lightweight web server.

Features
--------
* Face detection via cvzone FaceDetectionModule (MediaPipe-based).
* **Position prediction with linear interpolation**: when a face is detected,
  the script maintains a short history of face-center positions and extrapolates
  the next expected position using numpy.interp / linear regression.  This
  reduces servo lag by sending the *predicted* position rather than the current
  one, compensating for network + servo latency.
* Servo commands are sent asynchronously (non-blocking) to the ESP32 HTTP
  endpoint so the video loop is never stalled by network I/O.
* Smooth servo movement: new target angles are low-pass filtered against the
  previous command to avoid jitter.

Requirements
------------
    pip install opencv-python cvzone mediapipe numpy requests

ESP32 endpoint expected
-----------------------
    GET http://<ESP32_IP>/servo?x=<0-180>&y=<0-180>

Usage
-----
    1. Flash esp32_servo_server/esp32_servo_server.ino to your ESP32.
    2. Set ESP32_IP below to the IP shown in the ESP32 Serial Monitor.
    3. Run:  python facetracking_esp32.py
    4. Press 'q' to quit.
"""

import cv2
import numpy as np
import requests
import threading
import time
from collections import deque
from cvzone.FaceDetectionModule import FaceDetector

# ── Configuration ──────────────────────────────────────────────────────────
ESP32_IP        = "192.168.1.100"   # ← Change to your ESP32's IP address
ESP32_PORT      = 80
SERVO_ENDPOINT  = f"http://{ESP32_IP}:{ESP32_PORT}/servo"

CAM_INDEX       = 0
FRAME_W         = 1280
FRAME_H         = 720

# Prediction: number of past frames used to extrapolate next position
HISTORY_LEN     = 6    # frames kept in history buffer
PREDICT_STEPS   = 3    # how many frames ahead to predict (compensates latency)

# Smoothing factor for servo angles (0 = no smoothing, 1 = never moves)
SMOOTH_ALPHA    = 0.35  # new_angle = alpha*prev + (1-alpha)*target

# HTTP request timeout (seconds)
HTTP_TIMEOUT    = 0.15

# ── Globals ────────────────────────────────────────────────────────────────
servo_pos       = [90.0, 90.0]   # [X, Y] current smoothed servo angles
_send_lock      = threading.Lock()
_last_send_time = 0.0
SEND_INTERVAL   = 0.04           # minimum seconds between HTTP requests (~25 Hz)


# ── Position history for prediction ───────────────────────────────────────
class PositionPredictor:
    """
    Maintains a rolling window of (timestamp, x, y) observations and
    predicts the position N frames into the future using linear regression
    (least-squares fit over the history window).
    """

    def __init__(self, history_len: int = HISTORY_LEN,
                 predict_steps: int = PREDICT_STEPS,
                 fps_estimate: float = 30.0):
        self.history_len   = history_len
        self.predict_steps = predict_steps
        self.frame_dt      = 1.0 / fps_estimate
        self.times: deque  = deque(maxlen=history_len)
        self.xs:    deque  = deque(maxlen=history_len)
        self.ys:    deque  = deque(maxlen=history_len)

    def update(self, x: float, y: float) -> None:
        """Add a new observation."""
        self.times.append(time.monotonic())
        self.xs.append(float(x))
        self.ys.append(float(y))

    def predict(self) -> tuple[float, float]:
        """
        Return the predicted (x, y) position PREDICT_STEPS frames ahead.
        Falls back to the last known position when history is too short.
        """
        n = len(self.times)
        if n < 2:
            # Not enough data – return last known position
            return self.xs[-1], self.ys[-1]

        t_arr = np.array(self.times, dtype=np.float64)
        x_arr = np.array(self.xs,    dtype=np.float64)
        y_arr = np.array(self.ys,    dtype=np.float64)

        # Normalise time to avoid numerical issues
        t0    = t_arr[0]
        t_arr = t_arr - t0

        # Least-squares linear fit: position = a*t + b
        # Using numpy polyfit (degree 1)
        px = np.polyfit(t_arr, x_arr, 1)   # [slope, intercept]
        py = np.polyfit(t_arr, y_arr, 1)

        # Predict at current_time + predict_steps * frame_dt
        t_future = (time.monotonic() - t0) + self.predict_steps * self.frame_dt
        pred_x   = float(np.polyval(px, t_future))
        pred_y   = float(np.polyval(py, t_future))

        return pred_x, pred_y

    def reset(self) -> None:
        self.times.clear()
        self.xs.clear()
        self.ys.clear()


# ── Async HTTP sender ──────────────────────────────────────────────────────
def send_servo_command(angle_x: int, angle_y: int) -> None:
    """Send servo angles to ESP32 in a background thread (non-blocking)."""
    global _last_send_time

    now = time.monotonic()
    with _send_lock:
        if now - _last_send_time < SEND_INTERVAL:
            return                          # rate-limit: skip this frame
        _last_send_time = now

    def _send():
        try:
            url = f"{SERVO_ENDPOINT}?x={angle_x}&y={angle_y}"
            requests.get(url, timeout=HTTP_TIMEOUT)
        except requests.exceptions.RequestException:
            pass  # silently ignore network errors to keep the loop running

    t = threading.Thread(target=_send, daemon=True)
    t.start()


# ── Coordinate → servo angle conversion ───────────────────────────────────
def pixel_to_servo(px: float, py: float,
                   frame_w: int, frame_h: int) -> tuple[int, int]:
    """
    Map pixel coordinates to servo angles [0, 180] using linear interpolation.
    X axis is mirrored so the servo moves in the intuitive direction.
    """
    angle_x = int(np.interp(px, [0, frame_w], [180, 0]))   # mirror X
    angle_y = int(np.interp(py, [0, frame_h], [0,   180]))
    angle_x = int(np.clip(angle_x, 0, 180))
    angle_y = int(np.clip(angle_y, 0, 180))
    return angle_x, angle_y


# ── Smooth servo angle update ──────────────────────────────────────────────
def smooth_servo(current: list[float], target_x: int, target_y: int,
                 alpha: float = SMOOTH_ALPHA) -> tuple[int, int]:
    """Low-pass filter: blend previous angle with new target."""
    current[0] = alpha * current[0] + (1.0 - alpha) * target_x
    current[1] = alpha * current[1] + (1.0 - alpha) * target_y
    return int(current[0]), int(current[1])


# ── Main ───────────────────────────────────────────────────────────────────
def main() -> None:
    cap = cv2.VideoCapture(CAM_INDEX)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  FRAME_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_H)

    if not cap.isOpened():
        print("ERROR: Cannot open camera.")
        return

    detector  = FaceDetector(minDetectionCon=0.6)
    predictor = PositionPredictor(history_len=HISTORY_LEN,
                                  predict_steps=PREDICT_STEPS)

    # FPS estimation
    fps_timer  = time.monotonic()
    fps_count  = 0
    fps_display = 0.0

    print(f"Connecting to ESP32 at {ESP32_IP}:{ESP32_PORT} ...")
    print("Press 'q' to quit.\n")

    while True:
        success, img = cap.read()
        if not success:
            print("ERROR: Failed to read frame.")
            break

        # ── FPS counter ────────────────────────────────────────────────────
        fps_count += 1
        elapsed = time.monotonic() - fps_timer
        if elapsed >= 1.0:
            fps_display = fps_count / elapsed
            fps_count   = 0
            fps_timer   = time.monotonic()
            # Update predictor's frame_dt estimate
            predictor.frame_dt = 1.0 / max(fps_display, 1.0)

        # ── Face detection ─────────────────────────────────────────────────
        img, bboxs = detector.findFaces(img, draw=False)

        if bboxs:
            # Use the largest (closest) detected face
            bboxs_sorted = sorted(bboxs, key=lambda b: b["bbox"][2] * b["bbox"][3],
                                  reverse=True)
            fx, fy = bboxs_sorted[0]["center"]

            # Update predictor with current observation
            predictor.update(fx, fy)

            # Predict future position to compensate servo + network latency
            pred_x, pred_y = predictor.predict()
            pred_x = float(np.clip(pred_x, 0, FRAME_W))
            pred_y = float(np.clip(pred_y, 0, FRAME_H))

            # Convert predicted pixel position → servo angles
            target_x, target_y = pixel_to_servo(pred_x, pred_y, FRAME_W, FRAME_H)

            # Smooth the servo command
            cmd_x, cmd_y = smooth_servo(servo_pos, target_x, target_y)

            # Send to ESP32 (non-blocking)
            send_servo_command(cmd_x, cmd_y)

            # ── Overlay ────────────────────────────────────────────────────
            # Detected face center (green)
            cv2.circle(img, (fx, fy), 15, (0, 255, 0), cv2.FILLED)
            cv2.circle(img, (fx, fy), 80, (0, 255, 0), 2)

            # Predicted position (red)
            px_int = int(pred_x)
            py_int = int(pred_y)
            cv2.circle(img, (px_int, py_int), 12, (0, 0, 255), cv2.FILLED)
            cv2.circle(img, (px_int, py_int), 60, (0, 0, 255), 2)

            # Arrow from detected → predicted
            cv2.arrowedLine(img, (fx, fy), (px_int, py_int),
                            (0, 165, 255), 2, tipLength=0.3)

            # Crosshair lines
            cv2.line(img, (0, fy),   (FRAME_W, fy),   (0, 0, 0), 1)
            cv2.line(img, (fx, 0),   (fx, FRAME_H),   (0, 0, 0), 1)

            cv2.putText(img, f"Detected: ({fx}, {fy})",
                        (fx + 20, fy - 30), cv2.FONT_HERSHEY_PLAIN, 1.5,
                        (0, 255, 0), 2)
            cv2.putText(img, f"Predicted: ({px_int}, {py_int})",
                        (fx + 20, fy - 10), cv2.FONT_HERSHEY_PLAIN, 1.5,
                        (0, 0, 255), 2)
            cv2.putText(img, "TARGET LOCKED",
                        (FRAME_W - 420, 50), cv2.FONT_HERSHEY_PLAIN, 3,
                        (255, 0, 255), 3)

        else:
            # No face detected – reset predictor, hold last servo position
            predictor.reset()

            cv2.putText(img, "NO TARGET",
                        (FRAME_W - 380, 50), cv2.FONT_HERSHEY_PLAIN, 3,
                        (0, 0, 255), 3)
            # Default crosshair at centre
            cx, cy = FRAME_W // 2, FRAME_H // 2
            cv2.circle(img, (cx, cy), 80, (0, 0, 255), 2)
            cv2.circle(img, (cx, cy), 15, (0, 0, 255), cv2.FILLED)
            cv2.line(img, (0, cy),   (FRAME_W, cy),   (0, 0, 0), 1)
            cv2.line(img, (cx, 0),   (cx, FRAME_H),   (0, 0, 0), 1)

        # ── HUD ───────────────────────────────────────────────────────────
        cv2.putText(img, f"Servo X: {int(servo_pos[0])} deg",
                    (50, 50), cv2.FONT_HERSHEY_PLAIN, 2, (255, 200, 0), 2)
        cv2.putText(img, f"Servo Y: {int(servo_pos[1])} deg",
                    (50, 90), cv2.FONT_HERSHEY_PLAIN, 2, (255, 200, 0), 2)
        cv2.putText(img, f"FPS: {fps_display:.1f}",
                    (50, 130), cv2.FONT_HERSHEY_PLAIN, 2, (200, 200, 200), 2)
        cv2.putText(img, f"ESP32: {ESP32_IP}",
                    (50, 170), cv2.FONT_HERSHEY_PLAIN, 1.5, (200, 200, 200), 2)

        cv2.imshow("Face Tracking – ESP32 Wi-Fi", img)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()
    print("Stopped.")


if __name__ == "__main__":
    main()
