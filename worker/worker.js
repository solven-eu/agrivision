// AgriVision Cloudflare Worker — proxies Anthropic so the API key stays server-side.
//
// Cloudflare dashboard:
//   https://dash.cloudflare.com/ef022c9a994ccb0772ab8b3b43f25ffe/workers/services/view/agrivision-api/production
// Stripe dashboard (test mode):
//   https://dashboard.stripe.com/acct_1TcLMIJAQgzNO5f0/test/dashboard
// Stripe products / prices:
//   https://dashboard.stripe.com/acct_1TcLMIJAQgzNO5f0/test/products
// Stripe webhooks:
//   https://dashboard.stripe.com/acct_1TcLMIJAQgzNO5f0/test/webhooks
//
// Routes:
//   OPTIONS *                       → CORS preflight
//   POST    /api/analyze            → forward to Anthropic (optional Bearer for quota tracking)
//   POST    /api/mistral            → forward to Mistral AI (same payload shape, normalized)
//   GET     /api/features           → PLAN_FEATURES catalog (public, informational)
//   GET     /api/soil               → nearest N soil samples + medians (public)
//   POST    /api/feedback           → store user feedback in KV (optional Bearer for sub)
//   POST    /api/auth/dropbox/login → verify Dropbox id_token, mint AgriVision session JWT
//   POST    /api/auth/google/login  → verify Google id_token, mint AgriVision session JWT
//   POST    /api/auth/facebook/login→ verify FB access_token (Graph debug_token), mint session
//   POST    /api/auth/refresh        → rotate the session JWT (revokes the presented one)
//   POST    /api/auth/logout         → revoke the presented session JWT server-side
//   GET     /api/share/quota        → current user's quota (Bearer required)
//   GET     /api/share/load          → read back mirrored manifest + photos (Bearer required)
//   POST    /api/storage/register    → record non-secret storage pointer (Bearer required)
//   GET     /api/storage/pointer     → fetch storage pointer for the identity (Bearer required)
//   POST    /api/satellite/catalog   → Sentinel-2 acquisitions over bbox (Bearer required)
//   POST    /api/satellite/image     → NDVI/true-color PNG for bbox+day (Bearer required)
//   POST    /api/satellite/statistics→ per-geometry NDVI mean time series (Bearer required)
//   GET     /api/weather             → MF observed rain + Open-Meteo forecast/soil (Bearer req.)
//   POST    /api/alerts/subscribe    → store push subscription + parcels for rain alerts
//   POST    /api/alerts/unsubscribe  → remove rain-alert subscription
//   POST    /api/alerts/test         → send a test Web Push to confirm delivery
//   (cron `scheduled`)               → poll forecasts, push when rain ≥ threshold is coming
//   GET     /api/share/status       → last sync info (Bearer required)
//   POST    /api/share/save         → mirror manifest + photos into KV (Bearer required)
//   DELETE  /api/share/account      → purge user's data from KV (Bearer required)
//   POST    /api/billing/checkout    → create Stripe Checkout Session (Bearer required)
//   POST    /api/billing/portal      → create Stripe Customer Portal session (Bearer required)
//   POST    /api/billing/webhook     → Stripe events → update user plan in KV
//   GET     /api/billing/prices      → live Stripe Prices by lookup_key (public)
//   GET     /api/events-feed        → fetch + normalize an allowlisted RSS/HTML feed
//   GET     /api/vigicrues-stations → scrape Vigicrues Réunion station catalog
//
// Secrets:
//   ANTHROPIC_API_KEY       (set via: wrangler secret put ANTHROPIC_API_KEY)
//   MISTRAL_API_KEY         (set via: wrangler secret put MISTRAL_API_KEY) — optional;
//                            /api/mistral returns 503 when absent.
//   AGRI_JWT_SECRET         (set via: wrangler secret put AGRI_JWT_SECRET) — HMAC key
//                            for our session JWT. Generate: openssl rand -hex 32.
//   STRIPE_SECRET_KEY       (set via: wrangler secret put STRIPE_SECRET_KEY)
//   STRIPE_WEBHOOK_SECRET   (set via: wrangler secret put STRIPE_WEBHOOK_SECRET)
//   FACEBOOK_APP_SECRET     (set via: wrangler secret put FACEBOOK_APP_SECRET) — our app's
//                            secret, used to verify FB access_tokens. Not a user secret.
//   CDSE_CLIENT_ID          (set via: wrangler secret put CDSE_CLIENT_ID) — Copernicus Data
//                            Space OAuth client id for Sentinel-2 imagery.
//   CDSE_CLIENT_SECRET      (set via: wrangler secret put CDSE_CLIENT_SECRET) — its secret.
//   METEOFRANCE_APPLICATION_ID (set via: wrangler secret put METEOFRANCE_APPLICATION_ID) —
//                            base64(consumerKey:consumerSecret) for Météo-France. Manage app
//                            + subscriptions: https://portail-api.meteofrance.fr/web/fr/dashboard
//
// Optional environment:
//   ALLOWED_ORIGIN          (defaults to "*"; set to your hosting origin to lock it down)
//   GOOGLE_CLIENT_ID        (pins the accepted `aud` on Google id_tokens; recommended in prod)
//   FACEBOOK_APP_ID         (our Facebook app id; required for /api/auth/facebook/login)
//   CDSE_BASE               (defaults to CDSE Sentinel Hub; set to services.sentinel-hub.com
//                            for a commercial Sentinel Hub account)

const ALLOWED_HEADERS = "content-type,anthropic-version,authorization";
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB cap (several large images + context)

// AgriVision session JWT config. We mint an opaque-to-clients HS256 JWT signed with
// AGRI_JWT_SECRET (set via `wrangler secret put AGRI_JWT_SECRET`). The SPA presents it
// as Authorization: Bearer on every identified endpoint. See ROADMAP "First-party auth (BFF)".
const AGRI_JWT_AUD = "agrivision";
const AGRI_JWT_ISS = "agrivision";
const AGRI_JWT_TTL_SECONDS = 7 * 24 * 3600; // 7 days

// OpenID Connect identity providers. Each entry is a pure-OIDC IdP whose id_token is a
// signed JWT we verify against the provider's JWKS (RS256). `sub` becomes namespaced as
// `<provider>:<idp_sub>`. Facebook is NOT here — its web login returns an access_token,
// not an OIDC id_token, so it's verified out-of-band via the Graph debug_token endpoint
// (see verifyFacebookAccessToken). See ROADMAP "First-party auth (BFF)".
const OIDC_PROVIDERS = {
  dropbox: {
    discovery: "https://www.dropbox.com/.well-known/openid-configuration",
    // Issuers we accept on the id_token. Dropbox has used both at different times.
    acceptedIssuers: ["https://www.dropbox.com", "https://api.dropboxapi.com"],
  },
  google: {
    discovery: "https://accounts.google.com/.well-known/openid-configuration",
    // Google mints the id_token with either form of the issuer.
    acceptedIssuers: ["https://accounts.google.com", "accounts.google.com"],
  },
};

// Copernicus Data Space Ecosystem (CDSE) — free Sentinel Hub-compatible APIs for Sentinel-2
// imagery. OAuth2 client-credentials (our credentials, server-side only). Override the base
// via env CDSE_BASE to point at commercial Sentinel Hub (services.sentinel-hub.com) instead.
// Dashboard (register the OAuth client → CDSE_CLIENT_ID / CDSE_CLIENT_SECRET, monitor quota):
//   https://shapps.dataspace.copernicus.eu/dashboard/
const CDSE = {
  token: "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
  base: "https://sh.dataspace.copernicus.eu",
  collection: "sentinel-2-l2a",
};
// In-isolate token cache (client-credentials token, ~10 min TTL). Persists across requests
// within a warm isolate; a cold isolate just re-mints. We never store it durably.
let _cdseToken = { value: null, exp: 0 };

// Per-tier quotas & feature flags are imported from the SHARED config that the SPA also
// reads. Single source of truth — the Worker is the trust boundary that enforces, the SPA
// uses the same values purely to render UI affordances. See `js/plan-features.js`.
import { PLAN_FEATURES, quotasForPlan as quotasForTier, hasFeature } from "../js/plan-features.js";

// Soil dataset — preprocessed from the Nature Sci Data 2026 soil_run.csv.
// 22.7k samples across Réunion, columns indexed by `SOIL_DATA.fields`. See
// `scripts/build-soil-data.js` for the preprocessing pipeline.
// Wrangler/esbuild handles JSON imports natively — no `with { type: "json" }` attribute
// needed (which would break older wrangler < 3.78). Bundled JSON adds ~1.9 MB raw /
// ~600 KB compressed to the Worker script, within the Free-tier 1 MB compressed cap.
import SOIL_DATA from "./data/soil-reunion.json";

// Map a Price `lookup_key` to a (tier, cadence) pair. The lookup_key is the canonical
// link between Stripe Prices and our internal tier model — rename freely in Stripe as long
// as the prefix matches.
function tierFromLookupKey(lookupKey) {
  if (!lookupKey) return null;
  if (lookupKey.startsWith("standard_")) return "standard";
  if (lookupKey.startsWith("premium_")) return "premium";
  return null;
}

// Events feed allowlist. Adding a source = one line here. URLs that turn out to be wrong
// will return empty arrays (the client tolerates that). Each parser must return objects
// shaped like { id, title, link, date (ISO), severity? }.
const EVENTS_FEEDS = {
  "vigicrues-reunion": {
    // HTML bulletin from the Réunion flood-watch service. No RSS, so we scrape.
    // 3h cache TTL — bulletins update a few times per day at most.
    url: "https://www.vigicrues-reunion.re/bulletin.php",
    cacheTtl: 3 * 3600,
    parser: parseVigicruesReunion,
  },
  "meteofrance-vigilance-reunion": {
    // Météo-France Vigilance accessible page — same data as the main map, in plain HTML
    // designed for screen readers (much easier to parse than the JS-heavy main view).
    // Covers cyclone, vent fort, fortes pluies/orages, mer dangereuse, houle, etc.
    // 30 min cache TTL — vigilance bulletins update several times per day, more during
    // active events.
    url: "https://vigilance.meteofrance.fr/fr/la-reunion/vigilance-accessible",
    cacheTtl: 1800,
    parser: parseMeteoFranceVigilance,
  },
  "promed-plant": {
    // Global feed — filter for plant-related items in the parser. ProMED doesn't expose
    // a stable category-only feed; the post URL pattern is the closest we have.
    url: "https://promedmail.org/feed/",
    parser: (xml) =>
      parseRss(xml).filter((it) =>
        /plant|crop|fungi|virus|blight|wilt|rust|mildew|mosaic|leaf|fruit/i.test(
          it.title + " " + (it.summary || "")
        )
      ),
  },
  "cmrs-reunion": {
    // Météo-France Réunion cyclone bulletin RSS. If the URL drifts the proxy returns [].
    url: "https://meteofrance.re/rss/cyclone",
  },
  "eppo-reporting": {
    // EPPO Reporting Service RSS. URL pending confirmation — left disabled in the client
    // catalog until validated, but the route works if pointed at the right URL.
    url: "https://gd.eppo.int/reporting/rss",
  },
  "rnm-prices": {
    // RNM FranceAgriMer doesn't publish a plain RSS for daily cours. Leave disabled.
    url: "https://www.rnm.franceagrimer.fr/rss",
  },
};

