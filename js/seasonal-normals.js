// AgriVision RE — static local climate normals for La Réunion.
//
// Why static: ENSO + dynamic seasonal forecasts add network calls + parsing complexity
// with unclear immediate payoff. The monthly normals + cyclone window are STABLE
// information (1991-2020 normals don't drift fast enough to matter) and they're already
// agronomically actionable: disease pressure, irrigation planning, harvest windowing all
// depend on the local seasonality. Bundling this is ~3 KB and always works offline.
//
// Sources:
//   - Météo-France Réunion climate pages (https://meteofrance.re/climat)
//   - Atlas climatique de La Réunion (CIRAD / Météo-France)
//   - Réunion cyclone season window: 15 Nov – 15 May (official MF declaration)
//
// Windward / leeward note: Réunion has a dramatic rainfall gradient. The trade winds hit
// the east coast → 3-12 m/yr on the windward side (especially mid-altitude); the western
// leeward coast is in the rain shadow with < 1 m/yr. We carry both so the AI can pick
// based on the parcel longitude (windward = lon > ~55.55, leeward = lon < ~55.45).

export const REUNION_MONTHLY = [
  {
    month: "janvier",
    rain_windward_mm: 360,
    rain_leeward_mm: 90,
    tmax_c: 30,
    tmin_c: 23,
    cyclone_risk: "high",
    notes: "pic cyclonique, fortes pluies côte au vent",
  },
  {
    month: "février",
    rain_windward_mm: 380,
    rain_leeward_mm: 100,
    tmax_c: 30,
    tmin_c: 23,
    cyclone_risk: "high",
    notes: "pic cyclonique, intensité maximale",
  },
  {
    month: "mars",
    rain_windward_mm: 360,
    rain_leeward_mm: 100,
    tmax_c: 30,
    tmin_c: 23,
    cyclone_risk: "high",
    notes: "fin saison cyclonique, pluies abondantes",
  },
  {
    month: "avril",
    rain_windward_mm: 240,
    rain_leeward_mm: 60,
    tmax_c: 29,
    tmin_c: 22,
    cyclone_risk: "medium",
    notes: "transition vers saison sèche",
  },
  {
    month: "mai",
    rain_windward_mm: 130,
    rain_leeward_mm: 30,
    tmax_c: 27,
    tmin_c: 20,
    cyclone_risk: "low",
    notes: "début hiver austral, frais et sec",
  },
  {
    month: "juin",
    rain_windward_mm: 90,
    rain_leeward_mm: 20,
    tmax_c: 25,
    tmin_c: 18,
    cyclone_risk: "low",
    notes: "hiver austral, minimum thermique",
  },
  {
    month: "juillet",
    rain_windward_mm: 70,
    rain_leeward_mm: 15,
    tmax_c: 25,
    tmin_c: 17,
    cyclone_risk: "low",
    notes: "hiver austral, alizés soutenus",
  },
  {
    month: "août",
    rain_windward_mm: 70,
    rain_leeward_mm: 15,
    tmax_c: 25,
    tmin_c: 17,
    cyclone_risk: "low",
    notes: "fin hiver austral, sec",
  },
  {
    month: "septembre",
    rain_windward_mm: 70,
    rain_leeward_mm: 15,
    tmax_c: 26,
    tmin_c: 18,
    cyclone_risk: "low",
    notes: "sec, réchauffement progressif",
  },
  {
    month: "octobre",
    rain_windward_mm: 90,
    rain_leeward_mm: 20,
    tmax_c: 27,
    tmin_c: 20,
    cyclone_risk: "low",
    notes: "fin saison sèche",
  },
  {
    month: "novembre",
    rain_windward_mm: 140,
    rain_leeward_mm: 40,
    tmax_c: 28,
    tmin_c: 21,
    cyclone_risk: "medium",
    notes: "début saison cyclonique (officielle 15 nov)",
  },
  {
    month: "décembre",
    rain_windward_mm: 250,
    rain_leeward_mm: 60,
    tmax_c: 29,
    tmin_c: 22,
    cyclone_risk: "medium",
    notes: "saison cyclonique installée",
  },
];

// Coarse altitude → temperature offset using the standard tropical lapse rate (~6.5 °C
// per 1000 m). Useful with the IGN altitude we already fetch per parcel.
export function tempAdjustmentForAltitude(altitudeM) {
  if (altitudeM == null) return 0;
  return -(altitudeM / 1000) * 6.5;
}

// Coarse windward / leeward classifier from longitude. The crest line is roughly the
// 55.5°E meridian, but windward dominance extends a bit further west — use 55.55 as
// the transition. North & south coasts are mixed; pick the closer of the two.
export function exposureForLatLon(lat, lon) {
  if (lon == null) return "mixte";
  if (lon >= 55.55) return "côte au vent (est)";
  if (lon <= 55.4) return "côte sous le vent (ouest)";
  return "transition côtière";
}

