# Roadmap

## Climate context — dynamic ENSO + seasonal forecast integration

Today (v1, shipped): `js/seasonal-normals.js` carries static 1991-2020 monthly normals for La Réunion (rainfall windward/leeward, temperature, cyclone window) and injects them into every AI call's context block plus a "🗓️ Climatologie locale" card in the sidebar. That covers the "typical seasonality" question — raining seasons, cyclone window, normal temps — and the AI can reason about disease pressure and treatment timing accordingly.

What's missing — and what to add when the value is clearer:

- **v2 — NOAA CPC ENSO Diagnostic Discussion** monthly. Free REST + RSS feed. Adds a single field to the climate block: `phase: "neutral" | "el_nino" | "la_nina"` + `strength: "weak" | "moderate" | "strong"`. Réunion impact: El Niño = drier-than-normal saison cyclonique (lower cyclone count but more drought stress on canne mi-pente); La Niña = wetter + cyclone-prone. The AI prompt would mention this so disease pressure and irrigation recommendations adjust.
- **v3 — Copernicus Climate Change Service (C3S) seasonal forecast** (3-6 month outlook). Free with a CDS account, returns probability of temperature + precipitation anomalies by region. Higher resolution than ENSO alone. Best value: ahead-of-season recommendations ("the next 3 months are forecast 40 % more rainy than normal → plant resistant cultivars + plan extra fungicide passes"). Higher build cost: CDS API requires auth + their data model needs a Worker route to mediate.
- **v4 — In-prompt ENSO reasoning**. The AI is told _what_ the ENSO state is but not necessarily _how_ it affects Réunion crops. v4 = a curated impact matrix (per crop × per ENSO phase: yield delta, disease shift, harvest window shift) that the prompt uses to reason concretely instead of relying on the model's training-data recall.

**Why we're deferring this** (user's call): the value of pushing static normals to the AI is concrete and immediate (the model already uses them effectively). ENSO state is one number per month — useful but marginal unless we also wire the impact-matrix reasoning (v4), which is real agronomic work. Worth revisiting once we see how often the AI's recommendations need climate-trend-aware tweaks in practice.

## Multi-AI ensemble — cross-validate suggestions across providers before showing the user

Today every analysis goes through a single Claude model (`claude-haiku-4-5` by default). That's fast and cheap, but every model has its blind spots: Haiku can miss subtle disease symptoms, get cultivars wrong, or be overconfident on a poor-quality photo. Right now the user sees a single "oracle" answer with no cross-check.

**Goal:** treat AI providers as interchangeable adapters, and for high-stakes outputs (disease diagnosis, treatment recommendations, cost projections) ask **at least two** before showing the user. When they agree, show a normal result. When they disagree, surface the disagreement — that's a real signal to the farmer that the field needs more photos / a human agronomist.

**Phasing:**

- **v1 — Provider abstraction**. Extract the Anthropic call out of `analyze.js` + `chat.js` into a `js/ai-client.js` with `ask(provider, { system, messages, schema })`. Backends: Anthropic (existing), Mistral (`mistral-large-latest` + `pixtral-large` for vision), OpenAI (`gpt-4o` for comparison), local Ollama (dev). New Worker secrets: `MISTRAL_API_KEY`, `OPENAI_API_KEY`. Per-provider pricing table in `tokens.js` for honest cost accounting.
- **v2 — Provider choice per call**. Cheap quick-analyze calls (photo tagging) stay on the cheapest model (Haiku or Mistral Small). The disease funnel + treatment economics — high-stakes — get routed to the _most_ capable model available (Sonnet, Mistral Large, GPT-4o).
- **v3 — Ensemble mode (parallel)** — available on Standard+. For disease + treatment outputs, fire 2-3 providers in parallel:
  - All three agree on `name_fr` and `presence_probability_0_1 > 0.5` → show the consensus answer.
  - Disagreement on identification → show a "L'IA est incertaine" badge and the alternatives, with an "Add a closer photo of …" call-to-action.
  - Disagreement on treatment economics → surface the range (`€80-€240/ha selon le modèle`) instead of a false-precision single number.
- **v4 — Conversation-between-AIs (sequential, debating)** — **Premium-only**. For the disease funnel, have model A produce an initial diagnosis with its `evidence.missing` list, then have model B critique it ("what would you ask for that A didn't?"), iterate 1-2 turns, then show the synthesized result to the user. Meaningfully more expensive but the agronomic value is real on edge cases. The Premium upsell narrative: "Sur les diagnostics complexes, ton plan Premium fait débattre deux IA pour t'offrir l'avis le plus fiable."

**Why Mistral specifically:**