// Minimal RSS 2.0 / Atom parser — string-only, no DOM. Good enough for these feeds.
function parseRss(xml) {
  const items = [];
  // RSS <item> blocks
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    items.push({
      id: tag(block, "guid") || tag(block, "link") || tag(block, "title"),
      title: stripTags(tag(block, "title") || ""),
      link: tag(block, "link") || null,
      date: normalizeDate(tag(block, "pubDate") || tag(block, "dc:date")),
      summary: stripTags(tag(block, "description") || ""),
    });
  }
  if (items.length) return items;
  // Atom <entry> blocks
  const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[0];
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i);
    items.push({
      id: tag(block, "id") || (linkMatch && linkMatch[1]) || tag(block, "title"),
      title: stripTags(tag(block, "title") || ""),
      link: linkMatch ? linkMatch[1] : null,
      date: normalizeDate(tag(block, "updated") || tag(block, "published")),
      summary: stripTags(tag(block, "summary") || tag(block, "content") || ""),
    });
  }
  return items;
}
function tag(block, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}
function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Vigicrues Réunion stations catalog scraper. Parses the donnees.php navigation menu
// (NORD / EST / SUD / OUEST + rivers + station links) and returns a hierarchical catalog.
// Best-effort regex extraction: the page is server-rendered HTML with stable URL patterns
// (`donnees.php?id=<code>`); if the menu HTML drifts, we still return the flat list of
// stations under an "Inconnu" region rather than crashing.
function parseVigicruesStations(html) {
  // Step 1: pull every (id, label) station link.
  const linkRe = /<a[^>]+href="(?:[^"]*?)donnees\.php\?id=([A-Za-z0-9_-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const allStations = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const id = m[1];
    const name = stripTags(m[2]).trim();
    if (!name) continue;
    // Capture the surrounding 1500 chars so we can later infer region + river context.
    const start = Math.max(0, m.index - 1500);
    const ctx = stripTags(html.slice(start, m.index + m[0].length));
    allStations.push({ id, name, ctx });
  }
  if (allStations.length === 0) return [];

  // Step 2: per station, find the closest preceding region word and river label.
  const regionWords = ["NORD", "EST", "SUD", "OUEST"];
  const riverRe =
    /(rivi[èe]re\s+(?:des\s+|d[eu']\s+)?[A-ZÀ-ÿ][\wÀ-ÿ'\-\s]{1,40}|ravine\s+(?:des\s+|de\s+|du\s+|d[eu']\s+)?[A-ZÀ-ÿ][\wÀ-ÿ'\-\s]{1,40}|bras\s+(?:de\s+|du\s+|des\s+|d[eu']\s+)?[A-ZÀ-ÿ][\wÀ-ÿ'\-\s]{1,40})/gi;
  const byRegion = {};
  for (const s of allStations) {
    let region = "Inconnu";
    let lastIdx = -1;
    for (const w of regionWords) {
      const re = new RegExp(`\\b${w}\\b`, "g");
      let r;
      while ((r = re.exec(s.ctx)) !== null) {
        if (r.index > lastIdx) {
          lastIdx = r.index;
          region = w;
        }
      }
    }
    // River = last matched basin name before the station link in the context window.
    let river = "(autre)";
    let rm;
    riverRe.lastIndex = 0;
    while ((rm = riverRe.exec(s.ctx)) !== null) {
      river = rm[1].replace(/\s+/g, " ").trim();
    }
    (byRegion[region] ||= {})[river] = byRegion[region][river] || [];
    if (!byRegion[region][river].some((x) => x.id === s.id)) {
      byRegion[region][river].push({ id: s.id, name: s.name });
    }
  }

  return Object.entries(byRegion).map(([name, rivers]) => ({
    name,
    rivers: Object.entries(rivers).map(([rname, stations]) => ({ name: rname, stations })),
  }));
}

// Météo-France Vigilance — accessible page parser. The page lists phenomena
// (cyclone, vent fort, fortes pluies/orages, mer dangereuse, houle dangereuse, etc.)
// each annotated with a vigilance color (vert / jaune / orange / rouge). The accessible
// version is plain HTML with predictable patterns like "<Phénomène> : vigilance <color>"
// or "Phénomène : niveau <color>". We emit one event per non-green phenomenon plus an
// umbrella status item.
function parseMeteoFranceVigilance(html, feed) {
  const text = stripTags(html);
  const items = [];
  // Validity window — typical wording: "valable de XX:XX à YY:YY" or "valide jusqu'au DD/MM/YYYY".
  let validityDate = null;
  const dateMatch =
    text.match(/(\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}[hH:]\d{2})?)/) ||
    text.match(/(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/);
  if (dateMatch) {
    const parts = dateMatch[1].split("/");
    if (parts.length === 3) {
      const dmy = `${parts[2].slice(0, 4)}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
      const rest = dateMatch[1].split(/\s+/)[1];
      const iso = rest ? `${dmy}T${rest.replace(/[hH]/, ":")}:00` : `${dmy}T00:00:00`;
      const d = new Date(iso);
      if (!isNaN(d.getTime())) validityDate = d.toISOString();
    } else {
      const d = new Date(dateMatch[1]);
      if (!isNaN(d.getTime())) validityDate = d.toISOString();
    }
  }

  // NOTE: do NOT compute overall severity from a raw text scan of the page — the legend
  // and explainer sections ("comprendre les niveaux : vert, jaune, orange, rouge") would
  // false-trigger "high" even on calm days. We derive topSev below from the actual
  // emitted phenomenon items instead.
  let topSev = null;

  // Per-phenomenon extraction is intentionally NOT done here: heuristic regexes were
  // over-matching legend text ("Niveaux de vigilance : Vert, Jaune, Orange, Rouge")
  // and emitting phantom "Vent fort en orange" items on calm days. Without a stable
  // structured marker on the page (data-attribute, headline class, JSON-LD), we can't
  // distinguish current alerts from explainer text. We emit only the umbrella item
  // with severity=low + the source link, letting the user check the bulletin themselves.
  // When MF publishes a structured feed (or we find a reliable parse target), re-enable
  // the per-phenomenon path and have `topSev` promoted by it.

  // Umbrella status item — always shown so the user can reach the bulletin even on calm days.
  // Its severity reflects what we ACTUALLY found, not what the page text superficially
  // mentions. No phenomenon-with-non-green-color found → calm.
  items.unshift({
    id: `mf-vigilance-bulletin-${validityDate || "current"}`,
    title:
      topSev === "high"
        ? "Vigilance Météo-France — niveau élevé sur au moins un phénomène"
        : topSev === "med"
          ? "Vigilance Météo-France — phénomènes en jaune"
          : "Vigilance Météo-France Réunion (calme)",
    link: feed.url,
    date: validityDate,
    severity: topSev || "low",
    summary: "Bulletin officiel de vigilance météorologique pour La Réunion",
  });
  return items;
}

// Vigicrues Réunion bulletin scraper. The page lists each watched river with a vigilance
// color (vert / jaune / orange / rouge). We emit one item per non-green watershed plus an
// overall bulletin link. Resilient to layout drift: we look for the color words anchored
// near a section heading, and fall back to a single "bulletin disponible" item if nothing
// structured can be parsed.
function parseVigicruesReunion(html, feed) {
  const text = stripTags(html);
  const lower = text.toLowerCase();
  const items = [];
  // Look for a publication date — common French formats.
  let bulletinDate = null;
  const dateMatch =
    text.match(/(\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}[:hH]\d{2})?)/) ||
    text.match(/(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/);
  if (dateMatch) {
    const parts = dateMatch[1].split("/");
    if (parts.length === 3) {
      // DD/MM/YYYY (HH:MM optional)
      const dmy = `${parts[2].slice(0, 4)}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
      const rest = dateMatch[1].split(/\s+/)[1];
      const iso = rest ? `${dmy}T${rest.replace(/[hH]/, ":")}:00` : `${dmy}T00:00:00`;
      const d = new Date(iso);
      if (!isNaN(d.getTime())) bulletinDate = d.toISOString();
    } else {
      const d = new Date(dateMatch[1]);
      if (!isNaN(d.getTime())) bulletinDate = d.toISOString();
    }
  }

  // Severity is derived from emitted per-basin items below, NOT from a raw page-text
  // scan — the legend/explainer text ("Niveaux : vert, jaune, orange, rouge") would
  // otherwise false-trigger "high" on calm days.
  let topSev = null;

  // Try to extract per-river entries: a heading-like token (basin name) followed within
  // ~80 chars by a color word. Common Réunion watersheds — heuristic, not exhaustive.
  const basinRe =
    /(rivi[èe]re\s+(?:des\s+)?\w[\w'\s\-]*?|ravine\s+\w[\w'\s\-]*?|bras\s+\w[\w'\s\-]*?)[\s\S]{0,120}?\b(vert|jaune|orange|rouge)\b/gi;
  const seen = new Set();
  let m;
  while ((m = basinRe.exec(text)) !== null) {
    const name = m[1].replace(/\s+/g, " ").trim();
    const color = m[2].toLowerCase();
    const key = name.toLowerCase() + "|" + color;
    if (seen.has(key)) continue;
    seen.add(key);
    if (color === "vert") continue; // only emit non-trivial alerts
    const sev = color === "rouge" ? "high" : color === "orange" ? "high" : "med";
    if (sev === "high" || topSev !== "high") topSev = sev; // promote, never demote
    items.push({
      id: `vigicrues-${name}-${color}`,
      title: `${name} — vigilance ${color}`,
      link: feed.url,
      date: bulletinDate,
      severity: sev,
      summary: `Vigicrues Réunion : niveau ${color}`,
    });
  }

  // Always include a top-level "bulletin du jour" item so the user can jump to the page
  // even when nothing is flagged. Severity reflects the most concerning watershed.
  items.unshift({
    id: `vigicrues-bulletin-${bulletinDate || "current"}`,
    title:
      topSev === "high"
        ? "Vigilance crues — niveau élevé sur au moins un bassin"
        : topSev === "med"
          ? "Vigilance crues — bassins en jaune"
          : "Bulletin Vigicrues Réunion (calme)",
    link: feed.url,
    date: bulletinDate,
    severity: topSev || "low",
    summary: "Bulletin officiel de surveillance des crues à La Réunion",
  });
  return items;
}

const corsHeaders = (origin) => ({
  "access-control-allow-origin": origin || "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": ALLOWED_HEADERS,
  "access-control-expose-headers":
    "request-id,retry-after,anthropic-ratelimit-requests-limit,anthropic-ratelimit-requests-remaining,anthropic-ratelimit-requests-reset,anthropic-ratelimit-input-tokens-limit,anthropic-ratelimit-input-tokens-remaining,anthropic-ratelimit-input-tokens-reset,anthropic-ratelimit-output-tokens-limit,anthropic-ratelimit-output-tokens-remaining,anthropic-ratelimit-output-tokens-reset,anthropic-ratelimit-tokens-limit,anthropic-ratelimit-tokens-remaining,anthropic-ratelimit-tokens-reset",
  "access-control-max-age": "86400",
  vary: "Origin",
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // POST /api/auth/refresh — slide the session forward. Returns a new JWT with the
    // same `sub` + extras; the OLD jti is added to the revocation set so the previous
    // token can't be reused (defense against accidental token leakage across rotations).
    if (url.pathname === "/api/auth/refresh" && req.method === "POST") {
      if (!env.AGRI_JWT_SECRET) return json({ error: "AGRI_JWT_SECRET not configured" }, 503, origin);
      const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const claims = await verifyAgriSession(env, bearer);
      if (!claims) return json({ error: "session_invalid", message: "Session invalide" }, 401, origin);
      // Revoke the current jti (best-effort — non-fatal if SHARE_KV isn't bound).
      if (claims.jti && env.SHARE_KV) {
        const ttl = Math.max(60, (claims.exp || 0) - Math.floor(Date.now() / 1000));
        await env.SHARE_KV.put(`revoked/${claims.jti}`, "1", { expirationTtl: ttl }).catch(() => {});
      }
      const session = await mintAgriSession(env, claims.sub, {
        provider: claims.provider || null,
        email: claims.email || null,
      });
      return json({ agri_session: session.token, exp: session.exp, sub: claims.sub }, 200, origin);
    }

    // POST /api/auth/logout — invalidate the presented session JWT server-side. The
    // jti is added to `revoked/<jti>` in KV with TTL = remaining session lifetime so
    // the entry self-deletes when the JWT would have expired anyway.
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const claims = await verifyAgriSession(env, bearer);
      // Logout is idempotent — if the token is already invalid we still return ok.
      if (!claims || !claims.jti || !env.SHARE_KV) return json({ ok: true }, 200, origin);
      const ttl = Math.max(60, (claims.exp || 0) - Math.floor(Date.now() / 1000));
      await env.SHARE_KV.put(`revoked/${claims.jti}`, "1", { expirationTtl: ttl });
      return json({ ok: true, revoked: claims.jti }, 200, origin);
    }

    // POST /api/feedback — accept a user-submitted feedback message and store it in KV.
    // No auth required (anonymous feedback is valid). When a session bearer is present,
    // we attach the sub for correlation. Light rate-limiting by IP via CF cf.colo is left
    // for v2; PoC tolerates a few abuse messages.
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      return feedbackSubmit(req, env, origin);
    }

    // GET /api/soil?lat=&lon=&n=5 — returns the N nearest soil samples + aggregated medians.
    // Public, no auth. Brute-force nearest-neighbour over 22.7k samples (~5ms on a Worker).
    if (url.pathname === "/api/soil" && req.method === "GET") {
      return soilNearby(req, env, origin);
    }

    // GET /api/features — public, no auth. Returns the PLAN_FEATURES catalog so external
    // tools (or a debug build) can read the live config without bundling the same constants.
    // The Worker is the authoritative trust boundary; this endpoint is informational.
    if (url.pathname === "/api/features" && req.method === "GET") {
      return json({ plans: PLAN_FEATURES }, 200, origin);
    }

    // ----- Mistral AI (second provider) -----
    // POST /api/mistral — accepts the same payload shape as /api/analyze (Anthropic-style
    // system + messages with image+text content blocks). Worker translates to Mistral's
    // OpenAI-compatible format, calls api.mistral.ai, and normalizes the response back to
    // Anthropic shape so the client is provider-agnostic.
    if (url.pathname === "/api/mistral" && req.method === "POST") return mistralAnalyze(req, env, origin);

    // ----- Billing (Stripe) -----
    if (url.pathname === "/api/billing/checkout" && req.method === "POST")
      return billingCheckout(req, env, origin);
    if (url.pathname === "/api/billing/portal" && req.method === "POST")
      return billingPortal(req, env, origin);
    if (url.pathname === "/api/billing/webhook" && req.method === "POST")
      return billingWebhook(req, env, origin);
    if (url.pathname === "/api/billing/prices" && req.method === "GET")
      return billingPrices(req, env, origin);

    // POST /api/auth/dropbox/login — trade a verified Dropbox id_token for an AgriVision
    // session JWT. The SPA calls this once after the Dropbox OAuth code exchange, then
    // uses `Authorization: Bearer <agri_jwt>` on every other identified endpoint.
    if (url.pathname === "/api/auth/dropbox/login" && req.method === "POST") {
      if (!env.AGRI_JWT_SECRET) return json({ error: "AGRI_JWT_SECRET not configured" }, 503, origin);
      let body;
      try {
        body = await req.json();
      } catch (e) {
        return json({ error: "bad body: " + e.message }, 400, origin);
      }
      if (!body?.id_token) return json({ error: "id_token required" }, 400, origin);
      try {
        // Audience check: the SPA passes its Dropbox client_id (DROPBOX_APP_KEY) so the
        // Worker can confirm the id_token was minted for *this* SPA. Skip if not sent
        // (avoids forcing every caller to know the value during the PoC).
        const claims = await verifyOidcIdToken(body.id_token, OIDC_PROVIDERS.dropbox, body.client_id || null);
        const sub = `dropbox:${claims.sub}`;
        const anchor = await resolveEmailAnchor(env, {
          sub,
          provider: "dropbox",
          email: claims.email || null,
          emailVerified: claims.email_verified === true,
        });
        if (!anchor.ok)
          return json({ error: "email_taken", existing_provider: anchor.existing_provider }, 409, origin);
        const session = await mintAgriSession(env, sub, {
          provider: "dropbox",
          email: claims.email || null,
        });
        return json({ agri_session: session.token, exp: session.exp, sub }, 200, origin);
      } catch (e) {
        return json({ error: "id_token verification failed: " + e.message }, 401, origin);
      }
    }

    // POST /api/auth/google/login — trade a verified Google id_token for an AgriVision
    // session JWT. The SPA gets the id_token from Google Identity Services (the `credential`
    // field of the GIS callback). Pure identity — no storage is connected by this call.
    if (url.pathname === "/api/auth/google/login" && req.method === "POST") {
      if (!env.AGRI_JWT_SECRET) return json({ error: "AGRI_JWT_SECRET not configured" }, 503, origin);
      let body;
      try {
        body = await req.json();
      } catch (e) {
        return json({ error: "bad body: " + e.message }, 400, origin);
      }
      if (!body?.id_token) return json({ error: "id_token required" }, 400, origin);
      try {
        // Audience: pin to GOOGLE_CLIENT_ID server-side when configured (prevents a token
        // minted for a *different* Google OAuth app from being accepted). Fall back to the
        // client-sent client_id during local dev when the env var isn't set.
        const expectedAud = env.GOOGLE_CLIENT_ID || body.client_id || null;
        const claims = await verifyOidcIdToken(body.id_token, OIDC_PROVIDERS.google, expectedAud);
        const sub = `google:${claims.sub}`;
        const anchor = await resolveEmailAnchor(env, {
          sub,
          provider: "google",
          email: claims.email || null,
          emailVerified: claims.email_verified === true,
        });
        if (!anchor.ok)
          return json({ error: "email_taken", existing_provider: anchor.existing_provider }, 409, origin);
        const session = await mintAgriSession(env, sub, {
          provider: "google",
          email: claims.email || null,
        });
        return json({ agri_session: session.token, exp: session.exp, sub }, 200, origin);
      } catch (e) {
        return json({ error: "id_token verification failed: " + e.message }, 401, origin);
      }
    }

    // POST /api/auth/facebook/login — trade a verified Facebook access_token for an
    // AgriVision session JWT. The SPA gets the access_token from the Facebook JS SDK
    // (FB.login → authResponse.accessToken). Verified server-side via Graph debug_token.
    if (url.pathname === "/api/auth/facebook/login" && req.method === "POST") {
      if (!env.AGRI_JWT_SECRET) return json({ error: "AGRI_JWT_SECRET not configured" }, 503, origin);
      if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET)
        return json({ error: "Facebook login not configured" }, 503, origin);
      let body;
      try {
        body = await req.json();
      } catch (e) {
        return json({ error: "bad body: " + e.message }, 400, origin);
      }
      if (!body?.access_token) return json({ error: "access_token required" }, 400, origin);
      try {
        const fb = await verifyFacebookAccessToken(body.access_token, env);
        const sub = `facebook:${fb.sub}`;
        // Facebook never asserts email verification → emailVerified:false. It can't claim an
        // anchor, but is still blocked if the email already belongs to a verified account.
        const anchor = await resolveEmailAnchor(env, {
          sub,
          provider: "facebook",
          email: fb.email || null,
          emailVerified: false,
        });
        if (!anchor.ok)
          return json({ error: "email_taken", existing_provider: anchor.existing_provider }, 409, origin);
        const session = await mintAgriSession(env, sub, {
          provider: "facebook",
          email: fb.email,
        });
        return json({ agri_session: session.token, exp: session.exp, sub }, 200, origin);
      } catch (e) {
        return json({ error: "access_token verification failed: " + e.message }, 401, origin);
      }
    }

    // POST /api/share/save — opt-in mirror of a Dropbox manifest (+ optional photos) into KV.
    // Auth: Authorization: Bearer <dropbox_token>. The Worker validates the token with
    // Dropbox to derive a stable account_id, which is the only identity we use.
    if (url.pathname === "/api/share/save" && req.method === "POST") {
      return shareSave(req, env, origin);
    }
    // DELETE /api/share/account — opt-out + purge of everything under the user's prefix.
    if (url.pathname === "/api/share/account" && req.method === "DELETE") {
      return shareDelete(req, env, origin);
    }
    // GET /api/share/status — returns last sync info for the current account (if any).
    if (url.pathname === "/api/share/status" && req.method === "GET") {
      return shareStatus(req, env, origin);
    }
    // GET /api/share/quota — current consumption + caps for the user's UI.
    if (url.pathname === "/api/share/quota" && req.method === "GET") {
      return shareQuota(req, env, origin);
    }
    // GET /api/share/load — read back the AgriVision-mirrored manifest + photos so a fresh
    // device (or a user who dropped their own cloud) can restore from our backup.
    if (url.pathname === "/api/share/load" && req.method === "GET") {
      return shareLoad(req, env, origin);
    }

    // POST /api/storage/register — record a non-secret pointer to WHERE the user's data
    // lives (which cloud + which account), so another device knows where to send them to
    // restore. No tokens are stored — see CLAUDE.md "never store user secrets".
    if (url.pathname === "/api/storage/register" && req.method === "POST") {
      return storageRegister(req, env, origin);
    }
    // GET /api/storage/pointer — fetch that pointer for the signed-in identity.
    if (url.pathname === "/api/storage/pointer" && req.method === "GET") {
      return storagePointer(req, env, origin);
    }

    // POST /api/satellite/catalog — list available Sentinel-2 acquisitions (dates + cloud
    // cover) over a bbox/date-range. Powers the parcel timeline. Logged-in feature.
    if (url.pathname === "/api/satellite/catalog" && req.method === "POST") {
      return satelliteCatalog(req, env, origin);
    }
    // POST /api/satellite/image — render an NDVI / true-color PNG for a bbox + date.
    if (url.pathname === "/api/satellite/image" && req.method === "POST") {
      return satelliteImage(req, env, origin);
    }
    // POST /api/satellite/statistics — per-geometry NDVI mean time series (vigor).
    if (url.pathname === "/api/satellite/statistics" && req.method === "POST") {
      return satelliteStatistics(req, env, origin);
    }
    // GET /api/weather?lat=&lon= — observed rain (nearest Météo-France station) + forecast
    // precipitation, soil moisture & ET0 (Open-Meteo) → a per-parcel water picture.
    if (url.pathname === "/api/weather" && req.method === "GET") {
      return weatherHandler(req, env, origin);
    }
    // Rain alerts (Web Push). subscribe stores {subscription, parcels} in KV; the cron
    // (scheduled handler) polls forecasts and pushes when rain ≥ threshold is coming.
    if (url.pathname === "/api/alerts/subscribe" && req.method === "POST") {
      return alertsSubscribe(req, env, origin);
    }
    if (url.pathname === "/api/alerts/unsubscribe" && req.method === "POST") {
      return alertsUnsubscribe(req, env, origin);
    }
    if (url.pathname === "/api/alerts/test" && req.method === "POST") {
      return alertsTest(req, env, origin);
    }

    // GET /api/vigicrues-stations — scrapes the donnees.php menu structure,
    // returns { regions: [{name, rivers: [{name, stations: [{id, name}]}]}] }.
    if (url.pathname === "/api/vigicrues-stations" && req.method === "GET") {
      try {
        const upstream = await fetch("https://www.vigicrues-reunion.re/donnees.php", {
          headers: { "user-agent": "AgriVision/0.1" },
          cf: { cacheTtl: 86400, cacheEverything: true }, // 24h
        });
        if (!upstream.ok) return json({ regions: [], error: "upstream " + upstream.status }, 200, origin);
        const html = await upstream.text();
        return json({ regions: parseVigicruesStations(html) }, 200, origin);
      } catch (e) {
        return json({ regions: [], error: e.message }, 200, origin);
      }
    }

    // GET /api/events-feed?source=<id> — fetches an allowlisted feed and normalizes.
    if (url.pathname === "/api/events-feed" && req.method === "GET") {
      const sourceId = url.searchParams.get("source");
      const feed = EVENTS_FEEDS[sourceId];
      if (!feed) return json({ error: "unknown source" }, 400, origin);
      try {
        const upstream = await fetch(feed.url, {
          // Be polite — UA helps some publishers not 403.
          headers: { "user-agent": "AgriVision/0.1 (+https://github.com/blacelle/agrivision)" },
          // CF edge cache — default 30 min, overridden per source (e.g. 3h for Vigicrues).
          cf: { cacheTtl: feed.cacheTtl || 1800, cacheEverything: true },
        });
        if (!upstream.ok) return json({ items: [], error: "upstream " + upstream.status }, 200, origin);
        const text = await upstream.text();
        const items = (feed.parser || parseRss)(text, feed);
        return json({ source: sourceId, items }, 200, origin);
      } catch (e) {
        return json({ items: [], error: e.message }, 200, origin);
      }
    }

    if (url.pathname !== "/api/analyze" || req.method !== "POST") {
      return new Response("not found", { status: 404, headers: corsHeaders(origin) });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "ANTHROPIC_API_KEY secret not configured" }, 500, origin);
    }

    const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: `payload exceeds ${MAX_BODY_BYTES} bytes` }, 413, origin);
    }

    let body;
    try {
      body = await req.text();
    } catch (e) {
      return json({ error: "could not read body: " + e.message }, 400, origin);
    }

    // OAuth tokens (sk-ant-oat-*) use Bearer auth + the oauth beta header;
    // long-lived API keys (sk-ant-api*) use x-api-key.
    const key = env.ANTHROPIC_API_KEY;
    // OAuth tokens look like sk-ant-oat01-…, sk-ant-oat02-…, etc.
    const isOAuth = /^sk-ant-oat\d*-/.test(key);
    const upstreamHeaders = {
      "content-type": "application/json",
      "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01",
    };
    if (isOAuth) {
      upstreamHeaders["Authorization"] = `Bearer ${key}`;
      upstreamHeaders["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      upstreamHeaders["x-api-key"] = key;
    }
    // AI access gating + per-user token quota. Behavior depends on whether SHARE_KV is bound:
    //   - Not bound (local dev / no-KV demo): anonymous pass-through, no gating, no tracking.
    //   - Bound (production): require a paid tier. Anonymous → 402. Free tier → 402.
    //     Paid tiers → token-quota check, 429 if over.
    let identifiedAccount = null;
    if (env.SHARE_KV) {
      const auth = req.headers.get("authorization");
      if (!auth) {
        return json(
          {
            error: "ai_requires_signin",
            message: "Connecte-toi et choisis un plan Standard ou Premium pour utiliser l'IA.",
          },
          402,
          origin
        );
      }
      const who = await resolveAccount(req, env);
      if (who.error) return json({ error: who.error }, who.status, origin);
      const plan = await loadPlan(env, who.accountId);
      const limits = quotasForTier(plan.tier);
      if (limits.max_tokens_in_per_period === 0) {
        return json(
          {
            error: "ai_requires_paid_plan",
            message:
              "L'IA est réservée aux plans Standard et Premium. Passe à un plan payant pour l'utiliser.",
            tier: plan.tier,
          },
          402,
          origin
        );
      }
      const q = await loadQuota(env, who.accountId);
      {
        if (q.tokens_in >= limits.max_tokens_in_per_period)
          return json(
            {
              error: "tokens_in_quota_exceeded",
              current: q.tokens_in,
              max: limits.max_tokens_in_per_period,
              tier: plan.tier,
            },
            429,
            origin
          );
        if (q.tokens_out >= limits.max_tokens_out_per_period)
          return json(
            {
              error: "tokens_out_quota_exceeded",
              current: q.tokens_out,
              max: limits.max_tokens_out_per_period,
              tier: plan.tier,
            },
            429,
            origin
          );
        identifiedAccount = who.accountId;
      }
    }
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: upstreamHeaders,
      body,
    });

    // Stream the upstream response back with CORS + relevant Anthropic headers
    // (rate-limit, request-id) for client-side debugging in DevTools.
    const passThrough = {};
    for (const h of [
      "content-type",
      "request-id",
      "anthropic-organization-id",
      "anthropic-ratelimit-requests-limit",
      "anthropic-ratelimit-requests-remaining",
      "anthropic-ratelimit-requests-reset",
      "anthropic-ratelimit-input-tokens-limit",
      "anthropic-ratelimit-input-tokens-remaining",
      "anthropic-ratelimit-input-tokens-reset",
      "anthropic-ratelimit-output-tokens-limit",
      "anthropic-ratelimit-output-tokens-remaining",
      "anthropic-ratelimit-output-tokens-reset",
      "anthropic-ratelimit-tokens-limit",
      "anthropic-ratelimit-tokens-remaining",
      "anthropic-ratelimit-tokens-reset",
      "retry-after",
    ]) {
      const v = upstream.headers.get(h);
      if (v) passThrough[h] = v;
    }
    // Identified-user path: consume the body once to extract `usage`, bump KV, then echo.
    // Anonymous path streams unchanged.
    if (identifiedAccount) {
      const text = await upstream.text();
      try {
        const j = JSON.parse(text);
        if (j.usage) {
          const q = await loadQuota(env, identifiedAccount);
          q.tokens_in += (j.usage.input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0);
          q.tokens_out += j.usage.output_tokens || 0;
          q.writes = (q.writes || 0) + 1;
          await saveQuota(env, identifiedAccount, q);
        }
      } catch {}
      return new Response(text, {
        status: upstream.status,
        headers: { ...passThrough, ...corsHeaders(origin) },
      });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...passThrough, ...corsHeaders(origin) },
    });
  },

  // Cron Trigger — polls forecasts and pushes rain alerts. Schedule in wrangler.toml.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRainAlerts(env));
  },
};

