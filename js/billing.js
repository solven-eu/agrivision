// AgriVision RE — Stripe billing client. Trades a logged-in AgriVision session for a Stripe
// Checkout session. Default UX is **Embedded Checkout**: Stripe.js mounts the payment form
// inside our own centered modal (`openPlansModal`) — no full-page redirect. The hosted-redirect
// flow (`startCheckout`) is kept as a fallback when Stripe.js / the publishable key isn't
// available. Either way: webhook → Worker → KV updates the user's plan; on a successful payment
// Stripe redirects the top window to `?billing=success`, picked up by `handleBillingReturn`,
// which then polls /api/share/quota to surface the new tier.

import { WORKER_URL, STRIPE_PUBLISHABLE_KEY } from "./config.js";
import { PLAN_FEATURES, hasFeature } from "./plan-features.js";
import { safeSetItem } from "./storage-health.js";

// Re-exported so other modules don't need to import plan-features directly.
export { hasFeature, PLAN_FEATURES };

// Inspects an error response from /api/analyze (or any identified endpoint). Handles:
//   - AI-access gates (Free tier hitting AI / quota exceeded) → pops hamburger Plans card
//   - Stale-session 401 (`session_invalid` / `session_missing`) → clears the stale token
//     and attempts an opportunistic re-trade from the cached Dropbox id_token (cheap, no
//     user interaction). On success the user can simply re-click. On failure (no id_token,
//     etc.) prompts them to reconnect Dropbox.
// Returns true if handled (caller should bail out), false otherwise.
export function handleAiAccessError(j) {
  const e = j?.error;
  if (e === "session_invalid" || e === "session_missing") {
    localStorage.removeItem("agri_session");
    localStorage.removeItem("agri_session_exp");
    const idTok = localStorage.getItem("dbx_id_token");
    if (idTok) {
      // Async re-trade. Don't block — the user just re-clicks and the new session is
      // already in place. We surface a short notice so the click→error→retry feels
      // explained rather than mysterious.
      alert("Session AgriVision rafraîchie. Re-clique pour relancer l'action.");
      import("./share.js").then(({ tradeDropboxIdTokenForSession }) => {
        import("./config.js").then(({ DROPBOX_APP_KEY }) => {
          tradeDropboxIdTokenForSession(idTok, DROPBOX_APP_KEY).catch(() => {});
        });
      });
    } else {
      const menu = document.getElementById("app-menu-panel");
      if (menu) menu.style.display = "block";
      alert(j?.message || "Reconnecte-toi à Dropbox pour réactiver l'IA.");
    }
    return true;
  }
  if (
    e === "ai_requires_paid_plan" ||
    e === "ai_requires_signin" ||
    e === "tokens_in_quota_exceeded" ||
    e === "tokens_out_quota_exceeded"
  ) {
    const menu = document.getElementById("app-menu-panel");
    if (menu) menu.style.display = "block";
    const msg =
      j?.message ||
      (e === "tokens_in_quota_exceeded" || e === "tokens_out_quota_exceeded"
        ? "Quota de tokens IA atteint pour ce mois. Passe à un plan supérieur ou attends la prochaine période."
        : "Cette fonctionnalité requiert un plan payant.");
    alert(msg);
    return true;
  }
  return false;
}

// Catalog of buyable plans. lookup_keys must match the ones set on each Price in the
// Stripe Dashboard → Catalog → Products. The `price_display` field is a FALLBACK only —
// the actual displayed value comes from `/api/billing/prices` so we never drift from
// what Stripe will charge.
export const PLANS = [
  {
    lookup_key: "standard_monthly",
    tier: "standard",
    cadence: "monthly",
    label: "Standard mensuel",
    price_display: "(prix Stripe…)",
  },
  {
    lookup_key: "standard_yearly",
    tier: "standard",
    cadence: "yearly",
    label: "Standard annuel",
    price_display: "(prix Stripe…)",
    badge: "2 mois offerts",
  },
  {
    lookup_key: "premium_monthly",
    tier: "premium",
    cadence: "monthly",
    label: "Premium mensuel",
    price_display: "(prix Stripe…)",
  },
  {
    lookup_key: "premium_yearly",
    tier: "premium",
    cadence: "yearly",
    label: "Premium annuel",
    price_display: "(prix Stripe…)",
    badge: "2 mois offerts",
  },
];

