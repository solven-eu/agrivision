// AgriVision RE — address geocoding (BAN) + browser geolocation reverse-geocoding.
// Sets the shared `currentAddress` via setCurrentAddress callback so the rest of the app has
// a location context for prompt building.

import { BAN } from "./config.js";

/**
 * @param {object} app - { map, setCurrentAddress, getPendingDbxLoad }
 */
export function installGeocoding(app) {
  const statusEl = document.getElementById("status");
  let addressMarker = null;

  async function geocode() {
    const q = document.getElementById("addr").value.trim();
    if (!q) return;
    statusEl.textContent = "Géocodage…";
    try {
      const r = await fetch(`${BAN}?q=${encodeURIComponent(q)}&limit=1`);
      const j = await r.json();
      if (!j.features?.length) {
        statusEl.textContent = "Adresse introuvable.";
        return;
      }
      const f = j.features[0];
      const [lon, lat] = f.geometry.coordinates;
      const address = {
        label: f.properties.label,
        lat,
        lon,
        city: f.properties.city,
        postcode: f.properties.postcode,
        context: f.properties.context,
      };
      app.setCurrentAddress(address);
      app.map.setView([lat, lon], 16);
      if (addressMarker) app.map.removeLayer(addressMarker);
      addressMarker = L.marker([lat, lon]).addTo(app.map).bindPopup(address.label).openPopup();
      statusEl.textContent = address.label;
    } catch (e) {
      statusEl.textContent = "Erreur géocodage : " + e.message;
    }
  }

  document.getElementById("go").addEventListener("click", geocode);
  document.getElementById("addr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") geocode();
  });

  // Browser geolocation → reverse-geocode via BAN.
  function tryGeolocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        // If a saved crop is about to load, don't pan — its fitBounds will dictate the view.
        // The Dropbox restore path is the one that calls __initBasemap() afterwards.
        // Otherwise: pan to the GPS view, THEN install the basemap so tiles fetch once.
        if (!app.getPendingDbxLoad()) {
          app.map.setView([lat, lon], 15);
          window.__initBasemap?.();
        }
        L.circleMarker([lat, lon], { radius: 6, color: "#4ade80", fillOpacity: 0.8 })
          .addTo(app.map)
          .bindPopup("Position actuelle");
        fetch(`https://api-adresse.data.gouv.fr/reverse/?lat=${lat}&lon=${lon}`)
          .then((r) => r.json())
          .then((j) => {
            const f = j.features?.[0];
            if (!f) return;
            const address = {
              label: f.properties.label,
              lat,
              lon,
              city: f.properties.city,
              postcode: f.properties.postcode,
              context: f.properties.context,
            };
            app.setCurrentAddress(address);
            document.getElementById("addr").value = address.label;
            statusEl.textContent = address.label;
          })
          .catch(() => {
            const fallback = { label: `(${lat.toFixed(5)}, ${lon.toFixed(5)})`, lat, lon };
            app.setCurrentAddress(fallback);
            statusEl.textContent = fallback.label;
          });
      },
      () => {
        statusEl.textContent = "Géoloc refusée/indisponible — vue par défaut : La Réunion.";
        // No GPS + no Dropbox restore inbound → settle on DEFAULT_VIEW and install basemap
        // now (don't wait the 8 s safety net). If Dropbox restore IS pending, skip — its
        // fitBounds will choose the right view.
        if (!app.getPendingDbxLoad()) window.__initBasemap?.();
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  }

  tryGeolocation();

  return { geocode };
}
