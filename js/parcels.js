// AgriVision RE — parcel multi-selection on the map.
// Click → WFS GetFeature → point-in-polygon disambiguation → toggle selection. Each selected
// parcel is highlighted (green) with a crop emoji at its centroid. Side panel renders the
// running aggregate (count, area, BIO mode). Two on-map hint controls (select / lock).

import { IGN_WFS, RPG_WFS_TYPE } from "./config.js";
import { CULTU_LABELS, cropMeta, resolveIdentifiedCropMeta } from "./catalog.js";
import { pointInGeom } from "./util.js";
import { aggregateParcels } from "./state.js";

/**
 * @param {object} app - dependency bundle:
 *   - map (Leaflet), selectedParcels (Map, mutated in place)
 *   - getAnalysisCombined (fn) — accessor for emoji override
 *   - getBioMode / setBioMode — accessors
 *   - getParcelsLocked / setParcelsLocked — accessors
 *   - updateAnalyzeAvailability (fn)
 */
export function installParcels(app) {
  const parcelInfoEl = document.getElementById("parcel-info");
  const parcelHighlight = L.featureGroup().addTo(app.map);

  const featureKey = (f) =>
    f.id ||
    `${f.properties.pacage}-${f.properties.num_ilot}-${f.properties.num_parcel}-${f.properties.code_cultu}`;

  async function toggleParcelAt(latlng) {
    const { lat, lng: lon } = latlng;
    const d = 0.0005;
    const bbox = `${lon - d},${lat - d},${lon + d},${lat + d},EPSG:4326`;
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: RPG_WFS_TYPE,
      bbox,
      count: "10",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
    });
    try {
      const r = await fetch(`${IGN_WFS}?${params}`);
      const j = await r.json();
      if (!j.features?.length) {
        parcelInfoEl.innerHTML = `<dt>Aucune parcelle RPG ici</dt><dd class="small">Cliquer sur une zone agricole.</dd>`;
        parcelInfoEl.style.display = "block";
        return;
      }
      const pt = [lon, lat];
      const hit = j.features.find((f) => pointInGeom(pt, f.geometry)) || j.features[0];
      const id = featureKey(hit);
      if (app.selectedParcels.has(id)) app.selectedParcels.delete(id);
      else app.selectedParcels.set(id, { props: hit.properties, geometry: hit.geometry, latlng: [lat, lon] });
      renderParcelHighlight();
      renderParcelInfoPanel();
      updateLockHint();
      updateSelectHint();
    } catch (err) {
      parcelInfoEl.innerHTML = `<dt>Erreur</dt><dd>${err.message}</dd>`;
      parcelInfoEl.style.display = "block";
    }
  }

  function renderParcelHighlight() {
    parcelHighlight.clearLayers();
    for (const [, p] of app.selectedParcels) {
      const layer = L.geoJSON(p.geometry, {
        style: { color: "#4ade80", weight: 2, fillColor: "#4ade80", fillOpacity: 0.35 },
      }).addTo(parcelHighlight);
      const identified = resolveIdentifiedCropMeta(app.getAnalysisCombined()?.identification);
      const meta = identified || cropMeta(p.props?.code_cultu);
      if (meta.emoji) {
        const center = layer.getBounds().getCenter();
        L.marker(center, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "",
            html: `<div class="parcel-emoji" title="${meta.fr}">${meta.emoji}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        }).addTo(parcelHighlight);
      }
    }
  }

  function fitToSelectedParcels() {
    if (app.selectedParcels.size === 0) return;
    const b = parcelHighlight.getBounds();
    if (!b.isValid()) return;
    const sz = app.map.getSize();
    const padX = Math.round(sz.x * 0.15);
    const padY = Math.round(sz.y * 0.15);
    app.map.fitBounds(b, {
      paddingTopLeft: [padX, padY],
      paddingBottomRight: [padX, padY],
      animate: true,
    });
  }

  function renderParcelInfoPanel() {
    const bioMode = app.getBioMode();
    if (app.selectedParcels.size === 0) {
      parcelInfoEl.innerHTML = `
        <div class="parcel-empty">
          <span class="big">👉</span>
          <div class="lead">Sélectionnez vos parcelles</div>
          <div style="margin-top:4px">Cliquez directement sur la carte (zoom ≥ 12) sur les parcelles colorées qui vous intéressent.</div>
        </div>
        <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
          <label class="small" style="margin:0">Mode :</label>
          <select id="bio-mode" style="flex:1;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-size:11px">
            <option value="auto"${bioMode === "auto" ? " selected" : ""}>Auto (selon RPG)</option>
            <option value="bio"${bioMode === "bio" ? " selected" : ""}>🌱 BIO</option>
            <option value="conventional"${bioMode === "conventional" ? " selected" : ""}>Conventionnel</option>
          </select>
        </div>`;
      parcelInfoEl.style.display = "block";
      document.getElementById("bio-mode").addEventListener("change", (e) => {
        app.setBioMode(e.target.value);
        localStorage.setItem("agri_bio_mode", e.target.value);
        app.updateAnalyzeAvailability();
      });
      return;
    }
    const { totalArea, byCrop } = aggregateParcels(app.selectedParcels);
    const parcelsLocked = app.getParcelsLocked();
    const lockBadge = parcelsLocked ? ` <span style="color:var(--warn)">🔒</span>` : "";
    let html = `<dt>${app.selectedParcels.size} parcelle(s) — ${totalArea.toFixed(2)} ha${lockBadge}</dt>`;
    Object.entries(byCrop)
      .sort((a, b) => b[1].area - a[1].area)
      .forEach(([code, agg]) => {
        const label = CULTU_LABELS[code] || code;
        const bioTag = agg.bio === agg.count ? " 🌱" : agg.bio ? ` (${agg.bio} bio)` : "";
        html += `<dd>${label} <span class="small">(${code})</span> — ${agg.count} × ${agg.area.toFixed(2)} ha${bioTag}</dd>`;
      });
    html += `<div style="margin-top:8px;display:flex;gap:6px;align-items:center">
      <label class="small" style="margin:0">Mode :</label>
      <select id="bio-mode" style="flex:1;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-size:11px">
        <option value="auto"${bioMode === "auto" ? " selected" : ""}>Auto (selon RPG)</option>
        <option value="bio"${bioMode === "bio" ? " selected" : ""}>🌱 BIO</option>
        <option value="conventional"${bioMode === "conventional" ? " selected" : ""}>Conventionnel</option>
      </select>
    </div>`;
    html += `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
      <button class="secondary" id="fit-parcels" style="font-size:11px;padding:4px 8px">🎯 Cadrer</button>
      <button class="secondary" id="lock-parcels" style="font-size:11px;padding:4px 8px">${parcelsLocked ? "🔓 Déverrouiller" : "🔒 Verrouiller"}</button>
      <button class="secondary" id="clear-parcels" style="font-size:11px;padding:4px 8px" ${parcelsLocked ? "disabled" : ""}>Tout désélectionner</button>
    </div>`;
    parcelInfoEl.innerHTML = html;
    parcelInfoEl.style.display = "block";
    document.getElementById("clear-parcels").onclick = () => {
      if (app.getParcelsLocked()) return;
      app.selectedParcels.clear();
      renderParcelHighlight();
      renderParcelInfoPanel();
      updateLockHint();
      updateSelectHint();
    };
    document.getElementById("lock-parcels").onclick = () => {
      const next = !app.getParcelsLocked();
      app.setParcelsLocked(next);
      renderParcelInfoPanel();
      updateLockHint();
      if (next) fitToSelectedParcels();
    };
    document.getElementById("fit-parcels").onclick = () => fitToSelectedParcels();
    document.getElementById("bio-mode").addEventListener("change", (e) => {
      app.setBioMode(e.target.value);
      localStorage.setItem("agri_bio_mode", e.target.value);
      app.updateAnalyzeAvailability();
    });
  }

  // ---------- On-map hints ----------
  let _selectHint = null;
  function updateSelectHint() {
    if (!_selectHint) {
      const SelectHint = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
          const el = L.DomUtil.create("div", "select-hint");
          L.DomEvent.disableClickPropagation(el);
          el.innerHTML = "👉 Cliquez une parcelle pour commencer";
          return el;
        },
      });
      _selectHint = new SelectHint().addTo(app.map);
    }
    const el = _selectHint.getContainer();
    const show = app.selectedParcels.size === 0 && app.map.getZoom() >= 12;
    el.style.display = show ? "block" : "none";
    if (app.map.getZoom() < 12 && app.selectedParcels.size === 0) {
      el.style.display = "block";
      el.innerHTML = "🔍 Zoomez davantage pour cliquer sur une parcelle";
    } else if (show) {
      el.innerHTML = "👉 Cliquez une parcelle pour commencer";
    }
  }

  let _lockHint = null;
  function updateLockHint() {
    if (!_lockHint) {
      const LockHint = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
          const el = L.DomUtil.create("div", "lock-hint");
          L.DomEvent.disableClickPropagation(el);
          el.addEventListener("click", () => {
            app.setParcelsLocked(!app.getParcelsLocked());
            renderParcelInfoPanel();
            updateLockHint();
          });
          return el;
        },
      });
      _lockHint = new LockHint().addTo(app.map);
    }
    const el = _lockHint.getContainer();
    if (app.selectedParcels.size === 0) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    const parcelsLocked = app.getParcelsLocked();
    el.innerHTML = parcelsLocked
      ? `🔒 Parcelles verrouillées — clic sur la carte ignoré`
      : `🔓 Parcelles déverrouillées — clic = toggle parcelle`;
    el.className = "lock-hint " + (parcelsLocked ? "locked" : "unlocked");
  }

  app.map.on("zoomend", updateSelectHint);
  // First render: show the empty-state in the side panel + the on-map hint.
  setTimeout(() => {
    renderParcelInfoPanel();
    updateSelectHint();
  }, 100);

  // Briefly highlight the lock badge — used by the map-click router when the user clicks
  // while parcels are locked, to make the "ignored click" visible.
  function flashLockHint() {
    if (!_lockHint) return;
    const el = _lockHint.getContainer();
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 600);
  }

  // Show a "zoom in further" message in the side panel.
  function showZoomTooLowMessage() {
    parcelInfoEl.innerHTML = `<dt>Zoomer davantage</dt><dd class="small">Le clic est trop imprécis à ce niveau de zoom (≥12 recommandé).</dd>`;
    parcelInfoEl.style.display = "block";
  }

  return {
    featureKey,
    toggleParcelAt,
    renderParcelHighlight,
    fitToSelectedParcels,
    renderParcelInfoPanel,
    updateSelectHint,
    updateLockHint,
    flashLockHint,
    showZoomTooLowMessage,
  };
}
