const MAX_POINTS = 3;
const MAX_POINT_HISTORY = 250;
const MAX_TABLE_ROWS = 30;
const STREAM_URL_STORAGE_KEY = "esp32_predictor_saved_stream_url";
const LOCAL_PC_STREAM_URL = "http://127.0.0.1:8081/stream.mjpg";

const state = {
  points: [],
  pointHistory: [],
  startTimeMs: null,
  horizonMs: 200,
  timerId: null,
  predictionSeq: 0,
  pendingPrediction: null,
  validations: [],
  localStream: null,
  sourceMode: "none",
  trackingEnabled: false,
  trackingTargetColor: null,
  trackingLastFramePoint: null,
  trackingMarker: null,
  trackingLoopId: null,
  lastAutoSampleMs: 0,
  autoSampleIntervalMs: 120,
  trackingColorTolerance: 78,
  trackingMinMatchCount: 16,
  trackingLostFrames: 0,
  streamPixelReadableWarningShown: false,
  servoLastSent: { x: null, y: null, ts: 0 },
};

const ui = {
  networkStatus: document.getElementById("network-status"),
  streamUrl: document.getElementById("stream-url"),
  horizonMs: document.getElementById("horizon-ms"),
  loadStreamBtn: document.getElementById("load-stream"),
  useCameraBtn: document.getElementById("use-camera"),
  toggleTrackingBtn: document.getElementById("toggle-tracking"),
  clearDataBtn: document.getElementById("clear-data"),
  testServoBtn: document.getElementById("test-servo"),
  stage: document.getElementById("stage"),
  stageMessage: document.getElementById("stage-message"),
  video: document.getElementById("video"),
  streamImage: document.getElementById("stream-image"),
  overlay: document.getElementById("overlay"),
  predictionStatus: document.getElementById("prediction-status"),
  trackingStatus: document.getElementById("tracking-status"),
  predLinear: document.getElementById("pred-linear"),
  predQuadratic: document.getElementById("pred-quadratic"),
  predTargetTime: document.getElementById("pred-target-time"),
  pointsBody: document.getElementById("points-body"),
  errorsBody: document.getElementById("errors-body"),
};

const ctx = ui.overlay.getContext("2d");
const frameCanvas = document.createElement("canvas");
const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return Number(value).toFixed(2);
}

function formatRelativeMs(timestampMs) {
  if (state.startTimeMs === null) {
    return "0.00";
  }
  return formatNumber(timestampMs - state.startTimeMs);
}

function setMessage(text) {
  ui.stageMessage.textContent = text;
}

function setTrackingStatus(text, color = "var(--ink-soft)") {
  ui.trackingStatus.textContent = text;
  ui.trackingStatus.style.color = color;
}

