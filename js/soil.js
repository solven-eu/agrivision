// AgriVision RE — soil context fetcher + per-parcel cache.
// Calls /api/soil?lat&lon when a parcel is selected, caches the result in localStorage
// (parcels don't move, so the data is stable). The AI context block reads from this cache
// to inject "SOL TYPIQUE DE LA ZONE" into every analysis call. The parcel-info panel
// reads the same cache to render a soil card for the user.
//
// Data source:
//   Nature Scientific Data 2026 — https://www.nature.com/articles/s41597-026-07254-8
//   Dataset (CIRAD Dataverse) — https://dataverse.cirad.fr/file.xhtml?fileId=32543
//   License: CC-BY (cite the paper + the Dataverse DOI when redistributing).
//   Geographic scope: La Réunion only. Other DOM / métropole need different sources
//   (RMQS for métropole — see ROADMAP).

import { WORKER_URL } from "./config.js";
import { safeSetItem } from "./storage-health.js";

const CACHE_PREFIX = "soil:";
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days — soil data is essentially static

function cacheKey(lat, lon) {
  // ~10m precision is enough: collapsing rounded coords prevents duplicate fetches when
  // the user clicks slightly different points within the same parcel.
  return `${CACHE_PREFIX}${lat.toFixed(4)},${lon.toFixed(4)}`;
}

// Returns either the soil payload, or a small failure descriptor `{ error: "..." }`
// so the UI can distinguish "still loading" from "fetched but failed". A null return
// is reserved for "no WORKER_URL / no lat-lon" (programmer error, not network failure).
export async function fetchSoilAt(lat, lon, n = 5) {
  if (lat == null || lon == null || !WORKER_URL) return null;
  const k = cacheKey(lat, lon);
  try {
    const cached = JSON.parse(localStorage.getItem(k) || "null");
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  } catch {}
  try {
    const url = `${WORKER_URL.replace(/\/$/, "")}/api/soil?lat=${lat}&lon=${lon}&n=${n}`;
    const r = await fetch(url);
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.warn(`[soil] ${url} → HTTP ${r.status}`, errText.slice(0, 200));
      return { error: `HTTP ${r.status}`, status: r.status };
    }
    const j = await r.json();
    if (!j?.summary) {
      console.warn("[soil] missing summary in response:", j);
      return { error: "no summary in response" };
    }
    safeSetItem(k, JSON.stringify({ fetchedAt: Date.now(), data: j }));
    return j;
  } catch (e) {
    console.warn("[soil] fetch error:", e.message);
    return { error: e.message };
  }
}

// Trigger soil lookups for every selected parcel that doesn't have soil data yet.
// Used after Dropbox restore (parcels come back without soil) or after batch ops.
// Re-renders the parcel info panel on each resolution so the soil card appears
// progressively. Fire-and-forget — failures are silent.
export async function ensureSoilForSelected(selectedParcels, onUpdate) {
  if (!selectedParcels) return;
  for (const parcel of selectedParcels.values()) {
    if (parcel.soilFetched || !parcel.latlng) continue;
    fetchSoilAt(parcel.latlng[0], parcel.latlng[1])
      .then((soil) => {
        parcel.soil = soil;
        parcel.soilFetched = true;
        onUpdate?.();
      })
      .catch((err) => {
        parcel.soil = { error: err?.message || "unknown" };
        parcel.soilFetched = true;
        onUpdate?.();
      });
  }
}

// One-line compact soil summary — used in the multi-parcel breakdown of the AI context
// block, where the full multi-line `soilContextBlock` would be too verbose for N parcels.
// Returns "Andosols pH 5.8, CEC 22, K bon" or null when no usable data.
export function soilSummaryLine(soil) {
  if (!soil?.summary) return null;
  const s = soil.summary;
  const m = s.median || {};
  const parts = [];
  if (s.dominant_soil_type) parts.push(s.dominant_soil_type);
  if (m.pH_H2O != null) parts.push(`pH ${m.pH_H2O}`);
  if (m.CEC_cmol_kg != null) parts.push(`CEC ${m.CEC_cmol_kg}`);
  if (m.K_ex_cmol_kg != null) {
    const kq = m.K_ex_cmol_kg >= 0.3 ? "bon" : m.K_ex_cmol_kg >= 0.15 ? "moyen" : "faible";
    parts.push(`K ${kq}`);
  }
  if (m.P_OD_mg_kg != null) {
    const pq = m.P_OD_mg_kg >= 100 ? "bon" : m.P_OD_mg_kg >= 30 ? "moyen" : "faible";
    parts.push(`P ${pq}`);
  }
  return parts.length ? parts.join(", ") : null;
}

