# Roadmap

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
