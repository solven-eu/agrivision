// AgriVision RE — rain alerts via Web Push.
//
// Opt-in: the user activates push, we store their push subscription + parcel coordinates
// server-side (KV) so a scheduled Worker can poll the forecast and notify them BEFORE rain
// hits a parcel — even when the app is closed. Capability + platform restrictions are shown
// up-front when they try to activate (notably iOS: the PWA must be installed to the Home
// Screen, iOS 16.4+). A "test" button sends a real server push to confirm it works.

import { WORKER_URL, VAPID_PUBLIC_KEY } from "./config.js";
import { workerAuthHeader } from "./share.js";
import { cropMeta } from "./catalog.js";

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Returns { ok } or { ok:false, reason } describing why push can't work here.
function capability() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return { ok: false, reason: "Ton navigateur ne supporte pas les notifications push." };
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  if (isIOS && !standalone)
    return {
      ok: false,
      reason:
        "Sur iPhone/iPad : ajoute d'abord AgriVision à l'écran d'accueil (Partager → « Sur l'écran d'accueil »), puis ouvre-la depuis son icône. Les notifications push nécessitent iOS 16.4+.",
    };
  if (Notification.permission === "denied")
    return {
      ok: false,
      reason: "Notifications bloquées — réactive-les dans les réglages du navigateur pour ce site.",
    };
  return { ok: true };
}

export function createAlerts(app) {
  const state = {
    subscribed: localStorage.getItem("rain_alerts") === "1",
    busy: false,
    error: null,
    info: null,
  };
  const base = () => (WORKER_URL || "").replace(/\/$/, "");
  const authed = () => !!workerAuthHeader().authorization;

  function parcelsPayload() {
    const parcels = app.getSelectedParcels?.() || new Map();
    const out = [];
    for (const p of parcels.values()) {
      if (!p.latlng) continue;
      const label = cropMeta(p.props?.code_cultu)?.fr || p.props?.code_cultu || "Parcelle";
      out.push({ lat: p.latlng[0], lon: p.latlng[1], label });
    }
    return out;
  }

  async function subscribe() {
    const cap = capability();
    if (!cap.ok) {
      state.error = cap.reason;
      render();
      return;
    }
    if (!authed()) {
      state.error = "Connecte-toi pour activer les alertes.";
      render();
      return;
    }
    if (!VAPID_PUBLIC_KEY) {
      state.error = "Push non configuré (VAPID_PUBLIC_KEY manquant).";
      render();
      return;
    }
    const parcels = parcelsPayload();
    if (!parcels.length) {
      state.error = "Sélectionne au moins une parcelle à surveiller.";
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Permission refusée.");
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub)
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      const r = await fetch(`${base()}/api/alerts/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json", ...workerAuthHeader() },
        body: JSON.stringify({ subscription: sub.toJSON(), parcels, threshold_mm: 2 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      state.subscribed = true;
      localStorage.setItem("rain_alerts", "1");
      state.info = `Alertes actives sur ${j.parcels} parcelle(s). Seuil : ≥ 2 mm/jour.`;
    } catch (e) {
      state.error = e.message;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function unsubscribe() {
    state.busy = true;
    render();
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe().catch(() => {});
      await fetch(`${base()}/api/alerts/unsubscribe`, { method: "POST", headers: workerAuthHeader() }).catch(() => {});
      state.subscribed = false;
      localStorage.removeItem("rain_alerts");
      state.info = "Alertes désactivées.";
      state.error = null;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function test() {
    if (!authed()) {
      state.error = "Connecte-toi d'abord.";
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const r = await fetch(`${base()}/api/alerts/test`, {
        method: "POST",
        headers: { "content-type": "application/json", ...workerAuthHeader() },
        body: JSON.stringify({ subscription: sub?.toJSON() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.detail || `HTTP ${r.status}`);
      state.info = "Notif de test envoyée — verrouille ton écran, elle arrive dans quelques secondes.";
    } catch (e) {
      state.error = e.message;
    } finally {
      state.busy = false;
      render();
    }
  }

  function render() {
    const wrap = document.getElementById("alerts-panel");
    if (!wrap) return;
    const cap = capability();

    const intro = `<div class="small" style="color:var(--muted);margin-bottom:6px">Reçois une notification <strong>avant la pluie</strong> sur tes parcelles, même app fermée.</div>`;

    // Restriction banner — always shown when the platform can't do push, so the user knows why.
    const restriction = !cap.ok
      ? `<div class="small" style="background:var(--panel2);border:1px solid var(--warn);border-radius:6px;padding:8px;margin-bottom:6px;color:var(--text)">⚠ ${cap.reason}</div>`
      : "";

    let controls;
    if (state.subscribed) {
      controls = `
        <div class="small" style="color:var(--accent);margin-bottom:6px">✓ Alertes pluie actives (seuil ≥ 2 mm/jour)</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button id="alerts-test" class="secondary" style="font-size:11px;padding:5px 10px"${state.busy ? " disabled" : ""}>🔔 Envoyer une notif de test</button>
          <button id="alerts-resub" class="secondary" style="font-size:11px;padding:5px 10px"${state.busy ? " disabled" : ""}>↻ Mettre à jour les parcelles</button>
          <button id="alerts-off" class="secondary" style="font-size:11px;padding:5px 10px"${state.busy ? " disabled" : ""}>Désactiver</button>
        </div>`;
    } else {
      controls = `<button id="alerts-on" class="secondary" style="font-size:11px;padding:5px 10px"${state.busy || !cap.ok ? " disabled" : ""}>${state.busy ? "…" : "🔔 Activer les alertes pluie"}</button>`;
    }

    wrap.innerHTML = `
      ${intro}
      ${restriction}
      ${controls}
      ${state.info ? `<div class="small" style="color:var(--accent);margin-top:6px">${state.info}</div>` : ""}
      ${state.error ? `<div class="small" style="color:var(--bad);margin-top:6px">⚠ ${state.error}</div>` : ""}`;

    document.getElementById("alerts-on")?.addEventListener("click", subscribe);
    document.getElementById("alerts-resub")?.addEventListener("click", subscribe);
    document.getElementById("alerts-test")?.addEventListener("click", test);
    document.getElementById("alerts-off")?.addEventListener("click", unsubscribe);
  }

  return { render };
}
