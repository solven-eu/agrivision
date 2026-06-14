// AgriVision RE — RPG (categorized agricultural parcels) + cadastre WMS layer management.
//
// NOTE: this module used to also render a per-crop "chip" filter. It was removed because the RPG
// categorized layer is served from IGN's pre-rendered raster endpoint (data.geopf.fr/wms-r), which
// silently IGNORES the CQL_FILTER vendor parameter — verified: a GetMap with no filter, with
// `code_cultu IN ('__none__')`, and with a specific code all return byte-identical tiles. So the
// chips never actually hid anything. Real per-crop filtering would require rendering parcels as
// client-side vector polygons from WFS geometry (see ROADMAP); until then there is no filter UI.
//
// This module now owns only the RPG WMS overlay (always on; the RPG/cadastre layer control is
// hidden for now — see below).

import { IGN_WMS, RPG_LAYER } from "./config.js";

/**
 * @param {object} app - { map (Leaflet), getPendingRestore (fn) → boolean }
 * @returns {{ refreshChips: fn, refreshRpgLayer: fn }} - refreshChips is kept as an alias of
 *   refreshRpgLayer so existing callers (persistence.js, after a Dropbox restore) keep working
 *   without change.
 */
export function installChips(app) {
  let rpgLayer = null;

  function buildRpgLayer() {
    return L.tileLayer.wms(IGN_WMS, {
      layers: RPG_LAYER,
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      attribution: "RPG © IGN",
      opacity: 0.65,
      // Above the OSM basemap (z-index 1, set in main.js initBasemap), below satellite imagery
      // (250) and parcel highlights. The basemap is installed late/deferred, so without this the
      // two share the default z-index and the basemap can cover RPG — parcels flash then vanish.
      zIndex: 100,
    });
  }

  // Ensure the RPG layer exists and is on the map. Called at boot and again after a Dropbox
  // restore (the initial render is deferred in that case — see below). Idempotent: if the layer
  // already exists it does nothing.
  function refreshRpgLayer() {
    if (rpgLayer) return;
    rpgLayer = buildRpgLayer().addTo(app.map);
  }

  // The RPG/cadastre layer control is hidden for now: RPG is always on, and the cadastre overlay
  // (config.js CADASTRE_LAYER, all parcels agricultural or not) wasn't pulling its weight as a
  // toggle. To re-expose it, rebuild the cadastre L.tileLayer.wms + L.control.layers here (see
  // git history).

  // Initial RPG render — deferred when a Dropbox restore is imminent (the layer would be re-added
  // anyway once loadSession → refreshRpgLayer runs for the restored parcels' view).
  if (!app.getPendingRestore()) {
    rpgLayer = buildRpgLayer().addTo(app.map);
  }

  return { refreshChips: refreshRpgLayer, refreshRpgLayer };
}
