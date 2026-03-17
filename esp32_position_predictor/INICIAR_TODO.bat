@echo off
setlocal
cd /d "%~dp0"

set PORT=COM6
if not "%~1"=="" set PORT=%~1
set CAMERA_INDEX=0
if not "%~2"=="" set CAMERA_INDEX=%~2
set CAMERA_STREAM_PORT=8081

echo ==========================================
echo ESP32 POSITION PREDICTOR - AUTO INICIO
echo Hecho por Frank Panicide
echo Puerto: %PORT%
echo ==========================================

echo [1/5] Subiendo firmware...
pio run -t upload --upload-port %PORT%
if errorlevel 1 goto :error

echo [2/5] Subiendo interfaz web (LittleFS)...
pio run -t uploadfs --upload-port %PORT%
if errorlevel 1 goto :error

echo [3/5] Abriendo monitor de telemetria...
start "Telemetria ESP32" cmd /k "cd /d %~dp0 && pio device monitor --port %PORT% --baud 115200"

echo [4/5] Iniciando stream local de camara (script independiente)...
netstat -ano | findstr /r /c:":%CAMERA_STREAM_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo Stream local ya activo en puerto %CAMERA_STREAM_PORT%.
) else (
  where python >nul 2>&1
  if errorlevel 1 (
    echo AVISO: Python no encontrado. Ejecuta INICIAR_CAMARA_PC.bat manualmente.
  ) else (
    python -c "import cv2" >nul 2>&1
    if errorlevel 1 (
      echo AVISO: Falta OpenCV. Ejecuta: pip install opencv-python
    ) else (
      start "PC Camera Stream" cmd /k "cd /d %~dp0 && python pc_camera_stream.py --camera-index %CAMERA_INDEX% --port %CAMERA_STREAM_PORT%"
      timeout /t 1 >nul
    )
  )
)

echo [4.5/5] Intentando conectar Wi-Fi ESP32...
netsh wlan connect name=ESP32-Predictor ssid=ESP32-Predictor >nul 2>&1

echo [5/5] Abriendo interfaz principal...
set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
if exist "%CHROME_PATH%" (
  start "ESP32 UI" "%CHROME_PATH%" --new-window --user-data-dir="%TEMP%\esp32_cam_profile" http://192.168.4.1
) else (
  start "ESP32 UI" http://192.168.4.1
)

echo.
echo Listo. Stream local esperado en: http://127.0.0.1:%CAMERA_STREAM_PORT%/stream.mjpg
echo SSID: ESP32-Predictor
echo PASS: frank2026
echo URL:  http://192.168.4.1
goto :eof

:error
echo.
echo ERROR: No se pudo completar el inicio automatico.
echo Verifica cable USB, puerto COM y que no haya otro monitor serie abierto.
exit /b 1
