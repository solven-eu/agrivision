// AgriVision RE — Stripe billing client. Trades a logged-in AgriVision session for
// a Stripe Checkout URL; redirects the user to Stripe-hosted Checkout for the actual
// payment flow. Webhook → Worker → KV updates the user's plan; the client just polls
// /api/share/quota afterwards to see the new tier.

import { WORKER_URL } from "./config.js";
import { PLAN_FEATURES, hasFeature } from "./plan-features.js";

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
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), prices: _pricesMemo }));
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

// Start a Stripe Checkout flow for the given lookup_key. Redirects the page to Stripe
// (no popup — Stripe Checkout uses full-page redirect). On return, ?billing=success
// or ?billing=cancel is appended to the URL; the boot-time handler picks it up.
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

// Render the plans card inside the host element. Click on a plan → startCheckout.
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
      b.addEventListener("click", () => startCheckout(b.dataset.lookup));
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
