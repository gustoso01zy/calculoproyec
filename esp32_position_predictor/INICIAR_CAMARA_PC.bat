@echo off
setlocal
cd /d "%~dp0"

set CAMERA_INDEX=0
if not "%~1"=="" set CAMERA_INDEX=%~1

set STREAM_PORT=8081
if not "%~2"=="" set STREAM_PORT=%~2

echo ==========================================
echo PC CAMERA STREAM - ESP32 POSITION PREDICTOR
echo Camara indice: %CAMERA_INDEX%
echo Puerto: %STREAM_PORT%
echo ==========================================

where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python no encontrado en PATH.
  exit /b 1
)

python -c "import cv2" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Falta OpenCV para Python.
  echo Instala con: pip install opencv-python
  exit /b 1
)

echo Iniciando stream local...
echo URL: http://127.0.0.1:%STREAM_PORT%/stream.mjpg
python pc_camera_stream.py --camera-index %CAMERA_INDEX% --port %STREAM_PORT% --open-preview