// =========================================================================
// "Share with AgriVision" — opt-in KV mirror of the user's Dropbox manifests.
// Identity = Dropbox account_id. Layout under SHARE_KV:
//   share/<account_id>/cultures/<culture_id>/culture.json
//   share/<account_id>/cultures/<culture_id>/photos/<photo_id>
//   share/<account_id>/last_sync.json
// =========================================================================

// ============= Base64URL helpers (string + bytes) =============
function b64urlEncodeBytes(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlEncodeString(s) {
  return b64urlEncodeBytes(new TextEncoder().encode(s));
}
function b64urlDecodeBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecodeString(s) {
  return new TextDecoder().decode(b64urlDecodeBytes(s));
}

// ============= OIDC JWKS — discovered + edge-cached 24h =============
// Generic over any OIDC provider's discovery document. The CF edge cache keys on the URL,
// so each provider's JWKS is fetched at most once per 24h per colo.
async function fetchOidcJwks(discoveryUrl) {
  const dr = await fetch(discoveryUrl, {
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!dr.ok) throw new Error("oidc discovery " + dr.status);
  const conf = await dr.json();
  if (!conf.jwks_uri) throw new Error("no jwks_uri in discovery");
  const jr = await fetch(conf.jwks_uri, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!jr.ok) throw new Error("jwks " + jr.status);
  return { jwks: await jr.json(), issuer: conf.issuer || null };
}

// ============= Verify an OIDC id_token (RS256) against a provider's JWKS =============
// Generic verifier shared by Dropbox + Google. `provider` is an entry from OIDC_PROVIDERS.
// `expectedAudience` (when non-null) is enforced against the `aud` claim. Throws on any
// failure; returns the parsed claims on success.
async function verifyOidcIdToken(jwt, provider, expectedAudience) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(b64urlDecodeString(headerB64));
  if (header.alg !== "RS256") throw new Error("unexpected alg " + header.alg);
  if (!header.kid) throw new Error("missing kid");
  const { jwks, issuer: discoveredIssuer } = await fetchOidcJwks(provider.discovery);
  const key = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!key) throw new Error("kid not in jwks");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlDecodeBytes(sigB64);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sig, data);
  if (!ok) throw new Error("invalid signature");
  const claims = JSON.parse(b64urlDecodeString(payloadB64));
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error("expired");
  if (claims.nbf && claims.nbf > now) throw new Error("not yet valid");
  const acceptable = new Set(provider.acceptedIssuers);
  if (discoveredIssuer) acceptable.add(discoveredIssuer);
  if (!acceptable.has(claims.iss)) throw new Error("unexpected issuer: " + claims.iss);
  if (expectedAudience && claims.aud !== expectedAudience)
    throw new Error("unexpected audience: " + claims.aud);
  if (!claims.sub) throw new Error("no sub claim");
  return claims;
}

