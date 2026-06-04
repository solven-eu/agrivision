// AgriVision RE — login UI (identity providers).
//
// Identity is SEPARATE from storage. Storage providers (Dropbox today, OneDrive later)
// hold the user's bytes; identity providers (Dropbox, Google, Facebook) authenticate the
// user to the AgriVision backend so we can attribute quota, billing and sharing. A user
// can sign in with Google and still connect Dropbox for storage — the two are decoupled.
//
// Anonymous discovery stays free (no login needed for trivial operations). This panel is
// the gentle gate: signing in unlocks the identified features. The actual session is an
// AgriVision-minted HMAC JWT (`agri_session`); the IdP proof is traded for it server-side
// (see worker.js /api/auth/<provider>/login and share.js trade* helpers).

import { GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI, FACEBOOK_APP_ID, DROPBOX_APP_KEY } from "./config.js";
import {
  tradeGoogleIdTokenForSession,
  tradeFacebookTokenForSession,
  logoutSession,
  fetchStoragePointer,
} from "./share.js";

// Decode (without verifying — display only) the payload of our session JWT so the panel
// can show who's connected and via which provider. Verification is the Worker's job.
function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function currentSession() {
  const tok = localStorage.getItem("agri_session");
  if (!tok) return null;
  const claims = decodeJwtPayload(tok);
  if (!claims) return null;
  return {
    sub: claims.sub || localStorage.getItem("agri_sub") || null,
    provider: claims.provider || (claims.sub || "").split(":")[0] || null,
    email: claims.email || null,
    exp: claims.exp || null,
  };
}

const PROVIDER_LABEL = {
  dropbox: "Dropbox",
  google: "Google",
  facebook: "Facebook",
};

// ---- Google OAuth 2.0 redirect flow (popup) ----------------------------------------------
// We deliberately do NOT use Google Identity Services (the one-tap / rendered button): that
// flow silently reuses the single signed-in account and cannot be forced to show the account
// chooser. Instead we open the classic OAuth 2.0 authorization endpoint in a popup with
// `prompt=select_account` and `response_type=id_token`. Google sends the popup back to our
// redirect_uri with the id_token in the URL fragment; the popup (same origin = same app)
// postMessages it to the opener and closes. No client secret, no Worker changes — the id_token
// is verified server-side exactly as before (/api/auth/google/login).
const GOOGLE_MSG = "agri:google-auth";

// The exact URI Google returns to. Use the configured production value only when its origin
// matches the page we're on; otherwise fall back to this page's own URL so localhost dev
// keeps working (register both as Authorized redirect URIs).
function googleRedirectUri() {
  if (GOOGLE_REDIRECT_URI) {
    try {
      if (new URL(GOOGLE_REDIRECT_URI).origin === location.origin) return GOOGLE_REDIRECT_URI;
    } catch {}
  }
  return location.origin + location.pathname;
}

function randomToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Runs on every page load. If THIS window is the OAuth popup coming back from Google, the URL
// fragment carries the id_token — hand it to the opener and close. No-op for the normal app.
function maybeCompleteGooglePopup() {
  if (!window.opener || window.opener === window) return;
  const frag = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!frag) return;
  const p = new URLSearchParams(frag);
  if (!p.has("id_token") && !p.has("error")) return; // not our OAuth return
  try {
    window.opener.postMessage(
      {
        type: GOOGLE_MSG,
        id_token: p.get("id_token") || null,
        state: p.get("state") || null,
        error: p.get("error") || null,
      },
      location.origin
    );
  } catch {}
  // Scrub the token out of the URL bar before the (best-effort) close.
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {}
  window.close();
}
maybeCompleteGooglePopup();

let fbSdkPromise = null;
function loadFacebookSdk(appId) {
  if (fbSdkPromise) return fbSdkPromise;
  fbSdkPromise = new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);
    window.fbAsyncInit = function () {
      window.FB.init({ appId, cookie: true, xfbml: false, version: "v19.0" });
      resolve(window.FB);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => reject(new Error("Facebook SDK failed to load"));
    document.head.appendChild(s);
  });
  return fbSdkPromise;
}

// Every element with one of these ids gets the same login UI. This lets the hamburger
// "Compte" panel and the onboarding tutorial step share one implementation — sign in from
// either and both re-render. Handlers are bound per-mount via class selectors (not ids)
// so two mounts on the page don't collide.
const MOUNT_IDS = ["auth-panel", "tuto-auth-panel"];

