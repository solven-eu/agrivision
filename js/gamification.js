// AgriVision RE — "Dossier de culture" completeness score.
//
// A lightweight, non-blocking gamification layer that teaches new users what a good input
// looks like. It computes a 0–100 score from signals we already have (parcels, surface,
// photos, analysis) and renders a ring + an actionable checklist. It's a guide, never a
// gate — every item links to the action that improves it.
//
// All metrics are derived client-side from existing state. The only new input is an optional
// "surface totale de l'exploitation" the user can type, used to show mapped-coverage ratio.

import { pointInGeom, destPoint } from "./util.js";
import { parcelArea, aggregateParcels } from "./state.js";

const LS_TOTAL_SURFACE = "agri_total_surface_ha";

const DAY = 86400000;
function daysSince(d) {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (!isFinite(t)) return null;
  return (Date.now() - t) / DAY;
}
// Ramp: full credit at `fresh` days, zero at `stale` days, linear between.
function freshnessScore(days, fresh, stale) {
  if (days == null) return 0;
  if (days <= fresh) return 1;
  if (days >= stale) return 0.15;
  return 1 - (0.85 * (days - fresh)) / (stale - fresh);
}

export function createGamification(app) {
  // app: { getSelectedParcels(), getPhotos(), getAnalysisCombined(), openSection(id) }
  const state = { expanded: false };

  function getTotalSurfaceHa() {
    const v = parseFloat(localStorage.getItem(LS_TOTAL_SURFACE) || "");
    return isFinite(v) && v > 0 ? v : null;
  }

  // Does a photo "cover" a parcel? You normally photograph a field from OUTSIDE it, aiming in — so
  // the photo's GPS being outside the polygon is normal and must still count. We accept a photo if:
  //   1. it was taken INSIDE the parcel, or
  //   2. it has a direction and its line of sight (a cone around the aim) enters the parcel within
  //      a realistic framing distance (~10–140 m), or
  //   3. it has no direction but is close to the parcel (a ring up to ~60 m around the position).
  function photoCoversParcel(ph, geom) {
    if (pointInGeom([ph.lon, ph.lat], geom)) return true; // 1. taken inside
    if (ph.direction != null) {
      // 2. aimed into the field — sample a ~60° cone around the heading.
      for (const dDeg of [-30, -15, 0, 15, 30]) {
        const bearing = ph.direction + dDeg;
        for (let d = 10; d <= 140; d += 15) {
          const [plat, plon] = destPoint(ph.lat, ph.lon, bearing, d);
          if (pointInGeom([plon, plat], geom)) return true;
        }
      }
      return false;
    }
    // 3. no direction → proximity ring (was the photographer near the field edge?).
    for (let b = 0; b < 360; b += 45) {
      for (const d of [15, 30, 45, 60]) {
        const [plat, plon] = destPoint(ph.lat, ph.lon, b, d);
        if (pointInGeom([plon, plat], geom)) return true;
      }
    }
    return false;
  }

  // Fraction of selected parcels that have at least one photo covering them (inside, aimed-in, or
  // close by) — an honest "are your photos actually documenting the fields?".
  function photoCoverage(parcels, photos) {
    const located = photos.filter((p) => p.lat != null && p.lon != null);
    if (parcels.size === 0) return { ratio: 0, covered: 0, total: 0, located: located.length };
    let covered = 0;
    for (const parcel of parcels.values()) {
      if (!parcel.geometry) continue;
      const hit = located.some((ph) => photoCoversParcel(ph, parcel.geometry));
      if (hit) covered++;
    }
    return { ratio: parcels.size ? covered / parcels.size : 0, covered, total: parcels.size, located: located.length };
  }

  // Build the weighted checklist. Each item: {key,label,score 0..1,weight,detail,cta?{label,section}}.
  function computeItems() {
    const parcels = app.getSelectedParcels();
    const photos = app.getPhotos() || [];
    const analysis = app.getAnalysisCombined();
    const totalSurface = getTotalSurfaceHa();

    // 1. Parcelles
    const nParcels = parcels.size;
    const selectedArea = nParcels ? aggregateParcels(parcels).totalArea : 0;

    // 2. Surface mapped vs declared total
    const surfaceRatio = totalSurface ? Math.min(selectedArea / totalSurface, 1) : null;

    // 3-4. Photos
    const located = photos.filter((p) => p.takenAt);
    const ages = located.map((p) => daysSince(p.takenAt)).filter((d) => d != null);
    const newestAge = ages.length ? Math.min(...ages) : null;

    // 4b. Proper tagging: a photo is "well tagged" when it has BOTH a GPS position and a date —
    // without them the AI can't situate the observation on a parcel or reason about timing.
    const wellTagged = photos.filter((p) => p.lat != null && p.lon != null && p.takenAt).length;
    const untagged = photos.length - wellTagged;
    // No photos → 0, not 1: an empty dossier hasn't earned this item. A "100% tagged" credit with
    // zero photos wrongly floored the overall score at ~10% on a brand-new dossier.
    const tagRatio = photos.length ? wellTagged / photos.length : 0;
    // Report precisely what's missing (a placed-but-undated photo has GPS — don't claim otherwise).
    const noGps = photos.filter((p) => p.lat == null || p.lon == null).length;
    const noDate = photos.filter((p) => !p.takenAt).length;
    const tagMissingDetail = [
      noGps ? `${noGps} sans position GPS` : "",
      noDate ? `${noDate} sans date` : "",
    ]
      .filter(Boolean)
      .join(", ");

    // 5. Coverage
    const cov = photoCoverage(parcels, photos);

    // 6. Disease check recency
    const analyzedAge = analysis?.analyzed_at ? daysSince(analysis.analyzed_at) : null;
    const hasDiseases = !!analysis?.diseases?.length;

    const items = [
      {
        key: "parcels",
        label: "Parcelles cartographiées",
        score: nParcels > 0 ? 1 : 0,
        weight: 0.15,
        detail: nParcels
          ? `${nParcels} parcelle(s), ${selectedArea.toFixed(2)} ha`
          : "Sélectionne au moins une parcelle sur la carte",
        cta: nParcels ? null : { label: "Sélectionner", section: "parcels-section" },
      },
      {
        key: "surface",
        label: "Couverture de l'exploitation",
        score: surfaceRatio == null ? 0 : surfaceRatio,
        weight: 0.1,
        detail:
          surfaceRatio == null
            ? "Renseigne ta surface totale pour situer ta progression"
            : `${selectedArea.toFixed(1)} ha cartographiés sur ${totalSurface.toFixed(1)} ha (${Math.round(surfaceRatio * 100)}%)`,
        surfaceInput: true,
      },
      {
        key: "photo_count",
        label: "Photos de terrain",
        score: Math.min(photos.length / 5, 1),
        weight: 0.15,
        detail: photos.length
          ? `${photos.length} photo(s)${photos.length < 5 ? " — vise 5+ (vue large + gros plans)" : ""}`
          : "Ajoute des photos (vue large + gros plan feuille/fruit)",
        cta: photos.length >= 5 ? null : { label: "Ajouter une photo", section: "photos-section" },
      },
      {
        key: "photo_fresh",
        label: "Fraîcheur des photos",
        score: freshnessScore(newestAge, 14, 60),
        weight: 0.1,
        detail:
          newestAge == null
            ? "Aucune photo datée"
            : `Dernière photo il y a ${Math.round(newestAge)} j${newestAge > 30 ? " — pense à réactualiser" : ""}`,
        cta: newestAge != null && newestAge <= 30 ? null : { label: "Photographier", section: "photos-section" },
      },
      {
        key: "photo_tagging",
        label: "Photos taguées (GPS + date)",
        score: tagRatio,
        weight: 0.1,
        detail: !photos.length
          ? "Tes photos seront situées et datées pour l'analyse"
          : untagged === 0
            ? "Toutes tes photos ont une position et une date"
            : `${tagMissingDetail} (sur ${photos.length}) — complète pour situer et dater tes observations`,
        cta: photos.length && untagged > 0 ? { label: "Taguer les photos", section: "photos-section" } : null,
      },
      {
        key: "coverage",
        label: "Couverture photo des parcelles",
        score: cov.total ? cov.ratio : 0,
        weight: 0.2,
        detail: cov.total
          ? `${cov.covered}/${cov.total} parcelle(s) avec une photo (sur place ou orientée vers le champ)`
          : "Sélectionne des parcelles puis place/oriente des photos vers elles",
        cta: cov.total && cov.ratio < 1 ? { label: "Compléter", section: "photos-section" } : null,
      },
      {
        key: "diagnostic",
        label: "Contrôle maladies",
        score: hasDiseases ? freshnessScore(analyzedAge, 14, 45) : 0,
        weight: 0.2,
        detail: !hasDiseases
          ? "Lance une analyse pour le diagnostic phytosanitaire"
          : analyzedAge != null
            ? `Dernier contrôle il y a ${Math.round(analyzedAge)} j`
            : "Diagnostic disponible",
        cta: hasDiseases && (analyzedAge == null || analyzedAge <= 14) ? null : { label: "Lancer l'analyse", section: "chat-section" },
      },
    ];
    const total = items.reduce((a, it) => a + it.score * it.weight, 0);
    // Order by IMPACT ON THE SCORE: how many points completing this item would add = weight×(1−score).
    // Biggest score-to-gain first → the checklist always surfaces the most useful next action on top;
    // already-complete items (impact 0) sink to the bottom. (Display order only — the score itself
    // is order-independent.)
    items.forEach((it) => {
      it.impact = it.weight * (1 - it.score);
    });
    items.sort((a, b) => b.impact - a.impact);
    return { items, score: Math.round(total * 100) };
  }

  function color(score) {
    return score >= 0.75 ? "var(--accent)" : score >= 0.4 ? "var(--warn)" : "var(--bad)";
  }

  function ring(pct) {
    const r = 16,
      c = 2 * Math.PI * r,
      off = c * (1 - pct / 100);
    const col = color(pct / 100);
    return `
      <svg width="44" height="44" viewBox="0 0 44 44" style="flex:none">
        <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--border)" stroke-width="4"/>
        <circle cx="22" cy="22" r="${r}" fill="none" stroke="${col}" stroke-width="4"
          stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
          stroke-linecap="round" transform="rotate(-90 22 22)"/>
        <text x="22" y="26" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)">${pct}</text>
      </svg>`;
  }

  function dot(score) {
    return `<span style="flex:none;width:8px;height:8px;border-radius:50%;background:${color(score)}"></span>`;
  }

  function render() {
    const wrap = document.getElementById("dossier-panel");
    if (!wrap) return;
    const { items, score } = computeItems();

    const header = `
      <div id="dossier-head" style="display:flex;align-items:center;gap:10px;cursor:pointer">
        ${ring(score)}
        <div style="flex:1">
          <div style="font-weight:600;font-size:13px">Dossier de culture · ${score}%</div>
          <div class="small" style="color:var(--muted)">${score >= 75 ? "Dossier solide 💪" : score >= 40 ? "Bien avancé — quelques ajouts" : "Complète ton dossier pour une meilleure analyse"}</div>
        </div>
        <span style="color:var(--muted)">${state.expanded ? "▲" : "▼"}</span>
      </div>`;

    const list = state.expanded
      ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">${items
          .map(
            (it) => `
        <div style="display:flex;gap:8px;align-items:flex-start">
          ${dot(it.score)}
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:500">${it.label} <span style="color:var(--muted);font-weight:400">${Math.round(it.score * 100)}%</span></div>
            <div class="small" style="color:var(--muted)">${it.detail}</div>
            ${
              it.surfaceInput
                ? `<div style="display:flex;gap:6px;align-items:center;margin-top:4px">
                     <input id="dossier-surface" type="number" min="0" step="0.1" placeholder="surface totale (ha)" value="${getTotalSurfaceHa() ?? ""}"
                       style="width:140px;font-size:11px;padding:3px 6px"/>
                   </div>`
                : ""
            }
            ${
              it.cta
                ? `<button class="dossier-cta secondary" data-section="${it.cta.section}" style="font-size:10px;padding:3px 8px;margin-top:4px">${it.cta.label} →</button>`
                : ""
            }
          </div>
        </div>`
          )
          .join("")}</div>`
      : "";

    wrap.innerHTML = header + list;
    document.getElementById("dossier-head")?.addEventListener("click", () => {
      state.expanded = !state.expanded;
      render();
    });
    wrap.querySelectorAll(".dossier-cta").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        app.openSection?.(b.dataset.section);
      })
    );
    const surf = document.getElementById("dossier-surface");
    if (surf) {
      surf.addEventListener("click", (e) => e.stopPropagation());
      surf.addEventListener("change", () => {
        const v = parseFloat(surf.value);
        if (isFinite(v) && v > 0) localStorage.setItem(LS_TOTAL_SURFACE, String(v));
        else localStorage.removeItem(LS_TOTAL_SURFACE);
        render();
      });
    }
  }

  return { render, computeItems };
}