function sendTelemetry(eventName, details = {}) {
  const payload = JSON.stringify({
    event: eventName,
    ts: Date.now(),
    details,
  });

  fetch("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function mapStageToServo(point) {
  const maxX = ui.overlay.width;
  const maxY = ui.overlay.height;
  if (!maxX || !maxY) {
    return null;
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const ratioX = clamp01(point.x / maxX);
  const ratioY = clamp01(point.y / maxY);

  // Invert X so servo follows object movement naturally
  const servoX = Math.round((1 - ratioX) * 180);
  const servoY = Math.round(ratioY * 180);
  return { x: servoX, y: servoY };
}

function sendServoCommand(point) {
  const now = performance.now();
  const servoPos = mapStageToServo(point);
  if (!servoPos) return;

  // Throttle updates to ~20Hz
  if (now - state.servoLastSent.ts < 50) return;
  if (servoPos.x === state.servoLastSent.x && servoPos.y === state.servoLastSent.y) return;

  state.servoLastSent = { x: servoPos.x, y: servoPos.y, ts: now };

  fetch("/api/servo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(servoPos),
  }).catch(() => {});
}

let servoTestStage = 0;
const servoTestPositions = [
  { x: 0, y: 0 },
  { x: 90, y: 90 },
  { x: 180, y: 180 },
];

async function testServo() {
  try {
    const pos = servoTestPositions[servoTestStage];
    const resp = await fetch(`/api/test?x=${pos.x}&y=${pos.y}`);
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    setMessage(`Servo test enviado (x=${data.x} y=${data.y})`);
    sendTelemetry("servo_test", data);
    servoTestStage = (servoTestStage + 1) % servoTestPositions.length;
  } catch (error) {
    setMessage(`Error test servo: ${error}`);
  }
}

function resizeCanvasToStage() {
  const rect = ui.stage.getBoundingClientRect();
  ui.overlay.width = rect.width;
  ui.overlay.height = rect.height;
  drawOverlay();
}

function clearSessionState(emitTelemetry = true) {
  state.points = [];
  state.pointHistory = [];
  state.startTimeMs = null;
  state.validations = [];
  state.pendingPrediction = null;
  state.trackingMarker = null;
  state.lastAutoSampleMs = 0;
  state.trackingLostFrames = 0;
  state.predictionSeq += 1;
  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  renderPointsTable();
  renderErrorsTable();
  renderPredictionPanel();
  drawOverlay();
  if (state.trackingEnabled) {
    setMessage("Datos limpios. Seguimiento activo: haz clic en el objeto para calibrar.");
  } else {
    setMessage("Datos limpios. Haz clic para registrar nuevos puntos.");
  }
  if (emitTelemetry) {
    sendTelemetry("session_clear");
  }
}

function pushPoint(point, source = "manual") {
  if (state.startTimeMs === null) {
    state.startTimeMs = point.t;
  }

  state.pointHistory.push({
    x: point.x,
    y: point.y,
    t: point.t,
    source,
  });
  if (state.pointHistory.length > MAX_POINT_HISTORY) {
    state.pointHistory.shift();
  }

  state.points.push(point);
  if (state.points.length > MAX_POINTS) {
    state.points.shift();
  }
}

function computeLinearPrediction(targetTimeMs) {
  if (state.points.length < 2) {
    return null;
  }
  const p0 = state.points[state.points.length - 2];
  const p1 = state.points[state.points.length - 1];
  const dt = p1.t - p0.t;
  if (Math.abs(dt) < 1e-6) {
    return null;
  }

  const ratio = (targetTimeMs - p1.t) / dt;
  return {
    x: p1.x + (p1.x - p0.x) * ratio,
    y: p1.y + (p1.y - p0.y) * ratio,
  };
}

function lagrangeInterpolation(t, p0, p1, p2, key) {
  const d0 = (p0.t - p1.t) * (p0.t - p2.t);
  const d1 = (p1.t - p0.t) * (p1.t - p2.t);
  const d2 = (p2.t - p0.t) * (p2.t - p1.t);
  if (Math.abs(d0) < 1e-6 || Math.abs(d1) < 1e-6 || Math.abs(d2) < 1e-6) {
    return null;
  }

  const l0 = ((t - p1.t) * (t - p2.t)) / d0;
  const l1 = ((t - p0.t) * (t - p2.t)) / d1;
  const l2 = ((t - p0.t) * (t - p1.t)) / d2;
  return p0[key] * l0 + p1[key] * l1 + p2[key] * l2;
}

function computeQuadraticPrediction(targetTimeMs) {
  if (state.points.length < 3) {
    return null;
  }
  const [p0, p1, p2] = state.points;
  const x = lagrangeInterpolation(targetTimeMs, p0, p1, p2, "x");
  const y = lagrangeInterpolation(targetTimeMs, p0, p1, p2, "y");
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

function renderPointsTable() {
  if (state.pointHistory.length === 0) {
    ui.pointsBody.innerHTML = '<tr><td colspan="5">Sin datos.</td></tr>';
    return;
  }

  const visiblePoints = state.pointHistory.slice(-MAX_TABLE_ROWS).reverse();
  const total = state.pointHistory.length;

  ui.pointsBody.innerHTML = visiblePoints
    .map(
      (point, idx) =>
        `<tr>
          <td>${total - idx}</td>
          <td>${formatRelativeMs(point.t)}</td>
          <td>${formatNumber(point.x)}</td>
          <td>${formatNumber(point.y)}</td>
          <td>${point.source === "auto" ? "Auto" : "Manual"}</td>
        </tr>`
    )
    .join("");
}

function renderErrorsTable() {
  if (state.validations.length === 0) {
    ui.errorsBody.innerHTML = '<tr><td colspan="4">Sin evaluaciones.</td></tr>';
    return;
  }

  const latest = state.validations[state.validations.length - 1];
  const rows = [];

  if (latest.linear) {
    rows.push(
      `<tr>
        <td>Lineal</td>
        <td>${formatNumber(latest.linear.ex)}</td>
        <td>${formatNumber(latest.linear.ey)}</td>
        <td>${formatNumber(latest.linear.euclidean)}</td>
      </tr>`
    );
  }

  if (latest.quadratic) {
    rows.push(
      `<tr>
        <td>Cuadratica</td>
        <td>${formatNumber(latest.quadratic.ex)}</td>
        <td>${formatNumber(latest.quadratic.ey)}</td>
        <td>${formatNumber(latest.quadratic.euclidean)}</td>
      </tr>`
    );
  }

  ui.errorsBody.innerHTML = rows.join("");
}

function renderPredictionPanel() {
  const prediction = state.pendingPrediction;
  if (!prediction) {
    ui.predictionStatus.textContent = state.trackingEnabled
      ? "Seguimiento activo: esperando suficientes muestras."
      : "Aun no hay suficientes puntos.";
    ui.predLinear.textContent = "-";
    ui.predQuadratic.textContent = "-";
    ui.predTargetTime.textContent = "-";
    return;
  }

  if (state.trackingEnabled) {
    ui.predictionStatus.textContent = "Prediccion activa con validacion automatica.";
  } else {
    ui.predictionStatus.textContent = prediction.awaitingValidation
      ? "Esperando clic de posicion real para medir error."
      : "Prediccion generada, espera el tiempo objetivo.";
  }

  ui.predLinear.textContent = prediction.linear
    ? `(${formatNumber(prediction.linear.x)}, ${formatNumber(prediction.linear.y)})`
    : "-";

  ui.predQuadratic.textContent = prediction.quadratic
    ? `(${formatNumber(prediction.quadratic.x)}, ${formatNumber(prediction.quadratic.y)})`
    : "-";

  ui.predTargetTime.textContent = `${formatRelativeMs(prediction.targetTimeMs)} ms`;
}

function drawCircle(x, y, radius, color) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawCross(x, y, size, color) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.moveTo(x - size, y - size);
  ctx.lineTo(x + size, y + size);
  ctx.moveTo(x + size, y - size);
  ctx.lineTo(x - size, y + size);
  ctx.stroke();
}

function drawOverlay() {
  ctx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);

  if (state.points.length > 1) {
    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(243, 252, 255, 0.7)";
    ctx.moveTo(state.points[0].x, state.points[0].y);
    for (let i = 1; i < state.points.length; i += 1) {
      ctx.lineTo(state.points[i].x, state.points[i].y);
    }
    ctx.stroke();
  }

  state.points.forEach((point, idx) => {
    drawCircle(point.x, point.y, 4.5, "#ffdd57");
    ctx.fillStyle = "#101820";
    ctx.font = "12px Trebuchet MS";
    ctx.fillText(String(idx + 1), point.x + 8, point.y - 8);
  });

  if (state.pendingPrediction?.linear) {
    drawCross(state.pendingPrediction.linear.x, state.pendingPrediction.linear.y, 6, "#ff6b6b");
  }

  if (state.pendingPrediction?.quadratic) {
    drawCircle(state.pendingPrediction.quadratic.x, state.pendingPrediction.quadratic.y, 6, "#56cfe1");
  }

  if (state.trackingMarker) {
    drawCross(state.trackingMarker.x, state.trackingMarker.y, 8, "#9bff7f");
  }

  const latestValidation = state.validations[state.validations.length - 1];
  if (latestValidation?.realPoint) {
    drawCircle(latestValidation.realPoint.x, latestValidation.realPoint.y, 5, "#2a9d8f");
  }
}

