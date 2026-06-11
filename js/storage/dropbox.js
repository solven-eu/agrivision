// AgriVision RE — Dropbox storage driver (PKCE OAuth + App-folder file ops).
//
// Implements the common storage-driver interface consumed by persistence.js. Owns its own auth
// state (the `dbx_*` localStorage keys). Dropbox doubles as an IDENTITY provider: when no AgriVision
// session exists yet, the OpenID id_token from the token response is traded for one (storage and
// identity are otherwise decoupled — see exchangeCode).

import { DROPBOX_APP_KEY, DROPBOX_REDIRECT_URI } from "../config.js";
import { tradeDropboxIdTokenForSession, logoutSession, registerStoragePointer } from "../share.js";

const DBX_MSG = "agri:dropbox-auth";

// Scopes we request. `account_info.read` is intentionally absent (the storage pointer that needs it
// is best-effort), so users/get_current_account must NOT be called — it would 401. Re-add it here
// once enabled in the Dropbox console; registerPointer derives its behaviour from this one string.
const DBX_SCOPE = "openid email files.metadata.read files.content.read files.content.write";
const DBX_HAS_ACCOUNT_SCOPE = DBX_SCOPE.includes("account_info.read");

const LS = { token: "dbx_token", refresh: "dbx_refresh", verifier: "dbx_verifier", state: "dbx_state" };

// Dropbox OAuth round-trip back to our app. Use the configured redirect only when its origin matches
// the page (production); otherwise the callback page sits next to index.html. file:// can't be a
// Dropbox redirect → return null so the caller uses the manual code-paste fallback.
function dropboxRedirectUri() {
  if (DROPBOX_REDIRECT_URI) {
    try {
      if (new URL(DROPBOX_REDIRECT_URI).origin === location.origin) return DROPBOX_REDIRECT_URI;
    } catch {}
  }
  if (location.protocol === "http:" || location.protocol === "https:") {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "oauth-callback.html";
  }
  return null;
}

// Runs on every page load. If THIS window is the OAuth popup returning from Dropbox, the auth code is
// in the query string (?code=…) — hand it to the opener (which holds the PKCE verifier) and close.
// No-op for the normal app. Dropbox uses ?code (query); Google uses #id_token (fragment), so the two
// popup completers never collide. (The dedicated oauth-callback.html also handles this in prod.)
function maybeCompleteDropboxPopup() {
  if (!window.opener || window.opener === window) return;
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return;
  try {
    window.opener.postMessage(
      { type: DBX_MSG, code: q.get("code") || null, state: q.get("state") || null, error: q.get("error") || null },
      location.origin
    );
  } catch {}
  try {
    history.replaceState(null, "", location.pathname);
  } catch {}
  window.close();
}
maybeCompleteDropboxPopup();

// PKCE helpers
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function randomVerifier() {
  const a = new Uint8Array(64);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function challengeFor(verifier) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(hash);
}

/**
 * @param {object} deps - { onConnected?: () => void }  called after a successful (re)connect so the
 *   agnostic core can mark this provider active, re-render the panel, and schedule an initial save.
 */
