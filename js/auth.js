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

import { GOOGLE_CLIENT_ID, FACEBOOK_APP_ID, DROPBOX_APP_KEY } from "./config.js";
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

// ---- Lazy SDK loaders (only fetched when the panel actually needs them) ----
let googleSdkPromise = null;
function loadGoogleSdk() {
  if (googleSdkPromise) return googleSdkPromise;
  googleSdkPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => reject(new Error("Google SDK failed to load"));
    document.head.appendChild(s);
  });
  return googleSdkPromise;
}

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

  async function onGoogleCredential(response) {
    const idToken = response?.credential;
    if (!idToken) return;
    await tradeGoogleIdTokenForSession(idToken, GOOGLE_CLIENT_ID);
    render(); // login event also fires, but re-render immediately for snappiness
  }

  // Render the official Google button into a container. GIS needs a visible container with
  // a real width, so we (re)mount on every render — including when the tutorial page that
  // holds the container becomes visible.
  async function mountGoogleButton(container) {
    if (!GOOGLE_CLIENT_ID || !container) return;
    try {
      const google = await loadGoogleSdk();
      google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential });
      container.innerHTML = "";
      google.accounts.id.renderButton(container, {
        theme: "outline",
        size: "large",
        text: "signin_with",
        width: 240,
      });
    } catch (e) {
      container.textContent = "Google indisponible";
    }
  }

  async function loginWithFacebook() {
    if (!FACEBOOK_APP_ID) return;
    try {
      const FB = await loadFacebookSdk(FACEBOOK_APP_ID);
      FB.login(
        async (response) => {
          const token = response?.authResponse?.accessToken;
          if (!token) return; // user cancelled or not authorized
          await tradeFacebookTokenForSession(token);
          render();
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
    // Best-effort: also clear the Google one-tap auto-select so the next sign-in is explicit.
    try {
      window.google?.accounts?.id?.disableAutoSelect?.();
    } catch {}
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
        ${GOOGLE_CLIENT_ID ? row(`<div class="google-signin-btn"></div>`, "google") : ""}
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
    wrap.querySelector(".auth-facebook")?.addEventListener("click", loginWithFacebook);
    wrap.querySelector(".auth-dropbox")?.addEventListener("click", loginWithDropbox);
    mountGoogleButton(wrap.querySelector(".google-signin-btn"));
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

  return { render, signOut, isLoggedIn: () => !!currentSession() };
}
