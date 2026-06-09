// AgriVision RE — localStorage quota guard.
//
// localStorage is bounded (~5 MB per origin in most browsers). The app fills it gradually with
// per-coordinate caches (soil, elevation, weather, vigicrues), image-URL lookups (`img:`/`inat:`),
// and the Dropbox/session tokens. When it nears the cap, further writes throw QuotaExceededError
// and prefs/caches silently fail to persist. This module surfaces a LOUD, actionable warning
// BEFORE that happens — pointing the user at a durable storage solution (Dropbox, or our KV
// mirror) so their data isn't trapped in a soon-to-overflow local store. See CLAUDE.md
// "Gating: make plan/login limits loud and actionable".

import { toast } from "./toast.js";

// Conservative soft cap. Real limits vary (Chrome/Firefox ~5 MiB, Safari ~5 MB); we warn well
// below so the user has room to act before writes actually start failing.
const SOFT_LIMIT_BYTES = 5 * 1024 * 1024;
const WARN_AT = Math.round(SOFT_LIMIT_BYTES * 0.8); // ~4.2 MB
let _warnedThisSession = false;
// localStorageBytes() reads every value (incl. the multi-MB photo mirror), so don't run it on
// every change — throttle the proactive scan. The QuotaExceededError backstop (force:true) is
// exempt and always runs.
const CHECK_THROTTLE_MS = 8000;
let _lastCheckMs = 0;

// Approximate bytes used by localStorage for this origin. Keys + values are stored as UTF-16
// (~2 bytes/char), which is the right order of magnitude for a quota estimate.
export function localStorageBytes() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k == null) continue;
    total += (k.length + (localStorage.getItem(k)?.length || 0)) * 2;
  }
  return total;
}

// Hard backstop: a drop-in for `localStorage.setItem` that degrades gracefully instead of
// throwing when the store is full. On a QuotaExceededError it surfaces the (forced) warning and
// returns false; otherwise returns true. Use for NON-critical, growth-prone writes (caches) where
// a miss is harmless — the caller can ignore a false result. Don't use it for must-persist data
// (tokens, session ids): those should fail loudly so the bug isn't masked.
export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    // QuotaExceededError — the name/code varies across browsers (DOMException 22, or 1014 /
    // NS_ERROR_DOM_QUOTA_REACHED on old Firefox). Treat any of these as "store full".
    const quota =
      e &&
      (e.name === "QuotaExceededError" ||
        e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
        e.code === 22 ||
        e.code === 1014);
    if (quota) checkStorageHealth({ force: true });
    return false;
  }
}

// Check usage and, when over the soft threshold, raise ONE actionable toast per session (de-duped
// via the toast `id`). Pass { force: true } to warn unconditionally — e.g. right after catching a
// QuotaExceededError, where the store is already full regardless of our estimate.
export function checkStorageHealth({ force = false } = {}) {
  // Already warned this session → nothing more to do unless a write actually failed (force).
  if (_warnedThisSession && !force) return 0;
  if (!force) {
    // Throttle the proactive scan so the per-change hot path stays cheap.
    const now = Date.now();
    if (now - _lastCheckMs < CHECK_THROTTLE_MS) return 0;
    _lastCheckMs = now;
  }
  let bytes = 0;
  try {
    bytes = localStorageBytes();
  } catch {
    return 0;
  }
  if (!force && bytes < WARN_AT) return bytes;
  _warnedThisSession = true;

  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const hasDropbox = !!localStorage.getItem("dbx_token");
  // Photos are the bulk of what fills the store (the local session mirror inlines their bytes), so
  // the most direct remedy is re-compressing them — offered as the toast action in both cases.
  // Connecting Dropbox is the other durable fix; for non-Dropbox users we surface it in the text.
  const message = hasDropbox
    ? `Stockage local presque plein (${mb} Mo). Réduis la qualité des photos pour libérer de l'espace (tes données restent sur Dropbox).`
    : `Stockage local presque plein (${mb} Mo). Réduis la qualité des photos, ou connecte Dropbox, pour libérer le stockage local.`;
  toast(message, {
    kind: "warn",
    id: "storage-full",
    durationMs: 12000,
    action: "Réduire la qualité",
    onAction: () => window.dispatchEvent(new CustomEvent("agrivision:compress-photos")),
  });
  return bytes;
}
