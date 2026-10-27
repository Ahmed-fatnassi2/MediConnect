(() => {
  "use strict";

  const STORE_KEY = "mc-handsfree";
  const MEDIAPIPE_VERSION = "0.10.20";
  const MEDIAPIPE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.min.mjs`;
  const MEDIAPIPE_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
  const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  const LEFT_IRIS = 468;
  const RIGHT_IRIS = 473;
  const BLINK_OPEN_PHASE_MS = 2800;
  const BLINK_SAMPLE_PHASE_MS = 6400;
  const BLINK_ON = 0.52;
  const BLINK_OFF = 0.34;
  const BLINK_COOLDOWN = 450;
  const TARGETS = "a[href], button, input, select, textarea, summary, label, [role=button], [tabindex]:not([tabindex='-1'])";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const settings = document.querySelector("[data-hf-settings]");
  const announcer = document.querySelector("[data-hf-announcer]");
  if (!settings || !announcer) return;

  const modeInputs = [...settings.querySelectorAll("input[name=hf-mode]")];
  const sizeInput = settings.querySelector("[data-hf-size]");
  const previewInput = settings.querySelector("[data-hf-preview]");
  const message = settings.querySelector("[data-hf-message]");
  const consentDialog = document.querySelector("[data-hf-consent]");
  const calibrationDialog = document.querySelector("[data-hf-calibration]");
  const consentCheck = consentDialog.querySelector("[data-hf-consent-check]");
  const consentAccept = consentDialog.querySelector("[data-hf-consent-accept]");
  const calibrationStatus = calibrationDialog.querySelector("[data-hf-calibration-status]");
  const calibrationResult = calibrationDialog.querySelector("[data-hf-calibration-result]");
  const calibrationCount = calibrationDialog.querySelector("[data-hf-calibration-count]");

  let preferences = readPreferences();
  let core = null;
  let visionPromise = null;
  let visionFileset = null;
  let faceLandmarker = null;
  let handLandmarker = null;
  let cameraStream = null;
  let cameraVideo = null;
  let videoFrame = 0;
  let lastFrameAt = 0;
  let frameCount = 0;
  let fps = 0;
  let lowFpsSince = null;
  let lighterSuggestionShown = false;
  let activeMode = "off";
  let lastMode = "combined";
  let trackingPaused = false;
  let pageSuspended = false;
  let runtimeReady = false;
  let lastPoint = null;
  let lastGaze = null;
  let gazeSmooth = null;
  let blinkPeak = false;
  let blinkTarget = null;
  let lastBlinkClick = 0;
  let activeTarget = null;
  let pendingConfirmation = null;
  let pinchStart = null;
  let pinchDragged = false;
  let lastPinchPoint = null;
  let snapRadius = 72;
  let calibrationPhase = "idle";
  let calibrationStartedAt = 0;
  let calibrationOpenSamples = [];
  let calibrationBlinkSamples = [];
  let faceWasDetected = false;
  let lastFaceHintAt = 0;
  let handWasDetected = false;
  let lastHandHintAt = 0;
  let blinkThresholds = { on: BLINK_ON, off: BLINK_OFF };
  try {
    const savedThresholds = JSON.parse(localStorage.getItem("mc-handsfree-blink") || "null");
    if (Number.isFinite(savedThresholds?.on) && Number.isFinite(savedThresholds?.off)) blinkThresholds = savedThresholds;
  } catch (error) { /* use defaults */ }
  let suspendedMode = "off";
  let statusMode;

  let pinch;
  let palmPause;

  function readPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      return {
        mode: ["off", "eyes", "hands", "combined"].includes(value.mode) ? value.mode : "off",
        size: Math.max(32, Math.min(64, Number(value.size) || 42)),
        consent: value.consent === true,
        preview: value.preview === true,
      };
    } catch (error) {
      return { mode: "off", size: 42, consent: false, preview: false };
    }
  }

  function promoteOverlays() {
    if (activeMode === "off") return;
    status.hidden = false;
    const elements = cursor.hidden ? [status] : [cursor, status];
    for (const element of elements) {
      try {
        if (element.matches(":popover-open")) element.hidePopover();
        element.showPopover();
      } catch (error) {
        announce("Votre navigateur ne prend pas en charge les superpositions nécessaires au pointeur.");
      }
    }
  }

  function savePreferences() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(preferences)); }
    catch (error) { announce("Les préférences ne peuvent pas être enregistrées sur cet appareil."); }
  }

  function announce(text) {
    announcer.textContent = text;
    message.textContent = text;
    if (statusMessage) statusMessage.textContent = text;
  }

  function modeLabel(mode = activeMode) {
    return ({ off: "Désactivé", eyes: "Yeux", hands: "Mains", combined: "Yeux + mains" })[mode] || "Désactivé";
  }

  function renderControls() {
    modeInputs.forEach((input) => { input.checked = input.value === preferences.mode; });
    sizeInput.value = String(preferences.size);
    previewInput.checked = preferences.preview;
    settings.querySelector("[data-hf-size-value]").textContent = `${preferences.size} px`;
    if (cursor) cursor.style.setProperty("--hf-pointer-size", `${preferences.size}px`);
    if (statusMode) statusMode.textContent = modeLabel();
  }

  const cursor = document.createElement("div");
  cursor.className = "hf-cursor";
  cursor.setAttribute("popover", "manual");
  cursor.setAttribute("aria-hidden", "true");
  const cursorRing = document.createElement("span");
  cursorRing.className = "hf-cursor-ring";
  cursor.append(cursorRing);
  const status = document.createElement("div");
  status.className = "hf-status";
  status.setAttribute("popover", "manual");
  status.setAttribute("role", "region");
  status.setAttribute("aria-label", "Contrôles de navigation mains libres");
  statusMode = document.createElement("strong");
  statusMode.className = "hf-status-mode";
  const statusFps = document.createElement("span");
  statusFps.className = "hf-status-fps";
  statusFps.textContent = "0 FPS";
  const statusMessage = document.createElement("span");
  statusMessage.className = "hf-status-message";
  const pauseButton = document.createElement("button");
  pauseButton.type = "button";
  pauseButton.textContent = "Pause";
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = "Arrêter";
  status.append(statusMode, statusFps, statusMessage, pauseButton, stopButton);
  cursor.hidden = true;
  status.hidden = true;
  document.body.append(cursor, status);
  renderControls();

  function showOverlays() {
    if (activeMode === "off") return;
    status.hidden = false;
    const elements = cursor.hidden ? [status] : [cursor, status];
    for (const element of elements) {
      try {
        if (!element.matches(":popover-open")) element.showPopover();
      } catch (error) {
        announce("Votre navigateur ne prend pas en charge les superpositions nécessaires au pointeur.");
      }
    }
  }

  function positionCursor(point, progress = 0) {
    if (!point) return;
    lastPoint = point;
    cursor.hidden = false;
    cursor.style.left = `${Math.max(0, Math.min(innerWidth, point.x))}px`;
    cursor.style.top = `${Math.max(0, Math.min(innerHeight, point.y))}px`;
    cursorRing.style.setProperty("--hf-progress", `${Math.round(progress * 100)}%`);
    showOverlays();
  }

  function markTarget(target) {
    if (activeTarget === target) return;
    activeTarget?.classList.remove("hf-target-active");
    activeTarget = target;
    activeTarget?.classList.add("hf-target-active");
    if (pendingConfirmation && pendingConfirmation.target !== target) pendingConfirmation = null;
  }

  function visible(element) {
    if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function targets() {
    const dialogs = [...document.querySelectorAll("dialog[open]")];
    const root = dialogs.at(-1) || document;
    const elements = [...root.querySelectorAll(TARGETS), ...status.querySelectorAll(TARGETS)];
    return [...new Set(elements)].filter(visible).map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, element };
    });
  }

  function targetAt(point) {
    if (!core || !point) return null;
    const underPointer = document.elementFromPoint(point.x, point.y);
    const direct = underPointer?.closest(TARGETS);
    const list = targets();
    const result = core.snapTarget(point, list, snapRadius, visible(direct) ? direct : null);
    return result?.element || null;
  }

  function requiresConfirmation(target) {
    if (!target) return false;
    const isSubmit = target.matches("input[type=submit]") ||
      target.tagName === "BUTTON" && (!target.hasAttribute("type") || target.type === "submit");
    const postSubmit = isSubmit &&
      target.form?.method.toLowerCase() === "post";
    const label = (target.innerText || target.getAttribute("aria-label") || "").trim().toLocaleLowerCase("fr");
    return postSubmit || target.matches(".btn-danger, [data-confirm]") ||
      label.includes("terminer la consultation");
  }

  function needsRealActivation(target) {
    return target.matches("input[type=file], [data-requires-user-activation], [data-start-video], [data-toggle-cam]") ||
      target.tagName === "LABEL" && target.control?.type === "file";
  }

  function performClick(target) {
    if (needsRealActivation(target)) {
      announce("Cette action demande un vrai clic. Suivi en pause ; Reprendre pour continuer.");
      trackingPaused = true;
      updatePauseButton();
      return;
    }
    if (requiresConfirmation(target)) {
      const now = Date.now();
      if (!pendingConfirmation || pendingConfirmation.target !== target || now > pendingConfirmation.expiresAt) {
        pendingConfirmation = { target, expiresAt: now + 4000 };
        announce("Confirmer ? Faites un second clic dans les 4 secondes.");
        return;
      }
      pendingConfirmation = null;
    }
    announce("Clic");
    if (target instanceof HTMLSelectElement && typeof target.showPicker === "function") {
      target.focus();
      target.showPicker();
    } else {
      if (target.matches("input:not([type=button]):not([type=submit]), textarea")) target.focus();
      target.click();
    }
    setTimeout(showOverlays, 0);
  }

  function updatePointer(point) {
    positionCursor(point);
    const target = targetAt(point);
    markTarget(target);
    if (target) {
      cursorRing.hidden = false;
      cursorRing.style.setProperty("--hf-progress", "0%");
    } else {
      cursorRing.hidden = true;
    }
  }

  function updatePauseButton() {
    pauseButton.textContent = trackingPaused ? "Reprendre" : "Pause";
  }

  function setPaused(value, announcement = true) {
    trackingPaused = value;
    updatePauseButton();
    if (announcement) announce(value ? "En pause" : "Pointeur activé");
  }

  function countFrame(now) {
    frameCount += 1;
    if (now - lastFrameAt >= 1000) {
      fps = Math.round(frameCount * 1000 / Math.max(1, now - lastFrameAt));
      frameCount = 0;
      lastFrameAt = now;
      statusFps.textContent = `${fps} FPS`;
      if (fps < 8) {
        if (lowFpsSince === null) lowFpsSince = now;
        if (now - lowFpsSince >= 3000 && !lighterSuggestionShown) suggestLighterMode();
      } else {
        lowFpsSince = null;
      }
    }
  }

  function suggestLighterMode() {
    lighterSuggestionShown = true;
    const lighter = activeMode === "eyes" ? "off" : "eyes";
    announce("Le suivi est lent. Vous pouvez passer au mode plus léger.");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = activeMode === "combined" ? "Passer aux yeux" : "Arrêter le suivi";
    button.addEventListener("click", () => {
      preferences.mode = lighter;
      savePreferences();
      renderControls();
      startSelectedMode();
    }, { once: true });
    status.insertBefore(button, pauseButton);
  }

  function loadCore() {
    if (core) return Promise.resolve(core);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = settings.dataset.coreUrl;
      script.onload = () => {
        if (!window.HandsfreeCore) reject(new Error("Le moteur du pointeur est indisponible."));
        else {
          core = window.HandsfreeCore;
          pinch = new core.PinchDetector(0.22, 0.34, 140);
          palmPause = new core.PalmPauseDetector();
          resolve(core);
        }
      };
      script.onerror = () => reject(new Error("Impossible de charger le moteur du pointeur."));
      document.head.append(script);
    });
  }

  function loadVision() {
    if (!visionPromise) visionPromise = import(MEDIAPIPE_URL);
    return visionPromise;
  }

  async function ensureVisionFileset() {
    const vision = await loadVision();
    if (!visionFileset) visionFileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    return { vision, fileset: visionFileset };
  }

  async function ensureCamera() {
    if (cameraVideo?.readyState >= 2) return cameraVideo;
    if (!cameraStream) cameraStream = await navigator.mediaDevices.getUserMedia(streamConstraints());
    if (!cameraVideo) {
      cameraVideo = document.createElement("video");
      cameraVideo.muted = true;
      cameraVideo.playsInline = true;
      cameraVideo.autoplay = true;
      cameraVideo.className = "hf-local-video";
      cameraVideo.hidden = !preferences.preview;
      cameraVideo.srcObject = cameraStream;
      document.body.append(cameraVideo);
    }
    await cameraVideo.play();
    return cameraVideo;
  }

  function streamConstraints() {
    return {
      audio: false,
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 15, max: 20 },
      },
    };
  }

  function checkBrowserSupport() {
    return Boolean(
      window.isSecureContext &&
      navigator.mediaDevices?.getUserMedia &&
      HTMLElement.prototype.showPopover &&
      window.requestAnimationFrame
    );
  }

  function ensureConsent() {
    if (preferences.consent) return Promise.resolve(true);
    consentCheck.checked = false;
    consentAccept.disabled = true;
    consentDialog.showModal();
    promoteOverlays();
    return new Promise((resolve) => {
      const onChange = () => { consentAccept.disabled = !consentCheck.checked; };
      const onAccept = () => {
        consentDialog.close("accepted");
        setTimeout(promoteOverlays, 0);
      };
      const onCancel = () => {
        consentDialog.close("cancelled");
        setTimeout(promoteOverlays, 0);
      };
      const finish = (accepted) => {
        consentDialog.removeEventListener("close", onClose);
        consentCheck.removeEventListener("change", onChange);
        consentAccept.removeEventListener("click", onAccept);
        consentDialog.querySelector("[data-hf-consent-cancel]").removeEventListener("click", onCancel);
        if (accepted) {
          preferences.consent = true;
          savePreferences();
        }
        resolve(accepted);
      };
      const onClose = () => finish(consentDialog.returnValue === "accepted");
      consentDialog.addEventListener("close", onClose, { once: true });
      consentCheck.addEventListener("change", onChange);
      consentAccept.addEventListener("click", onAccept);
      consentDialog.querySelector("[data-hf-consent-cancel]").addEventListener("click", onCancel);
    });
  }

  async function startEyes() {
    const { vision, fileset } = await ensureVisionFileset();
    await ensureCamera();
    faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.4,
    });
  }

  function edgeScroll(y) {
    if (activeMode !== "eyes" || document.querySelector("dialog[open]") || trackingPaused) return;
    const margin = innerHeight * 0.12;
    let delta = 0;
    if (y < margin) delta = -Math.ceil((margin - y) / 10);
    else if (y > innerHeight - margin) delta = Math.ceil((y - innerHeight + margin) / 10);
    if (delta) window.scrollBy({ top: delta, behavior: reducedMotion.matches ? "auto" : "smooth" });
  }

  async function startHands() {
    const { vision, fileset } = await ensureVisionFileset();
    await ensureCamera();
    handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.45,
      minTrackingConfidence: 0.45,
    });
  }

  function blinkScore(result) {
    const categories = result?.faceBlendshapes?.[0]?.categories || [];
    return categories.reduce((score, item) =>
      item.categoryName === "eyeBlinkLeft" || item.categoryName === "eyeBlinkRight"
        ? Math.max(score, item.score) : score, 0);
  }

  function gazeFeature(landmarks) {
    if (!landmarks || landmarks.length <= RIGHT_IRIS) return null;
    const left = landmarks[LEFT_IRIS];
    const right = landmarks[RIGHT_IRIS];
    if (!left || !right || !Number.isFinite(left.x) || !Number.isFinite(right.x)) return null;
    return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  }

  function mapGazeToScreen(gaze) {
    return {
      x: Math.max(0.02, Math.min(0.98, 1 - gaze.x)) * innerWidth,
      y: Math.max(0.04, Math.min(0.96, gaze.y)) * innerHeight,
    };
  }

  function quantile(sorted, q) {
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower + 1] === undefined
      ? sorted[lower]
      : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
  }

  function finishBlinkCalibration() {
    calibrationPhase = "idle";
    const open = [...calibrationOpenSamples].sort((a, b) => a - b);
    const blinks = calibrationBlinkSamples;
    if (open.length < 12 || blinks.length < 20) {
      calibrationStatus.textContent = "Calibration incomplète.";
      calibrationResult.textContent = "Le visage n’a pas été détecté assez longtemps. Vérifiez le cadrage et l’éclairage, puis recommencez.";
    } else {
      const openHigh = quantile(open, 0.88);
      const blinkHigh = Math.max(...blinks);
      const span = blinkHigh - openHigh;
      if (span < 0.1) {
        calibrationStatus.textContent = "Clignements non détectés.";
        calibrationResult.textContent = "Gardez les yeux ouverts pendant la première étape, puis clignez volontairement plusieurs fois pendant la seconde.";
      } else {
        let on = openHigh + span * 0.48;
        let off = openHigh + span * 0.26;
        on = Math.min(0.92, Math.max(on, off + 0.07));
        off = Math.max(0.04, Math.min(off, on - 0.07));
        blinkThresholds = { on, off };
        try { localStorage.setItem("mc-handsfree-blink", JSON.stringify(blinkThresholds)); } catch (error) { /* local only */ }
        calibrationStatus.textContent = "Clignement calibré.";
        calibrationResult.textContent = "Le marqueur suit approximativement vos yeux. Regardez un bouton ou un lien, puis clignez une fois pour cliquer.";
      }
    }
    setTimeout(() => {
      if (calibrationDialog.open) calibrationDialog.close();
      showOverlays();
    }, 2200);
  }

  function sampleBlinkCalibration(score, now, hasFace) {
    const elapsed = now - calibrationStartedAt;
    if (calibrationPhase === "open") {
      if (hasFace) calibrationOpenSamples.push(score);
      calibrationCount.textContent = `Gardez les yeux ouverts : ${Math.max(0, Math.ceil((BLINK_OPEN_PHASE_MS - elapsed) / 1000))} s`;
      if (elapsed >= BLINK_OPEN_PHASE_MS) {
        calibrationPhase = "blink";
        calibrationStartedAt = now;
        calibrationBlinkSamples = [];
        calibrationCount.textContent = "Étape 2 sur 2";
        calibrationStatus.textContent = "Clignez plusieurs fois, normalement.";
        calibrationDialog.querySelector("[data-hf-calibration-instructions]").textContent = "Clignez volontairement plusieurs fois pendant la mesure. Gardez la tête face à la caméra.";
      }
    } else if (calibrationPhase === "blink") {
      if (hasFace) calibrationBlinkSamples.push(score);
      calibrationCount.textContent = `Clignez plusieurs fois : ${Math.max(0, Math.ceil((BLINK_SAMPLE_PHASE_MS - elapsed) / 1000))} s`;
      if (elapsed >= BLINK_SAMPLE_PHASE_MS) finishBlinkCalibration();
    }
  }

  function handleEyeBlink(score) {
    if (score >= blinkThresholds.on && !blinkPeak) {
      blinkPeak = true;
      blinkTarget = lastGaze ? targetAt(lastGaze) : activeTarget;
    }
    if (blinkPeak && score <= blinkThresholds.off) {
      blinkPeak = false;
      const target = blinkTarget;
      blinkTarget = null;
      if (target && Date.now() - lastBlinkClick >= BLINK_COOLDOWN) {
        lastBlinkClick = Date.now();
        performClick(target);
      } else if (target) {
        announce("Gardez le regard sur la cible jusqu’au remplissage du cercle, puis clignez une fois pour cliquer.");
      } else if (activeTarget) {
        announce("Gardez le regard sur la cible jusqu’au remplissage du cercle, puis clignez une fois pour cliquer.");
      } else {
        announce("Regardez un bouton ou un lien avant de cligner pour cliquer.");
      }
    }
  }

  function processEyes(result, now) {
    const landmarks = result.faceLandmarks?.[0];
    const gaze = gazeFeature(landmarks);
    const score = blinkScore(result);
    sampleBlinkCalibration(score, now, Boolean(landmarks));
    if (!gaze) {
      if (runtimeReady && !trackingPaused && !calibrationDialog.open) handleEyeBlink(score);
      if (calibrationPhase !== "idle") calibrationStatus.textContent = "Visage non détecté : ajustez l’éclairage et placez votre visage dans le cadre.";
      faceWasDetected = false;
      if (["eyes", "combined"].includes(activeMode) && Date.now() - lastFaceHintAt > 2500) {
        lastFaceHintAt = Date.now();
        announce("Visage non détecté. Placez votre visage face à la caméra et vérifiez l’éclairage.");
      }
      return;
    }
    if (!faceWasDetected) {
      faceWasDetected = true;
      if (["eyes", "combined"].includes(activeMode) && calibrationPhase === "idle") {
        announce("Visage détecté. Regardez un élément puis clignez une fois pour cliquer.");
      }
    }
    const point = mapGazeToScreen(gaze);
    gazeSmooth = core.smoothPoint(gazeSmooth, point, 0.24);
    lastGaze = gazeSmooth;

    if (!runtimeReady || trackingPaused || calibrationDialog.open) return;
    handleEyeBlink(score);
    if (!blinkPeak) {
      updatePointer(lastGaze);
      edgeScroll(lastGaze.y);
    }
  }

  function startDetection() {
    lastFrameAt = performance.now();
    frameCount = 0;
    const detect = (now) => {
      if (!cameraVideo || pageSuspended || activeMode === "off") return;
      videoFrame = requestAnimationFrame(detect);
      if (now - Number(cameraVideo.dataset.lastFrame || 0) < 60 || cameraVideo.readyState < 2) return;
      cameraVideo.dataset.lastFrame = String(now);
      if (faceLandmarker && ["eyes", "combined"].includes(activeMode)) {
        try { processEyes(faceLandmarker.detectForVideo(cameraVideo, now), now); }
        catch (error) { console.warn("Face tracking skipped a frame", error); }
      }
      if (handLandmarker && ["hands", "combined"].includes(activeMode)) {
        try { processHand(handLandmarker.detectForVideo(cameraVideo, now), now); }
        catch (error) { console.warn("Hand tracking skipped a frame", error); }
      }
      countFrame(now);
    };
    videoFrame = requestAnimationFrame(detect);
  }

  function processHand(result, now) {
    const landmarks = result.landmarks?.[0];
    if (!landmarks) {
      pinch.reset();
      palmPause.reset();
      lastPinchPoint = null;
      handWasDetected = false;
      if (activeMode === "hands" && Date.now() - lastHandHintAt > 2500) {
        lastHandHintAt = Date.now();
        announce("Main non détectée. Montrez une main entière, à hauteur du visage, face à la caméra.");
      }
      return;
    }
    if (!handWasDetected) {
      handWasDetected = true;
      if (activeMode === "hands") announce("Main détectée : pointez avec l’index, puis pincez pouce-index pour cliquer.");
    }
    const position = (point) => ({ x: (1 - point.x) * innerWidth, y: point.y * innerHeight });
    const index = landmarks[8];
    const thumb = landmarks[4];
    const wrist = landmarks[0];
    const middleMcp = landmarks[9];
    const handScale = Math.hypot(wrist.x - middleMcp.x, wrist.y - middleMcp.y) || 1;
    const pinchRatio = Math.hypot(index.x - thumb.x, index.y - thumb.y) / handScale;
    const handPoint = position(index);
    const tips = [8, 12, 16, 20].map((i) => Math.hypot(landmarks[i].x - wrist.x, landmarks[i].y - wrist.y) / handScale);
    const openPalm = tips.every((ratio) => ratio > 1.5) && pinchRatio > 0.08;
    if (palmPause.update(openPalm, now)) setPaused(!trackingPaused);
    if (!trackingPaused && activeMode === "hands") updatePointer(handPoint);
    const state = pinch.update(pinchRatio, now);
    if (!trackingPaused && activeMode === "hands") {
      cursorRing.hidden = false;
      cursorRing.style.setProperty("--hf-progress", state.pressed ? "100%" : "0%");
    }
    if (state.started) {
      pinchStart = handPoint;
      lastPinchPoint = handPoint;
      pinchDragged = false;
    } else if (state.pressed && pinchStart) {
      const dy = handPoint.y - lastPinchPoint.y;
      if (Math.hypot(handPoint.x - pinchStart.x, handPoint.y - pinchStart.y) > 12) pinchDragged = true;
      if (pinchDragged) window.scrollBy(0, core.scrollDrag(lastPinchPoint.y, handPoint.y));
      lastPinchPoint = handPoint;
    } else if (state.released && pinchStart) {
      if (!pinchDragged && !trackingPaused) {
        if (activeTarget) performClick(activeTarget);
        else announce("Aucune cible sous le curseur. Pointez un bouton ou un lien avant de pincer.");
      }
      pinchStart = null;
      lastPinchPoint = null;
      pinchDragged = false;
    }
  }

  function beginCalibration() {
    if (!faceLandmarker) {
      announce("Choisissez d’abord le mode Yeux ou Yeux + mains, puis autorisez la caméra.");
      return;
    }
    calibrationPhase = "open";
    calibrationStartedAt = performance.now();
    calibrationOpenSamples = [];
    calibrationBlinkSamples = [];
    calibrationResult.textContent = "";
    calibrationCount.textContent = "Étape 1 sur 2";
    calibrationStatus.textContent = "Regardez la caméra, les yeux ouverts.";
    calibrationDialog.querySelector("[data-hf-calibration-instructions]").textContent = "Restez face à la caméra et gardez les yeux ouverts pendant quelques secondes. Ensuite, clignez plusieurs fois normalement.";
    if (cameraVideo) cameraVideo.hidden = true;
    if (!calibrationDialog.open) calibrationDialog.showModal();
    promoteOverlays();
  }

  function cancelCalibration() {
    calibrationPhase = "idle";
    calibrationOpenSamples = [];
    calibrationBlinkSamples = [];
    if (calibrationDialog.open) calibrationDialog.close();
    showOverlays();
  }

  function showError(text) {
    void stopRuntime();
    preferences.mode = "off";
    activeMode = "off";
    savePreferences();
    renderControls();
    cursor.hidden = true;
    status.hidden = true;
    for (const element of [cursor, status]) {
      try { if (element.matches(":popover-open")) element.hidePopover(); } catch (error) {
        console.error("Hands-free overlay cleanup failed", error);
      }
    }
    announce(text);
  }

  async function startSelectedMode() {
    const desiredMode = preferences.mode;
    await stopRuntime();
    if (desiredMode === "off") {
      activeMode = "off";
      cursor.hidden = true;
      status.hidden = true;
      for (const element of [cursor, status]) {
        try { if (element.matches(":popover-open")) element.hidePopover(); } catch (error) {
          console.error("Hands-free overlay cleanup failed", error);
        }
      }
      renderControls();
      announce("Navigation mains libres désactivée.");
      return;
    }
    if (!checkBrowserSupport()) {
      showError("Navigateur incompatible ou contexte non sécurisé. Le site reste utilisable normalement.");
      return;
    }
    if (!(await ensureConsent())) {
      preferences.mode = "off";
      savePreferences();
      renderControls();
      announce("Navigation mains libres désactivée : autorisation non accordée.");
      return;
    }
    try {
      await loadCore();
      activeMode = desiredMode;
      lastMode = desiredMode;
      trackingPaused = false;
      lowFpsSince = null;
      lighterSuggestionShown = false;
      runtimeReady = false;
      if (desiredMode === "eyes" || desiredMode === "combined") await startEyes();
      if (desiredMode === "hands" || desiredMode === "combined") await startHands();
      runtimeReady = true;
      startDetection();
      snapRadius = desiredMode === "hands" ? 72 : 56;
      renderControls();
      announce("Pointeur activé");
      showOverlays();
    } catch (error) {
      showError(error?.name === "NotAllowedError"
        ? "Accès caméra refusé. Autorisez la caméra dans le navigateur ou gardez la navigation habituelle."
        : error?.message || "Le suivi mains libres est indisponible.");
    }
  }

  async function stopRuntime() {
    runtimeReady = false;
    if (videoFrame) cancelAnimationFrame(videoFrame);
    videoFrame = 0;
    let stopError = null;
    calibrationPhase = "idle";
    if (faceLandmarker) {
      try { faceLandmarker.close(); } catch (error) { stopError = error; }
      faceLandmarker = null;
    }
    if (handLandmarker) {
      try { handLandmarker.close(); } catch (error) { stopError ||= error; }
      handLandmarker = null;
    }
    if (cameraStream) {
      for (const track of cameraStream.getTracks()) {
        try { track.stop(); } catch (error) { stopError ||= error; }
      }
      cameraStream = null;
    }
    if (cameraVideo) {
      try { cameraVideo.pause(); } catch (error) { stopError ||= error; }
      cameraVideo.srcObject = null;
      cameraVideo.remove();
      cameraVideo = null;
    }
    activeTarget?.classList.remove("hf-target-active");
    activeTarget = null;
    lastPoint = null;
    lastGaze = null;
    gazeSmooth = null;
    blinkPeak = false;
    blinkTarget = null;
    pendingConfirmation = null;
    pinch?.reset();
    palmPause?.reset();
    if (stopError) {
      console.error("Hands-free resources failed to stop cleanly", stopError);
      announce("Le suivi mains libres n'a pas pu s'arrêter proprement. Rechargez la page avant de le réactiver.");
    }
  }

  function syncDialogs() {
    requestAnimationFrame(promoteOverlays);
  }

  const dialogObserver = new MutationObserver(syncDialogs);
  dialogObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
  document.addEventListener("close", syncDialogs, true);
  document.addEventListener("cancel", () => setTimeout(showOverlays, 0), true);

  settings.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("input[name=hf-mode]")) {
      const selected = input.value;
      preferences.mode = selected;
      if (selected !== "off") lastMode = selected;
      savePreferences();
      startSelectedMode();
    } else if (input === sizeInput) {
      preferences.size = Number(input.value);
      savePreferences();
      renderControls();
    } else if (input === previewInput) {
      preferences.preview = input.checked;
      savePreferences();
      if (cameraVideo) cameraVideo.hidden = !preferences.preview;
    }
  });

  settings.querySelector("[data-hf-calibrate]").addEventListener("click", () => {
    if (!faceLandmarker) {
      announce("Activez d'abord le mode Yeux pour recalibrer.");
      return;
    }
    beginCalibration();
  });
  calibrationDialog.querySelector("[data-hf-calibration-close]").addEventListener("click", () => {
    cancelCalibration();
  });
  calibrationDialog.addEventListener("close", () => {
    calibrationPhase = "idle";
    if (cameraVideo) cameraVideo.hidden = !preferences.preview;
    promoteOverlays();
  });
  pauseButton.addEventListener("click", () => setPaused(!trackingPaused));
  stopButton.addEventListener("click", () => {
    preferences.mode = "off";
    savePreferences();
    renderControls();
    startSelectedMode();
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyG") {
      event.preventDefault();
      preferences.mode = activeMode === "off" ? lastMode : "off";
      savePreferences();
      renderControls();
      startSelectedMode();
    }
  });

  function suspendForHiddenPage() {
    if (document.visibilityState === "hidden" && activeMode !== "off") {
      suspendedMode = preferences.mode;
      pageSuspended = true;
      stopRuntime();
      announce("Suivi arrêté pendant que la page est masquée.");
    } else if (document.visibilityState === "visible" && suspendedMode !== "off") {
      pageSuspended = false;
      preferences.mode = suspendedMode;
      suspendedMode = "off";
      startSelectedMode();
    }
  }
  document.addEventListener("visibilitychange", suspendForHiddenPage);
  window.addEventListener("pagehide", () => {
    pageSuspended = true;
    suspendedMode = "off";
    stopRuntime();
  });

  renderControls();
  if (preferences.mode !== "off") startSelectedMode();
  else announce("Navigation mains libres désactivée.");
})();
