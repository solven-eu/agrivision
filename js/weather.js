// AgriVision RE — water / weather for the selected parcels.
//
// Pulls /api/weather (Météo-France observed rain at the nearest station + Open-Meteo
// precipitation forecast, soil moisture and ET0 → water balance). Unlike soil/altitude/NDVI
// (static, persisted), weather is time-varying, so it's fetched live with a short cache and
// NOT stored in the manifest. Regional: one lookup at the field's representative point covers
// the whole culture. Surfaces a "💧 Eau" card + feeds the AI context block.

import { WORKER_URL } from "./config.js";
import { workerAuthHeader } from "./share.js";

const CACHE_PREFIX = "wx:";
const CACHE_TTL_MS = 2 * 3600 * 1000; // forecast refresh ~2h

function cacheKey(lat, lon) {
  return `${CACHE_PREFIX}${lat.toFixed(3)},${lon.toFixed(3)}`;
}

async function fetchWeather(lat, lon) {
  const key = cacheKey(lat, lon);
  try {
    const c = JSON.parse(localStorage.getItem(key) || "null");
    if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) return c.data;
  } catch {}
  const headers = workerAuthHeader();
  if (!headers.authorization) return null; // /api/weather is session-gated
  const r = await fetch(
    `${(WORKER_URL || "").replace(/\/$/, "")}/api/weather?lat=${lat}&lon=${lon}`,
    { headers }
  );
  if (!r.ok) return null;
  const data = await r.json();
  try {
    localStorage.setItem(key, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {}
  return data;
}

// Sum the forecast precip + balance over the next N days (excludes past_days entries).
function forecastTotals(w, days = 7) {
  const arr = (w?.forecast?.days || []).filter((d) => d.precip_mm != null);
  // Open-Meteo returns 3 past days + 7 forecast; take the last `days` (upcoming-weighted).
  const tail = arr.slice(-days);
  const rain = tail.reduce((a, d) => a + (d.precip_mm || 0), 0);
  const bal = tail.reduce((a, d) => a + (d.water_balance_mm || 0), 0);
  const next = tail.find((d) => (d.precip_mm || 0) >= 2);
  return { rain: Math.round(rain * 10) / 10, bal: Math.round(bal * 10) / 10, next };
}

// One-line summary for the AI prompt + the parcel sheet.
export function weatherSummaryLine(w) {
  if (!w) return null;
  const parts = [];
  const o = w.observed;
  if (o && o.temp_c != null) {
    parts.push(`obs ${o.station} (${o.distance_km} km) ${o.temp_c}°C${o.humidity_pct != null ? `, ${o.humidity_pct}% HR` : ""}${o.rain_mm != null ? `, pluie ${o.rain_mm} mm` : ""}`);
  }
  const t = forecastTotals(w);
  parts.push(`prévision 7 j : pluie ${t.rain} mm, bilan hydrique ${t.bal > 0 ? "+" : ""}${t.bal} mm`);
  if (w.forecast?.soil_moisture_m3m3 != null)
    parts.push(`humidité sol ${Math.round(w.forecast.soil_moisture_m3m3 * 100)}% (${w.forecast.soil_moisture_depth})`);
  if (t.next) parts.push(`prochaine pluie ${t.next.date} ~${t.next.precip_mm} mm`);
  return parts.join(" · ");
}

export function createWeather(app) {
  // app: { getPoint() -> {lat,lon} | null }
  let current = null; // last fetched weather object

  function getWeather() {
    return current;
  }

  async function ensureForSelection() {
    const pt = app.getPoint?.();
    if (!pt || pt.lat == null) return null;
    const w = await fetchWeather(pt.lat, pt.lon);
    if (w) {
      current = w;
      renderCard();
    }
    return w;
  }

  function bar(mm, max) {
    const pct = Math.max(2, Math.min(100, (mm / max) * 100));
    return `<div style="height:5px;background:#3b82f6;border-radius:2px;width:${pct}%"></div>`;
  }

  function renderCard() {
    const el = document.getElementById("weather-card");
    if (!el) return;
    if (!workerAuthHeader().authorization) {
      el.innerHTML = `<div class="small" style="color:var(--muted)">Connecte-toi pour la météo des parcelles.</div>`;
      return;
    }
    if (!current) {
      el.innerHTML = `<div class="small" style="color:var(--muted)">Sélectionne une parcelle puis ouvre cette section.</div>`;
      return;
    }
    const w = current;
    const o = w.observed;
    const t = forecastTotals(w);
    const future = (w.forecast?.days || []).slice(-7);
    const maxRain = Math.max(2, ...future.map((d) => d.precip_mm || 0));
    const rows = future
      .map((d) => {
        const day = new Date(d.date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit" });
        return `<div style="display:flex;align-items:center;gap:6px;font-size:11px">
            <span style="width:48px;color:var(--muted)">${day}</span>
            <div style="flex:1">${bar(d.precip_mm || 0, maxRain)}</div>
            <span style="width:52px;text-align:right">${d.precip_mm ?? 0} mm</span>
          </div>`;
      })
      .join("");
    const smPct = w.forecast?.soil_moisture_m3m3 != null ? Math.round(w.forecast.soil_moisture_m3m3 * 100) : null;
    el.innerHTML = `
      ${o && o.temp_c != null ? `<div class="small" style="color:var(--muted);margin-bottom:4px">Station ${o.station} (${o.distance_km} km) : ${o.temp_c}°C · ${o.humidity_pct ?? "?"}% HR · pluie ${o.rain_mm ?? "?"} mm</div>` : ""}
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">
        <span>Prévision 7 j</span>
        <span>☔ ${t.rain} mm · bilan ${t.bal > 0 ? "+" : ""}${t.bal} mm</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px">${rows}</div>
      ${smPct != null ? `<div class="small" style="color:var(--muted);margin-top:6px">💧 Humidité du sol : ${smPct}% (${w.forecast.soil_moisture_depth})</div>` : ""}
      <div class="small" style="color:var(--muted);margin-top:4px;opacity:0.7">Sources : Météo-France (obs) + Open-Meteo (prévision/sol)</div>`;
  }

  return { ensureForSelection, getWeather, renderCard };
}
