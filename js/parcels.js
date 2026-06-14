// AgriVision RE — parcel multi-selection on the map.
// Click → WFS GetFeature → point-in-polygon disambiguation → toggle selection. Each selected
// parcel is highlighted (green) with a crop emoji at its centroid. Side panel renders the
// running aggregate (count, area, BIO mode). Two on-map hint controls (select / lock).

import { IGN_WFS, RPG_WFS_TYPE } from "./config.js";
import { CULTU_LABELS, cropMeta, resolveIdentifiedCropMeta } from "./catalog.js";
import { pointInGeom } from "./util.js";
import { aggregateParcels, parcelArea } from "./state.js";
import { fetchSoilAt, renderSoilCard, soilSummaryLine } from "./soil.js";
import { fetchAltitude, exposureHintFromAltitude } from "./elevation.js";
import { scoreSuitability, colorForScore, evaluateParcel, scoreAllCrops } from "./culture-fit.js";
import { PLAN_FEATURES } from "./plan-features.js";

// Client-side parcel cap. Read from the shared plan-features config. The Worker is NOT involved
// in parcel storage — this is purely a UX gate that points the user at the upgrade path.
function maxParcelsForCurrentPlan() {
  const tier = window.__lastPlanTier;
  if (tier) return PLAN_FEATURES[tier]?.parcels?.max_count ?? PLAN_FEATURES.free.parcels.max_count;
  // Tier not resolved yet: a logged-in user's quota (incl. org-inherited Standard/Premium) is
  // fetched asynchronously at boot. Applying Free's cap of 1 here falsely blocks a returning user
  // who reloaded with parcels restored from a higher-tier session (the "4/1" bug). Be optimistic
  // while a session exists and the fetch is pending; a truly anonymous user gets Free.
  const hasSession = !!localStorage.getItem("agri_session");
  return hasSession ? Infinity : PLAN_FEATURES.free.parcels.max_count;
}

