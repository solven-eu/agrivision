// AgriVision RE — altitude lookup via IGN Géoplateforme.
// Free, no key, CORS-friendly REST endpoint backed by RGE ALTI (5 m resolution for FR
// métro + 5-25 m for DOM including Réunion). Returns elevation in meters.
//
//   GET https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json
//       ?lon=55.498&lat=-21.125&zonly=true&resource=ign_rge_alti_wld
//   → { "elevations": [121.4] }
//   NOTE: the `resource` param is mandatory — omitting it makes the gateway return 405.
//
// Cached in localStorage per ~10m coordinate bucket. Altitude doesn't change, so the
// cache TTL is essentially "forever" (we set 90 days as a sanity reset).

import { safeSetItem } from "./storage-health.js";

const CACHE_PREFIX = "alt:";
const CACHE_TTL_MS = 90 * 24 * 3600 * 1000;

function cacheKey(lat, lon) {
  return `${CACHE_PREFIX}${lat.toFixed(4)},${lon.toFixed(4)}`;
}

export async function fetchAltitude(lat, lon) {
  if (lat == null || lon == null) return null;
  const k = cacheKey(lat, lon);
  try {
    const cached = JSON.parse(localStorage.getItem(k) || "null");
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.altitude;
  } catch {}
  try {
    // `resource` is now REQUIRED by the IGN gateway — without it the Kong proxy returns 405.
    // ign_rge_alti_wld = RGE ALTI worldwide (covers FR métropole + DOM, incl. La Réunion).
    const url = `https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${lon}&lat=${lat}&zonly=true&resource=ign_rge_alti_wld`;
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`[elevation] ${url} → HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    const alt = Array.isArray(j.elevations) ? j.elevations[0] : null;
    if (alt == null || !isFinite(alt)) return null;
    const rounded = Math.round(alt);
    safeSetItem(k, JSON.stringify({ fetchedAt: Date.now(), altitude: rounded }));
    return rounded;
  } catch (e) {
    console.warn("[elevation] fetch error:", e.message);
    return null;
  }
}

// Loose qualitative hint based on altitude alone (no aspect/slope). Useful as a proxy
// for cloud cover on Réunion's interior. Honest framing — the prompt clarifies that
// this is a proxy, not measured insolation.
export function exposureHintFromAltitude(altitude) {
  if (altitude == null) return null;
  if (altitude < 300) return "côte sèche / ensoleillée";
  if (altitude < 800) return "mi-pente, nébulosité moyenne";
  if (altitude < 1400) return "moyenne montagne, fréquemment nuageuse";
  return "haute montagne, brumeuse + risque de gel";
}

// Trigger altitude lookups for selected parcels that don't have one yet. Mirrors the
// `ensureSoilForSelected` pattern. Fire-and-forget; re-renders progressively.
export async function ensureAltitudeForSelected(selectedParcels, onUpdate) {
  if (!selectedParcels) return;
  for (const parcel of selectedParcels.values()) {
    if (parcel.altitudeFetched || !parcel.latlng) continue;
    fetchAltitude(parcel.latlng[0], parcel.latlng[1])
      .then((alt) => {
        parcel.altitude = alt;
        parcel.altitudeFetched = true;
        onUpdate?.();
      })
      .catch(() => {
        parcel.altitudeFetched = true;
        onUpdate?.();
      });
  }
}