export function createAuth() {
  function mountEls() {
    return MOUNT_IDS.map((id) => document.getElementById(id)).filter(Boolean);
  }

  // Open Google's account chooser in a popup and wait for the id_token to come back via
  // postMessage (see maybeCompleteGooglePopup). `prompt=select_account` guarantees the chooser
  // even when a single Google account is signed in. `nonce` + `state` are minted per attempt:
  // state guards the postMessage round-trip, nonce ties the returned id_token to this request.
  async function loginWithGoogle() {
    if (!GOOGLE_CLIENT_ID) return;
    const nonce = randomToken();
    const state = randomToken();
    // Stash for the popup-blocked fallback: a full-page redirect loses the closure below, so
    // handleGoogleRedirectReturn() re-reads these on the way back in.
    sessionStorage.setItem("g_nonce", nonce);
    sessionStorage.setItem("g_state", state);
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: googleRedirectUri(),
      response_type: "id_token",
      scope: "openid email profile",
      nonce,
      state,
      prompt: "select_account",
    });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    const popup = window.open(url, "agri_google_login", "width=480,height=640,menubar=no,toolbar=no");
    if (!popup) {
      // Popup blocked — fall back to a full-page redirect (still forces select_account).
      location.assign(url);
      return;
    }

    const idToken = await new Promise((resolve) => {
      function cleanup() {
        window.removeEventListener("message", onMsg);
        clearInterval(timer);
      }
      function onMsg(ev) {
        if (ev.origin !== location.origin || ev.data?.type !== GOOGLE_MSG) return;
        cleanup();
        if (ev.data.error || ev.data.state !== state) return resolve(null);
        resolve(ev.data.id_token || null);
      }
      window.addEventListener("message", onMsg);
      // If the user closes the popup without finishing, stop waiting.
      const timer = setInterval(() => {
        if (popup.closed) {
          cleanup();
          resolve(null);
        }
      }, 500);
    });
    if (!idToken) return; // cancelled, blocked, or state mismatch
    sessionStorage.removeItem("g_state");
    await completeGoogleLogin(idToken, nonce);
  }

  // Trade a freshly returned Google id_token for an AgriVision session, after a defence-in-depth
  // nonce check. The Worker still does the real (signature + audience) verification.
  async function completeGoogleLogin(idToken, expectedNonce) {
    const claims = decodeJwtPayload(idToken);
    if (expectedNonce && claims?.nonce && claims.nonce !== expectedNonce) {
      console.warn("google: nonce mismatch, ignoring id_token");
      return;
    }
    sessionStorage.removeItem("g_nonce");
    await tradeGoogleIdTokenForSession(idToken, GOOGLE_CLIENT_ID);
    render(); // login event also fires, but re-render immediately for snappiness
  }

  // Popup-blocked fallback path: when loginWithGoogle had to do a full-page redirect, Google
  // brings the WHOLE tab back here with the id_token in the fragment and no window.opener.
  // Consume it on load. (The normal popup case is handled by maybeCompleteGooglePopup above.)
  async function handleGoogleRedirectReturn() {
    if (window.opener && window.opener !== window) return; // that's the popup, not us
    const frag = location.hash.startsWith("#") ? location.hash.slice(1) : "";
    if (!frag) return;
    const p = new URLSearchParams(frag);
    const idToken = p.get("id_token");
    if (!idToken) return;
    const ok = p.get("state") && p.get("state") === sessionStorage.getItem("g_state");
    // Scrub the token (and error/state) out of the URL bar regardless of outcome.
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {}
    if (!ok) return;
    sessionStorage.removeItem("g_state");
    await completeGoogleLogin(idToken, sessionStorage.getItem("g_nonce"));
  }

  async function loginWithFacebook() {
    if (!FACEBOOK_APP_ID) return;
    try {
      const FB = await loadFacebookSdk(FACEBOOK_APP_ID);
      // The FB SDK rejects an async function as the callback ("Expression is of type
      // asyncfunction, not function"), so the callback must be plain — it kicks off the async
      // token trade without awaiting.
      FB.login(
        (response) => {
          const token = response?.authResponse?.accessToken;
          if (!token) return; // user cancelled or not authorized
          tradeFacebookTokenForSession(token)
            .then(render)
            .catch((e) => console.warn("facebook session trade failed:", e.message));
        },
        { scope: "public_profile,email" }
      );
    } catch (e) {
      console.warn("facebook login error:", e.message);
    }
  }

  // Dropbox doubles as identity + storage. The OAuth flow lives in persistence.js; we ask
  // for it via an event so we don't depend on module init order (auth is created before DBX).
  function loginWithDropbox() {
    window.dispatchEvent(new CustomEvent("agrivision:connect-dropbox"));
  }

  async function signOut() {
    // Google sign-in already forces the account chooser every time (prompt=select_account),
    // so there's no auto-select state to clear here — just drop our session.
    await logoutSession();
    render();
  }

  function renderInto(wrap) {
    const session = currentSession();

    if (session) {
      const who = session.email || (session.sub ? session.sub.split(":")[1] : "compte");
      const prov = PROVIDER_LABEL[session.provider] || session.provider || "—";
      wrap.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
          <span class="small" style="color:var(--accent)">✓ Connecté · ${escapeHtml(who)}</span>
          <button class="auth-logout secondary" style="font-size:11px;padding:4px 8px">Se déconnecter</button>
        </div>
        <div class="small" style="color:var(--muted);margin-top:2px">via ${escapeHtml(prov)}</div>`;
      wrap.querySelector(".auth-logout")?.addEventListener("click", signOut);
      maybeRenderStorageHint(wrap);
      return;
    }

    const anyProvider = GOOGLE_CLIENT_ID || FACEBOOK_APP_ID || DROPBOX_APP_KEY;
    if (!anyProvider) {
      wrap.innerHTML = `<div class="small" style="color:var(--muted)">Connexion désactivée : configure <code>GOOGLE_CLIENT_ID</code> / <code>FACEBOOK_APP_ID</code> dans <code>config.js</code>.</div>`;
      return;
    }

    const btn = "font-size:12px;padding:7px 12px;display:flex;align-items:center;gap:8px;justify-content:center;width:240px;border-radius:6px;cursor:pointer";
    // "Last used" chip (à la Cloudflare) — shown next to the provider the user signed in with
    // last time, kept across logout to make re-login a one-glance choice.
    const lastProvider = localStorage.getItem("agri_last_provider");
    const chip = (p) =>
      p === lastProvider
        ? `<span title="Dernière méthode utilisée" style="font-size:9px;padding:2px 7px;border-radius:10px;background:var(--accent);color:#fff;white-space:nowrap">Dernière fois</span>`
        : "";
    const row = (inner, p) =>
      `<div style="display:flex;align-items:center;gap:6px">${inner}${chip(p)}</div>`;
    wrap.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
        ${
          GOOGLE_CLIENT_ID
            ? row(
                `<button class="auth-google secondary" style="${btn};background:#fff;color:#3c4043;border:1px solid #dadce0">
                 <span style="font-weight:700;color:#4285F4">G</span> Continuer avec Google
               </button>`,
                "google"
              )
            : ""
        }
        ${
          FACEBOOK_APP_ID
            ? row(
                `<button class="auth-facebook" style="${btn};background:#1877F2;color:#fff;border:none">
                 <span style="font-weight:700;font-size:15px">f</span> Continuer avec Facebook
               </button>`,
                "facebook"
              )
            : ""
        }
        ${
          DROPBOX_APP_KEY
            ? row(
                `<button class="auth-dropbox secondary" style="${btn}">
                 <span style="font-weight:700;color:#0061FF">▼</span> Continuer avec Dropbox
               </button>`,
                "dropbox"
              )
            : ""
        }
      </div>`;
    wrap.querySelector(".auth-google")?.addEventListener("click", loginWithGoogle);
    wrap.querySelector(".auth-facebook")?.addEventListener("click", loginWithFacebook);
    wrap.querySelector(".auth-dropbox")?.addEventListener("click", loginWithDropbox);
  }

  // When signed in but this device has no local storage connection (no dbx_token), tell the
  // user WHERE their data lives and offer to reconnect that cloud or restore from the
  // AgriVision backup. The pointer is non-secret; restore pulls inline photo bytes.
  async function maybeRenderStorageHint(wrap) {
    if (localStorage.getItem("dbx_token")) return; // storage already connected here
    const info = await fetchStoragePointer();
    if (!info) return;
    const dbx = info.pointer?.providers?.dropbox;
    if (!dbx && !info.has_mirror) return;
    const where = dbx?.email_masked
      ? `Dropbox (${dbx.email_masked})`
      : dbx
        ? "Dropbox"
        : null;
    const hint = document.createElement("div");
    hint.style.cssText =
      "margin-top:8px;padding:8px;background:var(--panel2);border-radius:6px;font-size:11px;line-height:1.5";
    hint.innerHTML = `
      ${where ? `<div style="color:var(--muted)">📦 Tes données sont sauvegardées dans <strong>${escapeHtml(where)}</strong>.</div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        ${dbx ? `<button class="hint-reconnect secondary" style="font-size:11px;padding:4px 8px">↻ Reconnecter Dropbox</button>` : ""}
        ${info.has_mirror ? `<button class="hint-restore secondary" style="font-size:11px;padding:4px 8px">⤓ Restaurer depuis AgriVision</button>` : ""}
      </div>`;
    wrap.appendChild(hint);
    hint
      .querySelector(".hint-reconnect")
      ?.addEventListener("click", () =>
        window.dispatchEvent(new CustomEvent("agrivision:connect-dropbox"))
      );
    hint.querySelector(".hint-restore")?.addEventListener("click", async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = "Restauration…";
      try {
        await window.DBX?.restoreFromAgriVision?.();
      } finally {
        render();
      }
    });
  }

  function render() {
    mountEls().forEach(renderInto);
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  // Keep every mount in sync when login/logout happens from anywhere (e.g. Dropbox connect
  // also mints a session, or a session is traded in another tab listener).
  window.addEventListener("agrivision:login", render);
  window.addEventListener("agrivision:logout", render);

  // If we landed here from a popup-blocked full-page Google redirect, finish the login.
  handleGoogleRedirectReturn();

  return { render, signOut, isLoggedIn: () => !!currentSession() };
}
