// AgriVision RE — photo handling: upload, EXIF, compression, map markers + FOV cones, card rendering.
// Returns bound functions so call sites in main.js stay short.

import { compressImage, cardinal, destPoint, formatRelativeDays } from "./util.js";
import { openImageModal } from "./metrics.js";

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
    // Keep the photos-section <summary> in sync with the bank size so the user sees the count
    // without expanding.
    const sumEl = document.getElementById("photos-summary-count");
    if (sumEl) {
      const n = app.photos.length;
      sumEl.textContent = n === 0 ? "Photos de la culture" : `Photos de la culture (${n})`;
    }
    app.photos.forEach((p, i) => {
      const wrap = document.createElement("div");
      wrap.className = "photo-card";
      const loc =
        p.lat != null
          ? `<div>📍 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} <span style="color:${p.locSource === "exif" ? "var(--accent)" : "var(--warn)"}">${p.locSource === "exif" ? "EXIF" : "manuel"}</span></div>`
          : `<div style="color:var(--bad)">📍 Pas de GPS dans la photo</div>`;
      const dir =
        p.direction != null ? `<div>🧭 ${Math.round(p.direction)}° ${cardinal(p.direction)}</div>` : "";
      // Date chip: click to edit. Source badge distinguishes EXIF (auto) from manual.
      const timeSource = p.takenAt
        ? p.takenAtSource === "manual"
          ? '<span style="color:var(--warn);font-size:9px"> manuel</span>'
          : '<span style="color:var(--accent);font-size:9px"> EXIF</span>'
        : "";
      const timeLabel = p.takenAt
        ? `🕒 ${formatRelativeDays((p.takenAt - Date.now()) / 86400000)}${timeSource}`
        : p.exifFound
          ? `📅 Dater la photo…`
          : `📅 Dater la photo…`;
      const time = `<div class="photo-date" data-id="${p.id}" title="${p.takenAt ? p.takenAt.toLocaleString("fr-FR") + " — cliquer pour modifier" : "Cliquer pour saisir une date (aujourd'hui par défaut)"}" style="cursor:pointer;color:${p.takenAt ? "inherit" : "var(--muted)"}">${timeLabel}</div>`;
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
        <div class="photo-slot" data-photo-id="${p.id}" style="position:relative;cursor:${p.lat != null ? "crosshair" : "default"}" title="${p.lat != null ? "Cliquer autour de la photo pour recentrer la carte" : ""}">
          <img class="photo-img" src="${p.dataUrl}" alt="${p.name}" data-photo-id="${p.id}" style="cursor:zoom-in" title="Cliquer pour agrandir" />
          <div style="position:absolute;top:-4px;left:-4px;background:var(--accent);color:#0a0e13;border-radius:50%;width:16px;height:16px;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;pointer-events:none">${i + 1}</div>
        </div>
        <div class="meta">
          <div title="${p.name}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name}</div>
          ${loc}${dir}${time}
          ${tagBadges.length || tags.shot_type ? `<div style="display:flex;gap:3px;margin-top:3px;flex-wrap:wrap">${tagBadges.join("")}${repBadge}</div>` : ""}
          <div style="display:flex;gap:4px;margin-top:2px;flex-wrap:wrap">
            <button class="secondary place" data-id="${p.id}">${p.lat != null ? "Replacer" : "📍 Placer"}</button>
            <button class="secondary aim" data-id="${p.id}" ${p.lat == null ? "disabled title='Place la photo d&apos;abord'" : ""}>🧭 Direction</button>
            <button class="secondary analyze-photo" data-id="${p.id}" ${p.analyzing ? "disabled" : ""} title="${p.analyzing ? "Analyse en cours…" : "Relancer l'analyse de cette photo"}">${p.analyzing ? "🔬 …" : p.tags?.analyzed_at ? "🔬 ↻" : "🔬 Analyser"}</button>
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
    // Date editor — clicking the date chip swaps it in-place for a native <input type="date">.
    // Default value = current takenAt OR today, so a single Enter/blur sets "today".
    app.thumbsEl.querySelectorAll(".photo-date").forEach((chip) => {
      chip.addEventListener("click", () => {
        const id = chip.dataset.id;
        const p = app.photos.find((x) => x.id === id);
        if (!p) return;
        const isoDefault = (p.takenAt || new Date()).toISOString().slice(0, 10);
        const input = document.createElement("input");
        input.type = "date";
        input.value = isoDefault;
        input.style.cssText = "font-size:11px;padding:2px 4px;width:120px";
        const clear = document.createElement("button");
        clear.textContent = "✕";
        clear.title = "Effacer la date";
        clear.style.cssText =
          "background:transparent;border:0;color:var(--bad);font-size:10px;cursor:pointer;padding:0 4px";
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:inline-flex;gap:2px;align-items:center";
        wrap.appendChild(input);
        wrap.appendChild(clear);
        chip.replaceWith(wrap);
        input.focus();
        let committed = false;
        const commit = (newDateOrNull) => {
          if (committed) return;
          committed = true;
          p.takenAt = newDateOrNull;
          if (newDateOrNull) p.takenAtSource = "manual";
          else delete p.takenAtSource;
          renderPhotos();
          app.onSchedule();
        };
        input.addEventListener("change", () => {
          const v = input.value;
          if (!v) {
            commit(null);
            return;
          }
          // Use noon UTC to avoid timezone-edge surprises that would shift the displayed day.
          const d = new Date(`${v}T12:00:00`);
          commit(isNaN(d.getTime()) ? null : d);
        });
        input.addEventListener("blur", () => {
          if (committed) return;
          // Treat a bare blur with the default value as "accept today" so a single click commits.
          const v = input.value || isoDefault;
          const d = new Date(`${v}T12:00:00`);
          commit(isNaN(d.getTime()) ? null : d);
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") input.blur();
          else if (e.key === "Escape") {
            committed = true;
            renderPhotos();
          }
        });
        clear.addEventListener("click", (e) => {
          e.stopPropagation();
          commit(null);
        });
      });
    });
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
    app.thumbsEl.querySelectorAll(".analyze-photo").forEach((b) => {
      b.onclick = (e) => {
        const id = e.currentTarget.dataset.id;
        const p = app.photos.find((x) => x.id === id);
        if (!p || p.analyzing || !app.analyzePhoto) return;
        p.analyzing = true;
        renderPhotos();
        app.analyzePhoto(p).catch((err) => {
          console.warn("per-photo analysis failed:", err.message);
          p.analyzing = false;
          renderPhotos();
        });
      };
    });
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
    // Image click → fullscreen modal (zoom). Stop bubbling so the slot's
    // map-recenter handler doesn't also fire.
    app.thumbsEl.querySelectorAll(".photo-img").forEach((img) => {
      img.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = img.dataset.photoId;
        const p = app.photos.find((x) => x.id === id);
        if (!p) return;
        const meta = [];
        if (p.lat != null) meta.push(`📍 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`);
        if (p.direction != null) meta.push(`🧭 ${Math.round(p.direction)}° ${cardinal(p.direction)}`);
        if (p.takenAt) meta.push(`🕒 ${p.takenAt.toLocaleString("fr-FR")}`);
        openImageModal(
          p.dataUrl,
          `<b>${p.name}</b><br><span class="small">${meta.join(" · ")}</span>`,
          p.dataUrl
        );
      });
    });
    // Slot (frame around image) click → recenter map on photo location.
    // Only fires when the click target is the slot itself, not the image.
    app.thumbsEl.querySelectorAll(".photo-slot").forEach((slot) => {
      slot.addEventListener("click", (e) => {
        if (e.target.classList.contains("photo-img")) return;
        const id = slot.dataset.photoId;
        const p = app.photos.find((x) => x.id === id);
        if (!p || p.lat == null) return;
        app.map.setView([p.lat, p.lon], Math.max(app.map.getZoom(), 17), { animate: true });
        if (p.marker) p.marker.openPopup?.();
      });
    });
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
      takenAtSource: takenAt ? "exif" : null,
      exifFound,
      representative: presetTags.includes("typical") ? true : null,
      tags: Object.keys(tagPreset).length ? tagPreset : null,
      locSource: gps?.latitude != null ? "exif" : null,
      marker: null,
      fovLayer: null,
    };
    app.photos.push(photo);
    if (photo.lat != null) placePhotoMarker(photo);
    // Fire-and-forget per-photo analysis. Sets `photo.analyzing = true` immediately so
    // the next renderPhotos shows a spinner; the analyzer flips it back and re-renders
    // when done. We don't await — the user keeps interacting freely.
    // Automated photo analysis fires ONLY for photos that haven't been analyzed yet
    // (no `tags.analyzed_at` marker). This means:
    //   - Fresh uploads from camera / file picker → analyzed automatically (always have no
    //     analyzed_at at first).
    //   - Photos restored from Dropbox with existing analysis → skipped (analyzed_at is
    //     persisted in the manifest, so it survives restore).
    //   - Swapping the AI provider does NOT re-analyze existing photos. The user can
    //     trigger a re-analysis manually via the 🔬 button per photo, which is the only
    //     code path that runs analysis on already-tagged photos.
    if (app.analyzePhoto && !photo.tags?.analyzed_at) {
      photo.analyzing = true;
      app.analyzePhoto(photo).catch((e) => {
        console.warn("per-photo analysis failed:", e.message);
        photo.analyzing = false;
        if (typeof renderPhotos === "function") renderPhotos();
      });
    }
    return photo;
  }

  return { placePhotoMarker, renderPhotos, addPhotoFromFile };
}
