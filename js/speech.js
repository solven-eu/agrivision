// AgriVision RE — voice input via the browser Web Speech API.
//
// WIP — v0 scope:
//   • Tap mic → SpeechRecognition starts in FR-FR (chosen via dialect dropdown later)
//   • Records up to 5 s OR until the final result event fires
//   • Interim results stream into the chat-text input as you speak
//   • On final result: auto-submits the chat turn
//   • Tap mic again to cancel mid-recording
//
// Browser support: Chrome / Edge / Safari iOS+macOS. Firefox: no SpeechRecognition → button hidden.
// Privacy: the browser may transparently send audio to a cloud STT (Google for Chrome,
// Apple for Safari). No audio leaves AgriVision directly. Plan a fully-local STT later
// (whisper.cpp via WASM, ~30 MB model) for offline / privacy-strict users.

const MAX_RECORDING_MS = 5000;

/**
 * @param {object} opts
 * @param {HTMLInputElement} opts.input - target #chat-text input field
 * @param {HTMLButtonElement} opts.button - the mic button (shows recording state)
 * @param {() => string} opts.getLang - returns BCP-47 lang tag ("fr-FR" by default)
 * @param {(text: string) => void} opts.onSubmit - called with the final transcript
 * @param {(text: string) => void} [opts.onInterim] - called with each interim transcript
 * @param {(msg: string) => void} [opts.onStatus] - status text updates ("Écoute…", "Erreur : …")
 * @returns {{ start, stop, toggle, supported: boolean }}
 */
export function createSpeech({ input, button, getLang, onSubmit, onInterim, onStatus }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (button) button.style.display = "none";
    return { supported: false, start: () => {}, stop: () => {}, toggle: () => {} };
  }

  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let recording = false;
  let stopTimer = null;
  let lastTranscript = "";

  function setUiRecording(on) {
    if (!button) return;
    button.classList.toggle("recording", on);
    button.textContent = on ? "⏺" : "🎤";
    button.title = on ? "Arrêter l'enregistrement" : "Dicter (5 s max)";
  }

  function start() {
    if (recording) return;
    rec.lang = (getLang?.() || "fr") === "fr" ? "fr-FR" : getLang();
    lastTranscript = "";
    try {
      rec.start();
    } catch (e) {
      // Often "InvalidStateError" if a previous instance hasn't fully released.
      onStatus?.("Erreur micro : " + e.message);
      return;
    }
    recording = true;
    setUiRecording(true);
    onStatus?.("🎤 Écoute… (5 s max)");
    stopTimer = setTimeout(stop, MAX_RECORDING_MS);
  }

  function stop() {
    if (!recording) return;
    recording = false;
    clearTimeout(stopTimer);
    stopTimer = null;
    try {
      rec.stop();
    } catch {}
    setUiRecording(false);
    onStatus?.("");
  }

  function toggle() {
    recording ? stop() : start();
  }

  rec.onresult = (e) => {
    let interim = "";
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    const text = (final || interim).trim();
    lastTranscript = text;
    if (input) input.value = text;
    if (interim) onInterim?.(interim);
    if (final) {
      stop();
      if (text) onSubmit?.(text);
    }
  };

  rec.onerror = (e) => {
    console.warn("[speech] error:", e.error);
    onStatus?.(`Erreur micro : ${e.error}`);
    stop();
  };

  rec.onend = () => {
    if (recording) {
      // The engine ended without a final result — submit whatever we have if non-empty.
      stop();
      if (lastTranscript) onSubmit?.(lastTranscript);
    }
  };

  return { start, stop, toggle, supported: true };
}
