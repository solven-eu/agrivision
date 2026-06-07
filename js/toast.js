// AgriVision RE — lightweight toasts + the central "gate" listener.
//
// Design rule (see CLAUDE.md "Gating: make plan/login limits loud and actionable"): a feature a
// user can't use because of their plan (cap/quota/tier) or because they're not logged in must
// fail LOUDLY and ACTIONABLY. The enforcement boundary (a client cap check, or the Worker
// returning a structured quota/plan error) dispatches `agrivision:plan-blocked`; this module
// turns it into a toast with a one-tap fix — "Améliorer mon plan" or "Se connecter".

let toastHost = null;
function host() {
  if (toastHost) return toastHost;
  toastHost = document.createElement("div");
  toastHost.id = "toast-host";
  toastHost.style.cssText =
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10060;display:flex;" +
    "flex-direction:column;gap:8px;align-items:center;max-width:92vw;pointer-events:none";
  document.body.appendChild(toastHost);
  return toastHost;
}

// Show a toast. opts: { action, onAction, durationMs=6000, kind: "info"|"warn", id }.
// Returns a dismiss() fn. Passing `id` de-dupes — a second toast with the same id replaces the
// first instead of stacking (so spamming a blocked action shows one toast, not ten).
export function toast(message, opts = {}) {
  const { action, onAction, durationMs = 6000, kind = "info", id } = opts;
  if (id) document.getElementById(`toast-${id}`)?.remove();

  const el = document.createElement("div");
  if (id) el.id = `toast-${id}`;
  el.style.cssText =
    "pointer-events:auto;background:var(--panel);color:var(--text);border:1px solid var(--border);" +
    `border-left:3px solid ${kind === "warn" ? "var(--accent)" : "var(--border)"};border-radius:8px;` +
    "padding:10px 14px;display:flex;align-items:center;gap:12px;font-size:13px;line-height:1.4;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.4)";

  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.remove();
  };

  if (action && onAction) {
    const btn = document.createElement("button");
    btn.textContent = action;
    btn.style.cssText = "font-size:12px;padding:6px 12px;white-space:nowrap";
    btn.onclick = () => {
      dismiss();
      onAction();
    };
    el.appendChild(btn);
  }

  const x = document.createElement("button");
  x.textContent = "✕";
  x.className = "secondary";
  x.style.cssText = "font-size:12px;padding:4px 8px;line-height:1";
  x.onclick = dismiss;
  el.appendChild(x);

  host().appendChild(el);
  if (durationMs) timer = setTimeout(dismiss, durationMs);
  return dismiss;
}

// Mount once. Translates gate events into actionable toasts. The toast's action just dispatches
// another event (`agrivision:open-plans` / `agrivision:open-login`) so this module stays free of
// any app-specific DOM knowledge — main.js owns those panels.
export function installGateToasts() {
  window.addEventListener("agrivision:plan-blocked", (e) => {
    const d = e.detail || {};
    if (d.requiresLogin) {
      toast(d.message || "Connecte-toi pour utiliser cette fonctionnalité.", {
        kind: "warn",
        id: d.feature || "login",
        action: "Se connecter",
        onAction: () => window.dispatchEvent(new CustomEvent("agrivision:open-login")),
      });
    } else {
      toast(d.message || "Cette fonctionnalité nécessite un plan supérieur.", {
        kind: "warn",
        id: d.feature || "plan",
        action: "Améliorer mon plan",
        onAction: () => window.dispatchEvent(new CustomEvent("agrivision:open-plans")),
      });
    }
  });
}
