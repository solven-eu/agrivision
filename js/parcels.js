// AgriVision RE — parcel multi-selection on the map.
// Click → WFS GetFeature → point-in-polygon disambiguation → toggle selection. Each selected
// parcel is highlighted (green) with a crop emoji at its centroid. Side panel renders the
// running aggregate (count, area, BIO mode). Two on-map hint controls (select / lock).

import { IGN_WFS, RPG_WFS_TYPE } from "./config.js";
import { CULTU_LABELS, cropMeta, resolveIdentifiedCropMeta } from "./catalog.js";
import { pointInGeom } from "./util.js";
import { aggregateParcels, parcelArea } from "./state.js";
import { fetchSoilAt, renderSoilCard } from "./soil.js";
import { scoreSuitability, colorForScore, evaluateParcel, scoreAllCrops } from "./culture-fit.js";
import { PLAN_FEATURES } from "./plan-features.js";

// Client-side parcel cap. Read from the shared plan-features config; default to Free's
// limit when no tier is known yet (boot, anonymous, etc.). The Worker is NOT involved
// in parcel storage — this is purely a UX gate that points the user at the upgrade path.
function maxParcelsForCurrentPlan() {
  const tier = window.__lastPlanTier || "free";
  return PLAN_FEATURES[tier]?.parcels?.max_count ?? PLAN_FEATURES.free.parcels.max_count;
}

// Static slider for a single soil parameter showing the optimum band, the optimum point,
// and where this parcel's measured value sits — plus the score contribution. Visual
// affordance to understand WHY the headline score is what it is.
function renderComponentSlider(comp) {
  if (!comp) return "";
  const [lo, hi, opt] = comp.range;
  // Render axis from (lo − 0.5·tolerance) to (hi + 0.5·tolerance) so the OK band fills
  // most of the bar but out-of-range values still appear with a visible offset.
  const span = (hi != null ? hi : opt) - lo || 1;
  const axisMin = lo - span * 0.5;
  const axisMax = (hi != null ? hi : opt + span * 0.3) + span * 0.5;
  const pct = (v) => Math.max(0, Math.min(100, ((v - axisMin) / (axisMax - axisMin)) * 100));
  const loPct = pct(lo);
  const hiPct = hi != null ? pct(hi) : 100;
  const optPct = pct(opt);
  const markerPct = pct(comp.value);
  const inRange = comp.value >= lo && (hi == null || comp.value <= hi);
  const markerColor = inRange ? "var(--accent)" : "var(--bad)";
  return `
    <div style="margin-top:6px">
      <div style="display:flex;justify-content:space-between;font-size:11px">
        <span><b>${comp.label}</b> · ${comp.value}${comp.unit ? " " + comp.unit : ""}</span>
        <span style="color:var(--muted)">${comp.contribution_pts}/${comp.max_pts} pts</span>
      </div>
      <div style="position:relative;height:8px;background:var(--panel);border-radius:4px;margin-top:3px;border:1px solid var(--border)">
        <div style="position:absolute;left:${loPct}%;width:${hiPct - loPct}%;height:100%;background:rgba(74,222,128,0.25);border-radius:4px"></div>
        <div style="position:absolute;left:${optPct}%;top:-2px;bottom:-2px;width:2px;background:var(--accent)"></div>
        <div style="position:absolute;left:calc(${markerPct}% - 2px);top:-3px;bottom:-3px;width:4px;background:${markerColor};border-radius:2px;box-shadow:0 0 3px rgba(0,0,0,0.5)" title="Votre parcelle"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--muted);margin-top:1px">
        <span>${axisMin.toFixed(1)}</span>
        <span>min ok ${lo}</span>
        <span>opt ${opt}</span>
        ${hi != null ? `<span>max ok ${hi}</span>` : ""}
        <span>${axisMax.toFixed(1)}</span>
      </div>
    </div>`;
}

