// AgriVision RE — photo handling: upload, EXIF, compression, map markers + FOV cones, card rendering.
// Returns bound functions so call sites in main.js stay short.

import { compressImage, cardinal, destPoint, formatRelativeDays } from "./util.js";

/**
 * @param {object} app - dependency bundle:
 *   - photos (Array, mutated in place)
 *   - map, mapEl, aStatus, analyzeBtn, thumbsEl (Leaflet + DOM)
 *   - onSchedule (fn) — called after any state mutation that should be persisted
 *   - setPlacingPhotoId(id|null), setAimingPhotoId(id|null) — state setters
 */
export function createPhotos(app) {
  function placePhotoMarker(p) {
    if (p.marker) app.map.removeLayer(p.marker);
    if (p.fovLayer) app.map.removeLayer(p.fovLayer);
    const idx = app.photos.indexOf(p) + 1;
    const html =
      p.direction != null
        ? `<div class="photo-pin" style="transform:rotate(${p.direction}deg)">▲<span style="position:absolute;font-size:9px;transform:rotate(${-p.direction}deg);color:#fff;font-weight:700">${idx}</span></div>`
        : `<div class="photo-pin no-dir">${idx}</div>`;
    const icon = L.divIcon({ className: "", html, iconSize: [24, 24], iconAnchor: [12, 12] });
    const dirTxt =
      p.direction != null
        ? ` · 🧭 ${Math.round(p.direction)}° (${cardinal(p.direction)})`
        : ` · <span style="color:#fbbf24">🧭 direction inconnue</span>`;
    const popupHtml = `
      <img src="${p.dataUrl}" style="max-width:240px;display:block;border-radius:4px"/>
      <div style="font-size:11px;margin-top:6px">${p.name}${dirTxt}</div>
      <div style="display:flex;gap:4px;margin-top:6px">
        <button class="popup-aim" data-id="${p.id}" style="font-size:11px;padding:3px 8px;background:#4ade80;color:#0a0e13;border:none;border-radius:4px;font-weight:600;cursor:pointer">🧭 ${p.direction != null ? "Modifier" : "Définir"} direction</button>
        <button class="popup-move" data-id="${p.id}" style="font-size:11px;padding:3px 8px;background:#232b34;color:#e6edf3;border:1px solid #2f3a45;border-radius:4px;cursor:pointer">📍 Replacer</button>
      </div>`;
    p.marker = L.marker([p.lat, p.lon], { icon }).addTo(app.map).bindPopup(popupHtml);
    p.marker.on("popupopen", (e) => {
      const root = e.popup.getElement();
      root.querySelector(".popup-aim")?.addEventListener("click", () => {
        app.setAimingPhotoId(p.id);
        app.setPlacingPhotoId(null);
        app.mapEl.classList.add("map-placing");
        app.aStatus.textContent = "Cliquez sur la carte vers où la photo a été prise.";
        p.marker.closePopup();
      });
      root.querySelector(".popup-move")?.addEventListener("click", () => {
        app.setPlacingPhotoId(p.id);
        app.setAimingPhotoId(null);
        app.mapEl.classList.add("map-placing");
        app.aStatus.textContent = "Cliquez sur la carte pour replacer cette photo.";
        p.marker.closePopup();
      });
    });
    if (p.direction != null) {
      const fov = 60,
        range = 80;
      const left = destPoint(p.lat, p.lon, p.direction - fov / 2, range);
      const right = destPoint(p.lat, p.lon, p.direction + fov / 2, range);
      p.fovLayer = L.polygon([[p.lat, p.lon], left, right], {
        color: "#4ade80",
        weight: 1,
        fillColor: "#4ade80",
        fillOpacity: 0.18,
        interactive: false,
      }).addTo(app.map);
    }
  }

  function renderPhotos() {
    app.thumbsEl.innerHTML = "";
    app.photos.forEach((p, i) => {
      const wrap = document.createElement("div");
      wrap.className = "photo-card";
      const loc =
        p.lat != null
          ? `<div>📍 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} <span style="color:${p.locSource === "exif" ? "var(--accent)" : "var(--warn)"}">${p.locSource === "exif" ? "EXIF" : "manuel"}</span></div>`
          : `<div style="color:var(--bad)">📍 Pas de GPS dans la photo</div>`;
      const dir =
        p.direction != null ? `<div>🧭 ${Math.round(p.direction)}° ${cardinal(p.direction)}</div>` : "";
      const time = p.takenAt
        ? `<div title="${p.takenAt.toLocaleString("fr-FR")}">🕒 ${formatRelativeDays((p.takenAt - Date.now()) / 86400000)}</div>`
        : p.exifFound
          ? `<div style="color:var(--muted)">🕒 Pas d'horodatage</div>`
          : `<div style="color:var(--muted)">🕒 Pas d'EXIF</div>`;
      const tags = p.tags || {};
      const tagBadges = [];
      if (tags.shot_type && tags.shot_type !== "unknown")
        tagBadges.push(
          `<span style="background:var(--panel);padding:1px 5px;border-radius:8px;font-size:9px">${tags.shot_type === "overview" ? "🌄 vue" : tags.shot_type === "single_plant" ? "🌱 plant" : tags.shot_type === "detail" ? "🔍 zoom" : tags.shot_type}</span>`
        );
      if (tags.plant_count_visible != null)
        tagBadges.push(
          `<span style="background:var(--panel);padding:1px 5px;border-radius:8px;font-size:9px">${tags.plant_count_visible}🌿</span>`
        );
      if (tags.maturity_pct_visible != null)
        tagBadges.push(
          `<span style="background:var(--panel);padding:1px 5px;border-radius:8px;font-size:9px">M ${tags.maturity_pct_visible}%</span>`
        );
      if (tags.health_visible_0_100 != null)
        tagBadges.push(
          `<span style="background:var(--panel);padding:1px 5px;border-radius:8px;font-size:9px;color:${tags.health_visible_0_100 > 66 ? "var(--accent)" : tags.health_visible_0_100 > 33 ? "var(--warn)" : "var(--bad)"}">♥ ${tags.health_visible_0_100}</span>`
        );
      const repState = p.representative === true ? "✓" : p.representative === false ? "✗" : "?";
      const repTitle =
        p.representative === true
          ? "Représentative du champ"
          : p.representative === false
            ? "PAS représentative (atypique)"
            : "Représentativité inconnue";
      const repBadge = `<button class="rep-toggle" data-id="${p.id}" title="${repTitle}" style="background:transparent;border:1px solid var(--border);color:inherit;border-radius:8px;padding:1px 5px;font-size:9px;cursor:pointer">Repr. ${repState}</button>`;
      wrap.innerHTML = `
        <div style="position:relative">
          <img src="${p.dataUrl}" alt="${p.name}" />
          <div style="position:absolute;top:-4px;left:-4px;background:var(--accent);color:#0a0e13;border-radius:50%;width:16px;height:16px;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>
        </div>
        <div class="meta">
          <div title="${p.name}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</div>
          ${loc}${dir}${time}
          ${tagBadges.length || tags.shot_type ? `<div style="display:flex;gap:3px;margin-top:3px;flex-wrap:wrap">${tagBadges.join("")}${repBadge}</div>` : ""}
          <div style="display:flex;gap:4px;margin-top:2px;flex-wrap:wrap">
            <button class="secondary place" data-id="${p.id}">${p.lat != null ? "Replacer" : "📍 Placer"}</button>
            <button class="secondary aim" data-id="${p.id}" ${p.lat == null ? "disabled title='Place la photo d&apos;abord'" : ""}>🧭 Direction</button>
          </div>
        </div>
        <button class="del" data-id="${p.id}">×</button>
      `;
      app.thumbsEl.appendChild(wrap);
    });
    app.thumbsEl.querySelectorAll(".rep-toggle").forEach(
      (b) =>
        (b.onclick = (e) => {
          const id = e.target.dataset.id;
          const p = app.photos.find((x) => x.id === id);
          if (!p) return;
          p.representative = p.representative == null ? true : p.representative === true ? false : null;
          renderPhotos();
          app.onSchedule();
        })
    );
    app.thumbsEl.querySelectorAll(".place").forEach(
      (b) =>
        (b.onclick = (e) => {
          app.setPlacingPhotoId(e.target.dataset.id);
          app.setAimingPhotoId(null);
          app.mapEl.classList.add("map-placing");
          app.aStatus.textContent = "Cliquez sur la carte pour placer cette photo (Echap pour annuler).";
        })
    );
    app.thumbsEl.querySelectorAll(".aim").forEach(
      (b) =>
        (b.onclick = (e) => {
          app.setAimingPhotoId(e.target.dataset.id);
          app.setPlacingPhotoId(null);
          app.mapEl.classList.add("map-placing");
          app.aStatus.textContent = "Cliquez sur la carte vers où la photo a été prise (Echap pour annuler).";
        })
    );
    app.thumbsEl.querySelectorAll(".del").forEach(
      (b) =>
        (b.onclick = (e) => {
          const id = e.target.dataset.id;
          const idx = app.photos.findIndex((x) => x.id === id);
          if (idx >= 0) {
            if (app.photos[idx].marker) app.map.removeLayer(app.photos[idx].marker);
            if (app.photos[idx].fovLayer) app.map.removeLayer(app.photos[idx].fovLayer);
            app.photos.splice(idx, 1);
            app.photos.forEach((p) => {
              if (p.lat != null) placePhotoMarker(p);
            });
            renderPhotos();
            app.analyzeBtn.disabled = app.photos.length === 0;
          }
        })
    );
  }

  async function addPhotoFromFile(f, presetTags = []) {
    let gps = null,
      direction = null,
      takenAt = null,
      exifFound = false;
    try {
      if (window.exifr) {
        gps = await exifr.gps(f);
        const all = await exifr
          .parse(f, ["GPSImgDirection", "DateTimeOriginal", "CreateDate", "DateTime"])
          .catch(() => null);
        if (all) {
          exifFound = true;
          if (all.GPSImgDirection != null) direction = all.GPSImgDirection;
          takenAt = all.DateTimeOriginal || all.CreateDate || all.DateTime || null;
          if (takenAt && !(takenAt instanceof Date)) takenAt = new Date(takenAt);
          if (takenAt && isNaN(takenAt.getTime())) takenAt = null;
        }
      }
    } catch {}
    const { dataUrl, b64, mime, width, height, recompressed } = await compressImage(f);
    const tagPreset = {};
    if (presetTags.includes("single_plant")) tagPreset.shot_type = "single_plant";
    else if (presetTags.includes("overview")) tagPreset.shot_type = "overview";
    else if (presetTags.includes("detail")) tagPreset.shot_type = "detail";
    const photo = {
      id: crypto.randomUUID(),
      name: f.name,
      mime,
      b64,
      dataUrl,
      width,
      height,
      recompressed,
      lat: gps?.latitude ?? null,
      lon: gps?.longitude ?? null,
      direction,
      takenAt,
      exifFound,
      representative: presetTags.includes("typical") ? true : null,
      tags: Object.keys(tagPreset).length ? tagPreset : null,
      locSource: gps?.latitude != null ? "exif" : null,
      marker: null,
      fovLayer: null,
    };
    app.photos.push(photo);
    if (photo.lat != null) placePhotoMarker(photo);
    return photo;
  }

  return { placePhotoMarker, renderPhotos, addPhotoFromFile };
}
