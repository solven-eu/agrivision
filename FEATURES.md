# AgriVision — Feature Reference

AgriVision is a **farmer's personal assistant**: from a phone camera and a map click it helps an
individual grower (and small cooperatives) **locate** their parcels, **document** fields with
photos, **analyse** crops with AI (identification, phenology, vigour, yield, market value),
**diagnose** disease pressure with per-treatment economics, and **persist** the whole working
session to their own cloud.

**Primary market:** France métropolitaine + DOM-TOM, current focus **La Réunion** (crop catalogs,
prices, treatments and créole dialects reflect that).

This document is organised by **technical feature domain**. Shipped features are described as
implemented; forward-looking work lives in [`ROADMAP.md`](./ROADMAP.md).

---

## 1. Identity & access

### 1.1 Multi-provider authentication (BFF pattern)
The SPA authenticates with an external Identity Provider, then trades that proof for an
**AgriVision-signed session JWT** minted by the Cloudflare Worker. Every subsequent API call carries
`Authorization: Bearer <agri_session>`; the Worker verifies only its own HMAC signature on the hot
path.

- **Dropbox** — OAuth 2.0 PKCE (App-folder scope), `id_token` verified server-side.
- **Google** — Google Identity Services `credential` (RS256 id_token, verified against Google JWKS).
- **Facebook** — Graph `debug_token` verification of the access token.
- **Session JWT** — HS256, namespaced `sub` (`dropbox:…`, `google:…`, `facebook:…`), with claims
  `provider`, `email`, `email_verified`, `created_at`, `jti`, `exp`. Sliding refresh + server-side
  revocation list (`/api/auth/refresh`, `/api/auth/logout`).

### 1.2 Email anchor & verification
One **verified** email maps to one account (block-don't-merge): a verified email *claims* an anchor;
a provider that doesn't assert verification (Facebook) can still create a sub-only account but
can't claim an email already owned. The session carries `email_verified`; the dashboard **flags an
unverified email** with an actionable warning. (Self-service email verification is on the roadmap.)

### 1.3 Account record & creation date
Each account has a sub-keyed record (`account/<sub>.json`) stamping its **first-seen date**, carried
in the session JWT — used for early-adopter gating without an extra lookup.

### 1.4 Organizations (financed plans)
An optional concept letting a grower's plan be **financed by a larger entity** (mairie, département,
région, collectivité, banque, programme de soutien). Modeled as an **org ↔ users table**, with the
plan **inherited** by members (highest tier wins). Membership is matched by:
- **`email_pattern`** regex — `".*"` = everybody, `"@domain\\.re$"` = a whole domain in one line;
- an optional **KV roster** (`org/<id>/members.json`, by sub or email) for ad-hoc members;
- an optional **`created_before`** date gate (early adopters).

Targeted (domain/roster) matches require a **verified** email to prevent impersonation; universal
promos opt out. Ships with an implicit **"Early Birds"** org granting Standard to accounts created
before a cutoff. Inheritance is computed at read time and never persisted.

### 1.5 Plans, quotas & billing
- **Tiers** (`plan-features.js`, the single source shared by Worker + SPA): **Free / Standard /
  Premium**, each defining parcel cap, photo caps (count + bytes), AI token quotas, allowed models,
  and feature flags (diseases, market data, ensemble/debate AI, KV mirror, events).
- **Server-side enforcement** — quotas are the ceiling, enforced per user in the Worker (tokens,
  photos, storage, KV writes). Free is capped tight.
- **Stripe billing** — **Embedded Checkout** mounted inside an in-app modal (no full-page redirect;
  hosted-redirect fallback), Customer Portal, webhook → KV plan updates. Live prices fetched from
  Stripe so the UI never drifts.
- **Loud, actionable gating** — a blocked action (plan cap or not-logged-in) emits a structured
  event rendered as a toast with a one-tap fix ("Améliorer mon plan" / "Se connecter").

---

## 2. Mapping & geospatial

### 2.1 Base map (OpenStreetMap + Leaflet)
Leaflet map with **OpenStreetMap** raster tiles as the basemap. Basemap install is deferred at boot
to avoid a tile cascade before the view is set.

