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

- `platformio.ini`: configuracion de compilacion
- `src/main.cpp`: firmware ESP32 (AP + servidor)
- `data/index.html`: interfaz principal
- `data/styles.css`: estilo visual
- `data/app.js`: logica de muestreo, interpolacion y error
- `docs/INFORME_PROYECTO.md`: informe tecnico completo

## 3. Requisitos

- ESP32 DevKit (o compatible `esp32dev`)
- PlatformIO CLI o extension en VS Code
- Cable USB

## 4. Carga al ESP32

Desde esta carpeta (`esp32_position_predictor`):

```bash
INICIAR_TODO.bat COM6
```

O manual:

```bash
pio run -t upload
pio run -t uploadfs
pio device monitor
```

`INICIAR_TODO.bat` intenta tambien conectarte al SSID `ESP32-Predictor` si ya existe perfil Wi-Fi guardado en Windows.

## 5. Uso del sistema

1. Conectate a la red del ESP32:
   - SSID: `ESP32-Predictor`
   - Password: `frank2026`
2. Abre `http://192.168.4.1`
3. Carga una URL de stream o activa camara local.
4. Haz clic en el objetivo para registrar puntos `(t, x, y)`.
5. El sistema calcula prediccion lineal y cuadratica a `t + delta`.
6. Al cumplirse el horizonte, haz clic en la posicion real para medir error absoluto.

## 6. Telemetria en vivo por terminal

```bash
pio device monitor --port COM6 --baud 115200
```

Veras:

- `[HB]`: heartbeat cada 3s con estaciones conectadas, heap y contadores.
- `[WEB_EVT]`: eventos de la interfaz (autocamara, clics, predicciones, errores).

## 7. Autoconexion de camara de PC

- Al abrir la web, el sistema intenta activar automaticamente la camara local de la PC.
- Si el navegador bloquea camara en HTTP, usa el boton `Usar camara local` o una URL de stream.
- Si cargaste una URL antes, queda guardada y se reconecta automaticamente.

## 8. Notas tecnicas

- Buffer circular de puntos: `N = 3`
- Interpolacion lineal: requiere 2 puntos
- Interpolacion cuadratica (Lagrange): requiere 3 puntos
- Error calculado:
  - `|Ex| = |x_real - x_pred|`
  - `|Ey| = |y_real - y_pred|`
  - `E = sqrt(Ex^2 + Ey^2)`

## 9. Mejoras futuras

- Guardado historico en SPIFFS/LittleFS como CSV
- Exportacion de reportes
- Seguimiento automatico con OpenCV desde nodo externo
- WebSocket para telemetria en vivo
