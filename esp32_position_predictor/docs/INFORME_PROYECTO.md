# INFORME DE PROYECTO: SISTEMA IOT DE PREDICCION DE POSICION

- Asignatura: Calculo Numerico / Sistemas Embebidos
- Fecha: 24 de mayo de 2024
- Tema: Aplicacion de interpolacion polinomica en tiempo real mediante ESP32 y vision externa
- Autor: Frank Panicide

## 1. Resumen

Este informe presenta el diseno e implementacion de un sistema IoT autonomo basado en ESP32 para predecir posicion en tiempo real. El enfoque desacopla captura de video y procesamiento matematico: el video proviene de un sensor externo (PC, smartphone o camara IP), mientras el ESP32 administra la red y sirve la interfaz web. El usuario registra coordenadas `(x, y)` en funcion del tiempo `t`, y el sistema estima trayectoria con interpolacion lineal y cuadratica. La precision se evalua con error absoluto respecto a una medicion real posterior.

## 2. Introduccion

En robotica y monitoreo industrial, estimar la posicion futura de un objetivo permite decisiones proactivas. El proyecto demuestra que un microcontrolador de recursos limitados puede ejecutar una solucion util cuando la arquitectura distribuye bien las tareas:

- Sensor externo: captura de video
- ESP32: red y servicio web
- Cliente web: registro y calculo numerico de baja latencia

## 3. Marco teorico: interpolacion polinomica

Sea un conjunto de muestras temporales:

`(t_i, x_i, y_i)`

Se desea estimar la posicion en un instante futuro `t_p = t_k + Delta t`.

### 3.1 Interpolacion lineal (2 puntos)

Para dos puntos consecutivos `P0` y `P1`:

`x(t) = x1 + (x1 - x0) * ((t - t1) / (t1 - t0))`

`y(t) = y1 + (y1 - y0) * ((t - t1) / (t1 - t0))`

### 3.2 Interpolacion cuadratica (Lagrange, 3 puntos)

Con tres puntos `P0, P1, P2`:

`f(t) = f0 * L0(t) + f1 * L1(t) + f2 * L2(t)`

Donde:

`L0(t) = ((t - t1)(t - t2)) / ((t0 - t1)(t0 - t2))`

`L1(t) = ((t - t0)(t - t2)) / ((t1 - t0)(t1 - t2))`

`L2(t) = ((t - t0)(t - t1)) / ((t2 - t0)(t2 - t1))`

La expresion se aplica por separado para `x(t)` y `y(t)`.

## 4. Descripcion del sistema (arquitectura)

El sistema usa tres capas:

1. Capa de adquisicion:
   - webcam de PC, movil o camara IP
2. Capa de red y control:
   - ESP32 en modo `WIFI_AP`
   - servidor HTTP en puerto 80
3. Capa de usuario:
   - interfaz web con canvas
   - registro de puntos por clic
   - calculo y evaluacion de error

## 5. Metodologia

### Paso 1: configuracion de red

- SSID AP: `ESP32-Predictor`
- IP estatica: `192.168.4.1`
- mascara: `255.255.255.0`

### Paso 2: registro de datos

Cada clic sobre el objetivo produce una muestra:

`S_k = (t_k, x_k, y_k)`

Las muestras se guardan en buffer circular de tamano `N = 3`.

### Paso 3: ejecucion de prediccion

Se fija un horizonte `Delta t` (ejemplo: 200 ms):

`t_p = t_k + Delta t`

Con las muestras disponibles se calcula:

- estimacion lineal `P_lin(t_p)`
- estimacion cuadratica `P_quad(t_p)`

### Paso 4: cuantificacion del error

Al alcanzar `t_p`, se toma una posicion real `P_real` y se calcula:

`|Ex| = |x_real - x_pred|`

`|Ey| = |y_real - y_pred|`

`E = sqrt(Ex^2 + Ey^2)`

## 6. Variables del sistema

| Variable | Tipo | Descripcion |
|---|---|---|
| `t` | Independiente | Marca de tiempo en ms |
| `(x, y)` | Dependiente medida | Coordenadas en pixeles |
| `(x_hat, y_hat)` | Dependiente calculada | Posicion estimada |
| `E` | Resultado | Error absoluto |

## 7. Resultados esperados y analisis

- Estabilidad de red:
  - el ESP32 debe sostener la interfaz sin degradacion critica
- Precision:
  - el modelo cuadratico reduce error en trayectorias con curvatura
- Limites:
  - el error crece con `Delta t` alto y cambios bruscos de aceleracion

## 8. Conclusiones

La implementacion confirma que el ESP32 puede operar como nucleo coordinador de un sistema educativo IoT para metodos numericos. La separacion entre captura visual y logica matematica mejora estabilidad y permite experimentar interpolacion en entorno de tiempo real con recursos limitados.

## 9. Bibliografia

1. Chapra, S. C., & Canale, R. P. (2011). *Metodos numericos para ingenieros*. McGraw-Hill.
2. Espressif Systems. (2023). *ESP32 Series Datasheet*.
3. Mozilla Developer Network (MDN). *HTML5 Canvas and Video API*.

---

Hecho por Frank Panicide.
