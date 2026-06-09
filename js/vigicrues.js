// AgriVision RE — Vigicrues Réunion stations quick-access widget.
// Fetches the stations catalog from the Worker (cached 24h in localStorage), determines
// the region of the user's current parcel/map view, and renders 3-6 nearby stations as
// clickable chips. The catalog has a flat shape: { regions: [{ name, rivers: [{ name,
// stations: [{ id, name }]}]}] }.

import { WORKER_URL } from "./config.js";
import { safeSetItem } from "./storage-health.js";

const LS_KEY = "vigicrues_stations_v1";
const LS_TTL_MS = 24 * 3600 * 1000;
const STATION_URL = (id) => `https://www.vigicrues-reunion.re/donnees.php?id=${id}`;

// Region centroids on La Réunion. Used for nearest-region matching since the catalog
// labels regions by cardinal name but doesn't carry per-station coordinates.
const REGION_CENTROIDS = {
  NORD: [-20.95, 55.45], // Saint-Denis
  EST: [-21.07, 55.7], // Saint-Benoît
  SUD: [-21.32, 55.5], // Saint-Pierre
  OUEST: [-21.1, 55.3], // Saint-Paul
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function regionForLatLon(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const [name, [clat, clon]] of Object.entries(REGION_CENTROIDS)) {
    const d = haversineKm(lat, lon, clat, clon);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

export async function fetchCatalog() {
  try {
    const cached = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (cached && Date.now() - cached.fetchedAt < LS_TTL_MS) return cached.regions;
  } catch {}
  if (!WORKER_URL) return [];
  try {
    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/vigicrues-stations`);
    if (!r.ok) return [];
    const j = await r.json();
    const regions = j.regions || [];
    safeSetItem(LS_KEY, JSON.stringify({ fetchedAt: Date.now(), regions }));
    return regions;
  } catch {
    return [];
  }
}

// Up-to-N nearest stations relative to (lat, lon). Since the catalog has region grouping
// but no per-station coordinates, we take stations from the nearest region first, then
// fall back to the next nearest region(s) until we have N (or run out).
export async function nearestStations(lat, lon, n = 3) {
  const regions = await fetchCatalog();
  if (!regions.length) return [];
  // Sort regions by distance from (lat, lon).
  const sorted = Object.entries(REGION_CENTROIDS)
    .map(([name, [clat, clon]]) => ({ name, distKm: haversineKm(lat, lon, clat, clon) }))
    .sort((a, b) => a.distKm - b.distKm);
  const out = [];
  for (const { name } of sorted) {
    if (out.length >= n) break;
    const region = regions.find((r) => r.name === name);
    if (!region) continue;
    for (const river of region.rivers) {
      for (const s of river.stations) {
        if (out.length >= n) break;
        // Avoid duplicates by id (catalogs sometimes list the same station under multiple rivers).
        if (out.some((x) => x.id === s.id)) continue;
        out.push({
          id: s.id,
          name: s.name,
          river: river.name,
          region: region.name,
          url: STATION_URL(s.id),
        });
      }
    }
  }
  return out;
}

export function createVigicruesWidget(app) {
  let cachedRegions = null;

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

  function render() {
    const host = document.getElementById("vigicrues-stations");
    if (!host) return;
    if (!cachedRegions) {
      host.innerHTML = `<div class="small" style="color:var(--muted)">Chargement des stations…</div>`;
      return;
    }
    const center = getCenterLatLon();
    if (!center) {
      host.innerHTML = `<div class="small" style="color:var(--muted)">Positionne la carte pour voir les stations à proximité.</div>`;
      return;
    }
    const targetRegion = regionForLatLon(center.lat, center.lon);
    const region = cachedRegions.find((r) => r.name === targetRegion);
    if (!region) {
      // No region match — show a compact "all regions" fallback.
      const total = cachedRegions.reduce(
        (acc, r) => acc + r.rivers.reduce((a, rv) => a + rv.stations.length, 0),
        0
      );
      host.innerHTML = `<div class="small" style="color:var(--muted)">${total} stations Vigicrues disponibles. <a href="https://www.vigicrues-reunion.re/donnees.php" target="_blank" rel="noopener" style="color:var(--accent)">voir la carte ↗</a></div>`;
      return;
    }
    // Render rivers as compact groups, max ~6 station chips visible to keep it tidy.
    const groups = region.rivers
      .filter((rv) => rv.stations.length > 0)
      .map(
        (rv) =>
          `<div style="margin-top:4px">
            <div class="small" style="color:var(--muted)">${escapeHtml(rv.name)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:2px">
              ${rv.stations
                .map(
                  (s) =>
                    `<a href="${STATION_URL(s.id)}" target="_blank" rel="noopener" class="vigicrues-chip" title="Station ${escapeHtml(s.id)}">${escapeHtml(s.name)}</a>`
                )
                .join("")}
            </div>
          </div>`
      )
      .join("");
    host.innerHTML = `
      <div class="small" style="color:var(--muted)">📍 Région <b>${targetRegion}</b> · ${region.rivers.reduce((a, r) => a + r.stations.length, 0)} stations</div>
      ${groups || `<div class="small" style="color:var(--muted)">Aucune station listée.</div>`}
    `;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  async function init() {
    render(); // shows loading state
    cachedRegions = await fetchCatalog();
    render();
  }

  return { init, render };
}
