#include <Arduino.h>
#include <LittleFS.h>
#include <WebServer.h>
#include <WiFi.h>

namespace {
constexpr char kApSsid[] = "ESP32-Predictor";
constexpr char kApPassword[] = "frank2026";
const IPAddress kApIp(192, 168, 4, 1);
const IPAddress kGateway(192, 168, 4, 1);
const IPAddress kSubnet(255, 255, 255, 0);

WebServer server(80);
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

  server.streamFile(file, contentTypeForPath(path));
  file.close();
  return true;
}

String buildStatusJson() {
  String json = "{";
  json += "\"ssid\":\"" + String(kApSsid) + "\",";
  json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"stations\":" + String(WiFi.softAPgetStationNum()) + ",";
  json += "\"uptime_ms\":" + String(millis());
  json += "}";
  return json;
}

void handleStatus() {
  server.send(200, "application/json", buildStatusJson());
}

void handlePing() {
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleNotFound() {
  if (!server.uri().startsWith("/api/") && serveFromLittleFs(server.uri())) {
    return;
  }
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
}

void setup() {
  Serial.begin(115200);
  delay(500);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed.");
  }

  setupAccessPoint();
  setupWebServer();
}

void loop() {
  server.handleClient();
  delay(2);
}