function schedulePrediction(nowMs) {
  const linear = computeLinearPrediction(nowMs + state.horizonMs);
  const quadratic = computeQuadraticPrediction(nowMs + state.horizonMs);

  if (!linear && !quadratic) {
    state.pendingPrediction = null;
    renderPredictionPanel();
    drawOverlay();
    return;
  }

  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }

  const seq = ++state.predictionSeq;
  state.pendingPrediction = {
    seq,
    targetTimeMs: nowMs + state.horizonMs,
    linear,
    quadratic,
    awaitingValidation: false,
  };

  sendTelemetry("prediction_ready", {
    horizonMs: state.horizonMs,
    linear: Boolean(linear),
    quadratic: Boolean(quadratic),
  });

  renderPredictionPanel();
  drawOverlay();

  if (state.trackingEnabled) {
    return;
  }

  state.timerId = setTimeout(() => {
    if (!state.pendingPrediction || state.pendingPrediction.seq !== seq) {
      return;
    }
    state.pendingPrediction.awaitingValidation = true;
    renderPredictionPanel();
    setMessage("Haz clic en la posicion real del objetivo para calcular el error.");
    sendTelemetry("prediction_waiting_real");
  }, state.horizonMs);
}

function buildError(predicted, realPoint) {
  const ex = Math.abs(realPoint.x - predicted.x);
  const ey = Math.abs(realPoint.y - predicted.y);
  return {
    ex,
    ey,
    euclidean: Math.sqrt(ex * ex + ey * ey),
  };
}

