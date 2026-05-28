// AgriVision RE — viewport-based crop chip filter + RPG/cadastre WMS layer management.
// On every map move, queries WFS GetFeature for distinct code_cultu values inside the viewport
// and renders one chip per crop type. Toggling a chip CQL_FILTERs the RPG WMS layer.

import { IGN_WMS, IGN_WFS, RPG_LAYER, RPG_WFS_TYPE, CADASTRE_LAYER } from "./config.js";
import { CULTU_LABELS } from "./catalog.js";

/**
 * @param {object} app - { map (Leaflet), getPendingDbxLoad (fn) → boolean }
 * @returns {{ refreshChips: fn, refreshRpgLayer: fn }}
 */
export function installChips(app) {
  let rpgLayer = null;
  let selectedGroups = new Set();
  let chipEls = {};
  let viewportCultus = new Set();
  let chipsExcluded = new Set();
  const chipsEl = document.getElementById("chips");

  // The CQL_FILTER string currently applied to rpgLayer. Used to dedupe rebuilds.
  let currentCqlFilter = null;

  // Compute the CQL_FILTER from current state. Returns "" when no filter is needed.
  function currentFilter() {
    if (viewportCultus.size === 0) return "";
    if (chipsExcluded.size === 0) return ""; // show all
    if (selectedGroups.size === 0) return `code_cultu IN ('__none__')`; // hide all
    const codes = [...selectedGroups].map((c) => `'${c}'`).join(",");
    return `code_cultu IN (${codes})`;
  }

  function buildRpgLayer(cqlFilter) {
    const opts = {
      layers: RPG_LAYER,
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      attribution: "RPG © IGN",
      opacity: 0.65,
    };
    if (cqlFilter) opts.CQL_FILTER = cqlFilter;
    return L.tileLayer.wms(IGN_WMS, opts);
  }

  // Rebuild the WMS layer ONLY when the CQL_FILTER actually changed. Otherwise reuse it —
  // Leaflet keeps its tile cache and avoids re-requesting every PNG on every map move.
  function refreshRpgLayer() {
    const newFilter = currentFilter();
    if (rpgLayer && newFilter === currentCqlFilter) return;
    currentCqlFilter = newFilter;
    const wasOnMap = !rpgLayer || app.map.hasLayer(rpgLayer);
    if (rpgLayer) {
      app.map.removeLayer(rpgLayer);
      if (layerCtl) layerCtl.removeLayer(rpgLayer);
    }
    rpgLayer = buildRpgLayer(newFilter).addTo(app.map);
    if (layerCtl) layerCtl.addOverlay(rpgLayer, "RPG (parcelles agricoles)");
    if (!wasOnMap) app.map.removeLayer(rpgLayer);
  }

  function rebuildRpgFilter() {
    selectedGroups.clear();
    for (const c of viewportCultus) if (!chipsExcluded.has(c)) selectedGroups.add(c);
    refreshRpgLayer();
  }

  async function refreshChips() {
    if (app.map.getZoom() < 11) {
      chipsEl.innerHTML = `<div class="small">Zoomer (≥11) pour voir les cultures du secteur.</div>`;
      return;
    }
    const b = app.map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},EPSG:4326`;
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: RPG_WFS_TYPE,
      bbox,
      count: "500",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      propertyName: "code_cultu",
    });
    chipsEl.innerHTML = `<div class="small">Recherche…</div>`;
    try {
      const r = await fetch(`${IGN_WFS}?${params}`);
      const j = await r.json();
      const cultus = new Set();
      (j.features || []).forEach((f) => {
        if (f.properties?.code_cultu) cultus.add(f.properties.code_cultu);
      });
      viewportCultus = cultus;
      chipsExcluded = new Set([...chipsExcluded].filter((c) => cultus.has(c)));
      renderChips();
      rebuildRpgFilter();
    } catch (e) {
      chipsEl.innerHTML = `<div class="small">Erreur : ${e.message}</div>`;
    }
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    chipEls = {};
    if (viewportCultus.size === 0) {
      chipsEl.innerHTML = `<div class="small">Aucune parcelle agricole dans la vue.</div>`;
      return;
    }
    [...viewportCultus].sort().forEach((code) => {
      const el = document.createElement("div");
      const on = !chipsExcluded.has(code);
      el.className = "chip" + (on ? " on" : "");
      el.textContent = CULTU_LABELS[code] || code;
      el.title = `code_cultu=${code}`;
      el.addEventListener("click", () => {
        if (chipsExcluded.has(code)) {
          chipsExcluded.delete(code);
          el.classList.add("on");
        } else {
          chipsExcluded.add(code);
          el.classList.remove("on");
        }
        rebuildRpgFilter();
      });
      chipsEl.appendChild(el);
      chipEls[code] = el;
    });
  }

  // Wire chip filter buttons (always selected / none).
  document.getElementById("chips-all")?.addEventListener("click", () => {
    chipsExcluded.clear();
    renderChips();
    rebuildRpgFilter();
  });
  document.getElementById("chips-none")?.addEventListener("click", () => {
    chipsExcluded = new Set(viewportCultus);
    renderChips();
    rebuildRpgFilter();
  });

  // Cadastre overlay (all parcels, agricultural or not).
  const cadastreLayer = L.tileLayer.wms(IGN_WMS, {
    layers: CADASTRE_LAYER,
    format: "image/png",
    transparent: true,
    version: "1.3.0",
    attribution: "Cadastre © DGFiP/IGN",
    opacity: 0.55,
  });

  // Initial RPG render — deferred when a Dropbox restore is imminent (the layer would be
  // re-fetched anyway once fitBounds moves the map to the actual parcels).
  if (!app.getPendingDbxLoad()) {
    currentCqlFilter = "";
    rpgLayer = buildRpgLayer("").addTo(app.map);
  }

  // Layer control: only the cadastre is registered initially; the RPG layer registers itself
  // via refreshRpgLayer (called either now or lazily after Dropbox restore completes).
  const layerCtl = L.control
    .layers(null, { "Cadastre (toutes parcelles)": cadastreLayer }, { collapsed: false })
    .addTo(app.map);
  if (rpgLayer) layerCtl.addOverlay(rpgLayer, "RPG (parcelles agricoles)");

  // Debounced refresh on map move.
  let _chipsTimer = null;
  app.map.on("moveend", () => {
    clearTimeout(_chipsTimer);
    _chipsTimer = setTimeout(refreshChips, 500);
  });

  // Initial chip load after map settles. Skip when a Dropbox auto-reload is imminent —
  // loadSession will fitBounds → moveend → refreshChips will fire for the right area.
  if (!app.getPendingDbxLoad()) setTimeout(refreshChips, 800);

  return { refreshChips, refreshRpgLayer };
}
