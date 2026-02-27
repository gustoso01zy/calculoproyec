const MAX_POINTS = 3;
const STREAM_URL_STORAGE_KEY = "esp32_predictor_saved_stream_url";

const state = {
  points: [],
  startTimeMs: null,
  horizonMs: 200,
  timerId: null,
  predictionSeq: 0,
  pendingPrediction: null,
  validations: [],
  localStream: null,
  sourceMode: "none",
};

const ui = {
  networkStatus: document.getElementById("network-status"),
  streamUrl: document.getElementById("stream-url"),
  horizonMs: document.getElementById("horizon-ms"),
  loadStreamBtn: document.getElementById("load-stream"),
  useCameraBtn: document.getElementById("use-camera"),
  clearDataBtn: document.getElementById("clear-data"),
  stage: document.getElementById("stage"),
  stageMessage: document.getElementById("stage-message"),
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  predictionStatus: document.getElementById("prediction-status"),
  predLinear: document.getElementById("pred-linear"),
  predQuadratic: document.getElementById("pred-quadratic"),
  predTargetTime: document.getElementById("pred-target-time"),
  pointsBody: document.getElementById("points-body"),
  errorsBody: document.getElementById("errors-body"),
};

const ctx = ui.overlay.getContext("2d");

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

function resizeCanvasToStage() {
  const rect = ui.stage.getBoundingClientRect();
  ui.overlay.width = rect.width;
  ui.overlay.height = rect.height;
  drawOverlay();
}

function clearSessionState(emitTelemetry = true) {
  state.points = [];
  state.startTimeMs = null;
  state.validations = [];
  state.pendingPrediction = null;
  state.predictionSeq += 1;
  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  renderPointsTable();
  renderErrorsTable();
  renderPredictionPanel();
  drawOverlay();
  setMessage("Datos limpios. Haz clic para registrar nuevos puntos.");
  if (emitTelemetry) {
    sendTelemetry("session_clear");
  }
}

function pushPoint(point) {
  if (state.startTimeMs === null) {
    state.startTimeMs = point.t;
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
  if (state.points.length === 0) {
    ui.pointsBody.innerHTML = '<tr><td colspan="4">Sin datos.</td></tr>';
    return;
  }

  ui.pointsBody.innerHTML = state.points
    .map(
      (point, idx) =>
        `<tr>
          <td>${idx + 1}</td>
          <td>${formatRelativeMs(point.t)}</td>
          <td>${formatNumber(point.x)}</td>
          <td>${formatNumber(point.y)}</td>
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
    ui.predictionStatus.textContent = "Aun no hay suficientes puntos.";
    ui.predLinear.textContent = "-";
    ui.predQuadratic.textContent = "-";
    ui.predTargetTime.textContent = "-";
    return;
  }

  ui.predictionStatus.textContent = prediction.awaitingValidation
    ? "Esperando clic de posicion real para medir error."
    : "Prediccion generada, espera el tiempo objetivo.";

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

function evaluatePendingPrediction(realPoint) {
  if (!state.pendingPrediction || !state.pendingPrediction.awaitingValidation) {
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
    hasLinear: Boolean(result.linear),
    hasQuadratic: Boolean(result.quadratic),
    linearEuclidean: result.linear ? Number(result.linear.euclidean.toFixed(2)) : null,
    quadraticEuclidean: result.quadratic ? Number(result.quadratic.euclidean.toFixed(2)) : null,
  });

  renderErrorsTable();
  renderPredictionPanel();
}

function toStageCoordinates(event) {
  const rect = ui.overlay.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function handleStageClick(event) {
  const nowMs = performance.now();
  const point = toStageCoordinates(event);
  const sample = { x: point.x, y: point.y, t: nowMs };

  evaluatePendingPrediction(point);
  pushPoint(sample);
  renderPointsTable();
  schedulePrediction(nowMs);
  drawOverlay();
  setMessage(`Ultimo punto: x=${formatNumber(sample.x)}, y=${formatNumber(sample.y)}`);
  sendTelemetry("point_sample", {
    x: Number(sample.x.toFixed(1)),
    y: Number(sample.y.toFixed(1)),
    pointsInBuffer: state.points.length,
  });
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

async function setVideoSource(url, options = {}) {
  const { auto = false, requireFrame = true } = options;

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  ui.video.srcObject = null;
  ui.video.src = url;

  try {
    await ui.video.play();
  } catch (_) {}

  const isReady = requireFrame ? await waitForVideoReady() : true;
  if (!isReady) {
    sendTelemetry("camera_stream_fail", { auto, url });
    if (!auto) {
      setMessage("No se pudo reproducir el stream. Verifica la URL.");
    }
    return false;
  }

  state.sourceMode = "stream-url";
  localStorage.setItem(STREAM_URL_STORAGE_KEY, url);
  sendTelemetry("camera_stream_ok", { auto, url });
  return true;
}

async function useLocalCamera(options = {}) {
  const { automatic = false, silent = false } = options;

  if (!navigator.mediaDevices?.getUserMedia) {
    sendTelemetry("camera_local_unavailable", {
      automatic,
      reason: "mediaDevices_not_available",
    });
    if (!silent) {
      setMessage("Este navegador no soporta camara local en este contexto.");
    }
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });

    if (state.localStream) {
      state.localStream.getTracks().forEach((track) => track.stop());
    }

    state.localStream = stream;
    ui.video.src = "";
    ui.video.srcObject = stream;
    await ui.video.play();
    state.sourceMode = "local-camera";

    sendTelemetry("camera_local_ok", {
      automatic,
      width: ui.video.videoWidth || null,
      height: ui.video.videoHeight || null,
    });

    if (!silent) {
      setMessage("Camara local activa. Haz clic para registrar puntos.");
    }
    return true;
  } catch (error) {
    sendTelemetry("camera_local_fail", {
      automatic,
      reason: String(error?.name || error?.message || "unknown"),
    });
    if (!silent) {
      setMessage(
        "No se pudo abrir camara local automaticamente. En HTTP puede bloquearse; usa URL de stream."
      );
    }
    return false;
  }
}

async function autoConnectVideoSource() {
  const savedUrl = localStorage.getItem(STREAM_URL_STORAGE_KEY) || "";
  if (savedUrl) {
    ui.streamUrl.value = savedUrl;
  }

  const localCameraConnected = await useLocalCamera({
    automatic: true,
    silent: true,
  });

  if (localCameraConnected) {
    setMessage("Camara de la PC conectada automaticamente.");
    return;
  }

  if (savedUrl) {
    const streamConnected = await setVideoSource(savedUrl, {
      auto: true,
      requireFrame: true,
    });
    if (streamConnected) {
      setMessage("Stream guardado conectado automaticamente.");
      return;
    }
  }

  setMessage("Autoconexion no disponible. Usa camara local o ingresa URL.");
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
      setMessage("Stream cargado. Haz clic en el objetivo para medir.");
    }
  });

  ui.useCameraBtn.addEventListener("click", async () => {
    await useLocalCamera({ automatic: false, silent: false });
  });

  ui.clearDataBtn.addEventListener("click", clearSessionState);

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
  fetchNetworkStatus();
  setInterval(fetchNetworkStatus, 5000);
  sendTelemetry("web_loaded", {
    userAgent: navigator.userAgent.slice(0, 80),
  });
  await autoConnectVideoSource();
}

init();