function finalizePredictionEvaluation(realPoint, mode = "manual") {
  if (!state.pendingPrediction) {
    return;
  }

  const result = {
    realPoint,
    linear: state.pendingPrediction.linear ? buildError(state.pendingPrediction.linear, realPoint) : null,
    quadratic: state.pendingPrediction.quadratic
      ? buildError(state.pendingPrediction.quadratic, realPoint)
      : null,
  };

  state.validations.push(result);
  if (state.validations.length > 10) {
    state.validations.shift();
  }
  state.pendingPrediction = null;
  state.predictionSeq += 1;
  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }

  sendTelemetry("prediction_evaluated", {
    mode,
    hasLinear: Boolean(result.linear),
    hasQuadratic: Boolean(result.quadratic),
    linearEuclidean: result.linear ? Number(result.linear.euclidean.toFixed(2)) : null,
    quadraticEuclidean: result.quadratic ? Number(result.quadratic.euclidean.toFixed(2)) : null,
  });

  renderErrorsTable();
  renderPredictionPanel();
  drawOverlay();
}

function evaluatePendingPrediction(realPoint) {
  if (!state.pendingPrediction || !state.pendingPrediction.awaitingValidation) {
    return;
  }
  finalizePredictionEvaluation(realPoint, "manual");
}

function evaluatePendingPredictionAuto(realPoint) {
  if (!state.pendingPrediction) {
    return;
  }
  if (realPoint.t < state.pendingPrediction.targetTimeMs) {
    return;
  }
  finalizePredictionEvaluation(realPoint, "auto");
}

