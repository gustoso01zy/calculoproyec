# ESP32 Servo Server – Wiring Guide

## Components

| Component | Quantity |
|-----------|----------|
| ESP32 DevKit (38-pin or 30-pin) | 1 |
| SG90 / MG996R servo (Pan – X axis) | 1 |
| SG90 / MG996R servo (Tilt – Y axis) | 1 |
| External 5 V power supply (≥ 2 A) | 1 |
| Breadboard + jumper wires | — |

---

## Pin Connections

```
ESP32 DevKit          Servo X (Pan)        Servo Y (Tilt)
─────────────         ─────────────        ──────────────
GPIO 13  ──────────►  Signal (orange)
GPIO 12  ──────────────────────────────►   Signal (orange)
GND      ──────────►  GND (brown/black)
GND      ──────────────────────────────►   GND (brown/black)

External 5 V PSU
─────────────────
+5 V     ──────────►  VCC (red)  [Servo X]
+5 V     ──────────────────────────────►   VCC (red)  [Servo Y]
GND      ──────────►  GND (brown/black)  [Servo X]
GND      ──────────────────────────────►   GND (brown/black) [Servo Y]
GND (PSU) ─────────►  GND (ESP32)   ← IMPORTANT: common ground
```

> ⚠️ **Never power servos directly from the ESP32 3.3 V or 5 V pins.**
> Servo motors draw high current on movement and will brown-out the ESP32.
> Always use an external 5 V supply and share the GND with the ESP32.

---

## Pan/Tilt Mount Orientation

```
         ┌──────────────────────┐
         │   Camera / Sensor    │
         └──────────┬───────────┘
                    │
         ┌──────────▼───────────┐
         │  Servo Y  (Tilt)     │  ← rotates up/down
         └──────────┬───────────┘
                    │
         ┌──────────▼───────────┐
         │  Servo X  (Pan)      │  ← rotates left/right
         └──────────────────────┘
                    │
              Fixed base
```

---

## Arduino IDE Setup for ESP32

1. Open **Arduino IDE** → *File → Preferences*.
2. Add to *Additional Boards Manager URLs*:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. *Tools → Board → Boards Manager* → search **esp32** → install **esp32 by Espressif Systems**.
4. Install the **ESP32Servo** library:
   *Sketch → Include Library → Manage Libraries* → search **ESP32Servo** → install.
5. Select board: *Tools → Board → ESP32 Arduino → ESP32 Dev Module*.
6. Select the correct COM port.
7. Open `esp32_servo_server.ino`, set your Wi-Fi credentials, upload.

---

## Finding the ESP32 IP Address

After uploading, open the **Serial Monitor** at **115200 baud**.
You will see output like:

```
Connecting to Wi-Fi: MyNetwork
....
Wi-Fi connected!
IP address: 192.168.1.100
HTTP server started on port 80
```

Copy that IP address and paste it into `facetracking_esp32.py`:

```python
ESP32_IP = "192.168.1.100"   # ← your ESP32's IP
```

---

## Quick Test (browser or curl)

```bash
# Set servos to centre position
curl "http://192.168.1.100/servo?x=90&y=90"

# Read current angles
curl "http://192.168.1.100/status"
```

Expected JSON response:
```json
{"status":"ok","x":90,"y":90}
```
