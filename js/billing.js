// AgriVision RE — Stripe billing client. Trades a logged-in AgriVision session for
// a Stripe Checkout URL; redirects the user to Stripe-hosted Checkout for the actual
// payment flow. Webhook → Worker → KV updates the user's plan; the client just polls
// /api/share/quota afterwards to see the new tier.

import { WORKER_URL } from "./config.js";
import { PLAN_FEATURES, hasFeature } from "./plan-features.js";

// Re-exported so other modules don't need to import plan-features directly.
export { hasFeature, PLAN_FEATURES };

// Inspects an error response from /api/analyze. If it's an AI-access gate (Free tier
// trying to use AI, or anonymous / quota exceeded), pops the hamburger to surface the
// Plans card and alerts the user with the localized message. Returns true if handled,
// false if the caller should still raise.
export function handleAiAccessError(j) {
  const e = j?.error;
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

// Catalog of buyable plans. lookup_keys must match the ones set on each Price in
// Stripe Dashboard → Catalog → Products. Pricing here is *display-only* — Stripe
// charges whatever the Price record says, not what the client claims.
export const PLANS = [
  {
    lookup_key: "standard_monthly",
    tier: "standard",
    cadence: "monthly",
    label: "Standard mensuel",
    price_display: "€4,99 / mois",
  },
  {
    lookup_key: "standard_yearly",
    tier: "standard",
    cadence: "yearly",
    label: "Standard annuel",
    price_display: "€49,90 / an",
    badge: "2 mois offerts",
  },
  {
    lookup_key: "premium_monthly",
    tier: "premium",
    cadence: "monthly",
    label: "Premium mensuel",
    price_display: "€14,99 / mois",
  },
  {
    lookup_key: "premium_yearly",
    tier: "premium",
    cadence: "yearly",
    label: "Premium annuel",
    price_display: "€149,90 / an",
    badge: "2 mois offerts",
  },
];

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
export function renderPlansCard(hostId, currentTier) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const rows = PLANS.map((p) => {
    const isCurrent = p.tier === currentTier;
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border:1px solid var(--border);border-radius:4px;margin-top:4px;background:${isCurrent ? "rgba(74,222,128,0.08)" : "var(--panel2)"}">
        <div>
          <div style="font-weight:600">${p.label}${p.badge ? ` <span style="font-size:9px;color:var(--accent)">· ${p.badge}</span>` : ""}</div>
          <div class="small" style="color:var(--muted)">${p.price_display}</div>
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
  `;
  host.querySelectorAll(".plan-buy").forEach((b) => {
    b.addEventListener("click", () => startCheckout(b.dataset.lookup));
  });
  document.getElementById("open-portal-btn")?.addEventListener("click", openPortal);
}