function toStageCoordinates(event) {
  const rect = ui.overlay.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getActiveFrameSource() {
  if (!ui.streamImage.hidden && ui.streamImage.naturalWidth > 0 && ui.streamImage.naturalHeight > 0) {
    return {
      element: ui.streamImage,
      width: ui.streamImage.naturalWidth,
      height: ui.streamImage.naturalHeight,
      mode: "image",
    };
  }

  if (!ui.video.hidden && ui.video.videoWidth > 0 && ui.video.videoHeight > 0) {
    return {
      element: ui.video,
      width: ui.video.videoWidth,
      height: ui.video.videoHeight,
      mode: "video",
    };
  }

  return null;
}

function readCurrentFrameData() {
  const frameSource = getActiveFrameSource();
  if (!frameSource || !frameCtx) {
    return null;
  }

  if (frameCanvas.width !== frameSource.width || frameCanvas.height !== frameSource.height) {
    frameCanvas.width = frameSource.width;
    frameCanvas.height = frameSource.height;
  }

  try {
    frameCtx.drawImage(frameSource.element, 0, 0, frameSource.width, frameSource.height);
    const imageData = frameCtx.getImageData(0, 0, frameSource.width, frameSource.height);
    return {
      imageData,
      width: frameSource.width,
      height: frameSource.height,
    };
  } catch (error) {
    if (!state.streamPixelReadableWarningShown) {
      state.streamPixelReadableWarningShown = true;
      setMessage(
        "No se puede leer pixeles del stream para seguimiento. Usa INICIAR_CAMARA_PC.bat actualizado."
      );
      sendTelemetry("tracking_frame_read_fail", {
        reason: String(error?.name || error?.message || "unknown"),
      });
    }
    return null;
  }
}

function stageToFramePoint(point, width, height) {
  return {
    x: clamp(Math.round((point.x / ui.overlay.width) * width), 0, width - 1),
    y: clamp(Math.round((point.y / ui.overlay.height) * height), 0, height - 1),
  };
}

function frameToStagePoint(point, width, height) {
  return {
    x: (point.x / width) * ui.overlay.width,
    y: (point.y / height) * ui.overlay.height,
  };
}

function sampleAverageColor(imageData, width, height, centerPoint, radius = 2) {
  const data = imageData.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let y = centerPoint.y - radius; y <= centerPoint.y + radius; y += 1) {
    if (y < 0 || y >= height) {
      continue;
    }
    for (let x = centerPoint.x - radius; x <= centerPoint.x + radius; x += 1) {
      if (x < 0 || x >= width) {
        continue;
      }
      const idx = (y * width + x) * 4;
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      count += 1;
    }
  }

  if (count === 0) {
    return null;
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function searchColorCentroid(imageData, width, height, targetColor, seedPoint = null) {
  const data = imageData.data;
  const step = seedPoint ? 2 : 3;
  const tolerance = state.trackingColorTolerance;
  const radius = seedPoint ? Math.round(Math.min(width, height) * 0.28) : 0;

  let minX = 0;
  let maxX = width - 1;
  let minY = 0;
  let maxY = height - 1;

  if (seedPoint) {
    minX = clamp(Math.floor(seedPoint.x - radius), 0, width - 1);
    maxX = clamp(Math.ceil(seedPoint.x + radius), 0, width - 1);
    minY = clamp(Math.floor(seedPoint.y - radius), 0, height - 1);
    maxY = clamp(Math.ceil(seedPoint.y + radius), 0, height - 1);
  }

  let sumX = 0;
  let sumY = 0;
  let matchCount = 0;

  for (let y = minY; y <= maxY; y += step) {
    const rowOffset = y * width * 4;
    for (let x = minX; x <= maxX; x += step) {
      const idx = rowOffset + x * 4;
      const distance =
        Math.abs(data[idx] - targetColor.r) +
        Math.abs(data[idx + 1] - targetColor.g) +
        Math.abs(data[idx + 2] - targetColor.b);

      if (distance <= tolerance) {
        sumX += x;
        sumY += y;
        matchCount += 1;
      }
    }
  }

  if (matchCount < state.trackingMinMatchCount) {
    return null;
  }

  return {
    x: sumX / matchCount,
    y: sumY / matchCount,
    matchCount,
  };
}

function setTrackingTargetFromStagePoint(stagePoint) {
  const frame = readCurrentFrameData();
  if (!frame) {
    return false;
  }

  const framePoint = stageToFramePoint(stagePoint, frame.width, frame.height);
  const sampledColor = sampleAverageColor(frame.imageData, frame.width, frame.height, framePoint, 2);
  if (!sampledColor) {
    return false;
  }

  state.trackingTargetColor = sampledColor;
  state.trackingLastFramePoint = framePoint;
  state.trackingMarker = { x: stagePoint.x, y: stagePoint.y };
  state.trackingLostFrames = 0;
  state.streamPixelReadableWarningShown = false;

  setMessage(
    `Objeto calibrado. Seguimiento activo (RGB ${sampledColor.r},${sampledColor.g},${sampledColor.b}).`
  );
  setTrackingStatus("Seguimiento: calibrado y activo.", "var(--ok)");
  sendTelemetry("tracking_target_set", sampledColor);
  drawOverlay();
  return true;
}

function processAutoSample(sample, matchCount) {
  evaluatePendingPredictionAuto(sample);
  pushPoint(sample, "auto");
  renderPointsTable();

  sendServoCommand(sample);

  if (!state.pendingPrediction) {
    schedulePrediction(sample.t);
  }
  drawOverlay();

  sendTelemetry("tracking_sample", {
    x: Number(sample.x.toFixed(1)),
    y: Number(sample.y.toFixed(1)),
    matches: matchCount,
    pointsInBuffer: state.points.length,
  });
}

function trackingLoop() {
  if (!state.trackingEnabled) {
    state.trackingLoopId = null;
    return;
  }

  if (!state.trackingTargetColor) {
    state.trackingLoopId = requestAnimationFrame(trackingLoop);
    return;
  }

  const frame = readCurrentFrameData();
  if (!frame) {
    state.trackingLoopId = requestAnimationFrame(trackingLoop);
    return;
  }

  let centroid = searchColorCentroid(
    frame.imageData,
    frame.width,
    frame.height,
    state.trackingTargetColor,
    state.trackingLastFramePoint
  );

  if (!centroid && state.trackingLastFramePoint) {
    centroid = searchColorCentroid(
      frame.imageData,
      frame.width,
      frame.height,
      state.trackingTargetColor,
      null
    );
  }

  if (centroid) {
    state.trackingLostFrames = 0;
    state.trackingLastFramePoint = { x: centroid.x, y: centroid.y };
    const stagePoint = frameToStagePoint(centroid, frame.width, frame.height);
    state.trackingMarker = stagePoint;

    const nowMs = performance.now();
    if (nowMs - state.lastAutoSampleMs >= state.autoSampleIntervalMs) {
      const sample = { x: stagePoint.x, y: stagePoint.y, t: nowMs };
      processAutoSample(sample, centroid.matchCount);
      state.lastAutoSampleMs = nowMs;
      setTrackingStatus("Seguimiento: detectando objeto.", "var(--ok)");
      setMessage(
        `Seguimiento auto x=${formatNumber(sample.x)}, y=${formatNumber(sample.y)} | muestras: ${state.pointHistory.length}`
      );
    } else {
      drawOverlay();
    }
  } else {
    state.trackingLostFrames += 1;
    if (state.trackingLostFrames === 15) {
      setTrackingStatus("Seguimiento: objetivo perdido.", "var(--warn)");
      setMessage("Seguimiento perdido. Haz clic otra vez sobre el objeto.");
      sendTelemetry("tracking_lost");
      state.trackingMarker = null;
      drawOverlay();
    }
  }

  state.trackingLoopId = requestAnimationFrame(trackingLoop);
}

function startTracking() {
  if (state.trackingEnabled) {
    return;
  }
  state.trackingEnabled = true;
  state.trackingTargetColor = null;
  state.trackingLastFramePoint = null;
  state.trackingMarker = null;
  state.trackingLostFrames = 0;
  state.lastAutoSampleMs = 0;
  ui.toggleTrackingBtn.textContent = "Detener seguimiento";
  setTrackingStatus("Seguimiento: esperando calibracion.", "var(--accent)");
  setMessage("Seguimiento activado. Haz clic sobre el objeto para calibrar.");
  sendTelemetry("tracking_enabled");
  renderPredictionPanel();
  if (!state.trackingLoopId) {
    state.trackingLoopId = requestAnimationFrame(trackingLoop);
  }
}

function stopTracking() {
  if (!state.trackingEnabled) {
    return;
  }
  state.trackingEnabled = false;
  state.trackingTargetColor = null;
  state.trackingLastFramePoint = null;
  state.trackingMarker = null;
  state.trackingLostFrames = 0;
  if (state.trackingLoopId) {
    cancelAnimationFrame(state.trackingLoopId);
    state.trackingLoopId = null;
  }
  ui.toggleTrackingBtn.textContent = "Iniciar seguimiento";
  setTrackingStatus("Seguimiento: desactivado.");
  setMessage("Seguimiento detenido.");
  sendTelemetry("tracking_disabled");
  renderPredictionPanel();
  drawOverlay();
}

function handleStageClick(event) {
  const point = toStageCoordinates(event);

  if (state.trackingEnabled) {
    const calibrated = setTrackingTargetFromStagePoint(point);
    if (!calibrated) {
      setMessage("No se pudo calibrar el objeto. Verifica que el stream este visible.");
    }
    return;
  }

  const nowMs = performance.now();
  const sample = { x: point.x, y: point.y, t: nowMs };

  evaluatePendingPrediction(point);
  pushPoint(sample, "manual");
  renderPointsTable();
  schedulePrediction(nowMs);
  drawOverlay();
  setMessage(`Ultimo punto: x=${formatNumber(sample.x)}, y=${formatNumber(sample.y)}`);
  sendTelemetry("point_sample", {
    mode: "manual",
    x: Number(sample.x.toFixed(1)),
    y: Number(sample.y.toFixed(1)),
    pointsInBuffer: state.points.length,
  });
}

function showStreamLayer(layer) {
  const useImage = layer === "image";
  ui.streamImage.hidden = !useImage;
  ui.video.hidden = useImage;
}

function clearMediaElements() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  state.trackingMarker = null;
  state.streamPixelReadableWarningShown = false;
  if ("srcObject" in ui.video) {
    ui.video.srcObject = null;
  }
  ui.video.removeAttribute("src");
  if (typeof ui.video.load === "function") {
    ui.video.load();
  }
  ui.streamImage.removeAttribute("src");
}

function waitForVideoReady(timeoutMs = 3500) {
  return new Promise((resolve) => {
    let done = false;
    let timerId = null;

    const cleanup = () => {
      ui.video.removeEventListener("loadeddata", onReady);
      ui.video.removeEventListener("canplay", onReady);
      ui.video.removeEventListener("error", onError);
      if (timerId) {
        clearTimeout(timerId);
      }
    };

    const finish = (ok) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      resolve(ok);
    };

    const onReady = () => finish(true);
    const onError = () => finish(false);

    ui.video.addEventListener("loadeddata", onReady, { once: true });
    ui.video.addEventListener("canplay", onReady, { once: true });
    ui.video.addEventListener("error", onError, { once: true });

    timerId = setTimeout(() => {
      finish(ui.video.readyState >= 2);
    }, timeoutMs);
  });
}

