// AgriVision RE — shared plan-features config.
// Single source of truth for what each plan unlocks. Imported BOTH by:
//   - the Worker (`worker/worker.js`) — to enforce server-side
//   - the SPA (`js/billing.js`, `js/analyze.js`, …) — to render UI affordances + hide
//     features the user's plan doesn't include
//
// The Worker is the trust boundary: client-side checks are informational only. The
// /api/features Worker route returns this object verbatim so an external tool / a
// support reading the live config doesn't need to read the bundle.

export const PLAN_FEATURES = {
  free: {
    label: "Free",
    parcels: { max_count: 1 }, // Free is intentionally tight: discovery / single-field trial.
    photos: {
      max_count: 5,
      max_photo_bytes: 1.5 * 1024 * 1024,
      max_total_bytes: 50 * 1024 * 1024,
    },
    ai: {
      enabled: false,
      max_tokens_in_per_period: 0,
      max_tokens_out_per_period: 0,
      models_allowed: [],
    },
    map: { rpg: true, cadastre: true, geolocation: true },
    diseases: { enabled: false }, // disease funnel requires AI
    market_data: { enabled: false }, // market gen call requires AI
    ensemble_ai: { enabled: false }, // parallel 2-3 providers, cross-check
    debate_ai: { enabled: false }, // sequential AIs critiquing each other
    share_to_kv: { enabled: true }, // photos + manifests can still be mirrored to KV
    events_feed: { enabled: true }, // open-meteo + RSS feeds are free
    support: "community",
  },
  standard: {
    label: "Standard",
    parcels: { max_count: 10 },
    photos: {
      max_count: 50,
      max_photo_bytes: 2 * 1024 * 1024,
      max_total_bytes: 250 * 1024 * 1024,
    },
    ai: {
      enabled: true,
      max_tokens_in_per_period: 100_000,
      max_tokens_out_per_period: 20_000,
      models_allowed: ["claude-haiku-4-5", "pixtral-12b-2409", "mistral-small-latest"],
    },
    map: { rpg: true, cadastre: true, geolocation: true },
    diseases: { enabled: true },
    market_data: { enabled: true },
    ensemble_ai: { enabled: true }, // ✓ parallel cross-check on Standard+
    debate_ai: { enabled: false }, // ✗ debate is Premium-only
    share_to_kv: { enabled: true },
    events_feed: { enabled: true },
    support: "email",
  },
  premium: {
    label: "Premium",
    parcels: { max_count: 100 },
    photos: {
      max_count: 500,
      max_photo_bytes: 5 * 1024 * 1024,
      max_total_bytes: 1500 * 1024 * 1024,
    },
    ai: {
      enabled: true,
      max_tokens_in_per_period: 1_000_000,
      max_tokens_out_per_period: 200_000,
      models_allowed: [
        "claude-haiku-4-5",
        "claude-sonnet-4-5",
        "pixtral-12b-2409",
        "pixtral-large-latest",
        "mistral-small-latest",
        "mistral-large-latest",
      ],
    },
    map: { rpg: true, cadastre: true, geolocation: true },
    diseases: { enabled: true },
    market_data: { enabled: true },
    ensemble_ai: { enabled: true },
    debate_ai: { enabled: true }, // ✓ Premium-only — 2 AIs critiquing each other
    share_to_kv: { enabled: true },
    events_feed: { enabled: true },
    support: "priority",
  },
};

// Derive quotas in the shape the Worker / shareSave already use.
export function quotasForPlan(plan) {
  const p = PLAN_FEATURES[plan] || PLAN_FEATURES.free;
  return {
    max_photos: p.photos.max_count,
    max_photo_bytes: p.photos.max_photo_bytes,
    max_total_bytes: p.photos.max_total_bytes,
    period_days: 30,
    max_tokens_in_per_period: p.ai.max_tokens_in_per_period,
    max_tokens_out_per_period: p.ai.max_tokens_out_per_period,
  };
}

// Check whether `featurePath` (dot-separated) is enabled for `plan`.
// Examples: hasFeature("standard", "ai.enabled") → true
//           hasFeature("free", "diseases.enabled") → false
//           hasFeature("standard", "debate_ai.enabled") → false
export function hasFeature(plan, featurePath) {
  const p = PLAN_FEATURES[plan] || PLAN_FEATURES.free;
  return featurePath.split(".").reduce((acc, k) => (acc != null ? acc[k] : null), p) === true;
}

// List the plans that unlock the given feature path. Useful for UI upsell messaging:
// "Cette fonctionnalité est disponible en " + plansWithFeature("debate_ai.enabled").join(", ")
export function plansWithFeature(featurePath) {
  return Object.keys(PLAN_FEATURES).filter((p) => hasFeature(p, featurePath));
}