// ============= Verify a Facebook access_token via the Graph debug_token endpoint =============
// Facebook web login yields an access_token (opaque), not an OIDC id_token. We confirm it
// server-side with our own app credentials: debug_token validates the token was minted for
// OUR app and is unexpired; then /me reads the stable user id + email. The app secret is
// OURS (not the user's), so this respects the CLAUDE.md "no user secrets" rule.
// Returns { sub, email, name }. Throws on any failure.
async function verifyFacebookAccessToken(accessToken, env) {
  if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET)
    throw new Error("FACEBOOK_APP_ID/SECRET not configured");
  if (!accessToken) throw new Error("access_token required");
  const appToken = `${env.FACEBOOK_APP_ID}|${env.FACEBOOK_APP_SECRET}`;
  const dbgUrl =
    `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}` +
    `&access_token=${encodeURIComponent(appToken)}`;
  const dr = await fetch(dbgUrl);
  if (!dr.ok) throw new Error("debug_token http " + dr.status);
  const dj = await dr.json();
  const data = dj.data || {};
  if (!data.is_valid) throw new Error("token not valid");
  if (String(data.app_id) !== String(env.FACEBOOK_APP_ID))
    throw new Error("token minted for a different app");
  if (!data.user_id) throw new Error("no user_id on token");
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at && data.expires_at < now) throw new Error("token expired");
  // Pull the email + name with the user's own token (debug_token doesn't return them).
  let email = null,
    name = null;
  try {
    const mr = await fetch(
      `https://graph.facebook.com/me?fields=id,email,name&access_token=${encodeURIComponent(accessToken)}`
    );
    if (mr.ok) {
      const mj = await mr.json();
      email = mj.email || null;
      name = mj.name || null;
    }
  } catch {}
  return { sub: String(data.user_id), email, name };
}

// ============= Email anchor: one verified email ↦ one account (block, don't merge) =============
// At account creation we bind the (verified) email to the account's `sub`. Thereafter:
//   • a DIFFERENT account presenting the same email is BLOCKED (no silent merge → no takeover);
//   • the SAME account whose provider email later changes is FROZEN — we keep serving it
//     (identity is the immutable `sub`), but never move the anchor. A future email-change
//     feature re-verifies and re-points the index.
// Only a VERIFIED email may CLAIM an anchor — this is what stops a provider with weak/absent
// email verification (Facebook) from squatting someone else's address (account pre-hijacking).
// KV (env.SHARE_KV): `email/<lowercased>` → {sub, provider, created_at};  `anchor/<sub>` → email.
// Returns { ok:true } to proceed, or { ok:false, existing_provider } → caller responds 409.
async function resolveEmailAnchor(env, { sub, provider, email, emailVerified }) {
  if (!email || !env.SHARE_KV) return { ok: true }; // nothing to enforce
  const norm = String(email).trim().toLowerCase();
  if (!norm) return { ok: true };

  // Already anchored? Then this is a returning account. If its provider email changed since,
  // FREEZE: ignore the new address entirely (don't claim it, don't block on it).
  const anchored = await env.SHARE_KV.get(`anchor/${sub}`).catch(() => null);
  if (anchored) return { ok: true };

  // No anchor yet (new sign-up, or a pre-existing account being indexed lazily).
  let existing = null;
  const raw = await env.SHARE_KV.get(`email/${norm}`).catch(() => null);
  if (raw) {
    try {
      existing = JSON.parse(raw);
    } catch {}
  }
  if (existing && existing.sub !== sub) {
    return { ok: false, existing_provider: existing.provider || null }; // owned by another account
  }
  // Claim (or repair) the anchor — verified emails only. Facebook (emailVerified=false) reaches
  // here, never claims, and so can still create a sub-only account when there's no collision.
  if (emailVerified) {
    if (!existing) {
      await env.SHARE_KV
        .put(`email/${norm}`, JSON.stringify({ sub, provider, created_at: Math.floor(Date.now() / 1000) }))
        .catch(() => {});
    }
    await env.SHARE_KV.put(`anchor/${sub}`, norm).catch(() => {});
  }
  return { ok: true };
}

