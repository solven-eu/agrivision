# AgriVision — Claude Code working notes

AgriVision is a **farmer's personal assistant**: a tool to help individual growers (and small cooperatives) identify their crops, diagnose disease pressure, plan treatments, and reason about the economics of an intervention — all from a phone camera and a map click.

## Scope today

**Primary market: France métropolitaine + DOM-TOM, with current focus on La Réunion.** Crop catalogs, market prices, treatment recommendations, and dialect translations (Créole réunionnais `rcf`, Créole antillais `gcf`) reflect that. Other geographies will work but are not validated.

Concretely the app helps a user:

1. **Locate** their parcels on the map (BAN geocoding, browser geolocation, IGN RPG overlay, optional cadastre layer).
2. **Select** one or more agricultural parcels (RPG WFS click, point-in-polygon resolution, multi-select with lock).
3. **Document** the field with photos (EXIF GPS + direction read automatically, manual placement + aim fallback, FOV cones on the map).
4. **Analyze** via Claude Vision: crop identification, phenology, vigor, expected yield, indicative market price + total value.
5. **Diagnose** diseases relevant to crop × region × season, with per-treatment economics (materials + labor h × €/h + equipment) and **expected net benefit** (probability × recovery × crop value − cost).
6. **Persist** sessions (parcels + photos + analysis) to the user's Dropbox via OAuth PKCE.

## Architectural choices and why

- **Single HTML file** (`index.html`) for the frontend — zero build, easy to inspect, no toolchain. Cost: file size approaches the limit where a build would help; revisit when shared.
- **Cloudflare Worker** (`worker/`) for the Anthropic proxy — hides the API key, free tier covers personal use. The frontend keeps a fallback direct-call mode for local-only development (`ANTHROPIC_API_KEY` constant).
- **Anthropic prompt caching** — long system prompt (role + methodology + schema + few-shot example) is marked `cache_control: ephemeral`. The per-request user message carries only the variable context.
- **PWA** (`manifest.webmanifest` + `sw.js`) — installable on phones, asset cache covers offline reload. Service worker requires HTTP(S); does nothing on `file://`.
- **Catalog-first lookups** — `CROP_CATALOG` keyed by RPG `code_cultu` (FR/scientific/emoji/dialect names/image). Falls back to Wikipedia REST API, then iNaturalist `/v1/taxa`.
- **Dropbox PKCE OAuth, App-folder scope** — narrow grant (`/Apps/AgriVision/` only), no client secret, manual code-paste flow works from `file://` and from any hosting.

## When adding features

- **FR/DOM-first**: defaults (labor rate ~25 €/h, RNM FranceAgriMer for prices, IGN data sources) reflect French agricultural reality. Don't generalize prematurely.
- **La Réunion realism**: the RPG categorized layer covers DOM since IGN's 2024 release. Common Réunion crops (canne à sucre `CSU`, bananier `BAN`, agrumes `AGR`, maraîchage diversifié `MDI`) have catalog entries. Tropical phenology windows differ from metro France — keep the prompt's "hémisphère sud" guidance.
- **Dialect**: any user-facing string the model produces (disease names, treatment names) should have a `name_local` slot. Don't invent local terms — leave `null` if not attested.
- **Costs**: economics must combine intrants + labor hours + equipment. A "treatment X €/ha" without time breakdown isn't useful to a farmer planning their week.
- **Persistence**: data (photos, parcels, named items, analyses) → Dropbox. Preferences (lock state, filter chips, dialect choice) → localStorage. Don't conflate them.
- **Privacy**: GPS in photos, parcel selections, farmer's name (if added) are sensitive. Anything that leaves the browser goes either through the user's Dropbox (which they own) or the Anthropic proxy (which we control via the Worker). No third-party analytics, no telemetry.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for queued enhancements (map rotation for elongated parcels, etc.).