function waitForImageReady(timeoutMs = 3500) {
  return new Promise((resolve) => {
    let done = false;
    let timerId = null;

    const cleanup = () => {
      ui.streamImage.removeEventListener("load", onReady);
      ui.streamImage.removeEventListener("error", onError);
      if (timerId) {
        clearTimeout(timerId);
      }
    };

    const finish = (ok) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      resolve(ok);
    };

    const onReady = () => finish(ui.streamImage.naturalWidth > 0);
    const onError = () => finish(false);

    ui.streamImage.addEventListener("load", onReady, { once: true });
    ui.streamImage.addEventListener("error", onError, { once: true });

    timerId = setTimeout(() => {
      finish(ui.streamImage.complete && ui.streamImage.naturalWidth > 0);
    }, timeoutMs);
  });
}

async function tryVideoElementSource(url, requireFrame) {
  showStreamLayer("video");
  ui.streamImage.removeAttribute("src");
  ui.video.crossOrigin = "anonymous";
  ui.video.src = url;
  try {
    if (typeof ui.video.play === "function") {
      await ui.video.play();
    }
  } catch (_) {}
  if (!requireFrame) {
    return true;
  }
  return waitForVideoReady();
}

async function tryImageElementSource(url, requireFrame) {
  showStreamLayer("image");
  ui.video.removeAttribute("src");
  if (typeof ui.video.load === "function") {
    ui.video.load();
  }
  ui.streamImage.crossOrigin = "anonymous";
  const withNoCache = url.includes("?") ? `${url}&_ts=${Date.now()}` : `${url}?_ts=${Date.now()}`;
  ui.streamImage.src = withNoCache;
  if (!requireFrame) {
    return true;
  }
  return waitForImageReady();
}