// ============= AgriVision session JWT (HS256) — mint + verify =============
async function mintAgriSession(env, sub, extras = {}) {
  if (!env.AGRI_JWT_SECRET) throw new Error("AGRI_JWT_SECRET not configured");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub, // namespaced: "dropbox:<dbx_sub>", "google:<g_sub>", …
    iss: AGRI_JWT_ISS,
    aud: AGRI_JWT_AUD,
    iat: now,
    exp: now + AGRI_JWT_TTL_SECONDS,
    jti: crypto.randomUUID(),
    ...extras,
  };
  const headerB64 = b64urlEncodeString(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadB64 = b64urlEncodeString(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AGRI_JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return { token: `${data}.${b64urlEncodeBytes(sig)}`, exp: payload.exp, jti: payload.jti };
}

async function verifyAgriSession(env, jwt) {
  if (!env.AGRI_JWT_SECRET || !jwt) return null;
  const parts = String(jwt).split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  try {
    header = JSON.parse(b64urlDecodeString(headerB64));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AGRI_JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sig = b64urlDecodeBytes(sigB64);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify("HMAC", key, sig, data);
  if (!ok) return null;
  let claims;
  try {
    claims = JSON.parse(b64urlDecodeString(payloadB64));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) return null;
  if (claims.iss !== AGRI_JWT_ISS || claims.aud !== AGRI_JWT_AUD) return null;
  // Revocation list: a `revoked/<jti>` key in SHARE_KV means /api/auth/logout was called
  // on this session. The key is written with expirationTtl = original token exp so it
  // self-cleans. Missing SHARE_KV binding falls back to "not revocable" (PoC tolerant).
  if (claims.jti && env.SHARE_KV) {
    const r = await env.SHARE_KV.get(`revoked/${claims.jti}`);
    if (r) return null;
  }
  return claims;
}

// Identity resolver for ALL identified endpoints. Only accepts our own session JWT
// in `Authorization: Bearer <agri_jwt>`. The IdP id_token is exchanged for an
// AgriVision JWT once at /api/auth/dropbox/login — IdP tokens never appear here.
async function resolveAccount(req, env) {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return { error: "session_missing", message: "AgriVision session manquante", status: 401 };
  const claims = await verifyAgriSession(env, bearer);
  if (!claims)
    return {
      error: "session_invalid",
      message: "Session AgriVision invalide ou expirée — reconnectez-vous à Dropbox.",
      status: 401,
    };
  return { accountId: claims.sub, email: claims.email || null };
}

function defaultQuota() {
  return {
    photos_count: 0,
    photos_bytes: 0,
    tokens_in: 0,
    tokens_out: 0,
    // KV writes counter — useful in PoC to keep an eye on the 1k/day free tier; drop in prod.
    writes: 0,
    period_start_iso: new Date().toISOString(),
  };
}

async function loadQuota(env, accountId) {
  const raw = await env.SHARE_KV.get(`share/${accountId}/quota.json`);
  if (!raw) return defaultQuota();
  let q;
  try {
    q = JSON.parse(raw);
  } catch {
    return defaultQuota();
  }
  // Roll the token-period if 30d elapsed. Photo counters are cumulative (occupied storage).
  const periodMs = 30 * 86400 * 1000;
  if (Date.now() - new Date(q.period_start_iso).getTime() > periodMs) {
    q.tokens_in = 0;
    q.tokens_out = 0;
    q.period_start_iso = new Date().toISOString();
  }
  return q;
}

async function saveQuota(env, accountId, q) {
  await env.SHARE_KV.put(`share/${accountId}/quota.json`, JSON.stringify(q));
}

// Returns the byte size of a base64 payload (close enough — ignores padding).
function b64Bytes(b64) {
  return Math.floor((String(b64 || "").length * 3) / 4);
}

async function shareSave(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV binding not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "invalid json body: " + e.message }, 400, origin);
  }
  const { manifest, photos = [] } = body || {};
  if (!manifest?.culture_id) return json({ error: "manifest.culture_id required" }, 400, origin);
  const base = `share/${who.accountId}/cultures/${manifest.culture_id}`;
  const quota = await loadQuota(env, who.accountId);
  const plan = await loadPlan(env, who.accountId);
  const limits = quotasForTier(plan.tier);

  // Pre-flight: reject the whole batch if any single photo is oversized, or if accepting
  // all of them would push the user past their photo count / total-bytes caps. Limits
  // come from the user's current plan tier.
  const incomingBytes = photos.reduce((a, p) => a + b64Bytes(p?.b64), 0);
  const oversized = photos.find((p) => b64Bytes(p?.b64) > limits.max_photo_bytes);
  if (oversized)
    return json(
      {
        error: "photo_too_large",
        max_bytes: limits.max_photo_bytes,
        photo_id: oversized.id,
        tier: plan.tier,
      },
      413,
      origin
    );
  if (quota.photos_count + photos.length > limits.max_photos)
    return json(
      {
        error: "photo_count_exceeded",
        max_photos: limits.max_photos,
        current: quota.photos_count,
        tier: plan.tier,
      },
      413,
      origin
    );
  if (quota.photos_bytes + incomingBytes > limits.max_total_bytes)
    return json(
      {
        error: "storage_exceeded",
        max_bytes: limits.max_total_bytes,
        current: quota.photos_bytes,
        tier: plan.tier,
      },
      413,
      origin
    );

  // Write manifest (always small, never quota-bound).
  await env.SHARE_KV.put(`${base}/culture.json`, JSON.stringify(manifest), {
    metadata: { account_email: who.email, updated_at: new Date().toISOString() },
  });
  // Write any provided photos (the client tracks which ids it has already uploaded so
  // these calls are normally incremental).
  let uploadedPhotos = 0;
  let uploadedBytes = 0;
  for (const p of photos) {
    if (!p?.id || !p?.b64) continue;
    const key = `${base}/photos/${p.id}`;
    await env.SHARE_KV.put(key, p.b64, {
      metadata: { mime: p.mime || "image/jpeg", uploaded_at: new Date().toISOString() },
    });
    uploadedPhotos++;
    uploadedBytes += b64Bytes(p.b64);
  }
  quota.photos_count += uploadedPhotos;
  quota.photos_bytes += uploadedBytes;
  // Count: manifest + last_sync marker + N photos + 1 for the quota write itself.
  quota.writes = (quota.writes || 0) + 2 + uploadedPhotos + 1;
  await saveQuota(env, who.accountId, quota);
  // Touch a per-account last-sync marker so /api/share/status can report it cheaply.
  await env.SHARE_KV.put(
    `share/${who.accountId}/last_sync.json`,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      culture_id: manifest.culture_id,
      photos: uploadedPhotos,
    })
  );
  return json({ ok: true, base, uploaded_photos: uploadedPhotos }, 200, origin);
}

async function shareDelete(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV binding not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  const prefix = `share/${who.accountId}/`;
  let cursor;
  let deleted = 0;
  // CF KV list is paginated; loop until list_complete.
  // Each KV.delete is one operation — bounded by SHARE_KV rate limits.
  do {
    const list = await env.SHARE_KV.list({ prefix, cursor });
    for (const k of list.keys) {
      await env.SHARE_KV.delete(k.name);
      deleted++;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  // Note: this loop above already wiped quota.json — counters effectively reset.
  return json({ ok: true, deleted }, 200, origin);
}

// ============================================================================
// Storage pointer — a NON-SECRET record of where a user's data lives, kept as
// metadata of the AgriVision storage at share/<sub>/storage.json:
//   { preferred: "dropbox", providers: { dropbox: { account_id, email_masked,
//     root_path, last_seen } }, updated_at }
// Lets any device (after the user logs in with the same identity) say "your data
// is in Dropbox (b•••@x.com) — reconnect to restore", and tells us where to send
// the user for OneDrive etc. later. We NEVER store the access/refresh token here.
// ============================================================================
async function storageRegister(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV binding not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "invalid json body: " + e.message }, 400, origin);
  }
  const provider = String(body?.provider || "").toLowerCase();
  if (!["dropbox", "onedrive", "gdrive"].includes(provider))
    return json({ error: "unsupported provider" }, 400, origin);
  if (!body?.account_id) return json({ error: "account_id required" }, 400, origin);

  const key = `share/${who.accountId}/storage.json`;
  let pointer = { preferred: null, providers: {}, updated_at: null };
  try {
    const raw = await env.SHARE_KV.get(key);
    if (raw) pointer = JSON.parse(raw);
  } catch {}
  pointer.providers = pointer.providers || {};
  pointer.providers[provider] = {
    account_id: String(body.account_id).slice(0, 200),
    // The client masks the email before sending; we defensively cap length and never
    // expect a full address here.
    email_masked: body.email_masked ? String(body.email_masked).slice(0, 120) : null,
    root_path: body.root_path ? String(body.root_path).slice(0, 200) : null,
    last_seen: new Date().toISOString(),
  };
  // First provider registered becomes the preferred one; user's own cloud is preferred
  // over the AgriVision mirror by construction (the mirror isn't a "provider" entry).
  if (!pointer.preferred) pointer.preferred = provider;
  pointer.updated_at = new Date().toISOString();
  await env.SHARE_KV.put(key, JSON.stringify(pointer));
  return json({ ok: true, pointer }, 200, origin);
}

async function storagePointer(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV binding not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  let pointer = null;
  try {
    const raw = await env.SHARE_KV.get(`share/${who.accountId}/storage.json`);
    if (raw) pointer = JSON.parse(raw);
  } catch {}
  // has_mirror: does an AgriVision-side backup exist for this identity?
  const lastSync = await env.SHARE_KV.get(`share/${who.accountId}/last_sync.json`);
  return json({ pointer, has_mirror: !!lastSync }, 200, origin);
}

// GET /api/share/load[?culture_id=…] — return a mirrored culture's manifest + its photos so
// the SPA can rehydrate from our backup. Without culture_id, picks the most recent culture
// (from last_sync.json, falling back to the first listed).
async function shareLoad(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV binding not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  const url = new URL(req.url);
  let cultureId = url.searchParams.get("culture_id");

  // Enumerate mirrored cultures (manifest keys end in /culture.json).
  const culturesPrefix = `share/${who.accountId}/cultures/`;
  const cultures = [];
  let cursor;
  do {
    const list = await env.SHARE_KV.list({ prefix: culturesPrefix, cursor });
    for (const k of list.keys) {
      const m = k.name.match(/cultures\/([^/]+)\/culture\.json$/);
      if (m) cultures.push(m[1]);
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  if (!cultureId) {
    try {
      const ls = await env.SHARE_KV.get(`share/${who.accountId}/last_sync.json`);
      if (ls) cultureId = JSON.parse(ls).culture_id || null;
    } catch {}
    if (!cultureId) cultureId = cultures[0] || null;
  }
  if (!cultureId) return json({ error: "no_mirror", cultures: [] }, 404, origin);

  const base = `share/${who.accountId}/cultures/${cultureId}`;
  const manifestRaw = await env.SHARE_KV.get(`${base}/culture.json`);
  if (!manifestRaw) return json({ error: "culture_not_found", cultures }, 404, origin);
  const manifest = JSON.parse(manifestRaw);

  // Pull photo bytes. Photos are stored keyed by their id; match by manifest order.
  const photos = [];
  const photosPrefix = `${base}/photos/`;
  cursor = undefined;
  do {
    const list = await env.SHARE_KV.list({ prefix: photosPrefix, cursor });
    for (const k of list.keys) {
      const id = k.name.slice(photosPrefix.length);
      const b64 = await env.SHARE_KV.get(k.name);
      if (b64) photos.push({ id, mime: k.metadata?.mime || "image/jpeg", b64 });
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  return json({ culture_id: cultureId, crop_code: manifest.crop_code || null, manifest, photos, cultures }, 200, origin);
}

// ============================================================================
// Satellite imagery (Copernicus / Sentinel-2 via CDSE Sentinel Hub APIs).
// Secrets: CDSE_CLIENT_ID + CDSE_CLIENT_SECRET (OUR credentials — register a free
// OAuth client at https://shapps.dataspace.copernicus.eu/dashboard/ ). Both routes
// require a signed-in AgriVision session (the Process API consumes CDSE quota).
// ============================================================================
async function getCdseToken(env) {
  if (!env.CDSE_CLIENT_ID || !env.CDSE_CLIENT_SECRET) throw new Error("CDSE credentials not configured");
  const now = Math.floor(Date.now() / 1000);
  if (_cdseToken.value && _cdseToken.exp - 30 > now) return _cdseToken.value;
  const r = await fetch(env.CDSE_TOKEN_URL || CDSE.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.CDSE_CLIENT_ID,
      client_secret: env.CDSE_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error("CDSE token " + r.status);
  const j = await r.json();
  _cdseToken = { value: j.access_token, exp: now + (j.expires_in || 600) };
  return _cdseToken.value;
}

function cdseBase(env) {
  return (env.CDSE_BASE || CDSE.base).replace(/\/$/, "");
}

// Evalscripts (Sentinel Hub v3). true-color = natural; ndvi = vigor ramp (brown→green).
const EVALSCRIPTS = {
  truecolor: `//VERSION=3
function setup(){return {input:["B02","B03","B04"],output:{bands:3}};}
function evaluatePixel(s){return [2.5*s.B04,2.5*s.B03,2.5*s.B02];}`,
  ndvi: `//VERSION=3
function setup(){return {input:["B04","B08"],output:{bands:3}};}
function evaluatePixel(s){
  let n=(s.B08-s.B04)/(s.B08+s.B04);
  if(n<0.0) return [0.30,0.45,0.70];      // water / bare
  if(n<0.2) return [0.78,0.60,0.40];      // soil
  if(n<0.4) return [0.95,0.90,0.40];      // sparse
  if(n<0.6) return [0.55,0.80,0.25];      // moderate
  return [0.10,0.55,0.12];                // dense / vigorous
}`,
};

async function satelliteCatalog(req, env, origin) {
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  if (!env.CDSE_CLIENT_ID) return json({ error: "satellite not configured" }, 503, origin);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "bad body: " + e.message }, 400, origin);
  }
  const { bbox, datetime, maxCloud = 100 } = body || {};
  if (!Array.isArray(bbox) || bbox.length !== 4) return json({ error: "bbox [w,s,e,n] required" }, 400, origin);
  try {
    const token = await getCdseToken(env);
    const r = await fetch(`${cdseBase(env)}/api/v1/catalog/1.0.0/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        collections: [env.CDSE_COLLECTION || CDSE.collection],
        bbox,
        datetime: datetime || defaultDatetimeRange(),
        limit: 100,
      }),
    });
    if (!r.ok) return json({ error: "catalog " + r.status, detail: await r.text() }, 502, origin);
    const j = await r.json();
    // Normalize features → compact acquisition list, filter by cloud, newest first.
    const acquisitions = (j.features || [])
      .map((f) => ({
        id: f.id,
        date: f.properties?.datetime || null,
        cloud: f.properties?.["eo:cloud_cover"] ?? null,
      }))
      .filter((a) => a.date && (a.cloud == null || a.cloud <= maxCloud))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    // Collapse to one entry per day (a bbox can intersect multiple tiles same day).
    const seen = new Set();
    const daily = [];
    for (const a of acquisitions) {
      const day = a.date.slice(0, 10);
      if (seen.has(day)) continue;
      seen.add(day);
      daily.push({ ...a, day });
    }
    return json({ acquisitions: daily }, 200, origin);
  } catch (e) {
    return json({ error: e.message }, 502, origin);
  }
}

async function satelliteImage(req, env, origin) {
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  if (!env.CDSE_CLIENT_ID) return json({ error: "satellite not configured" }, 503, origin);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "bad body: " + e.message }, 400, origin);
  }
  const { bbox, day, index = "truecolor", width = 512, height = 512 } = body || {};
  if (!Array.isArray(bbox) || bbox.length !== 4) return json({ error: "bbox [w,s,e,n] required" }, 400, origin);
  if (!day) return json({ error: "day (YYYY-MM-DD) required" }, 400, origin);
  const evalscript = EVALSCRIPTS[index] || EVALSCRIPTS.truecolor;
  const w = Math.min(Math.max(parseInt(width, 10) || 512, 64), 2048);
  const h = Math.min(Math.max(parseInt(height, 10) || 512, 64), 2048);
  try {
    const token = await getCdseToken(env);
    const r = await fetch(`${cdseBase(env)}/api/v1/process`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "image/png" },
      body: JSON.stringify({
        input: {
          bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
          data: [
            {
              type: env.CDSE_COLLECTION || CDSE.collection,
              dataFilter: {
                timeRange: { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` },
                mosaickingOrder: "leastCC",
              },
              // Interpolate the 10 m pixels (vs default nearest-neighbour blocks) so the
              // rendered overlay looks smooth rather than pixelated. Doesn't add real detail.
              processing: { upsampling: "BICUBIC", downsampling: "BICUBIC" },
            },
          ],
        },
        output: { width: w, height: h, responses: [{ identifier: "default", format: { type: "image/png" } }] },
        evalscript,
      }),
    });
    if (!r.ok) return json({ error: "process " + r.status, detail: await r.text() }, 502, origin);
    // Pass the PNG straight through with CORS headers.
    return new Response(r.body, {
      status: 200,
      headers: { ...corsHeaders(origin), "content-type": "image/png", "cache-control": "private, max-age=86400" },
    });
  } catch (e) {
    return json({ error: e.message }, 502, origin);
  }
}

