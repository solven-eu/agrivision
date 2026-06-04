# AgriVision — Agronomy capabilities

What the platform can sense, compute, and reason about for a grower's parcel — the data
sources we pull, the data each produces, and the analyses they enable. Scope is **France
métropole + DOM-TOM, focus La Réunion**. Status legend: ✅ integrated · 🟡 partial / in
progress · ⬜ planned (see [`ROADMAP.md`](./ROADMAP.md)).

---

## 1. Data sources

| Source | Access | Provides | Status |
| --- | --- | --- | --- |
| **IGN RPG 2024** (parcelles agricoles catégorisées) | Géoplateforme WFS | Parcel polygon, `code_cultu`, RPG category (TA/PP/CP), BIO flag, area | ✅ |
| **IGN BD ORTHO** (`ORTHOIMAGERY.ORTHOPHOTOS`) | Géoplateforme WMTS | ~20 cm aerial true-color imagery (FR + DOM) | ✅ |
| **IGN RGE ALTI** | Géoplateforme REST | Altitude per parcel (5 m), → cloud-exposure proxy | ✅ |
| **IGN Cadastre** | Géoplateforme WMS | Cadastral parcels overlay | ✅ |
| **BAN** (Base Adresse Nationale) | REST | Address → lat/lon geocoding | ✅ |
| **Soil — CIRAD / Nature Sci Data 2026** | bundled (`/api/soil`) | 22.7k Réunion samples → FAO type, pH, CEC, N, C-org, P, K, Mg, Ca, field capacity (pF 2.5), wilting point (pF 4.2) | ✅ |
| **Copernicus Sentinel-2 L2A** (CDSE Sentinel Hub) | Worker `/api/satellite/*` | Acquisition catalog + cloud cover; true-color / NDVI imagery; per-parcel NDVI mean time series | ✅ |
| **Météo-France DPObs** | Worker `/api/weather` | Nearest RADOME station: observed rain (`rr_per`), temp, humidity, wind | ✅ |
| **Open-Meteo** | Worker `/api/weather` | Precip forecast (mm, 7 d), soil moisture (5 depths), ET0 (FAO), → water balance | ✅ |
| **Météo-France climate normals** (1991–2020) | bundled (`seasonal-normals.js`) | Réunion monthly rainfall (windward/leeward), temp, cyclone window | ✅ |
| **Vigicrues Réunion** | Worker (scrape) | River level / flood stations | ✅ |
| **Events / RSS feeds** | Worker `/api/events-feed` | Agricultural alerts/events | ✅ |
| **Crop catalog** (`CROP_CATALOG` by `code_cultu`) + Wikipedia + iNaturalist | bundled + REST | Crop FR/scientific/emoji/dialect names + reference image | ✅ |
| **RNM FranceAgriMer** | via AI prompt knowledge | Indicative market prices (not a live feed) | 🟡 |
| **User photos** (phone camera) | browser | Field imagery + EXIF GPS/direction/time | ✅ |
| **Claude Vision** (+ Mistral optional) | Worker `/api/analyze`, `/api/mistral` | Multimodal agronomic reasoning | ✅ |
| **Météo-France AROME-OI** (forecast model) | portal (GRIB/WCS) | High-res Réunion rain forecast amounts | ⬜ (GRIB-heavy) |
| **Météo-France Vigilance Outre-mer** | legacy donneespubliques | Réunion pluie/cyclone warnings (JSON) | ⬜ |
| **Drone imagery** | — | High-res aerial / multispectral per flight | ⬜ |

---

## 2. Data we hold (per parcel / per culture)

**Parcel-level**
- Geometry, area (ha), `code_cultu`, RPG category, BIO flag, centroid lat/lon.
- Altitude + qualitative cloud-exposure band (côte sèche → haute montagne).
- Soil: dominant FAO type, pH, CEC, N, C-org, P, K, Mg, Ca, water-retention (field capacity / wilting point).
- Soil-fit score (crop × soil suitability, 0–100).
- Satellite NDVI mean (+ min/max, date, vigor label) and monthly time series.
- Weather: nearest-station observed rain/temp/humidity/wind; forecast precip + ET0 + water balance; soil moisture at depth.
- Photo associations (which photos fall inside the polygon).
- _(All of soil / altitude / NDVI are persisted in the Dropbox manifest + cached, so reopening a culture re-fetches nothing.)_