// Escape user-provided text (parcel names) before interpolating into innerHTML.
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// Slider switch markup for the lock toggle (🔓 left ↔ 🔒 right, knob slides to the active side).
// `id` lets the side-panel instance keep its #lock-parcels hook; the on-map instance omits it.
function lockSwitchHtml(locked, id) {
  const label = locked ? "Déverrouiller les parcelles" : "Verrouiller les parcelles";
  return (
    `<button class="lock-switch"${id ? ` id="${id}"` : ""} type="button" role="switch" ` +
    `aria-checked="${locked}" aria-label="${label}" title="${label}">` +
    `<span class="lock-switch-icon left">🔓</span>` +
    `<span class="lock-switch-icon right">🔒</span>` +
    `<span class="lock-switch-knob"></span>` +
    `</button>`
  );
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

function renderParcelBreakdown(parcel, idx, identifiedCrop) {
  if (!parcel.soil?.summary) {
    return `<div class="small" style="color:var(--muted)">Pas de données sol pour cette parcelle.</div>`;
  }
  // Effective crop = AI identification if available (e.g. "BAN" inferred from a banana
  // photo), else the RPG code. This fixes the "RPG says BCA / unknown but the AI saw
  // bananas" case — we use the better signal.
  const rpgCode = parcel.props?.code_cultu;
  const aiCode = identifiedCrop?.code_cultu;
  const rawCode = aiCode || rpgCode;
  // "Known crop" = a code that resolves to a real label.
  const hasKnownCrop = !!(rawCode && rawCode !== "UNK" && CULTU_LABELS[rawCode]);

  // Top-N crop recommendations — always computed, but presentation differs.
  const top = scoreAllCrops(parcel.soil).slice(0, 5);
  const recoHtml = top
    .map((r) => {
      const label = CULTU_LABELS[r.crop] || r.crop;
      const isCurrent = r.crop === rawCode;
      const color = colorForScore(r.score);
      return `<div style="display:flex;justify-content:space-between;padding:2px 0">
        <span>${isCurrent ? "★ " : ""}${label} <span class="small" style="color:var(--muted)">(${r.crop})</span></span>
        <span style="color:${color}"><b>${r.score}%</b> ${r.label}</span>
      </div>`;
    })
    .join("");

  if (!hasKnownCrop) {
    // No declared crop → recommendations are the primary display, no sliders.
    return `
      <div style="padding:8px;background:var(--panel);border-radius:4px;margin-top:4px;font-size:12px">
        <div class="small" style="color:var(--muted);margin-bottom:4px">
          Aucune culture déclarée sur cette parcelle. Cultures recommandées pour ce sol :
        </div>
        ${recoHtml}
      </div>`;
  }

  // Crop known → score detail for THAT crop is primary; alternatives behind a toggle.
  const evalRes = evaluateParcel(parcel.soil, rawCode);
  if (!evalRes) {
    return `<div class="small" style="color:var(--muted)">Score non calculable pour ${rawCode}.</div>`;
  }
  const compHtml = ["pH", "CEC", "K"].map((k) => renderComponentSlider(evalRes.components[k])).join("");
  const recosId = `parcel-recos-${idx}`;
  return `
    <div style="padding:8px;background:var(--panel);border-radius:4px;margin-top:4px;font-size:12px">
      <div class="small" style="color:var(--muted);margin-bottom:2px">Score détaillé pour ${CULTU_LABELS[rawCode]}</div>
      ${compHtml}
      ${evalRes.reasons.length ? `<div class="small" style="margin-top:6px;color:var(--bad)">⚠ ${evalRes.reasons.join(" · ")}</div>` : ""}
      <button class="secondary parcel-recos-toggle" data-target="${recosId}" style="font-size:11px;padding:3px 8px;margin-top:8px">▾ Voir alternatives</button>
      <div id="${recosId}" style="display:none;border-top:1px dashed var(--border);margin-top:6px;padding-top:6px">
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
  // Active = the SUBSET of selected parcels the user is currently focused on. Distinct
  // from the selection itself. Clicking a parcel row in the sidebar (or a polygon on the
  // map, when locked) toggles membership in this set. Used by future "contextual tools"
  // that should operate only on the focused subset (e.g. analyze only those photos that
  // sit in the focused parcels, run disease funnel on just one parcel of the field, etc.).
  // Empty set = all selected parcels are considered "in scope" (no narrowing applied).
  const activeParcelIds = new Set();
  function toggleActive(id) {
    if (activeParcelIds.has(id)) activeParcelIds.delete(id);
    else activeParcelIds.add(id);
  }

  const featureKey = (f) =>
    f.id ||
    `${f.properties.pacage}-${f.properties.num_ilot}-${f.properties.num_parcel}-${f.properties.code_cultu}`;

  // Point-in-polygon helper: which selected parcel contains the given lat/lon (if any)?
  // Used for photo → parcel association. v1 covers photos taken INSIDE the parcel; FOV
  // ray-casting for photos pointing AT a parcel from outside is a ROADMAP item.
  function findParcelForPoint(lat, lon) {
    if (lat == null || lon == null) return null;
    const pt = [lon, lat];
    for (const [id, p] of app.selectedParcels) {
      if (p.geometry && pointInGeom(pt, p.geometry)) return id;
    }
    return null;
  }
  // Recompute photo→parcel associations whenever the selection changes.
  function refreshPhotoAssociations() {
    for (const photo of app.photos || []) {
      photo.associatedParcelId = findParcelForPoint(photo.lat, photo.lon);
    }
  }

  async function toggleParcelAt(latlng) {
    const { lat, lng: lon } = latlng;
    const pt = [lon, lat];

    // When parcels are LOCKED, a map click must not add/remove anything — so don't hit the WFS
    // at all (it's a wasted network round-trip). ALWAYS blink the lock badge so the user gets
    // feedback that the lock is on (their earlier complaint: "should blink"). Then resolve the
    // click locally against the selected parcels' stored geometry: inside one → focus it.
    if (app.getParcelsLocked?.()) {
      let hitId = null;
      for (const [id, p] of app.selectedParcels) {
        if (p.geometry && pointInGeom(pt, p.geometry)) {
          hitId = id;
          break;
        }
      }
      if (hitId) {
        toggleActive(hitId);
        renderParcelHighlight();
        renderParcelInfoPanel();
        const sec = document.getElementById("parcels-section");
        if (sec && !sec.open) sec.open = true;
        // Open the detail sheet only when the click toggled the parcel IN; a toggle-out click
        // closes it instead of (re)opening it.
        if (activeParcelIds.has(hitId)) {
          const row = parcelInfoEl.querySelector(`.parcel-row[data-parcel-id="${hitId}"]`);
          row?.scrollIntoView({ behavior: "smooth", block: "center" });
          openParcelDetail(hitId); // inspect mode: show the parcel's detail sheet
        } else if (sheetParcelId === hitId) {
          closeParcelDetail();
        }
      }
      // Blink LAST — after the renders above, which call updateLockHint() and rewrite the badge's
      // className (that was silently wiping the "flash" class before, so it never animated).
      app.flashLockHint?.();
      return;
    }

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
        // Clicked outside any RPG parcel. Don't clobber the selected-parcels list (that made the
        // panel say "Aucune parcelle RPG ici" while the count showed 1) — only show that message
        // when nothing is selected; otherwise just re-render the existing selection.
        if (app.selectedParcels.size > 0) {
          renderParcelInfoPanel();
        } else {
          parcelInfoEl.innerHTML = `<dt>Aucune parcelle RPG ici</dt><dd class="small">Cliquer sur une zone agricole.</dd>`;
          parcelInfoEl.style.display = "block";
        }
        return;
      }
      const hit = j.features.find((f) => pointInGeom(pt, f.geometry)) || j.features[0];
      const id = featureKey(hit);
      // (Locked clicks are handled up-front without a WFS call — see the top of this function.)
      if (app.selectedParcels.has(id)) app.selectedParcels.delete(id);
      else {
        const cap = maxParcelsForCurrentPlan();
        // Always allow the FIRST parcel, whatever the plan cap (and whatever its surface) — a
        // user must be able to document at least one field, even a very large one, to get any
        // value from the app. The cap only gates selecting ADDITIONAL parcels beyond the first.
        if (app.selectedParcels.size >= 1 && app.selectedParcels.size >= cap) {
          // Over plan: reject the addition (nothing sticks on the map) and surface a loud,
          // actionable toast with an upgrade path — see CLAUDE.md "Gating". The enforcement
          // boundary just emits the event; toast.js renders it.
          window.dispatchEvent(
            new CustomEvent("agrivision:plan-blocked", {
              detail: {
                feature: "parcels",
                current: app.selectedParcels.size,
                cap,
                message: `Limite atteinte : ${app.selectedParcels.size}/${cap} parcelle${cap > 1 ? "s" : ""}. Passe à un plan supérieur pour en sélectionner davantage.`,
              },
            })
          );
          return;
        }
        const parcel = {
          props: hit.properties,
          geometry: hit.geometry,
          latlng: [lat, lon],
          soil: null,
          soilFetched: false,
          altitude: null,
          altitudeFetched: false,
        };
        app.selectedParcels.set(id, parcel);
        // Fire-and-forget soil + altitude lookups. Each resolves independently and
        // triggers a re-render so the info panel populates progressively.
        fetchSoilAt(lat, lon)
          .then((soil) => {
            parcel.soil = soil;
            parcel.soilFetched = true;
            renderParcelInfoPanel();
            renderParcelSheet();
          })
          .catch((err) => {
            parcel.soil = { error: err?.message || "unknown" };
            parcel.soilFetched = true;
            renderParcelInfoPanel();
            renderParcelSheet();
          });
        fetchAltitude(lat, lon)
          .then((alt) => {
            parcel.altitude = alt;
            parcel.altitudeFetched = true;
            renderParcelInfoPanel();
            renderParcelSheet();
          })
          .catch(() => {
            parcel.altitudeFetched = true;
            renderParcelInfoPanel();
            renderParcelSheet();
          });
      }
      // Selection changed → re-evaluate which photos sit inside which parcels.
      refreshPhotoAssociations();
      renderParcelHighlight();
      renderParcelInfoPanel();
      app.renderPhotos?.();
      updateLockHint();
      updateSelectHint();
      // USER click → open the section so the user sees the result. Restore-time
      // re-renders don't reach this code path, so reloads keep everything folded.
      const sec = document.getElementById("parcels-section");
      if (sec && app.selectedParcels.size > 0 && !sec.open) sec.open = true;
      // Don't auto-open the detail sheet while building the selection (unlocked) — it popped
      // over the map on every added parcel and got in the way of selecting the next one.
      // Inspection happens once parcels are locked (see the locked branch above). Just close
      // the sheet if this click deselected the parcel it was showing.
      if (!app.selectedParcels.has(id) && sheetParcelId === id) closeParcelDetail();
    } catch (err) {
      parcelInfoEl.innerHTML = `<dt>Erreur</dt><dd>${err.message}</dd>`;
      parcelInfoEl.style.display = "block";
    }
  }

  function renderParcelHighlight() {
    parcelHighlight.clearLayers();
    // Locked = inspection mode: keep the parcel INTERIOR clear (transparent) so satellite
    // imagery / RPG colors show through, and mark each parcel with an outward-fading glow
    // (layered translucent strokes) + a crisp edge. Unlocked = selection-building mode:
    // a green fill makes the picked parcels obvious while you assemble the set.
    const locked = app.getParcelsLocked?.();
    for (const [pid, p] of app.selectedParcels) {
      const isActive = activeParcelIds.has(pid);
      const edge = isActive ? "#fbbf24" : "#4ade80";
      let layer;
      if (locked) {
        // Halo: widest + faintest underneath → narrower → crisp 2px edge on top. Reads as a
        // glow hugging the boundary while the inside stays neat.
        L.geoJSON(p.geometry, { style: { color: edge, weight: 11, opacity: 0.08, fill: false } }).addTo(parcelHighlight);
        L.geoJSON(p.geometry, { style: { color: edge, weight: 6, opacity: 0.18, fill: false } }).addTo(parcelHighlight);
        layer = L.geoJSON(p.geometry, { style: { color: edge, weight: isActive ? 3 : 2, opacity: 1, fill: false } }).addTo(parcelHighlight);
      } else {
        // Active parcels get a brighter, thicker BORDER. Fill stays green (same as inactive)
        // so the highlight doesn't drown out the underlying RPG colors.
        const style = isActive
          ? { color: "#fbbf24", weight: 5, fillColor: "#4ade80", fillOpacity: 0.35 }
          : { color: "#4ade80", weight: 2, fillColor: "#4ade80", fillOpacity: 0.35 };
        layer = L.geoJSON(p.geometry, { style }).addTo(parcelHighlight);
      }
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
    // Selection changed (e.g. cleared) — refresh the on-map "Recadrer" visibility.
    updateRecadrerBtn();
  }

  // On-map "Recadrer" button — appears only once the user has panned/zoomed away from the
  // last auto-fit, and snaps the view back to frame the selected parcels.
  let recadrerCtrl = null;
  let fitTarget = null; // {center, zoom} captured after the last fit settles
  let suppressDrift = false; // ignore the programmatic moveend our own fitBounds triggers

  function ensureRecadrerControl() {
    if (recadrerCtrl) return;
    const Ctrl = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const btn = L.DomUtil.create("button", "recadrer-btn");
        btn.type = "button";
        btn.innerHTML = "🎯 Recadrer";
        btn.title = "Revenir au cadrage automatique des parcelles";
        btn.style.display = "none";
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.stop(e);
          fitToSelectedParcels();
        });
        recadrerCtrl = { btn };
        return btn;
      },
    });
    app.map.addControl(new Ctrl());
  }

  function isViewDrifted() {
    if (!fitTarget) return false;
    if (Math.abs(app.map.getZoom() - fitTarget.zoom) >= 0.75) return true;
    const p1 = app.map.latLngToContainerPoint(app.map.getCenter());
    const p2 = app.map.latLngToContainerPoint(fitTarget.center);
    return p1.distanceTo(p2) > 80; // pixels — scale-aware, intuitive threshold
  }

  function updateRecadrerBtn() {
    if (!recadrerCtrl) return;
    const drifted = app.selectedParcels.size > 0 && !suppressDrift && isViewDrifted();
    recadrerCtrl.btn.style.display = drifted ? "block" : "none";
  }

  function fitToSelectedParcels() {
    if (app.selectedParcels.size === 0) return;
    const b = parcelHighlight.getBounds();
    if (!b.isValid()) return;
    ensureRecadrerControl();
    const sz = app.map.getSize();
    const padX = Math.round(sz.x * 0.15);
    const padY = Math.round(sz.y * 0.15);
    suppressDrift = true; // the resulting moveend is ours, not the user's
    app.map.fitBounds(b, {
      paddingTopLeft: [padX, padY],
      paddingBottomRight: [padX, padY],
      animate: true,
    });
    // Capture the settled view as the new "home", then re-enable drift tracking. A timeout
    // fallback covers the case where fitBounds didn't move (so no moveend fires).
    const settle = () => {
      fitTarget = { center: app.map.getCenter(), zoom: app.map.getZoom() };
      suppressDrift = false;
      updateRecadrerBtn(); // hide — we're home
    };
    app.map.once("moveend", settle);
    setTimeout(() => {
      if (suppressDrift) settle();
    }, 700);
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
    for (const [pid, p] of app.selectedParcels) {
      idx++;
      const isActive = activeParcelIds.has(pid);
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
      // Altitude chip + cloud-cover proxy from elevation. Both fetched via IGN's free
      // /altimetrie/ REST endpoint. Hints at exposure without claiming measured insolation.
      const altChip =
        p.altitude != null
          ? ` · 📐 <b>${p.altitude} m</b><span class="small" style="color:var(--muted)"> (${exposureHintFromAltitude(p.altitude)})</span>`
          : !p.altitudeFetched
            ? ` · <span class="small" style="color:var(--muted)">📐 altitude…</span>`
            : "";
      // Photo count associated with this parcel (point-in-polygon, v1).
      const photoCount = (app.photos || []).filter((ph) => ph.associatedParcelId === pid).length;
      const photoChip = photoCount ? ` · 📷 <b>${photoCount}</b>` : "";
      const activeBg = isActive
        ? "background:rgba(251,191,36,0.18);border-left:3px solid var(--warn);padding-left:6px"
        : "";
      // User-given name (optional) shown ahead of the crop label; rename + remove affordances.
      const nameLabel = p.name ? `<b>${escapeHtml(p.name)}</b> · ` : "";
      const rowBtns =
        `<button class="parcel-remove" data-pid="${pid}" title="Retirer cette parcelle de la sélection" style="font-size:11px;padding:1px 6px;float:right;margin-left:4px">✕</button>` +
        `<button class="secondary parcel-rename" data-pid="${pid}" title="Nommer cette parcelle" style="font-size:10px;padding:1px 6px;float:right;margin-left:4px">✏️</button>`;
      html += `<dd class="parcel-row" data-parcel-id="${pid}" style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);cursor:pointer;${activeBg}">
        ${rowBtns}${expandBtn}<b>P${idx}.</b> ${nameLabel}${emoji} ${label} <span class="small" style="color:var(--muted)">(${code})</span>${bio} · <b>${area} ha</b>${altChip}${photoChip}
        <div style="margin-top:2px">${detail}</div>
        <div id="${detailId}" style="display:none">${hasSoil ? renderParcelBreakdown(p, idx, resolveIdentifiedCropMeta(app.getAnalysisCombined?.()?.identification)) : ""}</div>
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
    const hasActive = activeParcelIds.size > 0;
    html += `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <button class="secondary" id="fit-parcels" style="font-size:11px;padding:4px 8px">🎯 Cadrer</button>
      <span class="lock-switch-group" title="${parcelsLocked ? "Déverrouiller les parcelles" : "Verrouiller les parcelles"}">${parcelsLocked ? "🔒 Verrouillées" : "🔓 Déverrouillées"}${lockSwitchHtml(parcelsLocked, "lock-parcels")}</span>
      <button class="secondary" id="clear-parcels" style="font-size:11px;padding:4px 8px" title="Retire la surbrillance des parcelles mises en avant — les parcelles restent sélectionnées et sauvegardées" ${hasActive ? "" : "disabled"}>Tout désélectionner</button>
    </div>`;
    // Soil card — pulled from the first selected parcel's cached soil lookup.
    // Renders nothing while the fetch is in flight; appears when fetchSoilAt resolves
    // and triggers a re-render.
    const firstParcel = app.selectedParcels.values().next().value;
    if (firstParcel?.soil) html += renderSoilCard(firstParcel.soil);
    parcelInfoEl.innerHTML = html;
    parcelInfoEl.style.display = "block";
    // Update the summary label count (always). Auto-opening the section is done only
    // from toggleParcelAt below — i.e. on a USER click — so a Dropbox restore that
    // re-renders the panel does NOT pop the section open every page load.
    const sumLabel = document.getElementById("parcels-summary-label");
    if (sumLabel) {
      sumLabel.textContent =
        app.selectedParcels.size > 0
          ? `Parcelles sélectionnées (${app.selectedParcels.size})`
          : "Parcelles sélectionnées";
    }
    document.getElementById("clear-parcels").onclick = () => {
      // Clear only the HIGHLIGHT (active subset) — never drop parcels from the saved selection.
      // Works in lock mode too (that's where highlighting parcels is the main interaction).
      if (activeParcelIds.size === 0) return;
      activeParcelIds.clear();
      renderParcelHighlight();
      renderParcelInfoPanel();
    };
    document.getElementById("lock-parcels").onclick = () => {
      const next = !app.getParcelsLocked();
      app.setParcelsLocked(next);
      renderParcelInfoPanel();
      renderParcelHighlight(); // switch between filled (unlocked) and glow (locked) styling
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
    // Nested toggle inside the breakdown: show/hide the crop alternatives list when
    // a crop is already declared (alternatives are secondary in that case).
    parcelInfoEl.querySelectorAll(".parcel-recos-toggle").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const target = document.getElementById(btn.dataset.target);
        if (!target) return;
        const open = target.style.display !== "none";
        target.style.display = open ? "none" : "block";
        btn.textContent = open ? "▾ Voir alternatives" : "▴ Masquer alternatives";
      };
    });
    // Row click → toggle membership in the active-subset. Multi-select supported: each
    // click adds or removes one parcel from the focused subset. Map view pans to the
    // most-recently-toggled parcel for visual feedback (only when the toggle ADDED it).
    parcelInfoEl.querySelectorAll(".parcel-row").forEach((row) => {
      row.onclick = (e) => {
        // Avoid intercepting nested buttons (expand, recos toggle, lock select).
        if (e.target.closest("button, select, a, input")) return;
        const pid = row.dataset.parcelId;
        if (!pid) return;
        const wasActive = activeParcelIds.has(pid);
        toggleActive(pid);
        renderParcelHighlight();
        renderParcelInfoPanel();
        const parcel = app.selectedParcels.get(pid);
        if (!wasActive && parcel?.latlng) {
          app.map.setView(parcel.latlng, Math.max(app.map.getZoom(), 16), { animate: true });
        }
      };
    });
    // ✕ Remove a single parcel from the selection. Works regardless of lock state — it's the
    // escape hatch for a parcel selected twice (duplicate) or added by mistake. Re-rendering the
    // panel trips the #parcel-info MutationObserver in main.js, which persists the removal.
    parcelInfoEl.querySelectorAll(".parcel-remove").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const pid = btn.dataset.pid;
        if (!app.selectedParcels.has(pid)) return;
        app.selectedParcels.delete(pid);
        activeParcelIds.delete(pid);
        if (sheetParcelId === pid) closeParcelDetail();
        refreshPhotoAssociations();
        renderParcelHighlight();
        renderParcelInfoPanel();
        app.renderPhotos?.();
        updateLockHint();
        updateSelectHint();
      };
    });
    // ✏️ Name a parcel (free text; cleared by emptying). Persisted via the same observer path.
    parcelInfoEl.querySelectorAll(".parcel-rename").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const pid = btn.dataset.pid;
        const p = app.selectedParcels.get(pid);
        if (!p) return;
        const next = window.prompt("Nom de la parcelle (laisser vide pour retirer le nom) :", p.name || "");
        if (next === null) return; // cancelled
        p.name = next.trim() || null;
        renderParcelInfoPanel();
        if (sheetParcelId === pid) renderParcelSheet();
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
        // topright (with Recadrer/Ortho), NOT topleft — topleft is the zoom +/− cluster, which
        // overlapped the badge and intercepted clicks on the unlock button.
        options: { position: "topright" },
        onAdd() {
          const el = L.DomUtil.create("div", "lock-hint");
          // Stop map drag/zoom when interacting with the badge, but let the inner button click.
          L.DomEvent.disableClickPropagation(el);
          L.DomEvent.disableScrollPropagation(el);
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
    el.style.display = "flex";
    const parcelsLocked = app.getParcelsLocked();
    // Status text + a slider switch (🔓 left ↔ 🔒 right). The knob slides toward the lock side when
    // locking / the unlock side when unlocking; the end icons stay put so the travel direction
    // reads as the action.
    el.innerHTML =
      `<span>${parcelsLocked ? "🔒 Verrouillées" : "🔓 Déverrouillées"}</span>` +
      lockSwitchHtml(parcelsLocked);
    // Use classList (NOT el.className=) so we don't clobber Leaflet's `.leaflet-control` class —
    // that class is what gives the control pointer-events:auto. Overwriting className removed it,
    // leaving the badge + its button non-clickable (the corner container is pointer-events:none).
    el.classList.add("lock-hint");
    el.classList.toggle("locked", parcelsLocked);
    el.classList.toggle("unlocked", !parcelsLocked);
    const tbtn = el.querySelector(".lock-switch");
    if (tbtn) {
      // disableClickPropagation isolates the button from Leaflet's map click (no blink/WFS leak).
      // The handler is a plain .onclick (reliably fires, no listener accumulation across re-renders).
      L.DomEvent.disableClickPropagation(tbtn);
      L.DomEvent.disableScrollPropagation(tbtn);
      tbtn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const next = !app.getParcelsLocked();
        app.setParcelsLocked(next);
        renderParcelInfoPanel();
        renderParcelHighlight(); // filled ↔ glow styling on lock change
        updateLockHint();
      };
    }
  }

  app.map.on("zoomend", updateSelectHint);
  // Show/hide the on-map "Recadrer" button as the user drifts from / returns to the auto-fit.
  app.map.on("moveend zoomend", () => {
    if (!suppressDrift) updateRecadrerBtn();
  });
  // First render: show the empty-state in the side panel + the on-map hint.
  setTimeout(() => {
    renderParcelInfoPanel();
    updateSelectHint();
  }, 100);

  // Briefly highlight the lock badge — used by the map-click router when the user clicks
  // while parcels are locked, to make the "ignored click" visible.
  let _flashTimer = null;
  function flashLockHint() {
    if (!_lockHint) return;
    const el = _lockHint.getContainer();
    // Remove + force reflow so the blink animation restarts even on rapid repeat clicks; clear the
    // prior removal timer so a stale timeout can't cut a fresh animation short.
    clearTimeout(_flashTimer);
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    _flashTimer = setTimeout(() => el.classList.remove("flash"), 950);
  }

  // Show a "zoom in further" message in the side panel.
  function showZoomTooLowMessage() {
    parcelInfoEl.innerHTML = `<dt>Zoomer davantage</dt><dd class="small">Le clic est trop imprécis à ce niveau de zoom (≥12 recommandé).</dd>`;
    parcelInfoEl.style.display = "block";
  }

  // ===== On-map parcel detail sheet =====
  // Clicking a parcel opens a slide-in card with its metrics + satellite vigor + a
  // "Discuter avec l'IA" action scoped to that parcel.
  let sheetParcelId = null;

  function openParcelDetail(id) {
    if (!app.selectedParcels.has(id)) return;
    sheetParcelId = id;
    renderParcelSheet();
    const el = document.getElementById("parcel-sheet");
    if (el) {
      el.classList.add("open");
      el.setAttribute("aria-hidden", "false");
    }
    // Fetch field weather (cached) so the 💧 row fills in; re-render the sheet when it lands.
    window.weather
      ?.ensureForSelection?.()
      .then(() => sheetParcelId === id && renderParcelSheet())
      .catch(() => {});
  }

  function closeParcelDetail() {
    sheetParcelId = null;
    const el = document.getElementById("parcel-sheet");
    if (el) {
      el.classList.remove("open");
      el.setAttribute("aria-hidden", "true");
    }
  }

  function renderParcelSheet() {
    const el = document.getElementById("parcel-sheet");
    if (!el || !sheetParcelId) return;
    const id = sheetParcelId;
    const p = app.selectedParcels.get(id);
    if (!p) return closeParcelDetail();
    const identified = resolveIdentifiedCropMeta(app.getAnalysisCombined()?.identification);
    const meta = identified || cropMeta(p.props?.code_cultu);
    const area = parcelArea(p.props).toFixed(2);
    const bioMode = app.getBioMode();
    const isBio = bioMode === "bio" || (bioMode === "auto" && p.props?.bio === 1);
    const soilLine = soilSummaryLine(p.soil);
    const fit = scoreSuitability(p.soil, p.props?.code_cultu);
    const altTxt = p.altitude != null ? `${p.altitude} m · ${exposureHintFromAltitude(p.altitude)}` : null;
    const photoCount = (app.photos || []).filter((ph) => ph.associatedParcelId === id).length;
    const ndviColor = (m) => (m >= 0.6 ? "var(--accent)" : m >= 0.3 ? "var(--warn)" : "var(--bad)");
    const ndviRow =
      p.ndvi?.mean != null
        ? `<div class="psheet-row"><span>🛰️ NDVI</span><span style="color:${ndviColor(p.ndvi.mean)}">${p.ndvi.mean} · ${p.ndvi.label}</span></div>`
        : `<button id="psheet-ndvi" class="secondary" style="font-size:11px;padding:5px 8px;margin-top:2px">📊 Mesurer la vigueur (NDVI)</button>`;
    // Field weather (regional) — shown when js/weather.js has fetched it.
    let weatherRow = "";
    const wx = typeof window !== "undefined" ? window.weather?.getWeather?.() : null;
    if (wx?.forecast) {
      const sm = wx.forecast.soil_moisture_m3m3 != null ? `${Math.round(wx.forecast.soil_moisture_m3m3 * 100)}% sol` : "";
      const next = (wx.forecast.days || []).slice(-7).find((d) => (d.precip_mm || 0) >= 2);
      const rain = next
        ? `pluie ${next.precip_mm} mm ${new Date(next.date + "T12:00").toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })}`
        : "pas de pluie prévue";
      weatherRow = `<div class="psheet-row"><span>💧 Eau</span><span style="max-width:62%">${rain}${sm ? ` · ${sm}` : ""}</span></div>`;
    }
    const activeCount = activeParcelIds.size;
    const discussLabel =
      activeCount > 1 ? `💬 Discuter de ces ${activeCount} parcelles` : "💬 Discuter de cette parcelle";
    const titleName = p.name ? `${escapeHtml(p.name)} — ` : "";
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="font-weight:700;font-size:14px">${meta.emoji || "🌱"} ${titleName}${meta.fr || p.props?.code_cultu || "Parcelle"}</div>
        <button id="psheet-close" aria-label="Fermer" style="background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer;line-height:1">✕</button>
      </div>
      <div class="small" style="color:var(--muted);margin-bottom:8px">code ${p.props?.code_cultu || "?"} · ${area} ha${isBio ? " · 🌱 bio" : ""}</div>
      <div style="display:flex;flex-direction:column;gap:5px;font-size:12px">
        ${soilLine ? `<div class="psheet-row"><span>Sol</span><span style="max-width:62%">${soilLine}</span></div>` : ""}
        ${altTxt ? `<div class="psheet-row"><span>Altitude</span><span>${altTxt}</span></div>` : ""}
        ${fit ? `<div class="psheet-row"><span>Adéquation sol</span><span style="color:${colorForScore(fit.score)}">${fit.score}% ${fit.label}</span></div>` : ""}
        <div class="psheet-row"><span>📷 Photos ici</span><span>${photoCount}</span></div>
        ${ndviRow}
        ${weatherRow}
      </div>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
        <button id="psheet-discuss" class="primary-capture" style="font-size:13px;padding:8px">${discussLabel}</button>
        <button id="psheet-rename" class="secondary" style="font-size:11px;padding:4px 8px">${p.name ? "✏️ Renommer" : "✏️ Nommer la parcelle"}</button>
        <button id="psheet-remove" class="secondary" style="font-size:11px;padding:4px 8px">Retirer de la sélection</button>
      </div>`;
    el.querySelector("#psheet-close").onclick = closeParcelDetail;
    el.querySelector("#psheet-discuss").onclick = () => discussParcel(id);
    const ndviBtn = el.querySelector("#psheet-ndvi");
    if (ndviBtn)
      ndviBtn.onclick = async () => {
        ndviBtn.textContent = "Mesure en cours…";
        ndviBtn.disabled = true;
        try {
          await window.satellite?.measureParcel?.(p);
        } finally {
          renderParcelSheet();
        }
      };
    const rm = el.querySelector("#psheet-remove");
    if (rm)
      rm.onclick = () => {
        app.selectedParcels.delete(id);
        activeParcelIds.delete(id);
        refreshPhotoAssociations();
        renderParcelHighlight();
        renderParcelInfoPanel();
        app.renderPhotos?.();
        updateLockHint();
        updateSelectHint();
        closeParcelDetail();
      };
    const rn = el.querySelector("#psheet-rename");
    if (rn)
      rn.onclick = () => {
        const next = window.prompt("Nom de la parcelle (laisser vide pour retirer le nom) :", p.name || "");
        if (next === null) return;
        p.name = next.trim() || null;
        renderParcelSheet();
        renderParcelInfoPanel();
      };
  }

  // One-line summary of a parcel for a discussion prompt (name, crop, area, soil, altitude, NDVI).
  function parcelSummary(id, p) {
    const meta = cropMeta(p.props?.code_cultu);
    const area = parcelArea(p.props).toFixed(2);
    const bioMode = app.getBioMode();
    const isBio = bioMode === "bio" || (bioMode === "auto" && p.props?.bio === 1);
    const soilLine = soilSummaryLine(p.soil);
    const photoCount = (app.photos || []).filter((ph) => ph.associatedParcelId === id).length;
    const nm = p.name ? `« ${p.name} » — ` : "";
    const bits = [`${nm}${meta.fr || p.props?.code_cultu} (${area} ha${isBio ? ", bio" : ""})`];
    if (p.altitude != null) bits.push(`altitude ${p.altitude} m`);
    if (soilLine) bits.push(`sol : ${soilLine}`);
    if (p.ndvi?.mean != null) bits.push(`NDVI ${p.ndvi.mean} (${p.ndvi.label})`);
    bits.push(`${photoCount} photo(s) située(s) dans la parcelle`);
    return bits.join(" ; ");
  }

  // Build a parcel-scoped prompt and hand it to the chat (via main.js event listener). Scope: the
  // highlighted (active) subset when the user has focused several parcels; otherwise just `id`.
  function discussParcel(id) {
    const ids = activeParcelIds.size > 1 ? [...activeParcelIds] : [id];
    const entries = ids.map((i) => [i, app.selectedParcels.get(i)]).filter(([, p]) => p);
    if (!entries.length) return;
    let text;
    if (entries.length === 1) {
      const [pid, p] = entries[0];
      text = `Concentrons-nous sur cette parcelle — ${parcelSummary(pid, p)}. Donne-moi un diagnostic ciblé (état, risques de maladies, conseils d'intervention) pour CETTE parcelle précisément.`;
      // Focus the highlight on this parcel.
      activeParcelIds.clear();
      activeParcelIds.add(pid);
    } else {
      const lines = entries.map(([pid, p], n) => `P${n + 1}. ${parcelSummary(pid, p)}`);
      text = `Concentrons-nous sur ces ${entries.length} parcelles :\n${lines.join("\n")}\nDonne-moi un diagnostic ciblé (état, risques de maladies, conseils d'intervention) pour chacune, et signale ce qui les distingue.`;
    }
    renderParcelHighlight();
    window.dispatchEvent(new CustomEvent("agrivision:discuss-parcel", { detail: { text } }));
    closeParcelDetail();
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
    openParcelDetail,
    closeParcelDetail,
    // Photo → parcel association (point-in-polygon for v1). Called by main.js after a
    // photo is added, moved, or restored from Dropbox so the parcel row's 📷 N count
    // reflects reality. FOV ray-casting for outside-pointing-at-parcel photos: ROADMAP.
    refreshPhotoAssociations,
    // The active-subset (Set of parcel ids) is exposed read-only so future "contextual
    // tools" (focused-only analyze, photo filter, etc.) can read the user's narrowing.
    // An empty set means "no narrowing — use the full selection".
    getActiveParcelIds: () => new Set(activeParcelIds),
    clearActive: () => activeParcelIds.clear(),
  };
}
