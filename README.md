1. Resumen Ejecutivo

El proyecto consiste en un sistema mecatrónico de bucle cerrado que utiliza visión artificial para el seguimiento de rostros en tiempo real. El sistema emplea una arquitectura distribuida donde una PC procesa el video para detectar coordenadas espaciales, las cuales son enviadas a un microcontrolador ESP32. Este último se encarga de controlar un mecanismo Pan-Tilt (dos servomotores) para mantener el objetivo centrado o predecir su trayectoria futura.

2. Objetivos del Proyecto

Detección: Identificar rostros humanos mediante algoritmos de visión por computadora (Haar Cascades).

Seguimiento (Tracking): Calcular el error de posición respecto al centro del frame y corregir la orientación de los servomotores.

Predicción: Implementar algoritmos cinemáticos para anticipar la posición del objetivo basándose en su velocidad tangencial.

Interfaz: Proveer una interfaz web para el monitoreo y control de parámetros del sistema.

3. Arquitectura del Sistema

3.1 Hardware (Basado en wiring schematic.jpg)

Cerebro: ESP32 (NodeMCU/DevKit).

Actuadores: 2 Servomotores (MG996R o similares) para los ejes X (Pan) e Y (Tilt).

Entrada de Video: Cámara web (integrada en PC o externa).

Alimentación: Fuente externa para los servos (recomendado 5V-6V) compartiendo tierra con el ESP32.

3.2 Software y Tecnologías

Lenguajes: C++ (Arduino/ESP-IDF) y Python 3.

Librerías PC: OpenCV (cv2) para detección y pyserial para comunicación.

Librerías ESP32: ESP32Servo para control de PWM y AsyncTCP/ESPAsyncWebServer para la interfaz web.

4. Análisis de Módulos de Software

4.1 Procesamiento en PC (facetracking.py y facedetection.py)

El script de Python utiliza el clasificador haarcascade_frontalface_default.xml.

Lógica: Captura el frame, lo convierte a escala de grises y busca rectángulos de rostros.

Cálculo de Error: Define el centro del rostro $(x, y)$ y calcula la desviación respecto al centro de la imagen $(320, 240)$.

Transmisión: Envía las coordenadas formateadas por puerto serie (Serial) al ESP32.

4.2 Firmware del ESP32 (main.cpp)

El código en el microcontrolador gestiona tres tareas principales:

Recepción de Datos: Escucha el puerto serie buscando tramas de datos (ej: X120Y80).

Control de Servos: Mapea las coordenadas recibidas a ángulos de 0 a 180 grados.

Predicción: (Según los archivos del proyecto) El sistema calcula el "delta" de movimiento. Si el objetivo se mueve rápido, el sistema aplica una compensación proporcional a la velocidad calculada para que el servo se adelante a la posición actual.

4.3 Interfaz Web (data/index.html)

El ESP32 actúa como servidor web, permitiendo:

Visualizar la cámara (vía stream desde la PC).

Ajustar ganancias de control (PID o Proporcional).

Activar/Desactivar el modo de predicción.

5. Algoritmo de Predicción y Control

El sistema no solo sigue la posición actual, sino que implementa una lógica de interpolación lineal/predicción:

$$Pos_{futura} = Pos_{actual} + (Velocidad \times Tiempo\_estimado)$$

Donde la velocidad se deriva de la diferencia de posición entre los últimos frames procesados. Esto reduce la latencia percibida en el movimiento mecánico de los servomotores.

6. Configuración y Despliegue

Para poner en marcha el sistema se han incluido archivos de automatización:

INICIAR_TODO.bat: Ejecuta simultáneamente el script de cámara en la PC y establece la conexión con el ESP32.

platformio.ini: Contiene las dependencias necesarias para compilar el código del ESP32 de forma automática.

7. Conclusiones y Recomendaciones

El proyecto demuestra una integración sólida entre software de alto nivel (Python/Visión) y hardware de tiempo real (ESP32).
Mejoras sugeridas:

Implementar un filtro de Kalman para suavizar el ruido en la detección de rostros.

Sustituir Haar Cascades por MediaPipe o modelos basados en Deep Learning para mayor robustez ante rotaciones del rostro.

Asegurar el uso de una fuente de poder independiente para los servos para evitar reinicios por caídas de tensión en el ESP32.
