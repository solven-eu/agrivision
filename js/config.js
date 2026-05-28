// AgriVision RE — configuration constants.
// Edit local-dev values inline; production values come from build-time substitution or env (TODO).

// === Anthropic ===
// WORKER_URL set → calls the Cloudflare Worker which holds the API key server-side. RECOMMENDED.
// WORKER_URL empty → falls back to direct browser call using ANTHROPIC_API_KEY below.
//   Only safe on localhost for testing — key is exposed in the bundle.
export const WORKER_URL = "http://localhost:8787";
export const ANTHROPIC_API_KEY = ""; // only used when WORKER_URL is empty
export const ANTHROPIC_MODEL = "claude-haiku-4-5";

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
