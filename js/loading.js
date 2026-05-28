// AgriVision RE — loading overlay helpers.
// Exposed on `window.__setLoadingMsg` / `window.__hideLoading` so the persistence module
// can update / dismiss the overlay without needing a direct import (it owns its own
// in-flight progress bar via setSaveStatus etc.).

const _ovEl = () => document.getElementById("loading-overlay");
const _msgEl = () => document.getElementById("loading-msg");

export function setLoadingMsg(msg) {
  const e = _msgEl();
  if (e) e.textContent = msg;
}

export function hideLoading() {
  _ovEl()?.classList.remove("show");
}

// Install global hooks (used by persistence.js — keeps that module decoupled from this one).
export function installGlobals() {
  window.__setLoadingMsg = setLoadingMsg;
  window.__hideLoading = hideLoading;
}