// Build a compact human-readable summary for the AI context block. Returns a string
// or null if no soil data is available. Kept short — the AI gets all the medians + the
// dominant soil/land-use, but not the full sample list.
export function soilContextBlock(soil) {
  if (!soil?.summary) return null;
  const s = soil.summary;
  const m = s.median || {};
  const lines = [];
  lines.push("SOL TYPIQUE DE LA ZONE (médianes sur ~5 échantillons à proximité, source: CIRAD/Nature 2026)");
  if (s.dominant_soil_type) lines.push(`Type dominant : ${s.dominant_soil_type}`);
  if (s.dominant_historical_land_use)
    lines.push(`Usage historique dominant : ${s.dominant_historical_land_use}`);
  const fmt = (label, val, unit) => (val != null ? `${label} ${val} ${unit}` : null);
  const stats = [
    fmt("pH H₂O", m.pH_H2O, ""),
    fmt("N total", m.N_tot_g_kg, "g/kg"),
    fmt("C organique", m.C_org_g_100g, "g/100g"),
    fmt("P (Olsen-Dabin)", m.P_OD_mg_kg, "mg/kg"),
    fmt("CEC", m.CEC_cmol_kg, "cmol(+)/kg"),
    fmt("K éch.", m.K_ex_cmol_kg, "cmol(+)/kg"),
    fmt("Mg éch.", m.Mg_ex_cmol_kg, "cmol(+)/kg"),
    fmt("Ca éch.", m.Ca_ex_cmol_kg, "cmol(+)/kg"),
    fmt("Capacité au champ (pF 2.5)", m.pF25_g_100g, "g/100g"),
    fmt("Point de flétrissement (pF 4.2)", m.pF42_g_100g, "g/100g"),
  ].filter(Boolean);
  if (stats.length) lines.push(stats.join(" · "));
  lines.push(
    `Échantillons : ${s.samples_count}, plus proche à ${s.nearest_km} km. Valeurs indicatives de la zone, non mesurées sur la parcelle exacte.`
  );
  return lines.join("\n");
}

// Render the soil card in the parcel info panel. Returns an HTML string (no DOM mutation).
export function renderSoilCard(soil) {
  if (!soil?.summary) return "";
  const s = soil.summary;
  const m = s.median || {};
  const phColor =
    m.pH_H2O == null
      ? "var(--muted)"
      : m.pH_H2O < 5.5
        ? "var(--bad)"
        : m.pH_H2O > 7.5
          ? "var(--warn)"
          : "var(--accent)";
  const cell = (label, val, unit) =>
    val == null
      ? ""
      : `<div style="display:flex;justify-content:space-between;gap:4px">
          <span class="small" style="color:var(--muted)">${label}</span>
          <span class="small"><b>${val}</b> ${unit}</span>
        </div>`;
  return `
    <div style="margin-top:8px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--panel2)">
      <div class="small" style="color:var(--muted);margin-bottom:4px">
        🪨 Sol typique de la zone (CIRAD/Nature 2026)
      </div>
      ${s.dominant_soil_type ? `<div><b>${s.dominant_soil_type}</b></div>` : ""}
      ${s.dominant_historical_land_use ? `<div class="small">Usage historique : ${s.dominant_historical_land_use}</div>` : ""}
      <div style="margin-top:4px;display:grid;grid-template-columns:1fr 1fr;gap:0 8px">
        ${m.pH_H2O != null ? `<div style="display:flex;justify-content:space-between;gap:4px"><span class="small" style="color:var(--muted)">pH H₂O</span><span class="small" style="color:${phColor}"><b>${m.pH_H2O}</b></span></div>` : ""}
        ${cell("CEC", m.CEC_cmol_kg, "cmol/kg")}
        ${cell("C org.", m.C_org_g_100g, "g/100g")}
        ${cell("N total", m.N_tot_g_kg, "g/kg")}
        ${cell("P (O-D)", m.P_OD_mg_kg, "mg/kg")}
        ${cell("K éch.", m.K_ex_cmol_kg, "cmol/kg")}
      </div>
      <div class="small" style="margin-top:4px;color:var(--muted);font-style:italic">
        Médianes ~${s.samples_count} échantillons (le plus proche à ${s.nearest_km} km). Valeurs indicatives, non mesurées sur la parcelle.
      </div>
    </div>`;
}
