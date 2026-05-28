# Roadmap

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
