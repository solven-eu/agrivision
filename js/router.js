// AgriVision RE — unified map-click router.
// Routes a `map.on("click")` event to one of: photo placement, photo aiming, parcel toggle,
// or "ignored because locked / zoom too low".

import { bearingTo, cardinal } from "./util.js";

/**
 * @param {object} app - dependency bundle:
 *   - map (Leaflet), mapEl (DOM), aStatus (DOM)
 *   - photos (Array)
 *   - getPlacingPhotoId / setPlacingPhotoId — accessors for "click drops a pin here"
 *   - getAimingPhotoId / setAimingPhotoId — accessors for "click sets direction toward here"
 *   - getParcelsLocked — accessor
 *   - placePhotoMarker, renderPhotos (fns)
 *   - toggleParcelAt (fn)
 *   - closeParcelDetail (fn) — dismiss the open parcel detail sheet, if any
 *   - flashLockHint (fn) — visual feedback when click happens while locked
 *   - showZoomTooLowMessage (fn) — sidebar feedback when zoom is too low
 */
export function installMapClickRouter(app) {
  app.map.on("click", async (e) => {
    // Any click on the map dismisses an open parcel detail sheet. If the click lands on a
    // parcel, toggleParcelAt below re-opens the relevant one; an empty-map click just closes it.
    app.closeParcelDetail?.();

    // Photo placement (drop pin)
    const placingId = app.getPlacingPhotoId();
    if (placingId) {
      const p = app.photos.find((x) => x.id === placingId);
      if (p) {
        p.lat = e.latlng.lat;
        p.lon = e.latlng.lng;
        p.locSource = "manual";
        app.placePhotoMarker(p);
        app.renderPhotos();
        app.aStatus.textContent = "Photo placée.";
      }
      app.setPlacingPhotoId(null);
      app.mapEl.classList.remove("map-placing");
      return;
    }

    // Photo aiming (set direction)
    const aimingId = app.getAimingPhotoId();
    if (aimingId) {
      const p = app.photos.find((x) => x.id === aimingId);
      if (p && p.lat != null) {
        p.direction = bearingTo(p.lat, p.lon, e.latlng.lat, e.latlng.lng);
        app.placePhotoMarker(p);
        app.renderPhotos();
        app.aStatus.textContent = `Direction réglée : ${Math.round(p.direction)}° ${cardinal(p.direction)}.`;
      }
      app.setAimingPhotoId(null);
      app.mapEl.classList.remove("map-placing");
      return;
    }

    // Parcel toggle. When locked, parcels.js handles the click as a focus toggle on the
    // existing selection (doesn't add/remove). Zoom-too-low still short-circuits.
    if (app.map.getZoom() < 12) {
      app.showZoomTooLowMessage();
      return;
    }
    await app.toggleParcelAt(e.latlng);
  });
}