// True if (lat, lon) is plausibly on Réunion (rough bbox check). The static normals only
// apply here; the rest of the module returns null when off-island.
export function isOnReunion(lat, lon) {
  if (lat == null || lon == null) return false;
  return lat >= -21.4 && lat <= -20.85 && lon >= 55.2 && lon <= 55.85;
}

// One-shot summary for the given date (and optionally lat/lon/altitude). Used by the AI
// context block and the climate card UI.
export function climateSummary(date = new Date(), lat = null, lon = null, altitudeM = null) {
  const m = date.getMonth(); // 0-11
  const normals = REUNION_MONTHLY[m];
  const season =
    m === 10 || m === 11 || m === 0 || m === 1 || m === 2 || m === 3
      ? "saison humide / cyclonique"
      : "saison sèche / hiver austral";
  // Cyclone window: officially 15 Nov – 15 May.
  const day = date.getDate();
  const inCycloneSeason = (m === 10 && day >= 15) || (m === 4 && day <= 15) || m >= 11 || m <= 3;
  const exposure = isOnReunion(lat, lon) ? exposureForLatLon(lat, lon) : "mixte";
  const tAdj = tempAdjustmentForAltitude(altitudeM);
  return {
    month_index: m,
    month_name: normals.month,
    season,
    cyclone_window_open: inCycloneSeason,
    cyclone_risk_level: normals.cyclone_risk,
    exposure, // "côte au vent (est)" / "côte sous le vent (ouest)" / "transition côtière" / "mixte"
    rain_mm_typical_for_this_exposure:
      exposure === "côte au vent (est)"
        ? normals.rain_windward_mm
        : exposure === "côte sous le vent (ouest)"
          ? normals.rain_leeward_mm
          : Math.round((normals.rain_windward_mm + normals.rain_leeward_mm) / 2),
    tmax_c: Math.round((normals.tmax_c + tAdj) * 10) / 10,
    tmin_c: Math.round((normals.tmin_c + tAdj) * 10) / 10,
    altitude_offset_c: Math.round(tAdj * 10) / 10,
    notes: normals.notes,
  };
}

// Format the climate summary as a 3-4 line context block for the AI prompt. Returns null
// when off Réunion (no static normals available for other regions yet).
export function climateContextBlock(date, lat, lon, altitudeM) {
  if (!isOnReunion(lat, lon)) return null;
  const s = climateSummary(date, lat, lon, altitudeM);
  const lines = [
    `TENDANCES CLIMATIQUES (Réunion, normales 1991-2020)`,
    `Mois : ${s.month_name} · saison : ${s.season}`,
    `Exposition : ${s.exposure}${s.altitude_offset_c ? ` · correction altitude ${s.altitude_offset_c} °C` : ""}`,
    `Précipitations attendues : ~${s.rain_mm_typical_for_this_exposure} mm · températures normales ${s.tmin_c}–${s.tmax_c} °C`,
    `Cyclones : ${s.cyclone_window_open ? `dans la fenêtre (15 nov – 15 mai), risque ${s.cyclone_risk_level}` : "hors fenêtre cyclonique"}`,
    `Note : ${s.notes}`,
  ];
  return lines.join("\n");
}

// Render a compact climate card. The hostId must be an empty container element.
// Updates altitude offset when a selected parcel's altitude becomes available.
export function renderClimateCard(hostId, lat, lon, altitudeM) {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!isOnReunion(lat, lon)) {
    host.innerHTML = `<div class="small" style="color:var(--muted)">Climatologie locale disponible uniquement pour La Réunion.</div>`;
    return;
  }
  const s = climateSummary(new Date(), lat, lon, altitudeM);
  const riskColor =
    s.cyclone_risk_level === "high"
      ? "var(--bad)"
      : s.cyclone_risk_level === "medium"
        ? "var(--warn)"
        : "var(--accent)";
  host.innerHTML = `
    <div class="small" style="color:var(--muted);margin-bottom:4px">
      🗓️ Climatologie · ${s.month_name} · <b>${s.season}</b>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 8px;font-size:11px">
      <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Exposition</span><span><b>${s.exposure}</b></span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Pluie typique</span><span><b>${s.rain_mm_typical_for_this_exposure} mm</b></span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Tmax</span><span><b>${s.tmax_c} °C</b></span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Tmin</span><span><b>${s.tmin_c} °C</b></span></div>
      <div style="grid-column:span 2;display:flex;justify-content:space-between"><span style="color:var(--muted)">Cyclones</span><span style="color:${riskColor}"><b>${s.cyclone_window_open ? `dans la fenêtre · ${s.cyclone_risk_level}` : "hors saison"}</b></span></div>
    </div>
    <div class="small" style="margin-top:4px;color:var(--muted);font-style:italic">${s.notes}</div>
  `;
}
