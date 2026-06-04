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

## Security: never store user secrets in our own databases

**Strict rule, no exceptions without explicit confirmation from the user.**

We never persist a user's secret material — Dropbox access/refresh tokens, OAuth bearers, API keys, passwords, raw OIDC id_tokens beyond a request's lifetime — into any storage we control (Cloudflare KV, R2, D1, logs, manifests, etc.). The user's secrets stay in the user's browser (localStorage / sessionStorage) and are forwarded only transiently to operations that need them. Identity for our backend is derived from verifiable claims (e.g. an OIDC `sub`), not from holding the keys.

When designing a feature that _might_ require server-side custody of credentials (e.g. background sync, scheduled jobs, refresh on the user's behalf), do not assume it's OK — **ask the user first**, list the alternatives (signed claims, short-lived session tokens minted by us, OAuth on-behalf-of), and only proceed once the user has explicitly approved the chosen approach with awareness of the trust tradeoff.

## Abuse tolerance: quotas are the ceiling, not rate-limiting

We accept some abuse as long as **token + photo + storage + KV-write quotas are enforced server-side per user**. A determined abuser can still send junk through `/api/analyze` or `/api/feedback`, but they cannot exceed their plan's caps — and Free is capped tight (no AI, 5 photos, 50 MB). The cost ceiling is therefore bounded by the plan we sold them.

Do not reflexively add IP-based rate-limiting, captchas, or moderation-AI gates on the front of `/api/*` routes unless concrete abuse patterns show up in logs. Premature defenses cost UX (mobile users behind NAT get false-positive blocked) and engineering time. The quota architecture is the right ceiling for a PoC and reasonably for early prod.

## Git: never mutate the repository state

**The user owns all git history operations. No exceptions.**

Never run any state-changing git command on the user's behalf — no `git add`/staging, `git commit`, `git push`, `git merge`, `git rebase`, `git reset`, `git checkout`/`switch` that discards work, `git stash`, `git tag`, branch creation/deletion, or `git restore`. This holds even when explicitly asked to "commit" and even under `--dangerously-skip-permissions`: if the user asks you to commit/push, decline and let them do it themselves.

What you _may_ do: read-only inspection — `git status`, `git diff`, `git log`, `git show`, `git blame`. Make and edit files in the working tree freely; that's expected. When a change is ready, describe what you changed and hand it off for the user to stage and commit. If you think a commit/branch/push is warranted, suggest the command for the user to run (e.g. via the `! <command>` prompt), but do not execute it.
