// AgriVision RE — provider-agnostic AI client.
// Single `ask(provider, payload)` entry point. The payload is always Anthropic-shaped
// (system + messages with type=image/text blocks); the Worker translates upstream.
// Response is also always Anthropic-shaped (`{ content: [{text}], usage: { input_tokens,
// output_tokens } }`) regardless of which provider answered.

import { WORKER_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, MISTRAL_MODEL } from "./config.js";
import { shareAttribHeaders } from "./share.js";

export const PROVIDERS = {
  anthropic: { label: "Claude", defaultModel: ANTHROPIC_MODEL, route: "/api/analyze" },
  mistral: { label: "Mistral", defaultModel: MISTRAL_MODEL, route: "/api/mistral" },
};

/**
 * Generic ask. `payload` is the Anthropic-shaped body
 * `{ model?, max_tokens, system, messages, ... }`.
 * Returns the parsed Worker response (already normalized to Anthropic shape).
 */
export async function ask(providerId, payload) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error("unknown provider: " + providerId);
  const useWorker = !!WORKER_URL;
  // Mistral has no direct-call fallback in this PoC — it always goes through the Worker
  // because Mistral's CORS doesn't allow browser calls.
  if (!useWorker && providerId === "mistral") {
    throw new Error("Mistral requires WORKER_URL configured.");
  }
  const url = useWorker
    ? `${WORKER_URL.replace(/\/$/, "")}${provider.route}`
    : "https://api.anthropic.com/v1/messages";
  const headers = useWorker
    ? { "content-type": "application/json", "anthropic-version": "2023-06-01", ...shareAttribHeaders() }
    : {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      };
  const body = { ...payload, model: payload.model || provider.defaultModel };
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}
