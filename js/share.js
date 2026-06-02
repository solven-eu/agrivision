// AgriVision RE — opt-in "Share with AgriVision" feature.
// Mirrors the user's Dropbox manifest + photos into Cloudflare KV so the data stays
// in sync between Dropbox (owned by the user) and the AgriVision backend (used to
// improve the model + offer features that need a real backend).
//
// Identity: the user's Dropbox access token is forwarded as Authorization: Bearer
// to the Worker. The Worker validates it against Dropbox to derive the account_id;
// it never persists the token. Stopping sharing purges everything under the user's
// prefix in KV. No analytics, no third parties.

import { WORKER_URL } from "./config.js";

const LS = {
  enabled: "share_enabled",
  uploaded: "share_uploaded_photos", // photoId -> true
  lastSync: "share_last_sync_iso",
};

// Returns a header object that authenticates the caller to our Worker. Single carrier:
// `Authorization: Bearer <agri_session>` where agri_session is our HMAC-signed JWT
// minted by /api/auth/dropbox/login. Returns `{}` when no session is available — the
// Worker then treats the call as anonymous (no quota tracking).
export function shareAttribHeaders() {
  if (localStorage.getItem(LS.enabled) !== "1") return {};
  return workerAuthHeader();
}

// Authorization header carrying the AgriVision session JWT, or {} when signed out.
// Exported so other identified features (satellite, etc.) can authenticate to the Worker.
export function workerAuthHeader() {
  const s = localStorage.getItem("agri_session");
  return s ? { authorization: `Bearer ${s}` } : {};
}

// Slide the session forward when it's < 1 day from expiring. Best-effort — failures
// are silent so a stale Worker doesn't break the user's session prematurely.
const REFRESH_SKEW_SECONDS = 24 * 3600;
export async function maybeRefreshSession() {
  const s = localStorage.getItem("agri_session");
  const exp = parseInt(localStorage.getItem("agri_session_exp") || "0", 10);
  if (!s || !exp || !WORKER_URL) return;
  const now = Math.floor(Date.now() / 1000);
  if (exp - now > REFRESH_SKEW_SECONDS) return; // still fresh enough
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/auth/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${s}` },
    });
    if (!r.ok) return;
    const j = await r.json();
    if (j.agri_session) {
      localStorage.setItem("agri_session", j.agri_session);
      if (j.exp) localStorage.setItem("agri_session_exp", String(j.exp));
    }
  } catch {}
}

// Revoke the current session server-side and clear it locally. Idempotent.
export async function logoutSession() {
  const s = localStorage.getItem("agri_session");
  if (s && WORKER_URL) {
    try {
      await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${s}` },
      });
    } catch {}
  }
  localStorage.removeItem("agri_session");
  localStorage.removeItem("agri_session_exp");
  localStorage.removeItem("agri_sub");
  window.dispatchEvent(new CustomEvent("agrivision:logout"));
}

// POST a proof (IdP id_token or access_token) to one of our /api/auth/<provider>/login
// endpoints and persist the returned AgriVision session JWT under `agri_session`.
// Shared by every identity provider. Idempotent — a fresh session simply overwrites the
// previous one (switching providers re-identifies the browser). Returns the session token
// on success, null otherwise. `window` gets an `agrivision:login` event so the login UI
// (and any listener) can re-render without polling.
async function tradeForSession(path, payload) {
  if (!WORKER_URL) return null;
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.agri_session) {
      console.warn("agri session mint failed:", j.error || r.status);
      return null;
    }
    localStorage.setItem("agri_session", j.agri_session);
    if (j.exp) localStorage.setItem("agri_session_exp", String(j.exp));
    if (j.sub) localStorage.setItem("agri_sub", j.sub);
    // Remember which provider was used — kept across logout to show a "Dernière connexion"
    // chip on that button next time (à la Cloudflare's "Last used"). Helps the user pick.
    const prov = (j.sub || "").split(":")[0];
    if (prov) localStorage.setItem("agri_last_provider", prov);
    window.dispatchEvent(new CustomEvent("agrivision:login", { detail: { sub: j.sub || null } }));
    return j.agri_session;
  } catch (e) {
    console.warn("agri session mint error:", e.message);
    return null;
  }
}

// Exchange a Dropbox id_token for an AgriVision session JWT. Called once after the
// Dropbox OAuth code exchange (from persistence.js).
export async function tradeDropboxIdTokenForSession(idToken, dropboxClientId) {
  if (!idToken) return null;
  return tradeForSession("/api/auth/dropbox/login", {
    id_token: idToken,
    client_id: dropboxClientId || null,
  });
}

// Exchange a Google id_token (the `credential` from Google Identity Services) for a session.
export async function tradeGoogleIdTokenForSession(idToken, googleClientId) {
  if (!idToken) return null;
  return tradeForSession("/api/auth/google/login", {
    id_token: idToken,
    client_id: googleClientId || null,
  });
}

