/*
 * ESP32 Servo Web Server
 * ----------------------
 * Receives servo angle commands via HTTP GET requests over Wi-Fi.
 * Controls two servos (X and Y axes) for face-tracking pan/tilt mount.
 *
 * Endpoint:
 *   GET /servo?x=<0-180>&y=<0-180>
 *   GET /status  -> returns current servo positions as JSON
 *
 * Wiring:
 *   Servo X (Pan)  -> GPIO 13
 *   Servo Y (Tilt) -> GPIO 12
 *   Both servos share 5V and GND from external power supply.
 *   ESP32 GND must be common with servo power supply GND.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>

// ── Wi-Fi credentials ──────────────────────────────────────────────────────
const char* SSID     = "YOUR_WIFI_SSID";
const char* PASSWORD = "YOUR_WIFI_PASSWORD";

// ── Servo GPIO pins ────────────────────────────────────────────────────────
const int PIN_SERVO_X = 13;
const int PIN_SERVO_Y = 12;

// ── Servo angle limits ─────────────────────────────────────────────────────
const int SERVO_MIN = 0;
const int SERVO_MAX = 180;

// ── Global objects ─────────────────────────────────────────────────────────
WebServer server(80);
Servo servoX;
Servo servoY;

int currentX = 90;
int currentY = 90;

// ── Helpers ────────────────────────────────────────────────────────────────
int clamp(int value, int minVal, int maxVal) {
  if (value < minVal) return minVal;
  if (value > maxVal) return maxVal;
  return value;
}

// ── Route: /servo?x=<angle>&y=<angle> ─────────────────────────────────────
void handleServo() {
  if (server.hasArg("x") && server.hasArg("y")) {
    int angleX = clamp(server.arg("x").toInt(), SERVO_MIN, SERVO_MAX);
    int angleY = clamp(server.arg("y").toInt(), SERVO_MIN, SERVO_MAX);

    servoX.write(angleX);
    servoY.write(angleY);

    currentX = angleX;
    currentY = angleY;

    String response = "{\"status\":\"ok\",\"x\":" + String(angleX) +
                      ",\"y\":" + String(angleY) + "}";
    server.send(200, "application/json", response);
  } else {
    server.send(400, "application/json",
                "{\"status\":\"error\",\"message\":\"Missing x or y parameter\"}");
  }
}

// ── Route: /status ─────────────────────────────────────────────────────────
void handleStatus() {
  String response = "{\"status\":\"ok\",\"x\":" + String(currentX) +
                    ",\"y\":" + String(currentY) + "}";
  server.send(200, "application/json", response);
}

// ── Route: / (root info page) ──────────────────────────────────────────────
void handleRoot() {
  String html = "<!DOCTYPE html><html><head><title>ESP32 Servo Server</title></head><body>";
  html += "<h2>ESP32 Face-Tracking Servo Server</h2>";
  html += "<p>IP: " + WiFi.localIP().toString() + "</p>";
  html += "<p>Endpoints:</p><ul>";
  html += "<li><code>GET /servo?x=90&amp;y=90</code> &mdash; set servo angles</li>";
  html += "<li><code>GET /status</code> &mdash; get current angles (JSON)</li>";
  html += "</ul>";
  html += "<p>Current X: <b>" + String(currentX) + "&deg;</b> &nbsp; Y: <b>" + String(currentY) + "&deg;</b></p>";
  html += "</body></html>";
  server.send(200, "text/html", html);
}

// ── Setup ──────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // Attach servos
  servoX.attach(PIN_SERVO_X);
  servoY.attach(PIN_SERVO_Y);
  servoX.write(currentX);
  servoY.write(currentY);

  // Connect to Wi-Fi
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(SSID);
  WiFi.begin(SSID, PASSWORD);

  unsigned long startTime = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - startTime > 15000) {
      Serial.println("\nFailed to connect. Restarting...");
      ESP.restart();
    }
  }

  Serial.println("\nWi-Fi connected!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  // Register routes
  server.on("/",       handleRoot);
  server.on("/servo",  handleServo);
  server.on("/status", handleStatus);
  server.onNotFound([]() {
    server.send(404, "application/json", "{\"status\":\"error\",\"message\":\"Not found\"}");
  });

  server.begin();
  Serial.println("HTTP server started on port 80");
}

// ── Loop ───────────────────────────────────────────────────────────────────
void loop() {
  server.handleClient();
}