// Live Stripe Price cache. Fetched on first plan render; cached in localStorage for
// 1 hour since Prices change rarely but we want changes to surface within a day.
const PRICE_CACHE_KEY = "stripe_prices_v1";
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
let _pricesMemo = null;

export async function fetchStripePrices() {
  if (_pricesMemo) return _pricesMemo;
  try {
    const cached = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY) || "null");
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
      _pricesMemo = cached.prices;
      return _pricesMemo;
    }
  } catch {}
  if (!WORKER_URL) return null;
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/billing/prices`);
    if (!r.ok) {
      console.warn("[billing] /api/billing/prices →", r.status);
      return null;
    }
    const j = await r.json();
    _pricesMemo = j.prices || {};
    safeSetItem(PRICE_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), prices: _pricesMemo }));
    return _pricesMemo;
  } catch (e) {
    console.warn("[billing] price fetch error:", e.message);
    return null;
  }
}

// Format a Stripe Price record into the "€XX,XX / mois" or "€XXX,XX / an" string used
// in the plans card. Falls back to a clear "—" when data is missing.
function formatStripePrice(p) {
  if (!p || p.amount_cents == null) return "—";
  const amount = (p.amount_cents / 100).toFixed(2).replace(".", ",");
  const symbol = (p.currency || "eur").toLowerCase() === "eur" ? "€" : p.currency.toUpperCase();
  const unit = p.recurring_interval === "year" ? "an" : p.recurring_interval === "month" ? "mois" : "—";
  const taxNote = p.tax_behavior === "exclusive" ? " HT" : p.tax_behavior === "inclusive" ? " TTC" : "";
  return `${symbol}${amount}${taxNote} / ${unit}`;
}

function returnUrlBase() {
  return window.location.origin + window.location.pathname;
}

function authHeader() {
  const s = localStorage.getItem("agri_session");
  return s ? { authorization: `Bearer ${s}` } : null;
}

// Start a HOSTED Stripe Checkout flow for the given lookup_key — full-page redirect to
// Stripe. Fallback path used by the embedded modal when Stripe.js / the publishable key
// isn't available. On return, ?billing=success or ?billing=cancel is appended to the URL;
// the boot-time handler picks it up.
export async function startCheckout(lookupKey) {
  if (!WORKER_URL) {
    alert("WORKER_URL non configuré — impossible d'initier le paiement.");
    return;
  }
  const auth = authHeader();
  if (!auth) {
    alert("Connecte-toi avec Dropbox avant de passer à un plan payant.");
    return;
  }
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        lookup_key: lookupKey,
        success_url: returnUrlBase() + "?billing=success&plan=" + encodeURIComponent(lookupKey),
        cancel_url: returnUrlBase() + "?billing=cancel",
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.checkout_url) {
      alert("Erreur Stripe : " + (j.error || `HTTP ${r.status}`));
      return;
    }
    window.location.href = j.checkout_url;
  } catch (e) {
    alert("Erreur réseau : " + e.message);
  }
}

// Open the Stripe Customer Portal for self-service (cancel, swap card, view invoices).
export async function openPortal() {
  if (!WORKER_URL) return;
  const auth = authHeader();
  if (!auth) return;
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/billing/portal`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ return_url: returnUrlBase() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.portal_url) {
      alert("Portail indisponible : " + (j.error || `HTTP ${r.status}`));
      return;
    }
    window.location.href = j.portal_url;
  } catch (e) {
    alert("Erreur réseau : " + e.message);
  }
}

// Handle Stripe Checkout return-URL params. Called once at boot. Strips the params
// from the URL so they don't stick around on reload.
export function handleBillingReturn(onSuccess) {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("billing");
  if (!status) return;
  if (status === "success") {
    // Webhook delivery is usually <2s but can lag; let the user see a confirmation
    // and refetch the quota after a short delay so the new tier appears in the UI.
    alert("Paiement enregistré ✓ — mise à jour de ton plan en cours.");
    setTimeout(() => onSuccess?.(), 1500);
  } else if (status === "cancel") {
    alert("Paiement annulé.");
  }
  params.delete("billing");
  params.delete("plan");
  const clean =
    window.location.pathname + (params.toString() ? "?" + params.toString() : "") + window.location.hash;
  window.history.replaceState({}, document.title, clean);
}