async function setVideoSource(url, options = {}) {
  const { auto = false, requireFrame = true } = options;

  clearMediaElements();

  const normalizedUrl = String(url || "").toLowerCase();
  const preferImageFirst = normalizedUrl.includes(".mjpg") || normalizedUrl.includes("mjpeg");

  const attempts = preferImageFirst
    ? [
        { mode: "image", run: () => tryImageElementSource(url, requireFrame) },
        { mode: "video", run: () => tryVideoElementSource(url, requireFrame) },
      ]
    : [
        { mode: "video", run: () => tryVideoElementSource(url, requireFrame) },
        { mode: "image", run: () => tryImageElementSource(url, requireFrame) },
      ];

  for (const attempt of attempts) {
    const ok = await attempt.run();
    if (ok) {
      state.sourceMode = attempt.mode === "image" ? "stream-image" : "stream-url";
      localStorage.setItem(STREAM_URL_STORAGE_KEY, url);
      sendTelemetry("camera_stream_ok", { auto, url, mode: attempt.mode });
      return true;
    }
  }

  sendTelemetry("camera_stream_fail", { auto, url });
  if (!auto) {
    setMessage("No se pudo reproducir el stream. Verifica la URL.");
  }
  return false;
}

async function autoConnectVideoSource() {
  const savedUrl = localStorage.getItem(STREAM_URL_STORAGE_KEY) || "";
  if (savedUrl) {
    ui.streamUrl.value = savedUrl;
  }

  const localScriptConnected = await setVideoSource(LOCAL_PC_STREAM_URL, {
    auto: true,
    requireFrame: true,
  });

  if (localScriptConnected) {
    ui.streamUrl.value = LOCAL_PC_STREAM_URL;
    setMessage("Camara de la PC conectada por script local.");
    return true;
  }

  if (savedUrl && savedUrl !== LOCAL_PC_STREAM_URL) {
    const streamConnected = await setVideoSource(savedUrl, {
      auto: true,
      requireFrame: true,
    });
    if (streamConnected) {
      setMessage("Stream guardado conectado automaticamente.");
      return true;
    }
  }

  setMessage("No se detecto stream local. Ejecuta INICIAR_CAMARA_PC.bat o carga URL.");
  return false;
}

