// AgriVision RE — satellite imagery (Copernicus / Sentinel-2 via the Worker → CDSE).
//
// For the currently selected parcels, fetch the timeline of available Sentinel-2
// acquisitions (dates + cloud cover) and let the user overlay a true-color or NDVI
// (vigor) image of any date on the map. This is a signed-in feature — the Worker gates
// /api/satellite/* on an AgriVision session because the Process API consumes CDSE quota.
//
// Réunion is frequently cloudy mi-pente/highlands, so the timeline surfaces cloud cover
// per date and the user picks the clearest pass. The catalog isn't fetched automatically
// (it costs quota) — the user clicks "Charger la timeline".

import { WORKER_URL } from "./config.js";
import { workerAuthHeader } from "./share.js";
import { safeSetItem } from "./storage-health.js";

// Bounding box [west, south, east, north] from the selected parcels' GeoJSON geometries.
function bboxFromParcels(selectedParcels) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    } else {
      for (const c of coords) walk(c);
    }
  };
  for (const p of selectedParcels.values()) {
    if (p.geometry?.coordinates) walk(p.geometry.coordinates);
  }
  if (!isFinite(w)) return null;
  return [w, s, e, n];
}

// Device-local NDVI cache. NDVI is opt-in and costs CDSE quota, so a recently-measured
// parcel returns instantly without another API call. Keyed by the parcel's bbox; the monthly
// mean is stable over the TTL. (Cross-device persistence lives in the culture manifest.)
const NDVI_CACHE_PREFIX = "ndvi:";
const NDVI_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
function geomBboxKey(geometry) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    } else c.forEach(walk);
  };
  if (geometry?.coordinates) walk(geometry.coordinates);
  if (!isFinite(w)) return null;
  return `${NDVI_CACHE_PREFIX}${w.toFixed(4)},${s.toFixed(4)},${e.toFixed(4)},${n.toFixed(4)}`;
}

function fmtDay(day) {
  try {
    return new Date(day + "T12:00:00Z").toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return day;
  }
}

// Photo sources shown in the timeline. Ground photos (your phone/camera) are the default;
// `photo.source` lets future imports (e.g. drone) slot in as a distinct, clearly-labelled row.
const PHOTO_SOURCES = {
  camera: { icon: "📷", noun: "photo terrain" },
  drone: { icon: "🚁", noun: "photo drone" },
};

function cloudBadge(cloud) {
  const t = `title="Couverture nuageuse — plus c'est bas, plus l'image est nette"`;
  if (cloud == null) return `<span ${t} style="color:var(--muted)">☁ ?</span>`;
  const c = Math.round(cloud);
  const color = c <= 10 ? "var(--accent)" : c <= 40 ? "var(--warn)" : "var(--bad)";
  return `<span ${t} style="color:${color}">☁ ${c}%</span>`;
}

