// AgriVision RE — Events feed: meteo alerts + RSS-style disease/market bulletins.
// Open-Meteo is fetched directly from the browser (CORS-friendly, no key).
// All other sources go through the Worker's /api/events-feed proxy with an allowlist.

import { WORKER_URL } from "./config.js";
import { nearestStations } from "./vigicrues.js";

// Catalog: only `direct: true` sources are fetched browser-side. The rest require WORKER_URL.
// `enabled` lets us ship sources whose URL we still need to confirm — they show in the UI
// as "stub" rows so the user knows what's coming without breaking the panel.
const SOURCES = {
  "open-meteo": { label: "Open-Meteo", kind: "meteo", direct: true, enabled: true },
  "meteofrance-vigilance-reunion": {
    label: "Vigilance Météo-France",
    kind: "meteo",
    direct: false,
    enabled: true,
  },
  "vigicrues-reunion": { label: "Vigicrues Réunion", kind: "flood", direct: false, enabled: true },
  "promed-plant": { label: "ProMED Plant", kind: "disease", direct: false, enabled: true },
  // CMRS Réunion (cyclone-only) is now superseded by the broader Vigilance source above —
  // disabled by default; re-enable if you want the cyclone-specific bulletins separately.
  "cmrs-reunion": { label: "CMRS La Réunion", kind: "cyclone", direct: false, enabled: false },
  "eppo-reporting": { label: "EPPO Reporting", kind: "disease", direct: false, enabled: false },
  "rnm-prices": { label: "RNM FranceAgriMer", kind: "market", direct: false, enabled: false },
};

const KIND_ICON = { meteo: "🌧", disease: "🦠", cyclone: "🌀", flood: "🌊", market: "💶" };