export function createDropboxDriver(deps = {}) {
  const onConnected = deps.onConnected || (() => {});
  const state = {
    token: localStorage.getItem(LS.token) || null,
    refresh: localStorage.getItem(LS.refresh) || null,
  };

  function isEnabled() {
    return !!DROPBOX_APP_KEY;
  }
  function isConnected() {
    return !!state.token;
  }
  function accountLabel() {
    return null; // no email surfaced without account_info.read scope
  }

  async function startAuth() {
    const verifier = randomVerifier();
    sessionStorage.setItem(LS.verifier, verifier);
    const challenge = await challengeFor(verifier);
    const params = new URLSearchParams({
      client_id: DROPBOX_APP_KEY,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
      scope: DBX_SCOPE,
    });
    const redirectUri = dropboxRedirectUri();

    // No registered redirect for this origin (localhost / file://) → manual code-paste flow.
    if (!redirectUri) {
      window.open(`https://www.dropbox.com/oauth2/authorize?${params}`, "_blank", "noopener");
      return { manual: true };
    }

    // Seamless flow: Dropbox redirects a popup back to oauth-callback.html, which postMessages the
    // code here; we exchange it — no paste needed.
    params.set("redirect_uri", redirectUri);
    const csrf = randomVerifier();
    sessionStorage.setItem(LS.state, csrf);
    params.set("state", csrf);
    const url = `https://www.dropbox.com/oauth2/authorize?${params}`;
    const popup = window.open(url, "agri_dropbox_login", "width=560,height=720");
    if (!popup) {
      location.assign(url); // popup blocked → full-page redirect (handled by handleRedirectReturn)
      return { manual: false, redirected: true };
    }

    const code = await new Promise((resolve) => {
      function cleanup() {
        window.removeEventListener("message", onMsg);
        clearInterval(timer);
      }
      function onMsg(ev) {
        if (ev.origin !== location.origin || ev.data?.type !== DBX_MSG) return;
        cleanup();
        if (ev.data.error || ev.data.state !== csrf) return resolve(null);
        resolve(ev.data.code || null);
      }
      window.addEventListener("message", onMsg);
      const timer = setInterval(() => {
        if (popup.closed) {
          cleanup();
          resolve(null);
        }
      }, 500);
    });
    sessionStorage.removeItem(LS.state);
    if (!code) return { manual: false };
    await exchangeCode(code);
    onConnected();
    return { manual: false, done: true };
  }

  // Popup-blocked fallback: Dropbox brought the whole tab back with ?code and no opener.
  async function handleRedirectReturn() {
    if (window.opener && window.opener !== window) return;
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    if (!code) return;
    const okState = q.get("state") && q.get("state") === sessionStorage.getItem(LS.state);
    try {
      history.replaceState(null, "", location.pathname);
    } catch {}
    if (!okState) return;
    sessionStorage.removeItem(LS.state);
    try {
      await exchangeCode(code);
      onConnected();
    } catch (e) {
      console.warn("dropbox redirect exchange failed:", e.message);
    }
  }

  async function exchangeCode(code) {
    const verifier = sessionStorage.getItem(LS.verifier);
    if (!verifier) throw new Error("Code verifier introuvable (relancer la connexion).");
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: DROPBOX_APP_KEY,
      code_verifier: verifier,
    });
    const redirectUri = dropboxRedirectUri();
    if (redirectUri) body.set("redirect_uri", redirectUri);
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error_summary || JSON.stringify(j));
    state.token = j.access_token;
    state.refresh = j.refresh_token || null;
    localStorage.setItem(LS.token, state.token);
    if (state.refresh) localStorage.setItem(LS.refresh, state.refresh);
    // OpenID id_token: trade for an AgriVision session ONLY if not already signed in (Dropbox as
    // identity). If a session exists (e.g. Google login), connecting Dropbox is pure storage.
    if (j.id_token) {
      localStorage.setItem("dbx_id_token", j.id_token);
      const haveSession = !!localStorage.getItem("agri_session");
      const ready = haveSession
        ? Promise.resolve()
        : tradeDropboxIdTokenForSession(j.id_token, DROPBOX_APP_KEY);
      ready.then(() => registerPointer()).catch(() => {});
    }
    sessionStorage.removeItem(LS.verifier);
  }

  // Best-effort: record which Dropbox account holds the data (the token never leaves the browser).
  async function registerPointer() {
    if (!state.token || !DBX_HAS_ACCOUNT_SCOPE) return;
    try {
      const r = await dbxFetch("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST" });
      if (!r.ok) return;
      const acct = await r.json();
      await registerStoragePointer({
        provider: "dropbox",
        account_id: acct.account_id,
        email: acct.email || null,
        root_path: "/Apps/AgriVision",
      });
    } catch (e) {
      console.warn("dropbox pointer register failed:", e.message);
    }
  }

  async function refreshToken() {
    if (!state.refresh) return false;
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refresh,
        client_id: DROPBOX_APP_KEY,
      }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    state.token = j.access_token;
    localStorage.setItem(LS.token, state.token);
    if (j.id_token) {
      localStorage.setItem("dbx_id_token", j.id_token);
      if (!localStorage.getItem("agri_session")) {
        tradeDropboxIdTokenForSession(j.id_token, DROPBOX_APP_KEY).catch(() => {});
      }
    }
    return true;
  }

  async function dbxFetch(url, opts, retry = true) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${state.token}` },
    });
    if (res.status === 401 && retry && state.refresh) {
      const ok = await refreshToken();
      if (ok) return dbxFetch(url, opts, false);
    }
    return res;
  }

  function disconnect() {
    state.token = null;
    state.refresh = null;
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.refresh);
    localStorage.removeItem("dbx_id_token");
    // Server-side logout: revokes the JWT jti in KV; clears local agri_session keys too.
    logoutSession().catch(() => {});
  }

  async function uploadFile(path, body, mode = "overwrite") {
    const args = JSON.stringify({ path, mode, autorename: false, mute: true });
    const r = await dbxFetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": args },
      body,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Upload ${path} failed: ${r.status} ${t.slice(0, 200)}`);
    }
    return r.json();
  }

  async function downloadFile(path) {
    const r = await dbxFetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
    });
    if (!r.ok) throw new Error(`download ${path}: ${r.status}`);
    return r;
  }

  async function listSessions() {
    const r = await dbxFetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/crops", recursive: true }),
    });
    if (r.status === 409) return [];
    if (!r.ok) throw new Error("list_folder " + r.status);
    const j = await r.json();
    const cultures = [];
    for (const e of j.entries || []) {
      if (e[".tag"] !== "folder") continue;
      const parts = e.path_display.split("/").filter(Boolean); // ["crops","BAN","cultures","2026-..."]
      if (parts.length === 4 && parts[0] === "crops" && parts[2] === "cultures") {
        cultures.push({ crop: parts[1], id: parts[3], path: e.path_display });
      }
    }
    return cultures.sort((a, b) => b.id.localeCompare(a.id));
  }

  async function deleteFolder(path) {
    const r = await dbxFetch("https://api.dropboxapi.com/2/files/delete_v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`delete ${path}: ${r.status} ${t.slice(0, 150)}`);
    }
  }

  // Finish a popup-blocked full-page redirect on init (no-op in the normal case / inside the popup).
  handleRedirectReturn();

  return {
    id: "dropbox",
    label: "Dropbox",
    isEnabled,
    isConnected,
    accountLabel,
    startAuth,
    exchangeCode, // extra: used by the panel's manual code-paste box
    disconnect,
    uploadFile,
    downloadFile,
    listSessions,
    deleteFolder,
    registerPointer,
  };
}