// ============================================================================
// Weather / water — observed rainfall from the nearest Météo-France station (DPObs) +
// forecast precipitation, soil moisture and ET0 from Open-Meteo (free, keyless). Together:
// rain that fell, rain coming, soil humidity, and a water balance. Secret:
// METEOFRANCE_APPLICATION_ID (OAuth2 Basic → bearer). Manage app + subscriptions:
//   https://portail-api.meteofrance.fr/web/fr/dashboard
// ============================================================================
const MF_BASE = "https://public-api.meteofrance.fr/public";
let _mfToken = { value: null, exp: 0 };
let _mfStations = { list: null, exp: 0 }; // in-isolate cache of the DPObs station list

async function getMeteoFranceToken(env) {
  if (!env.METEOFRANCE_APPLICATION_ID) throw new Error("METEOFRANCE_APPLICATION_ID not configured");
  const now = Math.floor(Date.now() / 1000);
  if (_mfToken.value && _mfToken.exp - 60 > now) return _mfToken.value;
  const r = await fetch("https://portail-api.meteofrance.fr/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${env.METEOFRANCE_APPLICATION_ID}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error("MF token " + r.status);
  const j = await r.json();
  _mfToken = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return _mfToken.value;
}

// DPObs station list (CSV, ~140 KB). Cached in-isolate for 24h; parsed to {id,lat,lon,nom}.
async function getMfStations(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_mfStations.list && _mfStations.exp > now) return _mfStations.list;
  const token = await getMeteoFranceToken(env);
  const r = await fetch(`${MF_BASE}/DPObs/v1/liste-stations?format=json`, {
    headers: { authorization: `Bearer ${token}` },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!r.ok) throw new Error("MF stations " + r.status);
  const text = await r.text(); // CSV: Id_station;Id_omm;Nom_usuel;Latitude;Longitude;Altitude;...
  const list = [];
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const c = line.split(";");
    const lat = parseFloat(c[3]),
      lon = parseFloat(c[4]);
    if (isFinite(lat) && isFinite(lon)) list.push({ id: c[0], nom: c[2], lat, lon, pack: c[7] || "" });
  }
  _mfStations = { list, exp: now + 86400 };
  return list;
}

function nearestStation(stations, lat, lon) {
  let best = null,
    bestD = Infinity;
  for (const s of stations) {
    // equirectangular approximation — fine for "nearest" ranking
    const dLat = s.lat - lat,
      dLon = (s.lon - lon) * Math.cos((lat * Math.PI) / 180);
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (!best) return null;
  const km = Math.round(Math.sqrt(bestD) * 111 * 10) / 10;
  return { ...best, distance_km: km };
}

async function weatherHandler(req, env, origin) {
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: "lat & lon required" }, 400, origin);

  const out = { observed: null, forecast: null };

  // --- Météo-France: nearest station + latest observation (best-effort) ---
  if (env.METEOFRANCE_APPLICATION_ID) {
    try {
      const stations = await getMfStations(env);
      // Prefer RADOME stations — they carry the real-time 6-min feed (rr_per, t, u). ETENDU /
      // CIRAD stations are often closer but report null in infrahoraire-6m.
      const radome = stations.filter((s) => /RADOME/i.test(s.pack));
      const st = nearestStation(radome.length ? radome : stations, lat, lon);
      if (st) {
        const token = await getMeteoFranceToken(env);
        const or = await fetch(
          `${MF_BASE}/DPObs/v1/station/infrahoraire-6m?id_station=${encodeURIComponent(st.id)}&format=json`,
          { headers: { authorization: `Bearer ${token}` } }
        );
        if (or.ok) {
          const oj = await or.json();
          const o = Array.isArray(oj) ? oj[oj.length - 1] : oj;
          out.observed = {
            source: "Météo-France",
            station: st.nom,
            station_id: st.id,
            distance_km: st.distance_km,
            time: o?.validity_time || null,
            rain_mm: o?.rr_per ?? null,
            temp_c: o?.t != null ? Math.round((o.t - 273.15) * 10) / 10 : null,
            humidity_pct: o?.u ?? null,
            wind_ms: o?.ff ?? null,
          };
        }
      }
    } catch (e) {
      out.observed = { error: e.message };
    }
  }

  // --- Open-Meteo: precipitation forecast + soil moisture + ET0 → water balance ---
  try {
    const om = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=precipitation_sum,et0_fao_evapotranspiration&hourly=soil_moisture_3_to_9cm` +
        `&past_days=3&forecast_days=7&timezone=auto`
    );
    if (om.ok) {
      const j = await om.json();
      const days = (j.daily?.time || []).map((date, i) => {
        const precip = j.daily.precipitation_sum?.[i] ?? null;
        const et0 = j.daily.et0_fao_evapotranspiration?.[i] ?? null;
        return {
          date,
          precip_mm: precip,
          et0_mm: et0,
          water_balance_mm: precip != null && et0 != null ? Math.round((precip - et0) * 10) / 10 : null,
        };
      });
      const sm = j.hourly?.soil_moisture_3_to_9cm || [];
      const smLatest = sm.length ? sm[sm.length - 1] : null;
      out.forecast = {
        source: "Open-Meteo",
        days,
        soil_moisture_m3m3: smLatest,
        soil_moisture_depth: "3-9cm",
      };
    }
  } catch (e) {
    out.forecast = { error: e.message };
  }

  return json(out, 200, origin);
}

// ============================================================================
// Rain alerts — Web Push (VAPID + RFC 8291 aes128gcm). The scheduled() cron polls the
// Open-Meteo forecast for each subscriber's parcels and pushes when rain ≥ threshold is
// coming. Public key below ships to the SPA (config.js VAPID_PUBLIC_KEY); the matching
// private scalar is the Worker secret VAPID_PRIVATE_KEY.
// ============================================================================
const VAPID_PUBLIC_KEY = "BM8aw9vXzVz3Zz2vHzwBYIE-DtzaI8rXXE-D3qKkARciYdeJHYANsD35fnapqNSlXHNG4npu7_Wv6qcxItF7Jj4";
const VAPID_SUBJECT = "mailto:benoit@solven.eu";

function concatBytes(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

async function importVapidSigningKey(env) {
  const pub = b64urlDecodeBytes(VAPID_PUBLIC_KEY); // 0x04 || x(32) || y(32)
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: env.VAPID_PRIVATE_KEY,
      x: b64urlEncodeBytes(pub.slice(1, 33)),
      y: b64urlEncodeBytes(pub.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

async function vapidJwt(env, audience) {
  const key = await importVapidSigningKey(env);
  const header = b64urlEncodeString(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncodeString(
    JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || VAPID_SUBJECT })
  );
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(data));
  return `${data}.${b64urlEncodeBytes(new Uint8Array(sig))}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Encrypt `plaintext` for a push subscription per RFC 8291 (aes128gcm content-encoding).
async function encryptPushPayload(subscription, plaintext) {
  const enc = new TextEncoder();
  const uaPublic = b64urlDecodeBytes(subscription.keys.p256dh); // 65 bytes
  const authSecret = b64urlDecodeBytes(subscription.keys.auth); // 16 bytes
  const server = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPub = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey)); // 65 bytes
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, server.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concatBytes(enc.encode("WebPush: info\0"), uaPublic, serverPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concatBytes(plaintext, new Uint8Array([2])); // 0x02 = last-record delimiter
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record)
  );
  // header: salt(16) || rs(4, =4096) || idlen(1) || keyid(serverPub,65) || ciphertext
  const rs = new Uint8Array([0, 0, 0x10, 0]);
  return concatBytes(salt, rs, new Uint8Array([serverPub.length]), serverPub, ciphertext);
}

async function sendWebPush(env, subscription, payloadObj) {
  if (!env.VAPID_PRIVATE_KEY) throw new Error("VAPID_PRIVATE_KEY not configured");
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await vapidJwt(env, audience);
  const body = await encryptPushPayload(subscription, new TextEncoder().encode(JSON.stringify(payloadObj)));
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: "86400",
      authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
    },
    body,
  });
}

async function alertsSubscribe(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "bad body: " + e.message }, 400, origin);
  }
  if (!body?.subscription?.endpoint) return json({ error: "subscription required" }, 400, origin);
  const rec = {
    subscription: body.subscription,
    parcels: Array.isArray(body.parcels)
      ? body.parcels
          .slice(0, 50)
          .map((p) => ({ lat: +p.lat, lon: +p.lon, label: String(p.label || "").slice(0, 60) }))
          .filter((p) => isFinite(p.lat) && isFinite(p.lon))
      : [],
    threshold_mm: Number(body.threshold_mm) || 2,
    updated_at: new Date().toISOString(),
    last_alert: {},
  };
  await env.SHARE_KV.put(`alerts/${who.accountId}`, JSON.stringify(rec));
  return json({ ok: true, parcels: rec.parcels.length }, 200, origin);
}

async function alertsUnsubscribe(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  await env.SHARE_KV.delete(`alerts/${who.accountId}`);
  return json({ ok: true }, 200, origin);
}

async function alertsTest(req, env, origin) {
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  if (!env.VAPID_PRIVATE_KEY) return json({ error: "VAPID not configured" }, 503, origin);
  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  let sub = body.subscription;
  if (!sub && env.SHARE_KV) {
    const rec = JSON.parse((await env.SHARE_KV.get(`alerts/${who.accountId}`)) || "null");
    sub = rec?.subscription;
  }
  if (!sub?.endpoint) return json({ error: "no subscription" }, 400, origin);
  try {
    const r = await sendWebPush(env, sub, {
      title: "AgriVision — test 🔔",
      body: "Les alertes pluie fonctionnent. Tu seras prévenu avant la pluie sur tes parcelles.",
      tag: "agrivision-test",
      url: "./",
    });
    return json({ ok: r.ok, status: r.status, detail: r.ok ? null : await r.text() }, r.ok ? 200 : 502, origin);
  } catch (e) {
    return json({ error: e.message }, 500, origin);
  }
}

