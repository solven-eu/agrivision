// AgriVision RE — address geocoding (BAN) + browser geolocation reverse-geocoding.
// Sets the shared `currentAddress` via setCurrentAddress callback so the rest of the app has
// a location context for prompt building.

import { BAN } from "./config.js";
import { toast } from "./toast.js";

/**
 * @param {object} app - { map, setCurrentAddress, getPendingRestore }
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

  // Shared landing path for a GPS fix: marker + reverse-geocode via BAN. `pan` decides whether
  // we move the view (always for a user-initiated locate; guarded at startup).
  let gpsMarker = null;
  function applyPosition(lat, lon, { pan }) {
    if (pan) {
      app.map.setView([lat, lon], 15);
      window.__initBasemap?.();
    }
    if (gpsMarker) app.map.removeLayer(gpsMarker);
    // Pulsing "you are here" dot (a divIcon — easier to spot than a static circle, esp. on a phone
    // outdoors). The `gps-marker` className replaces Leaflet's default white divIcon box.
    const gpsIcon = L.divIcon({
      className: "gps-marker",
      html: '<span class="gps-ring"></span><span class="gps-dot"></span>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    gpsMarker = L.marker([lat, lon], { icon: gpsIcon, keyboard: false })
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
  }

  // Browser geolocation → reverse-geocode via BAN.
  function tryGeolocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Don't pan to GPS if a restore is pending OR has already set the view + basemap — its
        // fitBounds dictates the view, and geoloc can resolve AFTER the restore (which would
        // otherwise yank the map to GPS). Only auto-pan + install the basemap when nothing else
        // owns the view: no pending restore AND the basemap isn't installed yet.
        const pan = !app.getPendingRestore() && !app.isBasemapInstalled?.();
        applyPosition(pos.coords.latitude, pos.coords.longitude, { pan });
      },
      () => {
        statusEl.textContent = "Géoloc refusée/indisponible — vue par défaut : La Réunion.";
        // No GPS + no restore inbound → settle on DEFAULT_VIEW and install the basemap now (don't
        // wait the 8 s safety net). If a restore IS pending (any storage), skip — its fitBounds
        // will choose the right view.
        if (!app.getPendingRestore() && !app.isBasemapInstalled?.()) window.__initBasemap?.();
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  }

  // On-demand "Me localiser" — user intent overrides the restore/basemap guards, so it always
  // pans. Also the only way to retry after the startup attempt was denied or timed out.
  function locateMe(btn) {
    if (!navigator.geolocation) {
      toast("Géolocalisation indisponible sur ce navigateur.", { kind: "warn", id: "locate" });
      return;
    }
    // Browsers refuse geolocation on insecure origins (plain http:// on a LAN IP, etc.). The error
    // they return looks like PERMISSION_DENIED, which would wrongly send the user hunting in their
    // settings — so detect it up front and explain the real fix (open the app over HTTPS).
    if (window.isSecureContext === false) {
      toast(
        "La géolocalisation nécessite une connexion sécurisée (HTTPS). Ouvre l'app depuis le site sécurisé (pas via une adresse http://… locale).",
        { kind: "warn", id: "locate", durationMs: 9000 }
      );
      return;
    }
    btn.disabled = true;
    btn.textContent = "⏳";
    const done = () => {
      btn.disabled = false;
      btn.textContent = "📍";
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        done();
        applyPosition(pos.coords.latitude, pos.coords.longitude, { pan: true });
      },
      (err) => {
        done();
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "Géolocalisation refusée — autorise la position pour ce site dans les réglages du navigateur (puis réessaie)."
            : "Position introuvable — vérifie que le GPS est activé et réessaie.";
        toast(msg, { kind: "warn", id: "locate", durationMs: 9000 });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // Buttonless variant of locateMe for programmatic pans (permission-grant auto-zoom below).
  function panToCurrentPosition() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => applyPosition(pos.coords.latitude, pos.coords.longitude, { pan: true }),
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // First-load UX: pan to the user the moment they GRANT the geolocation prompt. The boot-time
  // getCurrentPosition above may already have timed out (slow first GPS fix on mobile) and settled
  // on the default view; the Permissions API 'change' event fires when the user clicks "Allow",
  // letting us zoom to them anyway. We only act on a fresh grant (an explicit user action) — not on
  // an already-"granted" state at load, so a returning user's restored-parcels view isn't yanked.
  if (navigator.permissions?.query) {
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        status.addEventListener("change", () => {
          if (status.state === "granted") panToCurrentPosition();
        });
      })
      .catch(() => {});
  }

  const LocateCtrl = L.Control.extend({
    // top-right, in the same cluster as Recadrer / Aérien — discoverable, and stays put when
    // parcels are selected (the top-left zoom column shifts around the select-hint).
    options: { position: "topright" },
    onAdd() {
      const btn = L.DomUtil.create("button", "map-locate-btn");
      btn.type = "button";
      btn.textContent = "📍";
      btn.title = "Me localiser";
      btn.setAttribute("aria-label", "Me localiser");
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.stop(e);
        locateMe(btn);
      });
      return btn;
    },
  });
  app.map.addControl(new LocateCtrl());

  tryGeolocation();

  return { geocode };
}