// ============ Embedded Checkout (Stripe.js mounted in our own modal) ============

// Lazy-load Stripe.js once and resolve the global `Stripe` constructor. Returns null if the
// script can't be loaded (offline / CSP) so callers can fall back to the hosted redirect.
let _stripeJsPromise = null;
function loadStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (_stripeJsPromise) return _stripeJsPromise;
  _stripeJsPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.async = true;
    s.onload = () => resolve(window.Stripe || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return _stripeJsPromise;
}

// Ask the Worker for an EMBEDDED Checkout session → { client_secret }. Returns null on any
// failure (the caller falls back to hosted redirect). The return_url must carry the
// {CHECKOUT_SESSION_ID} template — Stripe redirects the top window there after success.
async function createEmbeddedSession(lookupKey) {
  if (!WORKER_URL) return null;
  const auth = authHeader();
  if (!auth) {
    alert("Connecte-toi avec Dropbox avant de passer à un plan payant.");
    return null;
  }
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        lookup_key: lookupKey,
        ui_mode: "embedded",
        return_url:
          returnUrlBase() +
          "?billing=success&plan=" +
          encodeURIComponent(lookupKey) +
          "&session_id={CHECKOUT_SESSION_ID}",
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.client_secret) {
      console.warn("[billing] embedded session failed:", j.error || r.status);
      return null;
    }
    return j.client_secret;
  } catch (e) {
    console.warn("[billing] embedded session error:", e.message);
    return null;
  }
}

// ---- The plans modal: a centered overlay with two screens (plan list ↔ embedded checkout) ----
let _modalEl = null;
let _activeCheckout = null; // live Stripe EmbeddedCheckout instance (must be destroyed on close)

function destroyActiveCheckout() {
  if (_activeCheckout) {
    try {
      _activeCheckout.destroy();
    } catch {}
    _activeCheckout = null;
  }
}

function closePlansModal() {
  destroyActiveCheckout();
  _modalEl?.remove();
  _modalEl = null;
  document.removeEventListener("keydown", _onModalEsc);
}

function _onModalEsc(e) {
  if (e.key === "Escape") closePlansModal();
}

// Build (or reuse) the modal shell and return its mutable parts. Backdrop click + ✕ + Esc close.
function ensureModalShell() {
  if (_modalEl) return _modalEl._parts;
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10070;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,.55);padding:16px;overflow-y:auto";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePlansModal();
  });

  const card = document.createElement("div");
  card.style.cssText =
    "background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:12px;" +
    "width:min(460px,96vw);max-height:92vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.5)";
  card.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;" +
    "border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);z-index:1";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;font-size:15px";
  const closeBtn = document.createElement("button");
  closeBtn.className = "secondary";
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "font-size:13px;padding:4px 10px;line-height:1";
  closeBtn.onclick = closePlansModal;
  head.append(title, closeBtn);

  const body = document.createElement("div");
  body.style.cssText = "padding:14px 16px";

  card.append(head, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", _onModalEsc);

  _modalEl = overlay;
  _modalEl._parts = { title, body };
  return _modalEl._parts;
}

// Screen 1: the plan list. Reuses renderPlansCard so there's a single source of plan markup.
function showPlanListScreen(currentTier) {
  destroyActiveCheckout();
  const { title, body } = ensureModalShell();
  title.textContent = "Choisir un plan";
  body.innerHTML = `<div id="plans-modal-card"></div>`;
  renderPlansCard("plans-modal-card", currentTier);
}

