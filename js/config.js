// AgriVision RE — configuration constants.
// Edit local-dev values inline; production values come from build-time substitution or env (TODO).

// === Anthropic ===
// WORKER_URL set → calls the Cloudflare Worker which holds the API key server-side. RECOMMENDED.
// WORKER_URL empty → falls back to direct browser call using ANTHROPIC_API_KEY below.
//   Only safe on localhost for testing — key is exposed in the bundle.
export const WORKER_URL = "http://localhost:8787";
export const ANTHROPIC_API_KEY = ""; // only used when WORKER_URL is empty
export const ANTHROPIC_MODEL = "claude-haiku-4-5";

// === Mistral (second AI provider, optional) ===
// When set, the Worker exposes /api/mistral and we can call Mistral side-by-side with
// Anthropic for cross-validation. Vision models in the Pixtral family:
//   - pixtral-12b-2409       — small, very cheap, fine for photo tagging
//   - pixtral-large-latest   — high capability, comparable to Sonnet, ~3× the price
// Secret: `wrangler secret put MISTRAL_API_KEY` on the Worker.
export const MISTRAL_MODEL = "pixtral-12b-2409";

// === Dropbox ===
// Register an app at https://www.dropbox.com/developers/apps:
//   - Scoped access → App folder
//   - Permissions: files.content.write + files.content.read
//   - Copy the App key here (no client secret needed, PKCE flow).
// This app's settings: https://www.dropbox.com/developers/apps/info/rimf9kjv2vhki4j
export const DROPBOX_APP_KEY = "rimf9kjv2vhki4j";
// Optional: set to a hosted https URL once you deploy. If empty, the app uses
// the manual code-paste flow (works from file:// and any hosting).
export const DROPBOX_REDIRECT_URI = "";

// === Social identity providers (login only — no storage) ===
// These authenticate the user to the AgriVision backend (quota, billing, sharing).
// They are SEPARATE from storage providers (Dropbox today, OneDrive later). A user can
// sign in with Google/Facebook and independently connect Dropbox for storage.
//
// Google: create an OAuth 2.0 Client ID (type "Web application") at
//   https://console.cloud.google.com/apis/credentials
//   - Authorized JavaScript origins: your hosting origin (+ http://localhost:<port> for dev)
//   - The same value must be set on the Worker as GOOGLE_CLIENT_ID to pin the token audience.
// Leave empty to hide the "Sign in with Google" button.
// This client's settings:
//   https://console.cloud.google.com/auth/clients/634422093981-od2rmhdjqaiof1uhb3glj6oi0e6lrkcu.apps.googleusercontent.com?project=agrivision-498206
export const GOOGLE_CLIENT_ID =
  "634422093981-od2rmhdjqaiof1uhb3glj6oi0e6lrkcu.apps.googleusercontent.com";

// Facebook: create an app at https://developers.facebook.com/apps (product: Facebook Login).
//   - Add your origin under "Allowed Domains for the JavaScript SDK".
//   - Set the App Secret on the Worker as FACEBOOK_APP_SECRET, and FACEBOOK_APP_ID in its env.
// Leave empty to hide the "Continue with Facebook" button.
// This app's settings (App ID + App Secret live here):
//   https://developers.facebook.com/apps/26899197766369996/settings/basic/
export const FACEBOOK_APP_ID = "26899197766369996";

// === Stripe (billing) ===
// Dashboard (test mode): https://dashboard.stripe.com/acct_1TcLMIJAQgzNO5f0/test/dashboard
// Products / prices:     https://dashboard.stripe.com/acct_1TcLMIJAQgzNO5f0/test/products
// Webhooks:              https://dashboard.stripe.com/acct_1TcLMIJAQgzNO5f0/test/webhooks
// API keys:              https://dashboard.stripe.com/acct_1TcLMIJAQgzNO5f0/test/apikeys
//
// Test mode publishable key — only initiates Checkout sessions, cannot charge or refund.
// Safe to commit. Live key (`pk_live_...`) replaces this only once we go to production.
// Secret key (`sk_test_...` / `sk_live_...`) is set on the Worker via
//   `wrangler secret put STRIPE_TEST_SECRET_KEY`
// and never appears in client code.
export const STRIPE_PUBLISHABLE_KEY =
  "pk_test_51TcLMIJAQgzNO5f0YAzplVxzGGfSdIkysFc9MRzdYR6xQVMEyrb2GYG8TofJ9WeNvMNp2BPn7CNrJ0ijWP7cvD9e00iRlNe7zg";
// Stripe Product Prices — two tiers (Standard, Premium) × two cadences (monthly, yearly).
// Set either:
//   - the raw price IDs (price_1...) — fastest path, but you must update them when test/live swap
//   - the lookup_keys (e.g. "standard_monthly") — the Worker resolves to the live price ID at
//     Checkout time. Strongly preferred for prod. Set the lookup_key on the Price in the
//     Stripe Dashboard (Catalog → Products → Price → ... → "Edit price details").
// Leave the IDs blank and use lookup_keys: pass the lookup_key from client → Worker, Worker
// resolves via Stripe API. Less to keep in sync.
export const STRIPE_PRICES = {
  standard_monthly: { price_id: "", lookup_key: "standard_monthly" },
  standard_yearly: { price_id: "", lookup_key: "standard_yearly" },
  premium_monthly: { price_id: "", lookup_key: "premium_monthly" },
  premium_yearly: { price_id: "", lookup_key: "premium_yearly" },
};

// === IGN Geoplateforme + BAN ===
export const IGN_WMS = "https://data.geopf.fr/wms-r/wms";
export const IGN_WFS = "https://data.geopf.fr/wfs/ows";
export const RPG_LAYER = "IGNF_RPG_PARCELLES-AGRICOLES-CATEGORISEES_2024";
export const RPG_WFS_TYPE =
  "IGNF_RPG_PARCELLES-AGRICOLES-CATEGORISEES_2024:parcelles_agricole_categorisees_2024";
export const CADASTRE_LAYER = "CADASTRALPARCELS.PARCELLAIRE_EXPRESS";
export const BAN = "https://api-adresse.data.gouv.fr/search/";

// === Map ===
export const DEFAULT_VIEW = [-21.115, 55.536]; // La Réunion fallback

// === RPG 2024 categorized layer ===
export const RPG_CATEGORIES = {
  TA: "Terres arables",
  PP: "Prairies permanentes",
  CP: "Cultures permanentes (vignes/vergers)",
};
