@echo off
setlocal
cd /d "%~dp0"

set PORT=COM6
if not "%~1"=="" set PORT=%~1

echo ==========================================
echo ESP32 POSITION PREDICTOR - AUTO INICIO
echo Hecho por Frank Panicide
echo Puerto: %PORT%
echo ==========================================

echo [1/4] Subiendo firmware...
pio run -t upload --upload-port %PORT%
if errorlevel 1 goto :error

echo [2/4] Subiendo interfaz web (LittleFS)...
pio run -t uploadfs --upload-port %PORT%
if errorlevel 1 goto :error

echo [3/4] Abriendo monitor de telemetria...
start "Telemetria ESP32" cmd /k "cd /d %~dp0 && pio device monitor --port %PORT% --baud 115200"

echo [3.5/4] Intentando conectar Wi-Fi ESP32...
netsh wlan connect name=ESP32-Predictor ssid=ESP32-Predictor >nul 2>&1

echo [4/4] Abriendo interfaz principal...
set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
if exist "%CHROME_PATH%" (
  start "ESP32 UI" "%CHROME_PATH%" --new-window --unsafely-treat-insecure-origin-as-secure=http://192.168.4.1 --user-data-dir="%TEMP%\esp32_cam_profile" http://192.168.4.1
) else (
  start "ESP32 UI" http://192.168.4.1
)

echo.
echo Listo. Si la camara no aparece, acepta permiso en el navegador.
echo SSID: ESP32-Predictor
echo PASS: frank2026
echo URL:  http://192.168.4.1
goto :eof

:error
echo.
echo ERROR: No se pudo completar el inicio automatico.
echo Verifica cable USB, puerto COM y que no haya otro monitor serie abierto.
exit /b 1