### 2.2 IGN Géoplateforme layers (`data.geopf.fr`)
- **RPG (Registre Parcellaire Graphique) 2024 — categorized** agricultural parcels as a WMS overlay
  (covers métropole + DOM since IGN's 2024 release, so La Réunion parcels are included), coloured by
  crop category, with an in-app colour legend.
- **Cadastre** (`PARCELLAIRE_EXPRESS`) optional WMS overlay (all parcels, agricultural or not).
- **WFS GetFeature** for click-to-identify parcel geometry + `code_cultu`.

### 2.3 Geocoding & geolocation
- **BAN** (Base Adresse Nationale, `api-adresse.data.gouv.fr`) address search.
- Browser **geolocation** to jump to the user's position.
- **Sun/moon compass** widget (azimuth/elevation) to reason about exposure and photo lighting.

---

## 3. Parcels

### 3.1 Single-click selection
Click the map → **WFS GetFeature** in a small bbox → **point-in-polygon** disambiguation → toggle
the parcel into the selection. Each selected parcel is highlighted with a crop emoji at its
centroid.

### 3.2 Multi-select + lock
Multiple parcels form one working "culture". A **lock** prevents accidental add/remove: when locked,
a map click resolves **locally** against already-selected geometry (no wasted WFS call) — clicking a
selected parcel focuses it; clicking elsewhere **blinks the lock badge**. Free plan always allows at
least one parcel regardless of caps.

### 3.3 Soil × crop fit scoring
Per-parcel **culture-fit** score (`culture-fit.js`): scores how well the parcel's measured soil
suits a crop, with per-parameter sliders showing the optimum band and the parcel's value. Suggests
recommended crops on parcels with no declared culture.

### 3.4 Automated parcel configuration from photo + AI
When the RPG declares no crop (or to cross-check), **Claude Vision identifies the dominant crop**
from the field photos and the parcel is configured from that inference (crop, phenology), combined
with the official RPG prior when available.

---

## 4. Photos

- **Capture** — camera-first on mobile (`capture="environment"`) or file picker; multi-photo.
- **EXIF** — GPS latitude/longitude + image direction read automatically; capture date (`takenAt`).
- **Manual placement + aim** — fallback to place a photo on the map and set its heading by hand.
- **FOV cones** — each located photo draws a field-of-view cone on the map (position + bearing).
- **Compression** — images are recompressed on upload to fit plan byte caps; a manual **"reduce
  quality"** action reclaims local storage.
- Photos feed the AI as visual ground truth and anchor disease detections (spatial x/y markers).

---

## 5. AI & conversational intelligence

### 5.1 Provider abstraction (Claude + Mistral)
A single `ask(provider, payload)` entry point (`ai-providers.js`), Anthropic-shaped in and out:
- **Anthropic Claude** (default `claude-haiku-4-5`) — vision + reasoning, via the Worker proxy
  (`/api/analyze`) which hides the API key; optional direct-call fallback for local dev.
- **Mistral** (`pixtral-12b-2409` and family) — via the Worker (`/api/mistral`); French/EU provider,
  orthogonal failure modes. (Multi-provider **ensemble / debate** cross-checking is on the roadmap.)
- **Prompt caching** — the long system prompt (role + methodology + schema + few-shot) is marked
  `cache_control: ephemeral`; per-request messages carry only the variable context.

### 5.2 Crop & field analysis
From photos + parcel/soil/altitude/climate context, the model returns a structured analysis:
**crop identification** (confidence), **phenology** (BBCH stage, maturity, expected harvest window),
**vigour**, **expected yield** (t/ha + total), and **indicative market price + total value**.

### 5.3 Disease diagnosis & treatment economics
A disciplined 3-step funnel per disease (`schemas.js`, `prompts.js`): **base rate** (region × crop ×
season) → **evidence on this field** (supporting / against / missing, with "go take this photo"
guidance) → **conclusion** (probability + unknown rate). Plus progression speed, impact scenarios
(optimistic/neutral/pessimistic), and per-treatment **economics**: materials + labour hours × €/h +
equipment, success probability × recovery × crop value → **expected net benefit**.

### 5.4 Conversational chat
Multi-turn chat over the field context — usable **even without a parcel** (ask for help, submit a
document). Free-text + photo composer, action chips, report generation, **speech-to-text**
(`speech.js`), and **token tracking** with soft/hard caps (`tokens.js`).

### 5.5 Localisation & dialects
User-facing model output supports a `name_local` slot for **créole réunionnais (`rcf`)** and
**créole antillais (`gcf`)**; the conversation tracks and adapts the dialect, never inventing
unattested local terms.

---

## 6. Contextual datasets & interpolation

These enrich the AI context block and on-screen cards so the model reasons from observed data, not
just the photos.

### 6.1 Soil (CIRAD interpolation)
Hardcoded **soil study dataset from CIRAD** (CIRAD Dataverse, ~22.7k samples). The Worker
(`/api/soil`) does brute-force **nearest-N interpolation** (~5 ms) returning the nearest samples +
**aggregated median** soil values, rendered as a soil card and injected into the AI context. Cached
per-coordinate in localStorage (~30 days; soil is static).

### 6.2 Elevation
**IGN RGE ALTI** (5 m métropole, 5–25 m DOM incl. Réunion) per-parcel altitude → exposure hints.

### 6.3 Weather & climate
- **Open-Meteo** forecast (rain/water card, alert thresholds).
- **Climate normals** — static 1991–2020 monthly normals for La Réunion (`seasonal-normals.js`):
  rainfall windward/leeward, temperature, cyclone window — injected into every AI call + a
  "Climatologie locale" card. (Dynamic ENSO / seasonal forecast is on the roadmap.)

### 6.4 Satellite (Sentinel-2 / Copernicus)
Worker-proxied **Copernicus Data Space Ecosystem (CDSE)** Sentinel-2: a timeline of available
acquisitions (date + cloud cover) and a true-colour or **NDVI (vigour)** overlay on the map, merged
with photo dates into one chronological history. (Per-parcel clipping, NDVI stats into the prompt,
and time-series change detection are on the roadmap.)

### 6.5 Hydrology & events
- **Vigicrues** flood-monitoring stations near the parcels.
- **Events feed** — open RSS / Open-Meteo feeds for local agricultural-relevant events.

### 6.6 Catalogs & prices
- **Crop / disease / treatment catalog** (`catalog.json`) keyed by RPG `code_cultu` (FR /
  scientific / emoji / dialect names / image), with offline inline defaults.
- **Image lookup** fallback chain: local catalog → **Wikipedia** REST (FR then EN) → **iNaturalist**
  taxa.
- **Market prices** — **RNM / FranceAgriMer** defaults, with per-crop user override.

---

## 7. Storage & persistence

The architecture separates **data** (user-owned) from **preferences** (local) from **app-owned
server state**.

### 7.1 Dropbox (user-owned cloud)
PKCE OAuth, **App-folder scope** (`/Apps/AgriVision/` only, no client secret). Sessions —
parcels + photos + analysis + conversation — are saved as a `culture.json` manifest plus photo
files under `/crops/<code>/cultures/<id>/`, and auto-restored on reload.

### 7.2 Local-first mirror (localStorage)
The full working session (parcels + inline photo bytes + analysis + chat) is mirrored to
localStorage so it **survives a reload with no Dropbox at all**, and seeds the upload when the user
connects Dropbox later. Split storage (small manifest rewritten often, large photo bytes only when
changed), a `pagehide` flush, and load-suspension guards keep it correct and cheap.

### 7.3 Cloudflare KV (app-owned server state)
Opt-in "Share with AgriVision" mirror of the manifest (+ photos) for cross-device restore; plus
per-user **quotas**, **plans**, **org rosters**, **account records**, and the email anchor. Secrets
are never stored server-side (per the strict CLAUDE.md rule) — identity is derived from verifiable
claims.

### 7.4 PWA & offline
Installable PWA (`manifest.webmanifest` + service worker): app-shell precache, stale-while-revalidate
for code, network-first HTML. A **force-refresh** control clears SW caches + unregisters the worker
(without touching the user's data).

### 7.5 Storage-health guard
Monitors localStorage usage, warns before the ~5 MB cap with a one-tap **compress photos** action,
and degrades writes gracefully on `QuotaExceededError`.

---

## 8. Engagement & UX

- **Gamification** — a "Dossier de culture · N%" completeness ring + checklist scoring parcels,
  mapped-vs-declared surface, photo count/freshness/coverage, and diagnostic recency, each with a
  one-tap CTA (`gamification.js`).
- **Rain alerts** — opt-in **Web Push** notifications when rain ≥ threshold is forecast for the
  user's parcels (cron in the Worker).
- **Toasts & gating** — central transient-feedback + plan/login gate system.
- **Theming** — light "biotech" theme (moss-green + gold, Fraunces/Inter type) matching
  agrivision.re.
- **Mobile-first drawer**, FAB, full-row-clickable sections.

---

## 9. Architecture & security notes

- **Frontend** — native ES modules (no build step), `index.html` + `styles.css` + `js/*` modules.
- **Backend** — a single **Cloudflare Worker** (`worker/`) proxying Anthropic/Mistral/CDSE/soil,
  minting/verifying the session JWT, and enforcing quotas; KV for app state; Stripe for billing.
- **Privacy** — GPS-bearing photos, parcel selections and analyses leave the browser only through
  the user's own Dropbox or the AgriVision proxy/KV the user opts into. No third-party analytics.
- **Secrets rule** — the user's secret material (Dropbox tokens, OAuth bearers, raw id_tokens) is
  never persisted in AgriVision-controlled storage; backend identity is a verifiable `sub` claim.
- **Abuse posture** — quotas are the ceiling, not reflexive rate-limiting; Free is capped tight.

---

## 10. Roadmap

Queued enhancements (multi-AI ensemble/debate, treatments catalog, POV photo grouping, conversation
compaction, full rentability modeling, email verification, map rotation, satellite v2+, …) are
detailed in [`ROADMAP.md`](./ROADMAP.md).