function renderParcelBreakdown(parcel) {
  const code = parcel.props?.code_cultu || "UNK";
  if (!parcel.soil?.summary) {
    return `<div class="small" style="color:var(--muted)">Pas de données sol pour cette parcelle.</div>`;
  }
  const evalRes = evaluateParcel(parcel.soil, code);
  if (!evalRes) {
    return `<div class="small" style="color:var(--muted)">Score non calculable pour ${code}.</div>`;
  }
  const compHtml = ["pH", "CEC", "K"].map((k) => renderComponentSlider(evalRes.components[k])).join("");
  // Independent crop recommendations — top 5 best-fit crops for this soil.
  const all = scoreAllCrops(parcel.soil);
  const top = all.slice(0, 5);
  const recoHtml = top
    .map((r) => {
      const label = CULTU_LABELS[r.crop] || r.crop;
      const isCurrent = r.crop === code;
      const color = colorForScore(r.score);
      return `<div style="display:flex;justify-content:space-between;padding:2px 0">
        <span>${isCurrent ? "★ " : ""}${label} <span class="small" style="color:var(--muted)">(${r.crop})</span></span>
        <span style="color:${color}"><b>${r.score}%</b> ${r.label}</span>
      </div>`;
    })
    .join("");
  return `
    <div style="padding:8px;background:var(--panel);border-radius:4px;margin-top:4px;font-size:12px">
      <div class="small" style="color:var(--muted);margin-bottom:2px">Score détaillé pour la culture actuelle</div>
      ${compHtml}
      ${evalRes.reasons.length ? `<div class="small" style="margin-top:6px;color:var(--bad)">⚠ ${evalRes.reasons.join(" · ")}</div>` : ""}
      <div style="border-top:1px dashed var(--border);margin-top:8px;padding-top:6px">
        <div class="small" style="color:var(--muted);margin-bottom:4px">Cultures recommandées pour ce sol (★ = actuelle)</div>
        ${recoHtml}
      </div>
    </div>`;
}

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
      else {
        const cap = maxParcelsForCurrentPlan();
        if (app.selectedParcels.size >= cap) {
          parcelInfoEl.innerHTML = `<dt>Limite atteinte</dt><dd class="small">Ton plan actuel autorise ${cap} parcelle${cap > 1 ? "s" : ""} max. <a href="#" id="upgrade-from-parcels" style="color:var(--accent)">Passer à un plan supérieur ↗</a></dd>`;
          parcelInfoEl.style.display = "block";
          document.getElementById("upgrade-from-parcels")?.addEventListener("click", (e) => {
            e.preventDefault();
            document.getElementById("app-menu-panel").style.display = "block";
          });
          return;
        }
        const parcel = {
          props: hit.properties,
          geometry: hit.geometry,
          latlng: [lat, lon],
          soil: null,
          soilFetched: false,
        };
        app.selectedParcels.set(id, parcel);
        // Fire-and-forget soil lookup at the click point. On result, attach to the parcel
        // and re-render so the soil card appears + the AI context picks it up next call.
        fetchSoilAt(lat, lon)
          .then((soil) => {
            parcel.soil = soil;
            parcel.soilFetched = true;
            renderParcelInfoPanel();
          })
          .catch((err) => {
            parcel.soil = { error: err?.message || "unknown" };
            parcel.soilFetched = true;
            renderParcelInfoPanel();
          });
      }
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
      // Effective BIO: user override wins, else fall back to the RPG flag.
      const bioMode = app.getBioMode();
      const isBio = bioMode === "bio" || (bioMode === "auto" && p.props?.bio === 1);
      if (meta.emoji || isBio) {
        const center = layer.getBounds().getCenter();
        const bioBadge = isBio ? `<span class="parcel-bio" title="Agriculture biologique">🌱</span>` : "";
        L.marker(center, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "",
            html: `<div class="parcel-emoji-wrap"><div class="parcel-emoji" title="${meta.fr}">${meta.emoji || ""}</div>${bioBadge}</div>`,
            // Wider iconSize to accommodate the crop emoji + the small BIO leaf to its right.
            iconSize: [48, 28],
            iconAnchor: [24, 14],
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
    const { totalArea } = aggregateParcels(app.selectedParcels);
    const parcelsLocked = app.getParcelsLocked();
    const lockBadge = parcelsLocked ? ` <span style="color:var(--warn)">🔒</span>` : "";
    let html = `<dt>${app.selectedParcels.size} parcelle(s) — ${totalArea.toFixed(2)} ha${lockBadge}</dt>`;
    // Per-parcel list: each row shows surface, soil dominant type, and a soil×crop fit
    // score (rules-based — see js/culture-fit.js). Soil and fit appear progressively as
    // fetchSoilAt resolves; "…" is the in-flight placeholder.
    let idx = 0;
    for (const [, p] of app.selectedParcels) {
      idx++;
      const code = p.props?.code_cultu || "UNK";
      const label = CULTU_LABELS[code] || code;
      const emoji = cropMeta(code)?.emoji || "🌾";
      const area = parcelArea(p.props).toFixed(2);
      const bio = p.props?.bio === 1 ? " 🌱" : "";
      const soilType = p.soil?.summary?.dominant_soil_type;
      const fit = scoreSuitability(p.soil, code);
      let detail;
      if (!p.soilFetched) {
        detail = `<span class="small" style="color:var(--muted)">🪨 chargement du sol…</span>`;
      } else if (!p.soil) {
        // fetchSoilAt returned null (no WORKER_URL or no lat/lon — programmer error path).
        detail = `<span class="small" style="color:var(--muted)">🪨 lookup sol indisponible (Worker non configuré ?)</span>`;
      } else if (p.soil.error) {
        // Fetch ran but the Worker errored or returned no usable data.
        detail = `<span class="small" style="color:var(--bad)">🪨 erreur : ${p.soil.error}</span>`;
      } else if (!soilType) {
        detail = `<span class="small" style="color:var(--muted)">🪨 pas de données sol pour cette zone</span>`;
      } else {
        const color = colorForScore(fit?.score);
        const fitChip = fit
          ? `<span style="color:${color}"><b>${fit.score}%</b> ${fit.label}${fit.reasons.length ? ` <span class="small" style="color:var(--muted)">(${fit.reasons.join(", ")})</span>` : ""}</span>`
          : `<span class="small" style="color:var(--muted)">score n/d</span>`;
        detail = `<span class="small">🪨 ${soilType} · ${fitChip}</span>`;
      }
      const detailId = `parcel-detail-${idx}`;
      const hasSoil = !!p.soil?.summary;
      const expandBtn = hasSoil
        ? `<button class="secondary parcel-expand" data-detail="${detailId}" style="font-size:10px;padding:1px 6px;float:right" title="Détail du score + cultures recommandées">▾ Détail</button>`
        : "";
      html += `<dd style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border)">
        ${expandBtn}<b>P${idx}.</b> ${emoji} ${label} <span class="small" style="color:var(--muted)">(${code})</span>${bio} · <b>${area} ha</b>
        <div style="margin-top:2px">${detail}</div>
        <div id="${detailId}" style="display:none">${hasSoil ? renderParcelBreakdown(p) : ""}</div>
      </dd>`;
    }
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
    // Soil card — pulled from the first selected parcel's cached soil lookup.
    // Renders nothing while the fetch is in flight; appears when fetchSoilAt resolves
    // and triggers a re-render.
    const firstParcel = app.selectedParcels.values().next().value;
    if (firstParcel?.soil) html += renderSoilCard(firstParcel.soil);
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
    // Per-parcel ▾ Détail toggle — expands the slider breakdown + crop recommendations.
    parcelInfoEl.querySelectorAll(".parcel-expand").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const target = document.getElementById(btn.dataset.detail);
        if (!target) return;
        const open = target.style.display !== "none";
        target.style.display = open ? "none" : "block";
        btn.textContent = open ? "▾ Détail" : "▴ Masquer";
      };
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