// Exchange a Facebook access_token (from FB.login) for a session.
export async function tradeFacebookTokenForSession(accessToken) {
  if (!accessToken) return null;
  return tradeForSession("/api/auth/facebook/login", { access_token: accessToken });
}

// Mask an email for the storage-pointer hint: keep the first char + domain, e.g.
// "benoit@solven.eu" → "b•••@solven.eu". Done client-side so the full address never
// reaches our backend — we only ever store the masked form + the opaque account id.
export function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  const head = local.slice(0, 1) || "";
  return `${head}•••@${domain}`;
}

// Register a NON-SECRET pointer to where the user's data lives (which cloud + which
// account), keyed server-side by the signed-in identity. No token is ever sent. Best-effort.
export async function registerStoragePointer({ provider, account_id, email, root_path }) {
  if (!WORKER_URL || !account_id) return;
  const headers = { "content-type": "application/json", ...workerAuthHeader() };
  if (!headers.authorization) return; // needs an AgriVision session to attribute the pointer
  try {
    await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/storage/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider,
        account_id,
        email_masked: maskEmail(email),
        root_path: root_path || null,
      }),
    });
  } catch (e) {
    console.warn("storage pointer register failed:", e.message);
  }
}

// Fetch the storage pointer for the signed-in identity → { pointer, has_mirror } or null.
export async function fetchStoragePointer() {
  if (!WORKER_URL) return null;
  const headers = workerAuthHeader();
  if (!headers.authorization) return null;
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/storage/pointer`, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Load the AgriVision-mirrored manifest + photos for restore → { culture_id, crop_code,
// manifest, photos:[{id,mime,b64}], cultures:[] } or null.
export async function loadFromAgriVision(cultureId) {
  if (!WORKER_URL) return null;
  const headers = workerAuthHeader();
  if (!headers.authorization) return null;
  const qs = cultureId ? `?culture_id=${encodeURIComponent(cultureId)}` : "";
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/share/load${qs}`, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export function createShare(app) {
  const state = {
    enabled: localStorage.getItem(LS.enabled) === "1",
    uploaded: safeJson(localStorage.getItem(LS.uploaded)) || {},
    lastSync: localStorage.getItem(LS.lastSync) || null,
    syncing: false,
    lastError: null,
  };

  function safeJson(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  // "Has AgriVision session" predicate. Used to gate sync attempts so we don't fire
  // identified requests with no Authorization header.
  function dbxToken() {
    return localStorage.getItem("agri_session") || null;
  }

  // Bundle current data for upload. Only includes photos the client hasn't already
  // mirrored (per `state.uploaded`). Called by the post-save hook in persistence.
  async function buildPayload(manifest) {
    const newPhotos = (app.photos || []).filter((p) => !state.uploaded[p.id]);
    return {
      manifest,
      photos: newPhotos.map((p) => ({ id: p.id, mime: p.mime, b64: p.b64 })),
      photoIds: newPhotos.map((p) => p.id),
    };
  }

  async function syncNow(manifest) {
    if (!state.enabled) return;
    if (!WORKER_URL) {
      state.lastError = "WORKER_URL non configuré";
      render();
      return;
    }
    const tok = dbxToken();
    if (!tok) {
      state.lastError = "Session AgriVision manquante (reconnecter Dropbox)";
      render();
      return;
    }
    if (!manifest?.culture_id) return; // nothing meaningful to share yet
    state.syncing = true;
    state.lastError = null;
    render();
    try {
      const payload = await buildPayload(manifest);
      const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/share/save`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...workerAuthHeader(),
        },
        body: JSON.stringify({ manifest: payload.manifest, photos: payload.photos }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      for (const id of payload.photoIds) state.uploaded[id] = true;
      localStorage.setItem(LS.uploaded, JSON.stringify(state.uploaded));
      state.lastSync = new Date().toISOString();
      localStorage.setItem(LS.lastSync, state.lastSync);
      // Refresh quota in the background so the panel reflects the new consumption.
      fetchQuota();
    } catch (e) {
      state.lastError = e.message;
    } finally {
      state.syncing = false;
      render();
    }
  }

  async function enable() {
    const ok = confirm(
      "Activer le partage avec AgriVision ?\n\n" +
        "Tes parcelles, photos, analyses et conversations seront copiées sur les serveurs " +
        "AgriVision en plus de ta Dropbox, à chaque sauvegarde.\n\n" +
        "Tu peux arrêter et tout supprimer à tout moment.\n\n" +
        "Continuer ?"
    );
    if (!ok) return;
    state.enabled = true;
    localStorage.setItem(LS.enabled, "1");
    render();
    // Initial push if we already have a current culture.
    const analysis = app.getAnalysisCombined?.() || null;
    if (analysis && app.buildShareManifest) {
      const manifest = app.buildShareManifest(analysis);
      if (manifest) await syncNow(manifest);
    }
  }

  async function disable() {
    const ok = confirm(
      "Arrêter le partage et SUPPRIMER tes données sur les serveurs AgriVision ?\n\n" +
        "Ta Dropbox n'est pas touchée. Cette opération est irréversible côté AgriVision."
    );
    if (!ok) return;
    state.syncing = true;
    render();
    try {
      const tok = dbxToken();
      if (tok && WORKER_URL) {
        await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/share/account`, {
          method: "DELETE",
          headers: workerAuthHeader(),
        });
      }
    } catch (e) {
      console.warn("share delete failed:", e.message);
    }
    state.enabled = false;
    state.uploaded = {};
    state.lastSync = null;
    state.lastError = null;
    localStorage.removeItem(LS.enabled);
    localStorage.removeItem(LS.uploaded);
    localStorage.removeItem(LS.lastSync);
    state.syncing = false;
    render();
  }

  // Last-known quota snapshot from the Worker. Refreshed after each successful sync
  // and on explicit fetchQuota() (e.g. when the hamburger panel opens).
  let lastQuota = null;
  let lastLimits = null;

  async function fetchQuota() {
    if (!state.enabled) return;
    const tok = dbxToken();
    if (!tok || !WORKER_URL) return;
    try {
      const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/share/quota`, {
        headers: workerAuthHeader(),
      });
      if (!r.ok) return;
      const j = await r.json();
      lastQuota = j.quota;
      lastLimits = j.limits;
      if (j.plan?.tier) window.__lastPlanTier = j.plan.tier;
      render();
    } catch {}
  }

  function fmtBytes(n) {
    if (n == null) return "?";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function bar(pct) {
    const safe = Math.max(0, Math.min(100, pct));
    const color = safe > 90 ? "var(--bad)" : safe > 70 ? "var(--warn)" : "var(--accent)";
    return `<div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-top:2px"><div style="width:${safe}%;height:100%;background:${color}"></div></div>`;
  }

  function renderQuota() {
    if (!lastQuota || !lastLimits) return "";
    const q = lastQuota,
      l = lastLimits;
    const pctPhotos = (q.photos_count / l.max_photos) * 100;
    const pctBytes = (q.photos_bytes / l.max_total_bytes) * 100;
    const pctTokens = (q.tokens_in / l.max_tokens_in_per_period) * 100;
    return `
      <div style="margin-top:6px;padding:6px;background:var(--panel2);border-radius:4px;font-size:10px;color:var(--muted)">
        <div style="display:flex;justify-content:space-between"><span>Photos</span><span>${q.photos_count} / ${l.max_photos}</span></div>
        ${bar(pctPhotos)}
        <div style="display:flex;justify-content:space-between;margin-top:4px"><span>Stockage</span><span>${fmtBytes(q.photos_bytes)} / ${fmtBytes(l.max_total_bytes)}</span></div>
        ${bar(pctBytes)}
        <div style="display:flex;justify-content:space-between;margin-top:4px"><span>Tokens (30j)</span><span>${(q.tokens_in / 1000).toFixed(0)}k / ${(l.max_tokens_in_per_period / 1000).toFixed(0)}k</span></div>
        ${bar(pctTokens)}
        <div class="small" style="margin-top:4px;opacity:0.7">${q.writes || 0} écritures KV (PoC) · max photo ${fmtBytes(l.max_photo_bytes)}</div>
      </div>`;
  }

  function render() {
    const wrap = document.getElementById("share-panel");
    if (!wrap) return;
    const status = state.syncing
      ? "↑ Synchronisation…"
      : state.lastError
        ? `⚠ ${state.lastError}`
        : state.enabled
          ? state.lastSync
            ? `✓ Actif · ${new Date(state.lastSync).toLocaleTimeString("fr-FR")}`
            : "✓ Actif (en attente du 1er save)"
          : "Désactivé";
    const button = state.enabled
      ? `<button id="share-disable" class="secondary" style="font-size:11px;padding:4px 8px">🛑 Arrêter</button>`
      : `<button id="share-enable" class="secondary" style="font-size:11px;padding:4px 8px">🤝 Activer</button>`;
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
        <span class="small" style="color:${state.enabled ? "var(--accent)" : "var(--muted)"}">${status}</span>
        ${button}
      </div>
      <div class="small" style="color:var(--muted);margin-top:2px">Copie de tes données sur les serveurs AgriVision en plus de Dropbox.</div>
      ${state.enabled ? renderQuota() : ""}
    `;
    document.getElementById("share-enable")?.addEventListener("click", enable);
    document.getElementById("share-disable")?.addEventListener("click", disable);
  }

  return {
    enable,
    disable,
    syncNow,
    fetchQuota,
    render,
    get enabled() {
      return state.enabled;
    },
  };
}