async function fetchNetworkStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const status = await response.json();
    ui.networkStatus.innerHTML = `<span class="ok">Online</span> | SSID: <b>${status.ssid}</b> | IP: <b>${status.ip}</b> | Clientes: <b>${status.stations}</b> | Req: <b>${status.req_total}</b> | Tel: <b>${status.telemetry_hits}</b> | Heap: <b>${status.heap}</b>`;
  } catch (error) {
    ui.networkStatus.innerHTML =
      '<span class="warn">Sin conexion con API del ESP32.</span> Verifica estar en la red AP.';
  }
}

function bindEvents() {
  ui.loadStreamBtn.addEventListener("click", async () => {
    const url = ui.streamUrl.value.trim();
    if (!url) {
      setMessage("Ingresa una URL de stream.");
      return;
    }
    const ok = await setVideoSource(url, { auto: false, requireFrame: true });
    if (ok) {
      setMessage(
        state.trackingEnabled
          ? "Stream cargado. Haz clic en el objeto para calibrar seguimiento."
          : "Stream cargado. Haz clic en el objetivo para medir."
      );
    }
  });

  ui.useCameraBtn.addEventListener("click", async () => {
    const connected = await setVideoSource(LOCAL_PC_STREAM_URL, {
      auto: false,
      requireFrame: true,
    });
    if (connected) {
      ui.streamUrl.value = LOCAL_PC_STREAM_URL;
      setMessage("Stream local de la PC activo.");
      return;
    }
    setMessage("No se pudo conectar stream local. Ejecuta INICIAR_CAMARA_PC.bat.");
  });

  ui.toggleTrackingBtn.addEventListener("click", () => {
    if (state.trackingEnabled) {
      stopTracking();
      return;
    }
    startTracking();
  });

  ui.clearDataBtn.addEventListener("click", clearSessionState);
  ui.testServoBtn.addEventListener("click", () => {
    setMessage("Enviando comando de prueba al servo...");
    testServo();
  });

  ui.horizonMs.addEventListener("change", () => {
    const value = Number(ui.horizonMs.value);
    if (Number.isFinite(value) && value >= 20 && value <= 5000) {
      state.horizonMs = value;
      setMessage(`Horizonte de prediccion configurado en ${state.horizonMs} ms.`);
      sendTelemetry("horizon_change", { horizonMs: state.horizonMs });
      return;
    }
    ui.horizonMs.value = String(state.horizonMs);
  });

  ui.overlay.addEventListener("click", handleStageClick);
  window.addEventListener("resize", resizeCanvasToStage);
}

async function init() {
  bindEvents();
  resizeCanvasToStage();
  clearSessionState(false);
  setTrackingStatus("Seguimiento: desactivado.");
  ui.toggleTrackingBtn.textContent = "Iniciar seguimiento";
  fetchNetworkStatus();
  setInterval(fetchNetworkStatus, 5000);
  sendTelemetry("web_loaded", {
    userAgent: navigator.userAgent.slice(0, 80),
  });
  const sourceConnected = await autoConnectVideoSource();
  if (sourceConnected) {
    startTracking();
  }
}

init();
