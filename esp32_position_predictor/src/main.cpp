#include <Arduino.h>
#include <LittleFS.h>
#include <WebServer.h>
#include <WiFi.h>
#include <ESP32Servo.h>

namespace {
constexpr char kApSsid[] = "ESP32-Predictor";
constexpr char kApPassword[] = "frank2026";
const IPAddress kApIp(192, 168, 4, 1);
const IPAddress kGateway(192, 168, 4, 1);
const IPAddress kSubnet(255, 255, 255, 0);
constexpr uint32_t kHeartbeatIntervalMs = 3000;

WebServer server(80);

constexpr int kServoXPin = 14;  // Recomendado: GPIO14, evita pines de boot/strapping
constexpr int kServoYPin = 27;  // Recomendado: GPIO27
Servo servoX;
Servo servoY;

struct TelemetryStats {
  uint32_t totalRequests = 0;
  uint32_t statusHits = 0;
  uint32_t pingHits = 0;
  uint32_t telemetryPosts = 0;
  uint32_t staticHits = 0;
  uint32_t notFoundHits = 0;
  uint32_t lastHeartbeatMs = 0;
  String lastClient = "-";
  String lastEvent = "boot";
} stats;
}

String jsonEscape(const String &input) {
  String out;
  out.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); ++i) {
    const char c = input[i];
    if (c == '\\') {
      out += "\\\\";
    } else if (c == '"') {
      out += "\\\"";
    } else if (c == '\n' || c == '\r') {
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}

String sanitizeLine(const String &input) {
  String clean = input;
  clean.replace('\n', ' ');
  clean.replace('\r', ' ');
  if (clean.length() > 180) {
    clean = clean.substring(0, 180) + "...";
  }
  return clean;
}

void markRequest() {
  stats.totalRequests += 1;
  const String ip = server.client().remoteIP().toString();
  if (ip.length() > 0) {
    stats.lastClient = ip;
  }
}

String contentTypeForPath(const String &path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "text/plain";
}

bool serveFromLittleFs(const String &rawPath) {
  String path = rawPath;
  if (path == "/") {
    path = "/index.html";
  }
  if (path.endsWith("/")) {
    path += "index.html";
  }
  if (!LittleFS.exists(path)) {
    return false;
  }

  File file = LittleFS.open(path, "r");
  if (!file) {
    return false;
  }

  markRequest();
  stats.staticHits += 1;
  server.streamFile(file, contentTypeForPath(path));
  file.close();
  return true;
}

String buildStatusJson() {
  String json = "{";
  json += "\"ssid\":\"" + String(kApSsid) + "\",";
  json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"stations\":" + String(WiFi.softAPgetStationNum()) + ",";
  json += "\"uptime_ms\":" + String(millis()) + ",";
  json += "\"heap\":" + String(ESP.getFreeHeap()) + ",";
  json += "\"req_total\":" + String(stats.totalRequests) + ",";
  json += "\"status_hits\":" + String(stats.statusHits) + ",";
  json += "\"ping_hits\":" + String(stats.pingHits) + ",";
  json += "\"telemetry_hits\":" + String(stats.telemetryPosts) + ",";
  json += "\"static_hits\":" + String(stats.staticHits) + ",";
  json += "\"not_found_hits\":" + String(stats.notFoundHits) + ",";
  json += "\"last_client\":\"" + jsonEscape(stats.lastClient) + "\",";
  json += "\"last_event\":\"" + jsonEscape(stats.lastEvent) + "\"";
  json += "}";
  return json;
}

void handleStatus() {
  markRequest();
  stats.statusHits += 1;
  server.send(200, "application/json", buildStatusJson());
}

void handlePing() {
  markRequest();
  stats.pingHits += 1;
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleTelemetry() {
  markRequest();
  stats.telemetryPosts += 1;
  String body = sanitizeLine(server.arg("plain"));
  if (body.length() == 0) {
    body = "empty_telemetry";
  }
  stats.lastEvent = body;

  Serial.print("[WEB_EVT] up=");
  Serial.print(millis());
  Serial.print("ms client=");
  Serial.print(stats.lastClient);
  Serial.print(" payload=");
  Serial.println(body);

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleServo() {
  markRequest();
  
  int x = -1;
  int y = -1;
  
  // First try to parse as JSON (application/json)
  if (server.hasArg("plain") && server.arg("plain").length() > 0) {
    String jsonBody = server.arg("plain");
    
    // Simple JSON parsing for {"x":value,"y":value}
    int xIdx = jsonBody.indexOf("\"x\"");
    int yIdx = jsonBody.indexOf("\"y\"");
    
    if (xIdx >= 0) {
      int colonIdx = jsonBody.indexOf(":", xIdx);
      if (colonIdx >= 0) {
        String xStr = jsonBody.substring(colonIdx + 1);
        int commaIdx = xStr.indexOf(",");
        if (commaIdx >= 0) xStr = xStr.substring(0, commaIdx);
        int braceIdx = xStr.indexOf("}");
        if (braceIdx >= 0) xStr = xStr.substring(0, braceIdx);
        xStr.trim();
        x = xStr.toInt();
      }
    }
    
    if (yIdx >= 0) {
      int colonIdx = jsonBody.indexOf(":", yIdx);
      if (colonIdx >= 0) {
        String yStr = jsonBody.substring(colonIdx + 1);
        int commaIdx = yStr.indexOf(",");
        if (commaIdx >= 0) yStr = yStr.substring(0, commaIdx);
        int braceIdx = yStr.indexOf("}");
        if (braceIdx >= 0) yStr = yStr.substring(0, braceIdx);
        yStr.trim();
        y = yStr.toInt();
      }
    }
    
    Serial.print("JSON parsed: x=");
    Serial.print(x);
    Serial.print(" y=");
    Serial.println(y);
  }
  
  // Fallback to form arguments (application/x-www-form-urlencoded)
  if (server.hasArg("x") && x < 0) {
    x = server.arg("x").toInt();
  }
  if (server.hasArg("y") && y < 0) {
    y = server.arg("y").toInt();
  }
  
  // Apply servo positions
  if (x >= 0 && x <= 180) {
    servoX.write(x);
    Serial.print("ServoX write: ");
    Serial.println(x);
  }
  if (y >= 0 && y <= 180) {
    servoY.write(y);
    Serial.print("ServoY write: ");
    Serial.println(y);
  }
  
  Serial.print("Servo command: X=");
  Serial.print(x);
  Serial.print(" Y=");
  Serial.println(y);
  
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleNotFound() {
  if (!server.uri().startsWith("/api/") && serveFromLittleFs(server.uri())) {
    return;
  }
  markRequest();
  stats.notFoundHits += 1;
  server.send(404, "application/json", "{\"error\":\"Not found\"}");
}

void setupWebServer() {
  server.on("/", HTTP_GET, []() {
    if (!serveFromLittleFs("/index.html")) {
      server.send(500, "application/json", "{\"error\":\"index.html missing\"}");
    }
  });
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/ping", HTTP_GET, handlePing);
  server.on("/api/telemetry", HTTP_POST, handleTelemetry);
  server.on("/api/servo", HTTP_POST, handleServo);
  
  // Also allow GET for quick testing from a browser (e.g. /api/servo?x=90&y=90)
  server.on("/api/servo", HTTP_GET, []() {
    markRequest();
    int x = 90, y = 90;
    if (server.hasArg("x")) x = server.arg("x").toInt();
    if (server.hasArg("y")) y = server.arg("y").toInt();

    if (x >= 0 && x <= 180) servoX.write(x);
    if (y >= 0 && y <= 180) servoY.write(y);

    Serial.print("GET Servo: X=");
    Serial.print(x);
    Serial.print(" Y=");
    Serial.println(y);

    server.send(200, "application/json", "{\"ok\":true,\"x\":" + String(x) + ",\"y\":" + String(y) + "}");
  });
  
  // Test endpoint - access like /api/test?x=90&y=90
  server.on("/api/test", HTTP_GET, []() {
    int x = 90, y = 90;
    if (server.hasArg("x")) x = server.arg("x").toInt();
    if (server.hasArg("y")) y = server.arg("y").toInt();
    
    servoX.write(x);
    servoY.write(y);
    
    Serial.print("TEST: ServoX=");
    Serial.print(x);
    Serial.print(" ServoY=");
    Serial.println(y);
    
    server.send(200, "application/json", "{\"ok\":true,\"x\":" + String(x) + ",\"y\":" + String(y) + "}");
  });
  
  server.on("/styles.css", HTTP_GET, []() { serveFromLittleFs("/styles.css"); });
  server.on("/app.js", HTTP_GET, []() { serveFromLittleFs("/app.js"); });
  server.onNotFound(handleNotFound);
  server.begin();
}

void setupAccessPoint() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(kApIp, kGateway, kSubnet);
  const bool apStarted = WiFi.softAP(kApSsid, kApPassword, 1, false, 8);

  Serial.println();
  Serial.println("=== ESP32 Position Predictor ===");
  Serial.print("AP started: ");
  Serial.println(apStarted ? "yes" : "no");
  Serial.print("SSID: ");
  Serial.println(kApSsid);
  Serial.print("Password: ");
  Serial.println(kApPassword);
  Serial.print("IP: ");
  Serial.println(WiFi.softAPIP());
  Serial.println("Telemetry serial: heartbeat cada 3s + eventos WEB_EVT");
}

void logHeartbeatIfNeeded() {
  const uint32_t nowMs = millis();
  if (nowMs - stats.lastHeartbeatMs < kHeartbeatIntervalMs) {
    return;
  }
  stats.lastHeartbeatMs = nowMs;

  Serial.print("[HB] up=");
  Serial.print(nowMs);
  Serial.print("ms sta=");
  Serial.print(WiFi.softAPgetStationNum());
  Serial.print(" heap=");
  Serial.print(ESP.getFreeHeap());
  Serial.print(" req=");
  Serial.print(stats.totalRequests);
  Serial.print(" static=");
  Serial.print(stats.staticHits);
  Serial.print(" status=");
  Serial.print(stats.statusHits);
  Serial.print(" telem=");
  Serial.print(stats.telemetryPosts);
  Serial.print(" nf=");
  Serial.print(stats.notFoundHits);
  Serial.print(" last_client=");
  Serial.print(stats.lastClient);
  Serial.print(" last_event=");
  Serial.println(stats.lastEvent);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed.");
  }

  setupAccessPoint();
  setupWebServer();

  // Configure servos with explicit pulse width range
  // Standard servo: 1000-2000us, some servos need 500-2500us
  // Se usan pines que no son strapping (boot) para evitar problemas
  servoX.attach(kServoXPin, 500, 2500);  // GPIO14
  servoY.attach(kServoYPin, 500, 2500);  // GPIO27

  // Initialize servos to center position
  servoX.write(90);
  servoY.write(90);
  delay(1000);  // Give servos time to reach position

  Serial.println("Servos initialized at 90 degrees");

  // Test sweep
  Serial.println("Testing servo sweep...");
  servoX.write(0);
  servoY.write(0);
  delay(500);
  servoX.write(180);
  servoY.write(180);
  delay(500);
  servoX.write(90);
  servoY.write(90);
  delay(500);
  Serial.println("Sweep test complete");
}

void loop() {
  server.handleClient();
  logHeartbeatIfNeeded();
  delay(2);
}