- French company, EU data residency on request — relevant for GDPR + DGCCRF compliance on agronomic advice.
- `pixtral-large` is competitive with Sonnet on vision and ~30% the cost.
- Independent training data → genuinely orthogonal failure modes from Anthropic (vs OpenAI, where there's more overlap in failure modes due to similar training pipelines).

**Cost implications:**

- Token quotas (Standard 100k in / 20k out, Premium 1M / 200k) are currently sized for single-provider Haiku. Ensemble mode multiplies cost N×. Either keep ensemble paid-only, or route ensemble through the cheapest available provider per slot.
- Per-provider unit costs go in `tokens.js` `PRICING` so the existing cost-tracker (in `?debug`) keeps working across providers without changing UI.

**Connection to other roadmap items:**

- Depends on the existing BFF auth (already done) — the per-call provider routing decision is a function of the user's tier.
- The `treatments catalog` work intersects: when two AIs propose different treatments, the catalog acts as the tiebreaker (only one is actually authorized in this region for this crop).

## First-party auth (BFF) — verify IdP signatures, mint our own session JWT

Currently the share/quota feature attributes calls to a user by accepting the Dropbox OIDC `id_token` (header `X-DBX-IdToken`) and decoding the JWT payload in the Worker — **without verifying the signature**. There's a `TODO before prod use` comment but the gap is real: a malicious client can forge any `sub` and deplete or pollute another user's quota.

**Goal:** federated identity → first-party session. The SPA authenticates with any IdP (Dropbox today, Google / GitHub / Apple later), trades the IdP proof for an AgriVision-signed session JWT minted by our Worker, and uses that for all subsequent API calls. The Worker only needs to verify _one_ signature (its own) on steady-state requests.

**Flow:**

```
SPA  → IdP (Dropbox openid / Google / …)            → IdP id_token (JWT)
SPA  → POST /api/auth/login { id_token, provider }
Worker:
  - Fetch + cache the IdP's JWKS (24h edge cache)
  - Verify JWT signature with crypto.subtle.verify (RS256)
  - Verify issuer, audience, exp, nbf
  - Mint our JWT (HS256 with a CF Worker secret):
      { sub: "dropbox:<dbx_sub>",   // namespaced per provider
        aud: "agrivision",
        iat, exp (~7d),
        jti,
        provider: "dropbox",
        email?: "..." }
  - Return { agri_session: <jwt> }
SPA  → stores in localStorage as `agri_session`
SPA  → Authorization: Bearer <agri_jwt>  on every Worker call
Worker → HMAC-verify own signature only, read `sub` claim, done.
```

**Why the BFF JWT and not just keep verifying the IdP token per request?**

- One signature scheme to verify in the hot path, regardless of how many IdPs we add later.
- We control TTL, audience, and per-request claims (`scope`, `role`, etc.).
- Revocation is ours: a `revoked_jti` set in KV, checked per request, is enough.
- Multi-IdP migration is trivial — `sub` is namespaced (`dropbox:…`, `google:…`), so KV keys don't shift even if the user later swaps IdP.
- Honors the [CLAUDE.md security rule](./CLAUDE.md#security-never-store-user-secrets-in-our-own-databases): the user's IdP access token / refresh token never touches our servers.

**Phasing:**

- **v0 (now)**: this entry exists; PoC keeps the unverified-decode path with the comment.
- **v1**: Dropbox-only login. `POST /api/auth/dropbox/login` fetches `https://www.dropbox.com/.well-known/openid-configuration`, caches the JWKS, verifies RS256 signature, mints HS256 AgriVision JWT. New CF secret `AGRI_JWT_SECRET`. Swap `X-DBX-IdToken` → `Authorization: Bearer <agri_jwt>` in share + analyze attribution. About 100 LOC.
- **v2**: Google login (`accounts.google.com` JWKS). Same `/api/auth/google/login` endpoint, new `sub` prefix.
- **v3**: refresh + revocation. `POST /api/auth/refresh` issues a new JWT (sliding session). `revoked_jti` set in KV, checked on every Worker call; `POST /api/auth/logout` adds the current `jti` to that set with TTL = JWT exp.
- **v4**: optional — HttpOnly cookie carrier instead of localStorage Authorization header, once we host the SPA on a domain we control (mitigates XSS-driven token exfiltration).

**Until v1 lands**, anything that depends on identified-user state (share quotas, server-side token limits, cross-device sync) is best treated as a tampering-tolerant PoC. Don't expose data that's sensitive on a per-user basis through endpoints that authenticate via the unverified id_token path.

## Treatments catalog — cross-disease coverage + combo-pass deduplication

Today every disease in Claude's response carries its own `treatments` array with self-contained `name`, `success_probability_0_1`, `recovery_pct`, and `cost_breakdown`. The combined-strategy panel in `metrics.js` does multiplicative loss modeling on top of that, which is honest about probabilities, **but** it still has two pretend-it's-not-there gaps:

1. **No notion of treatment overlap across diseases.** Many real products treat several diseases at once. Cuivre (Bordeaux mixture) works on mildiou + plusieurs bactérioses + black sigatoka all at once. Mancozèbe covers a dozen Cercospora species. The current model lets Claude duplicate "Cuivre" in three separate disease entries, each with its own cost — the combined panel then sums them as if you'd sprayed three times.
2. **No notion of co-applicable labor.** If two treatments can be co-applied in the same pass (mix in the same tank, single tractor pass), labor + equipment + EPI costs collapse to one application, not three. Currently each treatment carries its own full labor cost.

Both gaps are because there's **no real catalog of treatments** — Claude generates them ad-hoc per call.

**Goal:** a curated treatments catalog (parallel to the crops + diseases catalogs) with cross-cutting coverage info, used by the combined-strategy solver to compute realistic plans.

**Data model (`catalog.json`):**

```json
{
  "treatments": {
    "cuivre_bouillie_bordelaise": {
      "name_fr": "Cuivre (bouillie bordelaise)",
      "name_local": { "rcf": "Bouili bordo" },
      "type": "biologique",
      "active_substance": "sulfate de cuivre + chaux",
      "ephy_id": "...", // ANSES e-phy reference for FR authorization
      "covers": {
        "Plasmopara viticola": { "success_probability_0_1": 0.75, "recovery_pct": 22 },
        "Mycosphaerella fijiensis": { "success_probability_0_1": 0.55, "recovery_pct": 18 },
        "Pseudomonas syringae": { "success_probability_0_1": 0.7, "recovery_pct": 25 }
      },
      "cost_per_ha": {
        "materials_eur": 35,
        "prep_time_h": 0.5,
        "application_time_h": 1.2,
        "labor_eur_per_h": 25,
        "equipment_eur": 15
      },
      "co_applicable_with": ["soufre_mouillable", "bt_aizawai"], // can be tank-mixed
      "incompatible_with": ["huile_blanche_dilution_haute"],
      "bio_compatible": true,
      "max_applications_per_year": 4,
      "min_days_between_applications": 14,
      "max_residue_eu_mg_per_kg": null,
      "regions_authorized": ["FR_metro", "FR_dom"],
      "notes": "Limite annuelle 4 kg Cu/ha (règlement EU 2018/1981)."
    }
  }
}
```

**Combined-strategy solver upgrade:**

Instead of "treat disease A with treatment T_A, disease B with T_B, ...", the solver enumerates:

1. Build a bipartite map: diseases ↔ treatments-that-cover-them.
2. Find minimum-cost cover sets that handle every disease at least once.
3. For each candidate cover set, group treatments by co-applicability → reduce labor cost (one pass instead of N).
4. Score by expected net benefit + P(all-cover succeed).

So a 3-disease scenario where one tank-mixed application of cuivre + soufre covers all three would surface as the top strategy, well above three separate single-purpose treatments at 3× the cost.

**UI:**

- "Stratégie ★ recommandée" row gains a "1 passage" badge when treatments are co-applied (vs "3 passages" today).
- New tooltip on each treatment: "Couvre aussi : Mildiou (75%), Sigatoka (55%) — voir catalogue".
- Filter chip on the strategy panel: "BIO uniquement" / "≤ 2 passages" / "Coût < X €" — re-runs the solver under constraints.

**Discovery + validation, parallel to the image-catalog pattern:**

- The existing `lookupTaxonImage` discovery dump (debug panel) inspired this. Same idea: every time Claude proposes a treatment that's NOT in the catalog, log the proposal to localStorage. The debug panel grows a "📋 Catalogue de traitements découverts" button that dumps them as JSON for manual review + merge into `catalog.json`.
- A validation test (`npm run test:treatments`) cross-references the catalog's `ephy_id` against e-phy ANSES to flag treatments that were withdrawn or had their authorized uses narrowed.

**Phasing:**

- v0 (now): no catalog, per-call ad-hoc treatments, combined panel uses multiplicative model but trusts the per-disease treatments at face value.
- v1: seed `treatments` dict in `catalog.json` with the 20 most common FR treatments (cuivre, soufre, BT, fosétyl-Al, propiconazole, …) with their disease coverage. Solver prefers catalog hits over Claude-generated treatments.
- v2: co-applicability groups → labor cost dedup.
- v3: e-phy validator + auto-discovery export.
- v4: per-crop authorized-treatments filter (RPG code_cultu → e-phy allowed product list).

**Why it matters:** the rentability roadmap entry depends on this. Without realistic combined-treatment cost modeling, the "Rentabilité prévisionnelle" panel will systematically overstate disease costs and underestimate net profit.

## POV (Point of View) — group photos taken from the same vantage over time

Today every photo carries its own `lat`, `lon`, `direction`, `takenAt`. That works for a one-off shoot but breaks down when the user wants to track the same plant / same field corner across multiple visits. The relevant concept is the **POV** (a vantage + a heading), and a POV accumulates a **timeline of photos**.

**Data model migration:**

```js
// New entity in state + Dropbox manifest
POV = {
  id: string,                    // stable, e.g. crypto.randomUUID()
  label: string | null,          // user-named ("Coin nord-est", "Bananier 3")
  lat: number,
  lon: number,
  direction: number | null,      // bearing 0–360
  fov_deg: number | null,        // optional FOV override (default 60)
  notes: string | null,
  created_at: ISO string,
}

Photo = {
  // existing: id, name, mime, b64, dataUrl, width, height, takenAt, exifFound, tags, ...
  pov_id: string | null,        // ← new: which POV this photo belongs to
  // The lat/lon/direction fields become DENORMALIZED (kept in sync with the POV but the POV is the source of truth).
}
```

**UI implications:**

- New "POVs" list in the sidebar (or a panel on the map) — each entry shows label, photo count, last shot date, a thumbnail of the latest photo.
- When uploading: prompt "Existing POV or new?" with a map showing existing pins.
- When placing on map: places a POV pin first; subsequent photos attached to that POV share the position.
- Map: each POV becomes one pin (not one pin per photo). Photo count badge on the pin. Tap pin → carousel of photos chronologically.
- "Same POV, retake" action: opens camera, auto-attaches to the same POV.

**Analysis benefits:**

- Time-series: Claude can compare photo @ POV X taken last week vs today — phenology progression, disease spread, new fruit set.
- Per-photo `attachPhotoIds` in conversation history becomes per-POV with timestamps, much richer context.
- Yield projection: count fruits at POVs of known density → extrapolate to total field.

**Migration:**

- v0 (now): each photo standalone.
- v1: auto-create a POV per existing photo at load time (one POV per photo, taking the photo's lat/lon/direction). Backwards-compatible.
- v2: on photo upload, detect "within 5 m + within 15° of an existing POV" → propose attaching to it instead of creating a new POV.
- v3: explicit POV-management UI; user names + curates them.

## Submission tracking — send only the differential to Claude

Each chat turn currently re-bundles the full conversation (which already includes every photo from turn 0 + any later attachments). That's fine for token volume because Anthropic's API replays the whole conversation per call. **But:**

- If the user adds 10 new photos mid-conversation but only wants Claude to focus on 3, there's no way to express that.
- If the user wants Claude to look at "the new photos since last turn" (typical workflow), they currently must use action chips and hope.
- Photo attachments are silent — no UI indication of which photos Claude has actually seen.

**Goal:** explicit per-photo submission state + UI affordance for the user to pick which photos go into the next turn.

**Data model:**

```js
Photo = {
  ...,
  submitted_turn_indices: number[],   // [0, 3] means sent in turns 0 and 3
  // Derived: never submitted (.length === 0), submitted but stale (Math.max < currentTurn-N), fresh (in current turn)
}
```

**UI:**

- Photo card badge: `✓ envoyé tour 3` / `🆕 jamais envoyé` / `⏳ stale` (last sent > 5 turns ago).
- Before each turn: a small "Photos à envoyer" picker showing all photos with checkboxes. Default selection: all photos that have `tags.shot_type` set since the last submission OR are flagged "new". User can override.
- Per-action: `take_photo` and `retake_photo` mark the resulting photo `submit_next=true`.
- Sidebar metric: "Photos non vues par Claude : N".

**Differential mode** (default for performance-conscious users):

- Send only photos that are new since the last user turn.
- If the user explicitly types/clicks "compare with previous", we re-include the older POV's photos for that turn.

## Conversation compaction — keep token cost flat as turns grow

Today every chat turn re-bundles the full conversation in the API call. After 10–15 turns, token cost ramps linearly even though the early context is mostly redundant.

**Strategy: layered compaction.**

```
Turn 0 (images + full context) — KEEP verbatim (the photos are still the visual ground truth)
Turn 1..N-3                     — SUMMARIZE in a single system message: "Précédemment dans la conversation : …"
Turn N-2, N-1, N                — KEEP verbatim (last 3 turns preserve the conversational flow)
```

**When to trigger:** at the start of turn N where `tokenTracker.snapshot().input > 50_000` (configurable).

**How to summarize:**

- Option A — server-side: send the old turns to Anthropic with a "compress this into 200 tokens" prompt. Cheap, blocking, ~1 s delay before the next turn fires. Adds one paid call per compaction.
- Option B — client-side using `?` heuristics: keep all `assistant` turns with `metrics_update`, drop chitchat, prepend a templated summary derived from `analysisCombined`. Fast, no extra API call, less accurate.

Recommend **B with optional A fallback** — option B handles 80 % of cases for free; activate option A only if the user explicitly clicks "📦 Compacter le contexte" or if even after B the next turn would exceed the soft limit.

**Persistence:** compacted summary stored in `culture.json` alongside the full conversation, so subsequent reloads can choose to expand or stay compacted.

**User affordance:**

- Status line shows "Contexte compacté à tour N" with an "Étendre" link to restore full history (debugging / audit).
- The "🗑 Effacer" button stays as the nuclear option — compaction never silently loses messages, just folds them.

**This is the natural follow-up to the token-tracking feature already shipped.**

## User authentication (prerequisite for server-side per-user features)

Today AgriVision has no notion of a user account. The Cloudflare Worker proxy is anonymous; the Dropbox connection identifies the user _to Dropbox_ but not to us. We need a stable, server-verifiable user identifier before we can do per-user rate-limiting, per-user storage in Cloudflare KV, paid tiers, multi-device sync, or culture sharing between farmers.

**Requirements:**

- Stable across devices and browser-clears (not a localStorage UUID).
- Server-verifiable (Worker can independently confirm the identity claim — no trust on a client-sent header).
- Low signup friction (a field-using farmer should not have to navigate a 4-page signup flow on a phone).
- Privacy-respecting: identifier is a hashed pseudonym, not a raw email/phone.

**Options ranked by friction:**

1. **Dropbox-as-identity** (zero new UX — recommended first step). The user is already connecting Dropbox for storage; we can use the `account_id` returned by `/2/users/get_current_account` as the canonical user ID. Hash it (`sha256("dropbox:" + account_id)`) before storing anywhere server-side so it's not directly correlatable. Worker verifies by calling Dropbox's `get_current_account` with the access token in the request header — cached for 5 min in Workers KV to avoid hitting Dropbox on every request. **Downside**: ties identity to one provider; users without Dropbox can't authenticate.
2. **Cloudflare Access** (one-click sign-in via Google/Apple/email). Free for ≤50 users. Worker reads the `Cf-Access-Jwt-Assertion` header, validates the signature against Cloudflare's JWKS. No code to maintain. **Downside**: pricing past 50 users (~$3/user/mo for the cheapest paid tier).
3. **Magic-link email** (Stytch, Clerk free tiers, or self-hosted via Resend). Email → click link → cookie-based session. Stable identifier = SHA-256 of normalized email.
4. **OAuth** (Google + Apple). Mandatory for iOS PWA / App Store later. Use a managed provider (Supabase Auth, Clerk, Auth0) — not worth rolling your own.
5. **Anonymous device UUID** (today's de facto state). Bypassable by clearing storage; acceptable as a fallback for "freemium-without-account" but not for paid tiers.

**Migration path:**

- v0 (now): anonymous, no quotas.
- v1: Dropbox-as-identity. Worker verifies token via Dropbox `get_current_account`. Use this for per-user KV storage + rate-limit + sharing.
- v2: add Cloudflare Access / OAuth as alternative paths for users who don't want Dropbox.
- v3: real account system if paid tiers ship (Stripe customer ID becomes the canonical link).

**The hashed user ID** flows everywhere downstream: KV keys (`tokens:${uid}:${month}`, `prefs:${uid}`, `share:${uid}:${cultureId}`), Dropbox-Worker-cache (`dbx-acct:${access_token_hash}` → `uid`), Stripe customer mapping if/when paid tiers arrive.

## Server-side storage in Cloudflare KV (per-user state)

Dropbox holds **user-owned** data (photos, culture manifests — GDPR-friendly since users own their bytes). Cloudflare KV will hold **app-owned, per-user** data — the things we need fast server-side access to and which logically belong to AgriVision rather than to the user's filesystem.

**Prerequisites:** the [User authentication](#user-authentication-prerequisite-for-server-side-per-user-features) ROADMAP item above. KV keys are scoped by the hashed user ID returned by the auth layer.

**What goes in KV (per-user):**

| Key pattern                        | Value                                             | TTL          | Why KV (not Dropbox)                                     |
| ---------------------------------- | ------------------------------------------------- | ------------ | -------------------------------------------------------- |
| `tokens:${uid}:${YYYY-MM}`         | running token counter for the month               | 35 d         | Worker increments on every API call; Dropbox is too slow |
| `prefs:${uid}`                     | UI preferences (theme, dialect default, units)    | none         | Tiny, frequent reads, needs to load before Dropbox auth  |
| `tier:${uid}`                      | subscription tier (`free`/`pro`/`pro+`) + expiry  | none         | Source of truth for rate-limit checks                    |
| `share:${shareId}`                 | `{ uid_owner, culture_path, expires_at, scopes }` | configurable | Public-readable share links to a Dropbox culture         |
| `dbx-acct:${sha256(access_token)}` | `uid` (cache of Dropbox→uid lookup)               | 5 min        | Avoid hitting Dropbox on every Worker request            |
| `analytics:${uid}:${YYYY-MM-DD}`   | `{ chats, reports, photos_added, time_spent_s }`  | 365 d        | Per-user usage analytics (opt-in)                        |

**What stays in Dropbox** (do not migrate to KV):

- Photo bytes (too large; user owns them).
- `culture.json` manifests (user owns; portable; survives KV loss).
- Conversation history (user-owned context).
- Anything large or sensitive.

**KV characteristics to design around:**

- **Eventually consistent across regions** (~60 s convergence). Fine for prefs and analytics; **not fine** for "you just crossed the quota" decisions — use **Durable Objects** for those.
- **Free tier**: 100k reads/day + 1k writes/day + 1 GB storage. Comfortable for hundreds of users at our patterns; need to upgrade ($5/mo) past that.
- **25 MB value cap**: nothing remotely large fits — that's fine, see "stays in Dropbox" above.
- **List operations are slow** (~50 ms): never iterate keys per request. Query by exact key only.

**Implementation order:**

1. Add `[[kv_namespaces]]` to `wrangler.toml`: `binding = "STATE"`, `id = "..."`.
2. Wire the auth layer (see prerequisite) so every Worker request has `req.user.uid` after middleware.
3. Migrate the rate-limit counter from the planned-but-not-shipped `tokens:anon` to `tokens:${uid}:${month}`.
4. Move `prefs` out of localStorage into KV (with localStorage fallback for offline) — sync via SWR pattern.
5. Implement share links (`/share/:id` route on the Worker reads `share:${id}`, returns a read-only view of the linked Dropbox culture).

**Cost projection at 1k active users / month:**

- Reads: ~10 reads × 1k users × 30 days = 300k reads/month → covered by free tier ($0).
- Writes: ~3 writes/user/day × 1k × 30 = 90k writes/month → over the 1k/day free tier (30k/month) → **$5/mo paid plan** plus $0.50 per million reads above free, $5 per million writes above free.
- Storage: prefs ≤ 1 KB, monthly tokens ≤ 100 B, share ≤ 200 B → ~3 KB/user × 1k = 3 MB. Free.
- **Total ~$5–10/mo** at 1k users.

## Server-side per-user token rate-limiting

**Depends on:** [User authentication](#user-authentication-prerequisite-for-server-side-per-user-features) (for the stable per-user ID) and [Server-side storage in Cloudflare KV](#server-side-storage-in-cloudflare-kv-per-user-state) (for the counter storage).

Today the client tracks Anthropic token usage and shows it in the `?debug` panel, with soft (200k tokens) and hard (500k tokens) caps **per conversation**. The hard cap blocks new turns until the user clicks "Recommencer".

**Limit**: client-side. A motivated user can clear localStorage and bypass it. To enforce real per-user quotas (e.g. a free tier of N tokens/month, paid tiers above), the Cloudflare Worker needs to keep the counters.

**Goal**: every `/api/analyze` call increments a server-side counter scoped to a user identifier; requests over the configured quota return 429 with a clear message and the remaining-quota header.

**Identity options:**

- **Dropbox token hash** (lightweight): SHA-256 of the `dbx_token` localStorage value, sent as an `x-user-id` header. No login screen, identity tied to the user's Dropbox account.
- **Anon device ID** (no signup): UUIDv4 generated client-side at first load, stored in localStorage. Easy to bypass (clear LS = fresh quota) but enough for casual abuse prevention.
- **Real auth** (long-term): Cloudflare Access, Clerk, Supabase Auth, or self-hosted. Required if a paid tier is introduced.

**Storage options on Cloudflare:**

- **Workers KV**: cheap, eventually-consistent, ideal for counters when occasional under-counting is acceptable. ~$0.50/M reads.
- **Durable Objects**: strongly consistent, slightly more expensive, the right primitive for rate-limit counters that absolutely must not race.
- **D1** (SQLite): if you want to query usage history per user / per day for billing or analytics.

**Sketch (KV + Dropbox hash identity):**

```js
// worker.js
const userId = await sha256(req.headers.get("x-user-id") || "anon");
const monthKey = new Date().toISOString().slice(0, 7);
const usageKey = `tokens:${userId}:${monthKey}`;
const current = parseInt((await env.USAGE.get(usageKey)) || "0", 10);
const QUOTA = 1_000_000; // 1M tokens / user / month (configurable per tier)
if (current >= QUOTA) {
  return new Response(JSON.stringify({ error: "quota_exceeded" }), {
    status: 429,
    headers: { ...corsHeaders(origin), "x-quota-remaining": "0" },
  });
}
// ... forward to Anthropic ...
// After response, parse usage and increment KV
const total =
  (json.usage?.input_tokens || 0) +
  (json.usage?.output_tokens || 0) +
  (json.usage?.cache_creation_input_tokens || 0) +
  (json.usage?.cache_read_input_tokens || 0);
await env.USAGE.put(usageKey, String(current + total), { expirationTtl: 60 * 60 * 24 * 35 });
```

**Frontend wiring** (already partially in place via `tokens.js`):

- Read `x-quota-remaining` from response headers, display in the debug panel ("Quota mensuel restant : 850k").
- Handle 429: render a friendly "Quota épuisé — réinitialise le 1er du mois prochain" instead of a generic error.
- For paid tiers: link to a billing page (Stripe / Lemon Squeezy / Polar).

**Tier suggestions:**

- Free: 200k tokens/month (~50 quick chats on Haiku, ~10 full reports)
- Pro €5/mo: 2M tokens/month (~500 chats) + access to Sonnet 4.5
- Pro+ €20/mo: 10M tokens + Opus + priority

## Full crop rentability evaluation (cost vs revenue planning)

Today Claude returns a yield estimate and an indicative selling price → a top-line "valeur estimée". This is **revenue**, not **profit**. To plan rentability, the farmer needs to subtract all the costs of getting that crop to market.

**Goal:** a normalized cost grid alongside the existing yield/value grid, producing a net-profit estimate per hectare and total field.

**Cost categories to model (per crop type, per region, per ha):**

| Category                  | Examples                                                                   | Notes                                                                      |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Intrants**              | semences/plants, engrais (NPK), amendements, paillage, support             | catalog these per crop type with FR market prices                          |
| **Eau / irrigation**      | volume m³, tarif EAU (€/m³), pompage, équipement irrigation                | varies by region (Réunion vs métro), bio adds drip pref                    |
| **Phyto / traitements**   | traitements préventifs réguliers (déjà partiellement couvert via diseases) | distinct from curative treatments under disease pressure                   |
| **Main d'œuvre**          | heures par opération (plantation, désherbage, taille, récolte) × €/h       | dialect: travail saisonnier vs permanent                                   |
| **Matériel / équipement** | amortissement tracteur, outillage, carburant, EPI                          | per-passage cost                                                           |
| **Foncier / fermage**     | location €/ha/an, taxes foncières                                          | optional, depends on ownership                                             |
| **Assurance / financier** | assurance récolte, taux d'emprunt si financement                           | optional                                                                   |
| **Pertes attendues**      | probabilité × impact maladie/aléas climatiques                             | already in `diseases.presence_probability × yield_impact_pct_if_untreated` |

**Net rentability = revenue − costs − risk-adjusted losses**

```
revenue   = yield_t_per_ha × price_eur_per_kg × 1000 × area_ha
costs     = Σ(category × area_ha)
losses    = Σ(disease.probability × |disease.impact_pct| × revenue)
profit    = revenue − costs − losses
ROI %     = profit / costs × 100
breakeven = costs / (yield_t_per_ha × 1000 × area_ha)   // €/kg required to cover
```

**UI:**

- New section under the metrics grid: "Rentabilité prévisionnelle"
- Stacked bar showing revenue ▶ costs breakdown ▶ losses ▶ profit
- Each cost category editable (like the existing price override) → user enters their actual figures
- Multi-year projection toggle (e.g. plantation pluri-annuelle: bananier amortit sur 3 ans, vigne sur 30 ans)
- Comparison mode: "Et si je passais en bio ?" / "Et si je changeais de culture ?" — re-run with different assumptions

**Catalog extension** (per-crop defaults in `catalog.json`):

```json
"BAN": {
  ...,
  "rentability_defaults": {
    "intrants_eur_per_ha": 1200,
    "irrigation_m3_per_ha_per_year": 8000,
    "labor_h_per_ha_per_year": 280,
    "labor_eur_per_h": 22,
    "equipment_eur_per_ha_per_year": 800,
    "fermage_eur_per_ha_per_year": 250,
    "expected_lifespan_years": 3
  }
}
```

Per-crop defaults seed the form; user override on any line. Saved to Dropbox alongside the analysis. Claude can refine the defaults from the photo context (e.g. observed irrigation system → adjust water cost).

## Farm-level (cross-cutting) folder in Dropbox

Today the storage layout is per-crop: `/crops/<code>/cultures/<id>/`. Some information is **not** crop-specific and is needed urgently in stressful moments — typically when an incident happens (storm, fire, pest outbreak) and the farmer needs to file an insurance claim from the field.

**Goal:** a transverse `/farm/` folder at the root that holds farm-wide info, easy to open in 1 tap from anywhere in the app.

```
/Apps/AgriVision/
  farm.json                ← name, SIRET, exploitation address, primary contacts
  insurance/
    <provider>.json        ← contract reference, policy number, claim hotline
    contract-xxx.pdf       ← scanned contracts (uploaded as attachments)
  crops/<code>/cultures/<id>/...
```

**UI:**

- New top-of-sidebar "Exploitation" tile showing the farm name + a 📞 **Assurance** quick-button → opens a sheet with all insurance providers, contact numbers, policy numbers, scanned contract links. Tap a contract → opens the PDF/image directly from Dropbox.
- A small "Déclarer un incident" flow that pre-packages: current bloc parcels, latest photos with EXIF/timestamps, address, weather context — into a single JSON ready to be sent to the insurer (or saved as a draft email).

**Why before sub-groups:** insurance is the highest-stakes use case that's also the lowest implementation cost. Sub-grouping cultures is a UX nicety; insurance shortcut is operationally critical.

## Sub-groups within a culture

A "culture" today = all parcels of a single crop type the farmer treats as one working unit. In practice a single crop can have meaningful sub-zones (different irrigation, different rootstock, different age cohort, different sun exposure).

**Goal:** within a culture, allow tagging parcels into named sub-groups so disease pressure, yield, treatments can be analyzed per sub-zone.

**Implementation outline:**

- Add an optional `subgroup` string to each entry in `selectedParcels`.
- UI: right-click (or long-press) a selected parcel → "Assigner au sous-groupe…" with autocomplete from existing names.
- Render sub-group as a small label next to the emoji on the map.
- `culture.json` stores the mapping; analysis grid shows aggregated metrics per sub-group when present.

## Modularize the frontend (single HTML → multiple JS files)

`index.html` has grown well past the comfortable "single file" point. Time to split.

**Proposed layout (no build step — native ES modules served via http(s)):**

```
public/
  index.html              ← shell + script tag entry
  styles.css              ← extracted from inline <style>
  catalog.json
  manifest.webmanifest
  icon.svg
  sw.js
  js/
    main.js               ← bootstrap, wires modules
    config.js             ← WORKER_URL, ANTHROPIC_*, DROPBOX_APP_KEY, catalog loader
    map.js                ← Leaflet map, RPG/cadastre layers, sun compass
    parcels.js            ← selection, highlight, point-in-polygon, WFS click
    chips.js              ← viewport-based culture chips
    photos.js             ← upload, EXIF, compression, FOV, placement, aim
    analyze.js            ← prompt building, fetch, render
    metrics.js            ← renderMetrics + renderDiseases + catalogs lookup
    persistence.js        ← Dropbox PKCE + save + reload
    util.js               ← bearing, destPoint, cardinal, formatters
```

**Cost:** requires http(s) serving (ES modules don't work on `file://`). Already required for PWA + Dropbox OAuth, so no new constraint.

**Bonus once split:** can introduce TypeScript per-file later if desired, or unit-test individual modules with Playwright component tests.

## Mobile-first UX redesign

AgriVision is meant to be used **in the field**. The current layout is desktop-first (380 px fixed sidebar + map). A first-pass responsive layout converts the sidebar to a bottom drawer on ≤768 px screens, but a real mobile redesign requires more.

**Pain points on phones today:**

- Photo upload UX assumes file picker on macOS; needs to default to camera capture (`<input type="file" accept="image/*" capture="environment">`).
- Direction setting is fiddly with finger taps — could read compass live via `DeviceOrientation` API.
- Geolocation flow assumes browser prompt; on iOS, must be triggered by a user action.
- The sun-compass + lock badge + select hint clutter the small map.
- Parcel-click hit area is tiny on touch.
- Dropbox manual-paste OAuth flow is painful on phone (juggling tabs).

**Direction:**

- Camera-first photo workflow: large round "📷 Capturer" button, photo opens directly in editing sheet (set location, direction, takenAt fallback).
- Live compass: when in "aim direction" mode, the FOV cone follows the device's actual heading.
- Drawer with snap points: peek (60 px) / half (45 vh) / full (95 vh).
- Map-level FAB (floating action button) for the primary action: when no crop, "✚ Nouveau crop"; when crop active, "📷 Photo".
- Inline OAuth: try `display: page` (Dropbox supports it) and a dedicated `/oauth-redirect` page to capture the code automatically.

**Out of scope (separate ROADMAP items):**

- Offline mode (already a PWA, needs offline tile cache + queued writes).
- Native wrapper (Capacitor / Tauri) for app-store distribution.

## Map rotation to fit elongated parcels

When parcels are locked and auto-fit, the map currently keeps north up. For elongated parcels (e.g. canne à sucre strips on La Réunion, vine rows in Gironde) this wastes ~30–40% of screen real estate.

**Goal:** rotate the map to align the minimum-bounding-rectangle of the selected parcels with the viewport, then fit. Result: more pixels per parcel, easier inspection.

**Implementation outline:**

- Add the `leaflet-rotate` plugin (CDN, ~7 KB) and enable `rotate: true` on the map.
- Compute the minimum-bounding-rectangle orientation of `parcelHighlight.getBounds()` via rotating calipers on the union of vertices.
- On lock: call `map.setBearing(angle)` before `fitBounds`.
- On unlock: reset bearing to 0.

**Open questions before building:**

- North-up convention is broken when rotated → the sun/moon compass widget must subtract `map.getBearing()` from its azimuth math.
- Users typically expect north-up; rotation should be opt-in (e.g. a toggle next to the lock badge), not automatic on every lock.
- Photo direction arrows (▲ glyph + FOV cones) are drawn in geographic space and rotate naturally with the map — should be checked but expected to work out-of-the-box.

**Cost / risk:**

- `leaflet-rotate` is community-maintained; occasional friction with built-in controls (layer toggle, scale). Vet against current Leaflet 1.9.x before committing.
- Adds cognitive load for users unfamiliar with rotated maps. Make the rotation indicator very visible (e.g. a faded "N ↑" arrow rotating in the corner).