export function createSatellite(app) {
  // app: { map, getSelectedParcels(), getPhotos() }
  const state = {
    index: "truecolor", // or "ndvi"
    opacity: 0.85,
    acquisitions: null,
    loading: false,
    error: null,
    activeDay: null,
    overlay: null, // Leaflet imageOverlay
    objectUrl: null,
  };

  function base() {
    return (WORKER_URL || "").replace(/\/$/, "");
  }
  function authed() {
    return !!workerAuthHeader().authorization;
  }

  async function loadTimeline() {
    const parcels = app.getSelectedParcels();
    const bbox = parcels && bboxFromParcels(parcels);
    if (!bbox) {
      state.error = "Sélectionne au moins une parcelle.";
      render();
      return;
    }
    if (!authed()) {
      state.error = "Connecte-toi pour accéder au satellite.";
      render();
      return;
    }
    state.loading = true;
    state.error = null;
    render();
    try {
      const r = await fetch(`${base()}/api/satellite/catalog`, {
        method: "POST",
        headers: { "content-type": "application/json", ...workerAuthHeader() },
        body: JSON.stringify({ bbox, maxCloud: 100 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      state.acquisitions = j.acquisitions || [];
    } catch (e) {
      state.error = e.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function showDay(day) {
    const parcels = app.getSelectedParcels();
    const bbox = parcels && bboxFromParcels(parcels);
    if (!bbox) return;
    state.activeDay = day;
    state.error = null;
    render();
    try {
      const r = await fetch(`${base()}/api/satellite/image`, {
        method: "POST",
        headers: { "content-type": "application/json", ...workerAuthHeader() },
        body: JSON.stringify({ bbox, day, index: state.index, width: 1024, height: 1024 }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      clearOverlay();
      state.objectUrl = URL.createObjectURL(blob);
      const [w, s, e, n] = bbox;
      state.overlay = window.L.imageOverlay(
        state.objectUrl,
        window.L.latLngBounds([s, w], [n, e]),
        { opacity: state.opacity, interactive: false }
      ).addTo(app.map);
    } catch (e) {
      state.error = e.message;
    }
    render();
  }

  function clearOverlay() {
    if (state.overlay) {
      app.map.removeLayer(state.overlay);
      state.overlay = null;
    }
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
  }

  function clear() {
    clearOverlay();
    state.activeDay = null;
    render();
  }

  // --- NDVI vigor (per parcel), via the Statistical API ---
  function ndviLabel(mean) {
    if (mean == null) return "n/a";
    if (mean < 0.15) return "sol nu / très faible";
    if (mean < 0.3) return "végétation clairsemée";
    if (mean < 0.45) return "vigueur faible à modérée";
    if (mean < 0.6) return "vigueur modérée";
    if (mean < 0.75) return "vigueur dense";
    return "très dense / vigoureuse";
  }
  const ndvi = { loading: false, error: null, loaded: false };

  // Fetch the latest NDVI mean for one geometry and return { mean, date, label, min, max }.
  // Served from the device-local cache when a recent measurement exists.
  async function fetchGeomNdvi(geometry, { force = false } = {}) {
    const key = geomBboxKey(geometry);
    if (key && !force) {
      try {
        const c = JSON.parse(localStorage.getItem(key) || "null");
        if (c && Date.now() - c.fetchedAt < NDVI_CACHE_TTL_MS) return c.data;
      } catch {}
    }
    const r = await fetch(`${base()}/api/satellite/statistics`, {
      method: "POST",
      headers: { "content-type": "application/json", ...workerAuthHeader() },
      body: JSON.stringify({ geometry, intervalDays: 30 }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const l = j.latest;
    if (!l) return null;
    const data = { mean: l.mean, min: l.min, max: l.max, date: (l.to || "").slice(0, 10), label: ndviLabel(l.mean), series: j.series };
    if (key) safeSetItem(key, JSON.stringify({ fetchedAt: Date.now(), data }));
    return data;
  }

  // Attach `parcel.ndvi` to each selected parcel (mirrors the soil/altitude enrichment).
  // Opt-in (costs CDSE quota) — triggered by the panel button. Re-renders progressively.
  async function loadNdvi() {
    const parcels = app.getSelectedParcels();
    if (!parcels || parcels.size === 0) {
      ndvi.error = "Sélectionne au moins une parcelle.";
      render();
      return;
    }
    if (!authed()) {
      ndvi.error = "Connecte-toi pour la vigueur satellite.";
      render();
      return;
    }
    ndvi.loading = true;
    ndvi.error = null;
    render();
    try {
      for (const parcel of parcels.values()) {
        if (!parcel.geometry) continue;
        try {
          parcel.ndvi = await fetchGeomNdvi(parcel.geometry);
        } catch (e) {
          parcel.ndvi = null;
          ndvi.error = e.message;
        }
        render();
      }
      ndvi.loaded = true;
    } finally {
      ndvi.loading = false;
      render();
    }
  }

  function ndviBlock() {
    const parcels = app.getSelectedParcels();
    const rows = [];
    let i = 0;
    for (const p of parcels?.values() || []) {
      i++;
      if (p.ndvi) {
        const pct = Math.round(p.ndvi.mean * 100);
        const col = p.ndvi.mean >= 0.6 ? "var(--accent)" : p.ndvi.mean >= 0.3 ? "var(--warn)" : "var(--bad)";
        rows.push(
          `<div style="display:flex;justify-content:space-between;font-size:11px;gap:8px"><span>Parcelle ${i}</span><span style="color:${col}">NDVI ${p.ndvi.mean} · ${p.ndvi.label}</span></div>`
        );
      }
    }
    return `
      <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
          <span class="small" style="color:var(--muted)">Vigueur (NDVI moyen, Sentinel-2)</span>
          <button id="sat-ndvi-load" class="secondary" style="font-size:11px;padding:4px 8px">${ndvi.loading ? "…" : "📊 Mesurer"}</button>
        </div>
        ${rows.length ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:3px">${rows.join("")}</div>` : ""}
        ${ndvi.error ? `<div class="small" style="color:var(--bad);margin-top:4px">⚠ ${ndvi.error}</div>` : ""}
        ${rows.length ? `<div class="small" style="color:var(--muted);margin-top:4px">Injecté dans la prochaine analyse IA.</div>` : ""}
      </div>`;
  }

  // --- IGN BD ORTHO — high-detail aerial (~20 cm, France + DOM), free WMTS, no key. A crisp
  // true-color base for "see the parcel in detail"; complements (doesn't replace) Sentinel-2,
  // which stays the multispectral/NDVI + time-series source.
  const IGN_ORTHO_WMTS =
    "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";
  const ortho = { layer: null, on: false };

  function toggleOrtho() {
    if (ortho.on) {
      if (ortho.layer) app.map.removeLayer(ortho.layer);
      ortho.on = false;
    } else {
      if (!ortho.layer) {
        ortho.layer = window.L.tileLayer(IGN_ORTHO_WMTS, {
          maxZoom: 21,
          maxNativeZoom: 19,
          tileSize: 256,
          zIndex: 250, // above the base tiles, below the parcel highlights / NDVI overlays
          attribution: "IGN BD ORTHO",
        });
      }
      ortho.layer.addTo(app.map);
      ortho.on = true;
    }
    render();
  }

  function orthoBlock() {
    return `
      <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border)">
        <button id="sat-ortho" class="${ortho.on ? "" : "secondary"}" style="font-size:11px;padding:5px 8px;width:100%">
          ${ortho.on ? "🔍 Ortho IGN affichée — masquer" : "🔍 Ortho IGN — vue aérienne (~20 cm)"}
        </button>
        ${ortho.on ? `<div class="small" style="color:var(--muted);margin-top:3px">Aérien haute résolution (IGN, FR + DOM). Pas de NDVI — c'est une vue détaillée, pas une mesure de vigueur.</div>` : ""}
      </div>`;
  }

  // Merge satellite acquisition days with user photo dates into one chronological history.
  // Photos are grouped per day (a day shows "📷 · N photo(s)").
  function combinedHistory() {
    const items = [];
    for (const a of state.acquisitions || []) {
      items.push({ kind: "sat", day: a.day, cloud: a.cloud });
    }
    const photos = app.getPhotos?.() || [];
    const groups = {}; // `${day}|${source}` -> count
    for (const p of photos) {
      if (!p.takenAt) continue;
      const day = new Date(p.takenAt).toISOString().slice(0, 10);
      const source = PHOTO_SOURCES[p.source] ? p.source : "camera";
      const k = `${day}|${source}`;
      groups[k] = (groups[k] || 0) + 1;
    }
    for (const [k, count] of Object.entries(groups)) {
      const [day, source] = k.split("|");
      items.push({ kind: "photo", day, source, count });
    }
    // newest first
    return items.sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  function render() {
    const wrap = document.getElementById("satellite-panel");
    if (!wrap) return;
    const toggle = `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <button id="sat-tc" class="${state.index === "truecolor" ? "" : "secondary"}" style="font-size:11px;padding:4px 8px">Couleur</button>
        <button id="sat-ndvi" class="${state.index === "ndvi" ? "" : "secondary"}" style="font-size:11px;padding:4px 8px">NDVI (vigueur)</button>
      </div>`;

    if (!state.acquisitions) {
      wrap.innerHTML = `
        ${orthoBlock()}
        ${ndviBlock()}
        <div class="small" style="color:var(--muted);margin-bottom:6px">Images Sentinel-2 (Copernicus) pour les parcelles sélectionnées.</div>
        <button id="sat-load" class="secondary" style="font-size:11px;padding:4px 8px">${state.loading ? "Chargement…" : "🛰️ Charger la timeline"}</button>
        ${state.error ? `<div class="small" style="color:var(--bad);margin-top:6px">⚠ ${state.error}</div>` : ""}`;
      document.getElementById("sat-load")?.addEventListener("click", loadTimeline);
      document.getElementById("sat-ndvi-load")?.addEventListener("click", loadNdvi);
      document.getElementById("sat-ortho")?.addEventListener("click", toggleOrtho);
      return;
    }

    const history = combinedHistory();
    const legend = `<div class="small" style="color:var(--muted);margin-bottom:6px;line-height:1.5">
        🛰️ satellite — <strong>clic = afficher sur la carte</strong> · ☁ couverture nuageuse · 📷 tes photos terrain (clic = voir)
      </div>`;
    const rows = history.length
      ? history
          .map((it) => {
            if (it.kind === "sat") {
              const active = it.day === state.activeDay;
              return `<button class="sat-day" data-day="${it.day}" title="Afficher cette image satellite sur la carte" style="display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;font-size:11px;padding:4px 8px;border:1px solid ${active ? "var(--accent)" : "var(--border)"};background:${active ? "var(--panel2)" : "transparent"};border-radius:4px;cursor:pointer">
                  <span>🛰️ ${fmtDay(it.day)}${active ? " ✓ affichée" : ""}</span>${cloudBadge(it.cloud)}
                </button>`;
            }
            const src = PHOTO_SOURCES[it.source] || PHOTO_SOURCES.camera;
            return `<button class="hist-photo" title="Tes ${src.noun}s de ce jour — clic pour voir" style="display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;font-size:11px;padding:4px 8px;border:1px dashed var(--border);background:transparent;border-radius:4px;cursor:pointer;color:var(--text)">
                <span>${src.icon} ${fmtDay(it.day)}</span><span style="color:var(--muted)">${it.count} ${src.noun}${it.count > 1 ? "s" : ""} →</span>
              </button>`;
          })
          .join("")
      : `<div class="small" style="color:var(--muted)">Aucune acquisition trouvée (6 derniers mois).</div>`;

    wrap.innerHTML = `
      ${orthoBlock()}
      ${ndviBlock()}
      ${toggle}
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <label class="small" style="color:var(--muted)">Opacité</label>
        <input id="sat-opacity" type="range" min="0.2" max="1" step="0.05" value="${state.opacity}" style="flex:1">
        <button id="sat-clear" class="secondary" style="font-size:11px;padding:4px 8px">Effacer</button>
        <button id="sat-reload" class="secondary" style="font-size:11px;padding:4px 8px">↻</button>
      </div>
      ${legend}
      <div style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto">${rows}</div>
      ${state.error ? `<div class="small" style="color:var(--bad);margin-top:6px">⚠ ${state.error}</div>` : ""}`;

    document.getElementById("sat-tc")?.addEventListener("click", () => setIndex("truecolor"));
    document.getElementById("sat-ndvi")?.addEventListener("click", () => setIndex("ndvi"));
    document.getElementById("sat-clear")?.addEventListener("click", clear);
    document.getElementById("sat-reload")?.addEventListener("click", loadTimeline);
    document.getElementById("sat-opacity")?.addEventListener("input", (e) => {
      state.opacity = parseFloat(e.target.value);
      if (state.overlay) state.overlay.setOpacity(state.opacity);
    });
    wrap.querySelectorAll(".sat-day").forEach((btn) => {
      btn.addEventListener("click", () => showDay(btn.dataset.day));
    });
    wrap.querySelectorAll(".hist-photo").forEach((btn) => {
      btn.addEventListener("click", () => app.openPhotos?.());
    });
    document.getElementById("sat-ndvi-load")?.addEventListener("click", loadNdvi);
    document.getElementById("sat-ortho")?.addEventListener("click", toggleOrtho);
  }

  function setIndex(idx) {
    if (state.index === idx) return;
    state.index = idx;
    // Re-render the active day with the new index if one is shown.
    if (state.activeDay) showDay(state.activeDay);
    else render();
  }

  // Measure NDVI for a single parcel (used by the parcel detail sheet). Sets parcel.ndvi
  // and refreshes the satellite panel. Returns the result or null.
  async function measureParcel(parcel) {
    if (!parcel?.geometry || !authed()) return null;
    try {
      parcel.ndvi = await fetchGeomNdvi(parcel.geometry);
    } catch {
      parcel.ndvi = null;
    }
    render();
    return parcel.ndvi;
  }

  return { render, loadTimeline, clear, measureParcel };
}