**Culture-level (AI analysis output)**
- Crop identification (FR + scientific + cultivar, confidence).
- Phenology: stage (BBCH), maturity %, expected harvest window.
- Health: vigor 0–100, disease-pressure 0–100, spatial observations + detections (per-photo x/y).
- Yield: t/ha, total t, confidence.
- Market: indicative €/kg, estimated total value, source hint.
- Diseases: per pathogen — base rate, evidence (supporting/against/missing), presence probability, progression (severity, speed %/week, weeks-to-plateau), 3 weighted impact scenarios, yield impact %.
- Treatments: per option — success probability, recovery %, cost breakdown (materials + prep/application hours × €/h + equipment), expected net benefit.
- Conversation history + dialect, photos with shot-type tags.

**Farm-level**
- Total declared surface (gamification input), completeness "Dossier" score.

---

## 3. Analyses feasible today

| Analysis | How | Status |
| --- | --- | --- |
| **Crop identification** | Claude Vision on photos + RPG `code_cultu` prior | ✅ |
| **Phenology / maturity / harvest window** | Vision + season (hemisphere-aware) + climate | ✅ |
| **Vigor assessment** | Visual (Vision) **cross-checked with Sentinel-2 NDVI** mean | ✅ |
| **Yield projection** | Crop × stage × vigor × area | ✅ |
| **Revenue / crop value** | yield × indicative price × area | ✅ |
| **Disease diagnosis funnel** | base rate → photo evidence → probability → progression → 3 impact scenarios | ✅ |
| **Treatment economics** | expected net benefit = P(success) × recovery × crop value − full cost | ✅ |
| **Combined-strategy disease modelling** | multiplicative loss across diseases/treatments | ✅ |
| **Soil-fit scoring** | crop requirements × parcel soil | ✅ |
| **Soil-aware treatment caveats** | e.g. cuivre phytotoxic < pH 5.5, mancozèbe on saline soil | ✅ |
| **Water balance** | forecast rain − ET0; soil moisture for irrigation timing | ✅ (card + AI context + per-parcel sheet) |
| **Rain alerts** | Web Push (VAPID) — cron polls forecast, notifies before rain ≥ 2 mm/day on a parcel | ✅ (delivery validates on deploy) |
| **Climatology-aware reasoning** | static Réunion normals (saison, cyclone window) in prompt | ✅ |
| **Per-parcel focused AI discussion** | parcel sheet → scoped chat turn | ✅ |
| **Time-series** | NDVI monthly series + photo timeline (camera; drone-ready) | ✅ |
| **Completeness / onboarding score** | parcels, surface, photo count/freshness/coverage, disease-check recency | ✅ |
| **Cross-validation** | Mistral as a second provider (optional) | 🟡 |

---

## 4. Gaps & opportunities (missing sources / data / metrics / analyses)

**Sources to add**
- **Météo-France AROME-OI** — authoritative Réunion rain-amount *forecast* (GRIB; heavy). ⬜
- **MF Vigilance Outre-mer** — Réunion pluie/cyclone alerts (legacy JSON). ⬜
- **Measured soil moisture** — Sentinel-1 radar / Copernicus Global Land SSM / SMAP, vs today's model estimate. ⬜
- **Drone** — per-flight cm-scale RGB + multispectral (own NDVI). ⬜
- **Live market prices** — RNM/FranceAgriMer as a real feed (today it's AI-knowledge only). ⬜
- **e-phy ANSES** — authorized-treatment list per crop/region (legality of a recommended product). ⬜
- **Phytosanitary bulletins (BSV)** — regional pest/disease pressure alerts. ⬜

**Data / metrics missing**
- **Full cost grid** → net profit (intrants, eau, main d'œuvre, matériel, foncier) — only revenue today. ⬜
- **Treatments catalog** with cross-disease coverage + tank-mix / co-application (avoid triple-counting passes). ⬜
- **Pests/insects** (not just fungal/bacterial diseases) and weeds. ⬜
- **Nutrient/fertilization plan** derived from soil deficits (N/P/K vs crop need). ⬜
- **Irrigation scheduling** (volume + timing) from water balance × soil water-holding capacity. ⬜
- **ENSO / seasonal anomaly** state to shift disease/water reasoning. ⬜
- **Per-sub-zone** metrics within a culture (rootstock/age/exposure subgroups). ⬜
- **Carbon / sustainability** indicators. ⬜

**Analyses to unlock once the above land**
- **Rentabilité prévisionnelle** (profit, ROI, breakeven €/kg, multi-year amortization). ⬜
- **Weather→disease coupling** — humid/forecast windows raising fungal pressure & treatment timing. ⬜
- **Change detection** — NDVI drop vs trailing median → "alerte vigueur". ⬜
- **Multi-AI ensemble / debate** for high-stakes diagnoses. ⬜
- **Yield calibration** from POV fruit-counts extrapolated to field. ⬜

See [`ROADMAP.md`](./ROADMAP.md) for the phased plans behind most ⬜ items.
