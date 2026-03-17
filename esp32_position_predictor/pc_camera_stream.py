#!/usr/bin/env python3
"""Expose the local PC camera as an MJPEG HTTP stream."""

import argparse
import signal
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import cv2
except ImportError as exc:  # pragma: no cover
    print("ERROR: No se encontro OpenCV. Instala con: pip install opencv-python")
    raise SystemExit(1) from exc


class CameraSource:
    def __init__(self, camera_index: int, width: int, height: int, fps: int, jpeg_quality: int):
        self.camera_index = camera_index
        self.width = width
        self.height = height
        self.fps = fps
        self.jpeg_quality = jpeg_quality
        self.capture = None
        self.thread = None
        self.running = threading.Event()
        self.lock = threading.Lock()
        self.latest_jpeg = None
        self.frame_id = 0

    def start(self) -> None:
        if sys.platform.startswith("win"):
            self.capture = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
        else:
            self.capture = cv2.VideoCapture(self.camera_index)

        if not self.capture or not self.capture.isOpened():
            raise RuntimeError(f"No se pudo abrir la camara indice {self.camera_index}.")

        if self.width > 0:
            self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        if self.height > 0:
            self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        if self.fps > 0:
            self.capture.set(cv2.CAP_PROP_FPS, self.fps)

        self.running.set()
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.running.clear()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.0)
        if self.capture is not None:
            self.capture.release()
            self.capture = None

    def _capture_loop(self) -> None:
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), int(self.jpeg_quality)]
        while self.running.is_set():
            ok, frame = self.capture.read()
            if not ok:
                time.sleep(0.02)
                continue

            encoded_ok, encoded = cv2.imencode(".jpg", frame, encode_params)
            if not encoded_ok:
                continue

            jpeg = encoded.tobytes()
            with self.lock:
                self.latest_jpeg = jpeg
                self.frame_id += 1

    def get_latest_jpeg(self):
        with self.lock:
            return self.latest_jpeg, self.frame_id


class CameraHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_class, camera_source: CameraSource, running_flag: threading.Event):
        super().__init__(server_address, handler_class)
        self.camera_source = camera_source
        self.running_flag = running_flag


class MJPEGHandler(BaseHTTPRequestHandler):
    server_version = "PC-CAM-HTTP/1.0"

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path in ("/", "/index.html"):
            self._handle_index()
            return
        if self.path == "/health":
            self._handle_health()
            return
        if self.path.startswith("/stream.mjpg"):
            self._handle_stream()
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Ruta no encontrada")

    def _handle_index(self) -> None:
        body = (
            "<html><body><h3>PC Camera Stream OK</h3>"
            "<p>URL: /stream.mjpg</p>"
            "<img src='/stream.mjpg' style='max-width:100%;height:auto;'/>"
            "</body></html>"
        ).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self._send_cors_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_health(self) -> None:
        body = b"ok"
        self.send_response(HTTPStatus.OK)
        self._send_cors_headers()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_stream(self) -> None:
        self.send_response(HTTPStatus.OK)
        self._send_cors_headers()
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()

        last_frame_id = -1
        try:
            while self.server.running_flag.is_set():
                jpeg, frame_id = self.server.camera_source.get_latest_jpeg()
                if jpeg is None or frame_id == last_frame_id:
                    time.sleep(0.01)
                    continue

                last_frame_id = frame_id
                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii"))
                self.wfile.write(jpeg)
                self.wfile.write(b"\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):  # noqa: A003
        sys.stdout.write(f"[HTTP] {self.address_string()} - {fmt % args}\n")


def parse_args():
    parser = argparse.ArgumentParser(description="Stream MJPEG de camara local para ESP32 Position Predictor.")
    parser.add_argument("--host", default="127.0.0.1", help="Host de escucha (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8081, help="Puerto HTTP (default: 8081)")
    parser.add_argument("--camera-index", type=int, default=0, help="Indice de camara (default: 0)")
    parser.add_argument("--width", type=int, default=640, help="Ancho solicitado")
    parser.add_argument("--height", type=int, default=480, help="Alto solicitado")
    parser.add_argument("--fps", type=int, default=30, help="FPS solicitado")
    parser.add_argument("--jpeg-quality", type=int, default=80, help="Calidad JPEG 1..100")
    parser.add_argument(
        "--open-preview",
        action="store_true",
        help="Abrir vista previa local en navegador al iniciar",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    jpeg_quality = max(1, min(100, int(args.jpeg_quality)))
    camera = CameraSource(
        camera_index=int(args.camera_index),
        width=int(args.width),
        height=int(args.height),
        fps=int(args.fps),
        jpeg_quality=jpeg_quality,
    )

    try:
        camera.start()
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        return 1

    running_flag = threading.Event()
    running_flag.set()
    server = CameraHTTPServer((args.host, int(args.port)), MJPEGHandler, camera, running_flag)

    print("==========================================")
    print("PC CAMERA STREAM INICIADO")
    print(f"Camara indice: {args.camera_index}")
    print(f"URL stream:    http://{args.host}:{args.port}/stream.mjpg")
    print("Presiona Ctrl+C para detener.")
    print("==========================================")

    if args.open_preview:
        try:
            webbrowser.open(f"http://{args.host}:{args.port}/", new=1)
        except Exception:
            pass

    def request_stop(_signum=None, _frame=None):
        if running_flag.is_set():
            running_flag.clear()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_stop)

    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        running_flag.clear()
        server.server_close()
        camera.stop()
        print("PC CAMERA STREAM detenido.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