// Screen 2: embedded checkout for one price. Falls back to hosted redirect if Stripe.js or the
// session can't be set up.
async function showCheckoutScreen(lookupKey, currentTier) {
  destroyActiveCheckout();
  const { title, body } = ensureModalShell();
  const plan = PLANS.find((p) => p.lookup_key === lookupKey);
  title.textContent = plan ? plan.label : "Paiement";
  body.innerHTML = `
    <button id="plans-modal-back" class="secondary" style="font-size:12px;padding:4px 10px;margin-bottom:10px">← Retour aux plans</button>
    <div id="embedded-checkout-mount" style="min-height:120px"></div>
    <div id="embedded-checkout-status" class="small" style="color:var(--muted);margin-top:8px">Chargement du paiement sécurisé…</div>`;
  body.querySelector("#plans-modal-back").onclick = () => showPlanListScreen(currentTier);
  const statusEl = body.querySelector("#embedded-checkout-status");

  const Stripe = STRIPE_PUBLISHABLE_KEY ? await loadStripeJs() : null;
  const clientSecret = Stripe ? await createEmbeddedSession(lookupKey) : null;
  if (!Stripe || !clientSecret) {
    // Embedded path unavailable → fall back to the hosted redirect so the user can still pay.
    if (statusEl) statusEl.textContent = "Redirection vers le paiement sécurisé Stripe…";
    closePlansModal();
    startCheckout(lookupKey);
    return;
  }
  try {
    const stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
    const checkout = await stripe.initEmbeddedCheckout({ clientSecret });
    // If the user closed the modal while we were awaiting, don't mount a now-orphaned instance.
    if (!_modalEl) {
      try {
        checkout.destroy();
      } catch {}
      return;
    }
    _activeCheckout = checkout;
    statusEl?.remove();
    checkout.mount("#embedded-checkout-mount");
  } catch (e) {
    console.warn("[billing] embedded mount error:", e.message);
    if (statusEl) statusEl.textContent = "Redirection vers le paiement sécurisé Stripe…";
    closePlansModal();
    startCheckout(lookupKey);
  }
}

// Public entry point: open the plans modal (used by the "Améliorer mon plan" gate toast and the
// hamburger menu). Centered + actionable, unlike the old corner dropdown.
export function openPlansModal(currentTier) {
  showPlanListScreen(currentTier || "free");
}

// Render the plans card inside the host element. Click on a plan → embedded checkout modal.
// Renders immediately with the fallback price strings, then re-renders once the
// live Stripe prices arrive (cached in localStorage so subsequent boots are instant).
export function renderPlansCard(hostId, currentTier) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const draw = (livePrices) => {
    const rows = PLANS.map((p) => {
      const isCurrent = p.tier === currentTier;
      const live = livePrices?.[p.lookup_key];
      const display = live ? formatStripePrice(live) : p.price_display;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border:1px solid var(--border);border-radius:4px;margin-top:4px;background:${isCurrent ? "rgba(74,222,128,0.08)" : "var(--panel2)"}">
          <div>
            <div style="font-weight:600">${p.label}${p.badge ? ` <span style="font-size:9px;color:var(--accent)">· ${p.badge}</span>` : ""}</div>
            <div class="small" style="color:var(--muted)">${display}</div>
          </div>
          ${
            isCurrent
              ? `<span class="small" style="color:var(--accent)">✓ actif</span>`
              : `<button class="secondary plan-buy" data-lookup="${p.lookup_key}" style="font-size:11px;padding:4px 8px">Choisir</button>`
          }
        </div>`;
    }).join("");
    host.innerHTML = `
      <div class="small" style="color:var(--muted);margin-bottom:4px">Plan actuel : <b>${currentTier || "free"}</b></div>
      ${rows}
      ${
        currentTier && currentTier !== "free"
          ? `<button id="open-portal-btn" class="secondary" style="font-size:11px;padding:4px 8px;margin-top:6px;width:100%">Gérer mon abonnement (Stripe)</button>`
          : ""
      }
      ${livePrices ? "" : `<div class="small" style="color:var(--muted);margin-top:6px;font-style:italic">Récupération des prix Stripe…</div>`}
    `;
    host.querySelectorAll(".plan-buy").forEach((b) => {
      b.addEventListener("click", () => showCheckoutScreen(b.dataset.lookup, currentTier));
    });
    document.getElementById("open-portal-btn")?.addEventListener("click", openPortal);
  };
  // First pass with whatever is in the in-memory / localStorage cache (likely null on
  // first ever open). Then async-fetch and re-render with live data.
  draw(_pricesMemo);
  fetchStripePrices().then((live) => {
    if (live) draw(live);
  });
}
