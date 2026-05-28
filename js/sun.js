// AgriVision RE — sun + moon compass overlay (top-right of map).
// Shows the current solar + lunar azimuth + altitude for the map's center coordinates,
// plus the current moon phase. Useful for understanding shadow direction when comparing
// the map to a real-world view of the field. Leaflet control; updates on move + every 60s.

/**
 * @param {L.Map} map - the Leaflet map instance.
 * @returns {L.Control} the sun-compass control (already added to the map).
 */
export function installSunCompass(map) {
  const SunCompass = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const wrap = L.DomUtil.create("div", "");
      const disc = L.DomUtil.create("div", "sun-compass", wrap);
      disc.innerHTML = `
        <span class="card n">N</span><span class="card s">S</span>
        <span class="card e">E</span><span class="card w">W</span>
        <span class="sun">☀</span><span class="moon">🌙</span>`;
      const meta = L.DomUtil.create("div", "sun-meta", wrap);
      this._sun = disc.querySelector(".sun");
      this._moon = disc.querySelector(".moon");
      this._meta = meta;
      this.update();
      return wrap;
    },
    // SunCalc azimuth: from south, clockwise → convert to from-north, clockwise.
    _place(el, body, r, cx, cy, label) {
      const azN = (body.azimuth + Math.PI + 2 * Math.PI) % (2 * Math.PI);
      el.style.left = cx + r * Math.sin(azN) + "px";
      el.style.top = cy - r * Math.cos(azN) + "px";
      el.classList.toggle("below", body.altitude <= 0);
      const azDeg = Math.round((azN * 180) / Math.PI);
      const altDeg = Math.round((body.altitude * 180) / Math.PI);
      el.title = `${label} — azimut ${azDeg}°, hauteur ${altDeg >= 0 ? "+" : ""}${altDeg}°`;
      return { azDeg, altDeg };
    },
    update() {
      const c = map.getCenter();
      const now = new Date();
      const sunPos = SunCalc.getPosition(now, c.lat, c.lng);
      const moonPos = SunCalc.getMoonPosition(now, c.lat, c.lng);
      const s = this._place(this._sun, sunPos, 28, 35, 35, "Soleil");
      const m = this._place(this._moon, moonPos, 20, 35, 35, "Lune");
      const phase = SunCalc.getMoonIllumination(now).phase; // 0=new … 0.5=full … 1=new
      const phaseGlyph = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"][Math.round(phase * 8) % 8];
      this._moon.textContent = phaseGlyph;
      this._meta.innerHTML =
        `☀ ${s.azDeg}° / ${s.altDeg >= 0 ? "+" : ""}${s.altDeg}°<br>` +
        `${phaseGlyph} ${m.azDeg}° / ${m.altDeg >= 0 ? "+" : ""}${m.altDeg}°`;
    },
  });
  const compass = new SunCompass().addTo(map);
  map.on("moveend", () => compass.update());
  setInterval(() => compass.update(), 60000);
  return compass;
}
