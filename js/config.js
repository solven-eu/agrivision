// AgriVision RE — configuration constants.
// Edit local-dev values inline; production values come from build-time substitution or env (TODO).

// === Anthropic ===
// WORKER_URL set → calls the Cloudflare Worker which holds the API key server-side. RECOMMENDED.
// WORKER_URL empty → falls back to direct browser call using ANTHROPIC_API_KEY below.
//   Only safe on localhost for testing — key is exposed in the bundle.
//
// Environment-aware: localhost dev hits the local `wrangler dev` Worker; everywhere else (the
// deployed app over HTTPS) MUST hit the deployed Worker — an HTTPS page cannot call http://localhost
// (mixed content → "Failed to fetch"). Set WORKER_URL_PROD to your deployed Worker URL, printed by
// `cd worker && npx wrangler deploy` (e.g. https://agrivision-api.<your-subdomain>.workers.dev),
// or a custom route/domain if you add one.
const WORKER_URL_DEV = "http://localhost:8787";
const WORKER_URL_PROD = "https://agrivision-api.benoit-ef0.workers.dev";
const _isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname);
export const WORKER_URL = _isLocalhost ? WORKER_URL_DEV : WORKER_URL_PROD;
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
// Hosted https URL Dropbox redirects back to after authorization. MUST be registered verbatim
// under the app's OAuth 2 → "Redirect URIs". Used only when its origin matches the page's
// origin (production); on any other origin (localhost/file://) the app falls back to the manual
// code-paste flow. Register both this and any dev URL you use.
//   Console: https://www.dropbox.com/developers/apps/info/rimf9kjv2vhki4j → OAuth 2 → Redirect URIs
export const DROPBOX_REDIRECT_URI = "https://www.solven.eu/agrivision/";

// === Social identity providers (login only — no storage) ===
// These authenticate the user to the AgriVision backend (quota, billing, sharing).
// They are SEPARATE from storage providers (Dropbox today, OneDrive later). A user can
// sign in with Google/Facebook and independently connect Dropbox for storage.
//
// Google: create an OAuth 2.0 Client ID (type "Web application") at
//   https://console.cloud.google.com/apis/credentials
//   - Authorized JavaScript origins: every origin the app is served from, e.g.
//       https://solven.eu            (the origin — NO path, NO trailing slash)
//       http://localhost:8000        (your dev port)
//   - Authorized redirect URIs: the exact page the OAuth popup returns to, e.g.
//       https://solven.eu/agrivision/   (must match GOOGLE_REDIRECT_URI below, incl. trailing slash)
//       http://localhost:8000/          (or whatever index.html is served at in dev)
//   - The same Client ID must be set on the Worker as GOOGLE_CLIENT_ID to pin the token audience.
// We use the OAuth 2.0 redirect flow (response_type=id_token) with prompt=select_account so the
// user always gets the account chooser — the older Google Identity Services button auto-picked
// the single signed-in account and could not be forced to ask.
// Leave empty to hide the "Sign in with Google" button.
// This client's settings:
//   https://console.cloud.google.com/auth/clients/634422093981-od2rmhdjqaiof1uhb3glj6oi0e6lrkcu.apps.googleusercontent.com?project=agrivision-498206
export const GOOGLE_CLIENT_ID =
  "634422093981-od2rmhdjqaiof1uhb3glj6oi0e6lrkcu.apps.googleusercontent.com";
// Where Google sends the OAuth popup back. MUST be registered verbatim as an Authorized
// redirect URI on the client above. Used only when its origin matches the page's origin
// (i.e. in production on solven.eu); on any other origin (localhost dev) the app falls back
// to this page's own URL — so register BOTH this and your dev URL as redirect URIs.
export const GOOGLE_REDIRECT_URI = "https://www.solven.eu/agrivision/";

// Facebook: create an app at https://developers.facebook.com/apps (product: Facebook Login).
//   - Add your origin under "Allowed Domains for the JavaScript SDK".
//   - Set the App Secret on the Worker as FACEBOOK_APP_SECRET, and FACEBOOK_APP_ID in its env.
// Leave empty to hide the "Continue with Facebook" button.
// This app's settings (App ID + App Secret live here):
//   https://developers.facebook.com/apps/26899197766369996/settings/basic/
export const FACEBOOK_APP_ID = "26899197766369996";

// === Web Push (rain alerts) ===
// VAPID public key (applicationServerKey). The matching private key is the Worker secret
// VAPID_PRIVATE_KEY. Regenerate the pair with `node` (EC prime256v1) if rotating.
// Empty → the rain-alert subscribe UI is hidden.
export const VAPID_PUBLIC_KEY = "BM8aw9vXzVz3Zz2vHzwBYIE-DtzaI8rXXE-D3qKkARciYdeJHYANsD35fnapqNSlXHNG4npu7_Wv6qcxItF7Jj4";

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
