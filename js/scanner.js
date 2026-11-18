// Envoltorio sobre html5-qrcode (global `Html5Qrcode`, cargado desde CDN en index.html).

import { normalizeCode } from "./util.js";

const DUPLICATE_WINDOW_MS = 1500;

export class ScannerError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "insecure" | "denied" | "nocamera" | "inuse" | "nolib" | "other"
  }
}

function formats() {
  const F = globalThis.Html5QrcodeSupportedFormats;
  return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39];
}

function classify(err) {
  const text = String(err?.name || "") + " " + String(err?.message || err || "");
  if (/NotAllowed|Permission|denied/i.test(text)) {
    return new ScannerError("denied", "No hay permiso para usar la cámara.");
  }
  if (/NotFound|no camera|Requested device not found|OverconstrainedError/i.test(text)) {
    return new ScannerError("nocamera", "No se encontró una cámara en este dispositivo.");
  }
  if (/NotReadable|Could not start video|TrackStart/i.test(text)) {
    return new ScannerError("inuse", "La cámara está siendo usada por otra aplicación.");
  }
  return new ScannerError("other", "No se pudo abrir la cámara: " + text.trim());
}

export function createScanner(elementId) {
  let instance = null;
  let running = false;
  let paused = false;
  let lastCode = "";
  let lastAt = 0;

  async function start(onCode) {
    if (!window.isSecureContext) {
      throw new ScannerError("insecure", "La cámara solo funciona con HTTPS.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new ScannerError("nocamera", "Este navegador no permite usar la cámara.");
    }
    if (!globalThis.Html5Qrcode) {
      throw new ScannerError("nolib", "No se cargó el lector de códigos. Abre la app con internet una vez.");
    }
    await stop();
    instance = new Html5Qrcode(elementId, {
      formatsToSupport: formats(),
      // Usa el lector nativo (más rápido) cuando el navegador lo tiene, p. ej. Chrome Android.
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });

    const onSuccess = (decodedText) => {
      if (paused) return;
      const code = normalizeCode(decodedText);
      if (!code) return;
      const now = Date.now();
      if (code === lastCode && now - lastAt < DUPLICATE_WINDOW_MS) return;
      lastCode = code;
      lastAt = now;
      pause(); // evita lecturas dobles mientras se procesa
      onCode(code);
    };

    try {
      await instance.start(
        { facingMode: "environment" },
        {
          fps: 12,
          // Rectángulo ancho: mejor para códigos de barra 1D.
          qrbox: (w, h) => {
            const width = Math.max(120, Math.floor(w * 0.88));
            const height = Math.max(80, Math.floor(Math.min(h * 0.5, width * 0.55)));
            return { width, height };
          },
          disableFlip: true,
        },
        onSuccess,
        () => {} // errores por cuadro sin código: se ignoran
      );
      running = true;
      paused = false;
    } catch (err) {
      try {
        instance.clear();
      } catch {}
      instance = null;
      running = false;
      throw classify(err);
    }
  }

  function pause() {
    if (!running || paused) return;
    paused = true;
    try {
      instance.pause(true);
    } catch {}
  }

  function resume() {
    if (!running || !paused) return;
    paused = false;
    try {
      instance.resume();
    } catch {}
  }

  async function stop() {
    if (!instance) return;
    const inst = instance;
    instance = null;
    try {
      if (running) await inst.stop();
    } catch {}
    try {
      inst.clear();
    } catch {}
    running = false;
    paused = false;
  }

  return {
    start,
    pause,
    resume,
    stop,
    get running() {
      return running;
    },
    /** Olvida el último código para permitir volver a escanearlo de inmediato. */
    resetDuplicateGuard() {
      lastCode = "";
      lastAt = 0;
    },
  };
}

/* ---------- Feedback: vibración y sonido ---------- */

let audioCtx = null;

/** Debe llamarse dentro de un gesto del usuario (iOS exige esto para el audio). */
export function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx ||= new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}

export function beep() {
  try {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = 1800;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.13);
  } catch {}
}

export function vibrate(ms = 60) {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}
