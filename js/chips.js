// AgriVision RE — RPG (categorized agricultural parcels) + cadastre WMS layer management.
//
// NOTE: this module used to also render a per-crop "chip" filter. It was removed because the RPG
// categorized layer is served from IGN's pre-rendered raster endpoint (data.geopf.fr/wms-r), which
// silently IGNORES the CQL_FILTER vendor parameter — verified: a GetMap with no filter, with
// `code_cultu IN ('__none__')`, and with a specific code all return byte-identical tiles. So the
// chips never actually hid anything. Real per-crop filtering would require rendering parcels as
// client-side vector polygons from WFS geometry (see ROADMAP); until then there is no filter UI.
//
// This module now owns only the two WMS overlays (RPG + cadastre) and the Leaflet layer control.

import { IGN_WMS, RPG_LAYER, CADASTRE_LAYER } from "./config.js";

/**
 * @param {object} app - { map (Leaflet), getPendingDbxLoad (fn) → boolean }
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
    });
  }

  // Ensure the RPG layer exists and is on the map. Called at boot and again after a Dropbox
  // restore (the initial render is deferred in that case — see below). Idempotent: if the layer
  // already exists it does nothing, so a user who unchecked RPG in the layer control keeps it off.
  function refreshRpgLayer() {
    if (rpgLayer) return;
    rpgLayer = buildRpgLayer().addTo(app.map);
    if (layerCtl) layerCtl.addOverlay(rpgLayer, "RPG (parcelles agricoles)");
  }

  // Cadastre overlay (all parcels, agricultural or not).
  const cadastreLayer = L.tileLayer.wms(IGN_WMS, {
    layers: CADASTRE_LAYER,
    format: "image/png",
    transparent: true,
    version: "1.3.0",
    attribution: "Cadastre © DGFiP/IGN",
    opacity: 0.55,
  });

  // Initial RPG render — deferred when a Dropbox restore is imminent (the layer would be re-added
  // anyway once loadSession → refreshRpgLayer runs for the restored parcels' view).
  if (!app.getPendingDbxLoad()) {
    rpgLayer = buildRpgLayer().addTo(app.map);
  }

  // Layer control: the cadastre is registered initially; the RPG layer registers itself when built
  // (either now or lazily after a Dropbox restore completes).
  const layerCtl = L.control
    .layers(null, { "Cadastre (toutes parcelles)": cadastreLayer }, { collapsed: false })
    .addTo(app.map);
  if (rpgLayer) layerCtl.addOverlay(rpgLayer, "RPG (parcelles agricoles)");

  return { refreshChips: refreshRpgLayer, refreshRpgLayer };
}