export function createEvents(app) {
  let lastFetched = null;
  let events = [];
  let busy = false;

  // Pick a reference point: first selected parcel centroid > geocoded address > map center.
  function getCenterLatLon() {
    if (app.selectedParcels?.size > 0) {
      const first = app.selectedParcels.values().next().value;
      if (first?.latlng) return { lat: first.latlng[0], lon: first.latlng[1] };
    }
    const addr = app.getCurrentAddress?.();
    if (addr?.lat != null) return { lat: addr.lat, lon: addr.lon };
    const c = app.map?.getCenter();
    return c ? { lat: c.lat, lon: c.lng } : null;
  }

  // Open-Meteo: 7-day daily. Synthesize one event per high-impact threshold crossed.
  async function fetchOpenMeteo(lat, lon) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=weather_code,precipitation_sum,wind_speed_10m_max,temperature_2m_max,temperature_2m_min` +
      `&forecast_days=7&timezone=auto`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
    const j = await r.json();
    const d = j.daily || {};
    const out = [];
    const dates = d.time || [];
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const rain = d.precipitation_sum?.[i] ?? 0;
      const wind = d.wind_speed_10m_max?.[i] ?? 0;
      const tmax = d.temperature_2m_max?.[i];
      const tmin = d.temperature_2m_min?.[i];
      const alerts = [];
      if (rain >= 50)
        alerts.push({ sev: "high", title: `Pluies fortes (${rain.toFixed(0)} mm)`, kind: "rain" });
      else if (rain >= 25)
        alerts.push({ sev: "med", title: `Pluies marquées (${rain.toFixed(0)} mm)`, kind: "rain" });
      if (wind >= 80)
        alerts.push({ sev: "high", title: `Vents violents (${Math.round(wind)} km/h)`, kind: "wind" });
      else if (wind >= 60)
        alerts.push({ sev: "med", title: `Vents forts (${Math.round(wind)} km/h)`, kind: "wind" });
      if (tmax != null && tmax >= 35)
        alerts.push({ sev: "med", title: `Chaleur intense (${Math.round(tmax)} °C)`, kind: "heat" });
      if (tmin != null && tmin <= 0)
        alerts.push({ sev: "high", title: `Gel (${Math.round(tmin)} °C)`, kind: "frost" });
      for (const a of alerts) {
        out.push({
          id: `om-${date}-${a.kind}`,
          source: "open-meteo",
          severity: a.sev,
          title: a.title,
          date,
          kind: "meteo",
          link: `https://open-meteo.com/en/dashboard?latitude=${lat}&longitude=${lon}`,
        });
      }
    }
    return out;
  }

  async function fetchProxied(sourceId) {
    if (!WORKER_URL) return [];
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/events-feed?source=${sourceId}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.items || []).map((it) => ({
      id: `${sourceId}-${it.id || it.link || it.title}`,
      source: sourceId,
      severity: it.severity || "low",
      title: it.title,
      date: it.date || null,
      kind: it.kind || SOURCES[sourceId]?.kind || "other",
      link: it.link || null,
    }));
  }

  // Cached "3 nearest Vigicrues stations" — set once per refresh, attached to each
  // Vigicrues bulletin event during render so the user can deep-link to relevant rivers.
  let nearestVigicrues = [];

  async function refresh() {
    if (busy) return;
    busy = true;
    render();
    const center = getCenterLatLon();
    const tasks = [];
    if (center) tasks.push(fetchOpenMeteo(center.lat, center.lon).catch(() => []));
    for (const [id, src] of Object.entries(SOURCES)) {
      if (src.direct || !src.enabled) continue;
      tasks.push(fetchProxied(id).catch(() => []));
    }
    // Resolve the 3 nearest Vigicrues stations in parallel with the feed fetches.
    const nearestTask = center
      ? nearestStations(center.lat, center.lon, 3).catch(() => [])
      : Promise.resolve([]);
    const results = await Promise.all(tasks);
    nearestVigicrues = await nearestTask;
    const all = [].concat(...results);
    const sevRank = { high: 3, med: 2, low: 1 };
    all.sort(
      (a, b) =>
        (sevRank[b.severity] ?? 1) - (sevRank[a.severity] ?? 1) || (b.date || "").localeCompare(a.date || "")
    );
    events = all;
    lastFetched = new Date();
    busy = false;
    render();
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function render() {
    const host = document.getElementById("events-list");
    if (!host) return;
    const counter = document.getElementById("events-count");
    if (counter) counter.textContent = events.length ? ` (${events.length})` : "";
    const lastEl = document.getElementById("events-last");
    if (lastEl) {
      lastEl.textContent = busy
        ? "Chargement…"
        : lastFetched
          ? `Mis à jour à ${lastFetched.toLocaleTimeString("fr-FR")}`
          : "Cliquer Actualiser pour charger.";
    }
    if (busy && events.length === 0) {
      host.innerHTML = `<div class="small" style="color:var(--muted)">Chargement…</div>`;
      return;
    }
    if (events.length === 0) {
      host.innerHTML = `<div class="small" style="color:var(--muted)">Aucun événement pour la zone. Sélectionner une parcelle puis Actualiser.</div>`;
      return;
    }
    host.innerHTML = events
      .map((e) => {
        const dot = e.severity === "high" ? "🔴" : e.severity === "med" ? "🟡" : "🟢";
        const kindIcon = KIND_ICON[e.kind] || "•";
        const label = SOURCES[e.source]?.label || e.source;
        const dateTxt = e.date ? new Date(e.date).toLocaleDateString("fr-FR") : "";
        const link = e.link
          ? ` · <a href="${escapeHtml(e.link)}" target="_blank" rel="noopener" style="color:var(--accent)">source ↗</a>`
          : "";
        // For Vigicrues events: append a sub-row of the 3 nearest station deep-links so
        // the user can jump straight to the most relevant river instead of the generic
        // bulletin page.
        const isVigicrues = e.source === "vigicrues-reunion";
        const stationsRow =
          isVigicrues && nearestVigicrues.length
            ? `<div class="small" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
                <span style="color:var(--muted)">📍 Stations à proximité :</span>
                ${nearestVigicrues
                  .map(
                    (s) =>
                      `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" class="vigicrues-chip" title="${escapeHtml(s.river)} (${escapeHtml(s.region)})">${escapeHtml(s.name)}</a>`
                  )
                  .join("")}
              </div>`
            : "";
        return `<div class="event-card">
          <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline">
            <div style="flex:1;min-width:0">${dot} ${kindIcon} <b>${escapeHtml(e.title)}</b></div>
            <div class="small" style="color:var(--muted);white-space:nowrap">${dateTxt}</div>
          </div>
          <div class="small" style="margin-top:2px;color:var(--muted)">${label}${link}</div>
          ${stationsRow}
        </div>`;
      })
      .join("");
  }

  return { refresh, render, SOURCES };
}
