# ESP32 Position Predictor

Sistema IoT para prediccion de posicion con interpolacion polinomica en tiempo real.

Hecho por Frank Panicide.

## 1. Objetivo

El ESP32 actua como:

- Punto de acceso Wi-Fi (AP)
- Servidor web (interfaz HTML/CSS/JS)
- Coordinador de tiempo y red

La captura visual se hace con una fuente externa (camara IP, PC, movil o webcam puenteada).

## 2. Estructura

- `esp32_position_predictor.ino`: firmware ESP32 (AP + servidor)
- `data/index.html`: interfaz principal
- `data/styles.css`: estilo visual
- `data/app.js`: logica de muestreo, interpolacion y error
- `docs/INFORME_PROYECTO.md`: informe tecnico completo

## 3. Requisitos

- ESP32 DevKit (o compatible `esp32dev`)
- Arduino IDE 2.x
- Core ESP32 instalado en Boards Manager
- Herramienta para subir `data/` a LittleFS (ESP32 LittleFS uploader)
- Cable USB

## 4. Carga al ESP32

1. Abre `esp32_position_predictor.ino` en Arduino IDE.
2. Selecciona:
   - Board: `ESP32 Dev Module`
   - Puerto COM correcto
3. Sube el sketch con `Upload`.
4. Sube la carpeta `data/` a LittleFS con la herramienta de ESP32 LittleFS.
5. Abre Monitor Serie a `115200`.

## 5. Uso del sistema

1. Conectate a la red del ESP32:
   - SSID: `ESP32-Predictor`
   - Password: `frank2026`
2. Abre `http://192.168.4.1`
3. Carga una URL de stream o activa camara local.
4. Haz clic en el objetivo para registrar puntos `(t, x, y)`.
5. El sistema calcula prediccion lineal y cuadratica a `t + delta`.
6. Al cumplirse el horizonte, haz clic en la posicion real para medir error absoluto.

## 6. Notas tecnicas

- Buffer circular de puntos: `N = 3`
- Interpolacion lineal: requiere 2 puntos
- Interpolacion cuadratica (Lagrange): requiere 3 puntos
- Error calculado:
  - `|Ex| = |x_real - x_pred|`
  - `|Ey| = |y_real - y_pred|`
  - `E = sqrt(Ex^2 + Ey^2)`

## 7. Mejoras futuras

- Guardado historico en SPIFFS/LittleFS como CSV
- Exportacion de reportes
- Seguimiento automatico con OpenCV desde nodo externo
- WebSocket para telemetria en vivo