// Cron: poll the forecast for every subscriber's parcels; push when rain ≥ threshold comes.
async function runRainAlerts(env) {
  if (!env.SHARE_KV || !env.VAPID_PRIVATE_KEY) return;
  let cursor;
  do {
    const list = await env.SHARE_KV.list({ prefix: "alerts/", cursor });
    for (const k of list.keys) {
      try {
        const rec = JSON.parse((await env.SHARE_KV.get(k.name)) || "null");
        if (!rec?.subscription || !rec.parcels?.length) continue;
        let changed = false;
        let gone = false;
        rec.last_alert = rec.last_alert || {};
        for (const p of rec.parcels) {
          const fc = await fetchNextRain(p.lat, p.lon);
          if (!fc || fc.mm < (rec.threshold_mm || 2)) continue;
          const pkey = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
          if (rec.last_alert[pkey] === fc.date) continue; // already alerted for this event
          const r = await sendWebPush(env, rec.subscription, {
            title: "🌧️ Pluie prévue",
            body: `${p.label || "Parcelle"} : ~${fc.mm} mm le ${fc.date}`,
            tag: `rain-${pkey}`,
            url: "./",
          });
          if (r.status === 404 || r.status === 410) {
            gone = true;
            break;
          }
          rec.last_alert[pkey] = fc.date;
          changed = true;
        }
        if (gone) await env.SHARE_KV.delete(k.name);
        else if (changed) await env.SHARE_KV.put(k.name, JSON.stringify(rec));
      } catch {}
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
}

// Next upcoming day (within 2 days) with any forecast rain → { date, mm }.
async function fetchNextRain(lat, lon) {
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum&forecast_days=2&timezone=auto`
  );
  if (!r.ok) return null;
  const j = await r.json();
  const times = j.daily?.time || [];
  const pr = j.daily?.precipitation_sum || [];
  for (let i = 0; i < times.length; i++) {
    if ((pr[i] || 0) > 0) return { date: times[i], mm: Math.round(pr[i] * 10) / 10 };
  }
  return null;
}

// Default catalog window: last ~6 months up to "now". Date.now() is allowed in the Worker
// runtime (unlike workflow scripts).
function defaultDatetimeRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 183 * 24 * 3600 * 1000);
  return `${from.toISOString()}/${to.toISOString()}`;
}

// NDVI mean time series over a parcel geometry — the agronomic "vigor" signal. Uses the
// Sentinel Hub Statistical API: it aggregates per interval, masking clouds/no-data, and
// returns per-interval mean/min/max/stDev. We normalize to a compact series + the latest
// valid interval, which the SPA attaches to the parcel and injects into the AI prompt.
const NDVI_STATS_EVALSCRIPT = `//VERSION=3
function setup(){return {input:[{bands:["B04","B08","SCL","dataMask"]}],output:[{id:"ndvi",bands:1},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){
  // mask clouds/shadows/snow/water via the scene classification band
  var bad=[3,8,9,10,11], valid = s.dataMask===1 && bad.indexOf(s.SCL)<0 ? 1:0;
  var n=(s.B08-s.B04)/(s.B08+s.B04);
  return {ndvi:[n], dataMask:[valid]};
}`;

async function satelliteStatistics(req, env, origin) {
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  if (!env.CDSE_CLIENT_ID) return json({ error: "satellite not configured" }, 503, origin);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "bad body: " + e.message }, 400, origin);
  }
  const { geometry, from, to, intervalDays = 30 } = body || {};
  if (!geometry?.type) return json({ error: "geometry (GeoJSON) required" }, 400, origin);
  const now = new Date();
  const toD = to ? new Date(to) : now;
  const fromD = from ? new Date(from) : new Date(toD.getTime() - 120 * 24 * 3600 * 1000);
  try {
    const token = await getCdseToken(env);
    const r = await fetch(`${cdseBase(env)}/api/v1/statistics`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        input: {
          bounds: { geometry, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
          data: [{ type: env.CDSE_COLLECTION || CDSE.collection, dataFilter: {} }],
        },
        aggregation: {
          timeRange: { from: fromD.toISOString(), to: toD.toISOString() },
          aggregationInterval: { of: `P${Math.max(1, parseInt(intervalDays, 10) || 30)}D` },
          // Bounds CRS is EPSG:4326, so resx/resy are in DEGREES. ~0.00009° ≈ 10 m at
          // Réunion's latitude → genuine ~10 m Sentinel-2 pixels, not a 1-pixel collapse.
          resx: 0.00009,
          resy: 0.00009,
          evalscript: NDVI_STATS_EVALSCRIPT,
        },
        calculations: { ndvi: { statistics: { default: {} } } },
      }),
    });
    if (!r.ok) return json({ error: "statistics " + r.status, detail: await r.text() }, 502, origin);
    const j = await r.json();
    const series = (j.data || [])
      .map((d) => {
        const st = d.outputs?.ndvi?.bands?.B0?.stats || {};
        const valid = (st.sampleCount || 0) - (st.noDataCount || 0);
        return {
          from: d.interval?.from || null,
          to: d.interval?.to || null,
          mean: valid > 0 ? +Number(st.mean).toFixed(3) : null,
          min: valid > 0 ? +Number(st.min).toFixed(3) : null,
          max: valid > 0 ? +Number(st.max).toFixed(3) : null,
          valid,
        };
      })
      .filter((p) => p.mean != null)
      .sort((a, b) => (a.from < b.from ? -1 : 1));
    const latest = series.length ? series[series.length - 1] : null;
    return json({ series, latest }, 200, origin);
  } catch (e) {
    return json({ error: e.message }, 502, origin);
  }
}

// ============================================================================
// Billing (Stripe). Secret: STRIPE_SECRET_KEY (test/live). Webhook secret:
// STRIPE_WEBHOOK_SECRET (set after creating the webhook endpoint in Stripe).
// Per-user plan persisted at share/<sub>/plan.json:
//   { tier: "free"|"standard"|"premium", status, current_period_end,
//     stripe_customer_id, stripe_subscription_id, updated_at }
// ============================================================================
const STRIPE_API = "https://api.stripe.com";

async function stripeApi(env, method, path, params) {
  const opts = {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "stripe-version": "2024-11-20.acacia",
    },
  };
  if (params) {
    opts.headers["content-type"] = "application/x-www-form-urlencoded";
    opts.body = params instanceof URLSearchParams ? params.toString() : params;
  }
  const r = await fetch(`${STRIPE_API}${path}`, opts);
  return r;
}

// Resolve a lookup_key → price_id via Stripe API. Edge-cacheable since Prices change rarely.
async function resolvePriceByLookupKey(env, lookupKey) {
  const r = await stripeApi(
    env,
    "GET",
    `/v1/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`
  );
  const j = await r.json();
  return j.data?.[0]?.id || null;
}

async function loadPlan(env, accountId) {
  if (!env.SHARE_KV) return { tier: "free", status: "active" };
  const raw = await env.SHARE_KV.get(`share/${accountId}/plan.json`);
  if (!raw) return { tier: "free", status: "active" };
  try {
    return JSON.parse(raw);
  } catch {
    return { tier: "free", status: "active" };
  }
}

async function savePlan(env, accountId, plan) {
  if (!env.SHARE_KV) return;
  await env.SHARE_KV.put(
    `share/${accountId}/plan.json`,
    JSON.stringify({ ...plan, updated_at: new Date().toISOString() })
  );
}

// POST /api/billing/checkout — { lookup_key, success_url, cancel_url } → { checkout_url }
// ============================================================================
// Soil context. Brute-force nearest-N over 22.7k samples is ~5ms — no spatial index
// needed for PoC. Each call returns the nearest samples (truncated) plus aggregated
// median values for the user-facing soil card and for AI context injection.
// ============================================================================
function soilHaversineKmSq(lat1, lon1, lat2, lon2) {
  // Squared planar approximation is enough for ranking nearest points at this scale
  // (Réunion ~2500 km²). We compute true Haversine only on the top-N to report distance.
  const dy = lat1 - lat2;
  const dx = (lon1 - lon2) * Math.cos((lat1 * Math.PI) / 180);
  return dy * dy + dx * dx;
}
function soilHaversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function median(arr) {
  const xs = arr.filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

async function soilNearby(req, env, origin) {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const n = Math.min(20, Math.max(1, parseInt(url.searchParams.get("n") || "5", 10)));
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: "lat & lon required" }, 400, origin);
  // Coarse rectangular pre-filter to avoid scoring all 22.7k samples. ~10km box.
  const dBox = 0.1; // degrees ≈ 11 km
  const candidates = [];
  for (const r of SOIL_DATA.rows) {
    if (Math.abs(r[0] - lat) > dBox || Math.abs(r[1] - lon) > dBox) continue;
    candidates.push(r);
  }
  // If too few candidates in the box (e.g. user clicked offshore), widen.
  const sample = candidates.length >= n ? candidates : SOIL_DATA.rows;
  // Score by squared planar distance, then sort.
  const scored = sample.map((r) => ({ r, d2: soilHaversineKmSq(lat, lon, r[0], r[1]) }));
  scored.sort((a, b) => a.d2 - b.d2);
  const top = scored.slice(0, n).map(({ r }) => ({
    lat: r[0],
    lon: r[1],
    distance_km: Math.round(soilHaversineKm(lat, lon, r[0], r[1]) * 100) / 100,
    soil_type: SOIL_DATA.soil_types[r[2]] || null,
    land_use: SOIL_DATA.land_uses[r[3]] || null,
    year: r[4],
    pH_H2O: r[5],
    N_tot_g_kg: r[6],
    C_org_g_100g: r[7],
    P_OD_mg_kg: r[8],
    CEC_cmol_kg: r[9],
    K_ex_cmol_kg: r[10],
    Mg_ex_cmol_kg: r[11],
    Ca_ex_cmol_kg: r[12],
    Na_ex_cmol_kg: r[13],
    pF25_g_100g: r[14],
    pF42_g_100g: r[15],
  }));
  // Aggregated medians — the "typical of this zone" summary used by the AI context block.
  const agg = {
    pH_H2O: median(top.map((s) => s.pH_H2O)),
    N_tot_g_kg: median(top.map((s) => s.N_tot_g_kg)),
    C_org_g_100g: median(top.map((s) => s.C_org_g_100g)),
    P_OD_mg_kg: median(top.map((s) => s.P_OD_mg_kg)),
    CEC_cmol_kg: median(top.map((s) => s.CEC_cmol_kg)),
    K_ex_cmol_kg: median(top.map((s) => s.K_ex_cmol_kg)),
    Mg_ex_cmol_kg: median(top.map((s) => s.Mg_ex_cmol_kg)),
    Ca_ex_cmol_kg: median(top.map((s) => s.Ca_ex_cmol_kg)),
    pF25_g_100g: median(top.map((s) => s.pF25_g_100g)),
    pF42_g_100g: median(top.map((s) => s.pF42_g_100g)),
  };
  // Dominant soil + land-use class (modes).
  const tally = (arr) =>
    arr.reduce((acc, v) => {
      if (!v) return acc;
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, {});
  const dominantOf = (arr) => Object.entries(tally(arr)).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return json(
    {
      query: { lat, lon, n },
      samples: top,
      summary: {
        dominant_soil_type: dominantOf(top.map((s) => s.soil_type)),
        dominant_historical_land_use: dominantOf(top.map((s) => s.land_use)),
        median: agg,
        samples_count: top.length,
        nearest_km: top[0]?.distance_km ?? null,
        source: SOIL_DATA.source,
      },
    },
    200,
    origin
  );
}

// ============================================================================
// Feedback / contact form. Stores submissions in SHARE_KV under feedback/<ts>-<sub>.
// Admin can browse them via the wrangler KV UI or a future /api/feedback/list endpoint.
// ============================================================================
async function feedbackSubmit(req, env, origin) {
  if (!env.SHARE_KV)
    return json({ error: "SHARE_KV not configured — feedback temporarily unavailable" }, 503, origin);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json body" }, 400, origin);
  }
  const subject = String(body?.subject || "").slice(0, 100);
  const message = String(body?.message || "")
    .trim()
    .slice(0, 5000);
  if (!message) return json({ error: "message required" }, 400, origin);
  // Optional auth — if a session bearer is sent, attach the sub for correlation.
  let sub = "anonymous";
  let email = null;
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer) {
    const claims = await verifyAgriSession(env, bearer);
    if (claims) {
      sub = claims.sub;
      email = claims.email;
    }
  }
  const ts = new Date().toISOString();
  const key = `feedback/${ts.replace(/[:.]/g, "-")}-${sub.slice(0, 60)}`;
  const record = {
    sub,
    email,
    subject,
    message,
    context: body?.context || {},
    submitted_at: ts,
    ip: req.headers.get("cf-connecting-ip") || null,
    country: req.headers.get("cf-ipcountry") || null,
  };
  await env.SHARE_KV.put(key, JSON.stringify(record));
  return json({ ok: true, key }, 200, origin);
}

// ============================================================================
// Mistral AI adapter. Accepts an Anthropic-shaped payload, translates to OpenAI-
// compatible Mistral format, calls the Mistral API, normalizes the response back
// to Anthropic shape. Per-user token quota uses the same TIER_QUOTAS as Anthropic
// (we don't double-count: each provider counts its own tokens into the same bucket).
// ============================================================================

// Translate Anthropic-format messages → Mistral OpenAI-style.
//   Anthropic: { role, content: [{type:"image", source:{type:"base64",media_type,data}}, {type:"text",text}] }
//   Mistral:   { role, content: [{type:"image_url", image_url:"data:<mime>;base64,<data>"}, {type:"text",text}] }
function toMistralMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: String(system) });
  for (const m of messages || []) {
    const role = m.role || "user";
    if (typeof m.content === "string") {
      out.push({ role, content: m.content });
      continue;
    }
    const parts = [];
    for (const block of m.content || []) {
      if (block?.type === "image" && block.source?.type === "base64") {
        const mime = block.source.media_type || "image/jpeg";
        parts.push({
          type: "image_url",
          image_url: `data:${mime};base64,${block.source.data}`,
        });
      } else if (block?.type === "text") {
        parts.push({ type: "text", text: block.text || "" });
      }
    }
    out.push({ role, content: parts });
  }
  return out;
}

async function mistralAnalyze(req, env, origin) {
  if (!env.MISTRAL_API_KEY) return json({ error: "MISTRAL_API_KEY not configured" }, 503, origin);
  // Same gating as /api/analyze: in production (SHARE_KV bound), require paid plan.
  let identifiedAccount = null;
  if (env.SHARE_KV) {
    const auth = req.headers.get("authorization");
    if (!auth)
      return json(
        {
          error: "ai_requires_signin",
          message: "Connecte-toi et passe à un plan payant pour utiliser l'IA.",
        },
        402,
        origin
      );
    const who = await resolveAccount(req, env);
    if (who.error) return json({ error: who.error }, who.status, origin);
    const plan = await loadPlan(env, who.accountId);
    const limits = quotasForTier(plan.tier);
    if (limits.max_tokens_in_per_period === 0)
      return json(
        {
          error: "ai_requires_paid_plan",
          message: "L'IA est réservée aux plans Standard et Premium.",
          tier: plan.tier,
        },
        402,
        origin
      );
    const q = await loadQuota(env, who.accountId);
    if (q.tokens_in >= limits.max_tokens_in_per_period)
      return json(
        {
          error: "tokens_in_quota_exceeded",
          current: q.tokens_in,
          max: limits.max_tokens_in_per_period,
          tier: plan.tier,
        },
        429,
        origin
      );
    if (q.tokens_out >= limits.max_tokens_out_per_period)
      return json(
        {
          error: "tokens_out_quota_exceeded",
          current: q.tokens_out,
          max: limits.max_tokens_out_per_period,
          tier: plan.tier,
        },
        429,
        origin
      );
    identifiedAccount = who.accountId;
  }
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "bad json body: " + e.message }, 400, origin);
  }
  const mistralBody = {
    model: body.model || "pixtral-12b-2409",
    messages: toMistralMessages(
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((s) => s.text).join("\n\n")
          : "",
      body.messages
    ),
    max_tokens: body.max_tokens || 2000,
  };
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(mistralBody),
  });
  const mj = await r.json();
  if (!r.ok || mj.error)
    return json(
      { error: mj.error?.message || mj.message || "HTTP " + r.status, details: mj },
      r.status || 500,
      origin
    );
  const text = mj.choices?.[0]?.message?.content ?? "";
  const usage = mj.usage || {};
  const inTok = usage.prompt_tokens || 0;
  const outTok = usage.completion_tokens || 0;
  // Bump per-user counters using the same TIER_QUOTAS bucket as Anthropic.
  if (identifiedAccount && env.SHARE_KV) {
    const q = await loadQuota(env, identifiedAccount);
    q.tokens_in += inTok;
    q.tokens_out += outTok;
    q.writes = (q.writes || 0) + 1;
    await saveQuota(env, identifiedAccount, q);
  }
  // Normalize to Anthropic shape so callers don't fork.
  return json(
    {
      id: mj.id || null,
      type: "message",
      role: "assistant",
      model: mistralBody.model,
      content: [{ type: "text", text }],
      usage: { input_tokens: inTok, output_tokens: outTok },
      provider: "mistral",
    },
    200,
    origin
  );
}

// GET /api/billing/prices — public, no auth. Returns active Stripe Prices keyed by
// lookup_key so the client renders the **actual** configured prices (currency, interval,
// amount) instead of hardcoded display strings that drift over time.
async function billingPrices(req, env, origin) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "STRIPE_SECRET_KEY not configured" }, 503, origin);
  const lookupKeys = ["standard_monthly", "standard_yearly", "premium_monthly", "premium_yearly"];
  const params = new URLSearchParams();
  for (const k of lookupKeys) params.append("lookup_keys[]", k);
  params.append("active", "true");
  params.append("expand[]", "data.product");
  const r = await stripeApi(env, "GET", `/v1/prices?${params}`);
  const j = await r.json();
  if (!j.data) return json({ error: "Stripe price fetch failed", details: j }, 500, origin);
  const out = {};
  for (const price of j.data) {
    if (!price.lookup_key) continue;
    out[price.lookup_key] = {
      lookup_key: price.lookup_key,
      currency: price.currency,
      amount_cents: price.unit_amount,
      recurring_interval: price.recurring?.interval, // "month" | "year"
      recurring_interval_count: price.recurring?.interval_count || 1,
      product_name: price.product?.name || null,
      tax_behavior: price.tax_behavior || null, // "inclusive" | "exclusive" | "unspecified"
    };
  }
  return json({ prices: out, fetched_at: new Date().toISOString() }, 200, origin);
}

async function billingCheckout(req, env, origin) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "STRIPE_SECRET_KEY not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json body" }, 400, origin);
  }
  const lookupKey = body?.lookup_key;
  if (!lookupKey) return json({ error: "lookup_key required" }, 400, origin);
  const tier = tierFromLookupKey(lookupKey);
  if (!tier) return json({ error: "unknown lookup_key: " + lookupKey }, 400, origin);
  const priceId = await resolvePriceByLookupKey(env, lookupKey);
  if (!priceId) return json({ error: "no active Stripe Price with lookup_key=" + lookupKey }, 404, origin);

  // Reuse the existing Stripe customer if we have one, else create + cache.
  const plan = await loadPlan(env, who.accountId);
  let customerId = plan.stripe_customer_id || null;
  if (!customerId) {
    const cp = new URLSearchParams();
    if (who.email) cp.append("email", who.email);
    cp.append("metadata[agri_sub]", who.accountId);
    const cr = await stripeApi(env, "POST", "/v1/customers", cp);
    const cj = await cr.json();
    if (!cj.id) return json({ error: "customer creation failed", details: cj }, 500, origin);
    customerId = cj.id;
    plan.stripe_customer_id = customerId;
    await savePlan(env, who.accountId, plan);
  }

  // Create the Checkout Session.
  // `ui_mode: "embedded"` (requested by the client) keeps the payment form inside our own
  // modal via Stripe.js — no full-page redirect. It returns a `client_secret` instead of a
  // hosted `url`, and uses a single `return_url` (Stripe redirects the top window there only
  // AFTER a successful payment). The hosted flow (default) is kept as a fallback.
  const embedded = body.ui_mode === "embedded";
  const p = new URLSearchParams();
  p.append("mode", "subscription");
  p.append("customer", customerId);
  p.append("line_items[0][price]", priceId);
  p.append("line_items[0][quantity]", "1");
  if (embedded) {
    p.append("ui_mode", "embedded");
    // Must contain the {CHECKOUT_SESSION_ID} template; Stripe substitutes the real id.
    p.append(
      "return_url",
      body.return_url || "https://example.com/?billing=success&session_id={CHECKOUT_SESSION_ID}"
    );
  } else {
    p.append("success_url", body.success_url || "https://example.com/?billing=success");
    p.append("cancel_url", body.cancel_url || "https://example.com/?billing=cancel");
  }
  // Don't set payment_method_types: Checkout then auto-shows the methods enabled in the
  // Stripe Dashboard (CB, SEPA, etc.) based on the customer's country. Note:
  // `automatic_payment_methods` is a PaymentIntent param and is INVALID on Checkout Sessions.
  p.append("client_reference_id", who.accountId);
  p.append("metadata[agri_sub]", who.accountId);
  p.append("metadata[tier]", tier);
  p.append("subscription_data[metadata][agri_sub]", who.accountId);
  p.append("subscription_data[metadata][tier]", tier);
  const sr = await stripeApi(env, "POST", "/v1/checkout/sessions", p);
  const sj = await sr.json();
  if (embedded) {
    if (!sj.client_secret)
      return json({ error: "embedded checkout session creation failed", details: sj }, 500, origin);
    return json({ client_secret: sj.client_secret, session_id: sj.id }, 200, origin);
  }
  if (!sj.url) return json({ error: "checkout session creation failed", details: sj }, 500, origin);
  return json({ checkout_url: sj.url, session_id: sj.id }, 200, origin);
}

// POST /api/billing/portal → { portal_url } — Stripe-hosted self-service for the user
// to manage their subscription (cancel, swap card, view invoices).
async function billingPortal(req, env, origin) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "STRIPE_SECRET_KEY not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  const plan = await loadPlan(env, who.accountId);
  if (!plan.stripe_customer_id) return json({ error: "no stripe customer for this user yet" }, 404, origin);
  let body = {};
  try {
    body = await req.json();
  } catch {}
  const p = new URLSearchParams();
  p.append("customer", plan.stripe_customer_id);
  p.append("return_url", body.return_url || "https://example.com/?billing=return");
  const r = await stripeApi(env, "POST", "/v1/billing_portal/sessions", p);
  const j = await r.json();
  if (!j.url) return json({ error: "portal session failed", details: j }, 500, origin);
  return json({ portal_url: j.url }, 200, origin);
}

// Verify a Stripe webhook signature (Stripe-Signature header: "t=…,v1=…").
// Returns the parsed event on success, null on any failure.
async function verifyStripeWebhook(env, req, rawBody) {
  const sigHeader = req.headers.get("stripe-signature");
  if (!sigHeader || !env.STRIPE_WEBHOOK_SECRET) return null;
  const parts = {};
  for (const seg of sigHeader.split(",")) {
    const [k, v] = seg.split("=");
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  }
  const ts = parts.t?.[0];
  const v1 = parts.v1 || [];
  if (!ts || v1.length === 0) return null;
  // Replay protection: 5-minute tolerance.
  if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return null;
  const payload = `${ts}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (!v1.includes(expected)) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

// POST /api/billing/webhook — Stripe events that mutate the user's plan in KV.
// Idempotent: each event_id is stored in `stripe_events/<id>` with a 30-day TTL so retries
// (Stripe retries up to 3 days) don't double-process.
async function billingWebhook(req, env, origin) {
  const rawBody = await req.text();
  const event = await verifyStripeWebhook(env, req, rawBody);
  if (!event) return json({ error: "invalid signature" }, 400, origin);
  if (env.SHARE_KV) {
    const dedupeKey = `stripe_events/${event.id}`;
    const seen = await env.SHARE_KV.get(dedupeKey);
    if (seen) return json({ ok: true, deduped: true }, 200, origin);
    await env.SHARE_KV.put(dedupeKey, "1", { expirationTtl: 30 * 86400 });
  }
  const obj = event.data?.object || {};
  const agriSub = obj.metadata?.agri_sub || obj.subscription_details?.metadata?.agri_sub;

  // Subscription lifecycle: created / updated / deleted.
  if (event.type.startsWith("customer.subscription.")) {
    const sub = obj;
    const tier = tierFromLookupKey(sub.items?.data?.[0]?.price?.lookup_key) || "free";
    const finalTier = event.type === "customer.subscription.deleted" ? "free" : tier;
    if (agriSub) {
      const plan = await loadPlan(env, agriSub);
      plan.tier = finalTier;
      plan.status = sub.status || "active";
      plan.current_period_end = sub.current_period_end || null;
      plan.stripe_customer_id = sub.customer || plan.stripe_customer_id;
      plan.stripe_subscription_id = sub.id;
      await savePlan(env, agriSub, plan);
    }
  }
  // Invoice events — useful for grace periods and dunning later. PoC just logs status.
  if (event.type === "invoice.payment_failed" && agriSub) {
    const plan = await loadPlan(env, agriSub);
    plan.status = "past_due";
    await savePlan(env, agriSub, plan);
  }
  return json({ ok: true, type: event.type }, 200, origin);
}

async function shareQuota(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV binding not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  const q = await loadQuota(env, who.accountId);
  const plan = await loadPlan(env, who.accountId);
  return json({ quota: q, limits: quotasForTier(plan.tier), plan }, 200, origin);
}

async function shareStatus(req, env, origin) {
  if (!env.SHARE_KV) return json({ error: "SHARE_KV binding not configured" }, 503, origin);
  const who = await resolveAccount(req, env);
  if (who.error) return json({ error: who.error }, who.status, origin);
  const raw = await env.SHARE_KV.get(`share/${who.accountId}/last_sync.json`);
  return json({ enabled: !!raw, last_sync: raw ? JSON.parse(raw) : null }, 200, origin);
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}
