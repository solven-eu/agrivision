// Pure utilities: formatters, geometry, image processing, JSON resilience.
// No DOM access here.

// ---------- Formatters ----------
export function formatRelativeDays(days) {
  if (days == null || !isFinite(days)) return "—";
  const d = Math.round(days);
  if (Math.abs(d) < 1) return "aujourd'hui";
  const past = d < 0;
  const abs = Math.abs(d);
  let txt;
  if (abs < 14) txt = `${abs} j`;
  else if (abs < 60) txt = `${Math.round(abs / 7)} sem.`;
  else if (abs < 730) txt = `${Math.round(abs / 30)} mois`;
  else txt = `${(abs / 365).toFixed(1)} ans`;
  return past ? `il y a ${txt}` : `dans ${txt}`;
}

export function fmtEUR(v) {
  if (v == null) return "—";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(v);
}

// ---------- Geo / bearing ----------

// Bearing from (lat1,lon1) to (lat2,lon2), degrees from north clockwise.
export function bearingTo(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1),
    φ2 = toRad(lat2),
    Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Compute a destination point given start lat/lon, bearing (deg from N), distance (m).
export function destPoint(lat, lon, bearing, distM) {
  const R = 6378137;
  const br = (bearing * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180,
    lon1 = (lon * Math.PI) / 180;
  const dr = distM / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

export function cardinal(deg) {
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  return dirs[Math.round((deg % 360) / 45) % 8];
}

// ---------- Point-in-polygon (ray casting) ----------

// pt = [lon, lat], ring = [[lon,lat], ...]
export function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt, polygon) {
  if (!pointInRing(pt, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(pt, polygon[i])) return false;
  return true;
}

export function pointInGeom(pt, geom) {
  if (geom.type === "Polygon") return pointInPolygon(pt, geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some((p) => pointInPolygon(pt, p));
  return false;
}

// ---------- Image compression ----------

// Downscale + recompress in browser. Anthropic vision caps at 5 MB / image.
// Default: max 1568 px (Claude's optimal long side) and JPEG quality 0.85.
export async function compressImage(
  file,
  { maxDim = 1568, quality = 0.85, maxBytes = 4 * 1024 * 1024 } = {}
) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  const maxSide = Math.max(img.width, img.height);
  if (maxSide <= maxDim && file.size < maxBytes) {
    return {
      dataUrl,
      b64: dataUrl.split(",")[1],
      mime: file.type || "image/jpeg",
      width: img.width,
      height: img.height,
      recompressed: false,
    };
  }
  const scale = Math.min(1, maxDim / maxSide);
  const w = Math.round(img.width * scale),
    h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  let q = quality,
    out;
  // Try progressively lower quality until under maxBytes (base64 inflates ~33%).
  for (let i = 0; i < 4; i++) {
    out = canvas.toDataURL("image/jpeg", q);
    if (out.length * 0.75 < maxBytes) break;
    q -= 0.1;
  }
  return {
    dataUrl: out,
    b64: out.split(",")[1],
    mime: "image/jpeg",
    width: w,
    height: h,
    recompressed: true,
  };
}

// Re-encode an existing image (a data: URL already in memory) at a smaller dimension and lower
// JPEG quality. Unlike compressImage (which takes a File on upload), this re-compresses a photo
// we already hold — used by the "reduce photo quality" action to reclaim localStorage space
// without the original file. Returns the same shape fields the photo object uses.
export async function shrinkDataUrl(dataUrl, { maxDim = 1280, quality = 0.6 } = {}) {
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  const maxSide = Math.max(img.width, img.height) || 1;
  const scale = Math.min(1, maxDim / maxSide);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", quality);
  return { dataUrl: out, b64: out.split(",")[1], mime: "image/jpeg", width: w, height: h };
}

// ---------- JSON resilience ----------

// Parse Claude's response defensively. Handles markdown fences, trailing commas,
// mid-array truncation (auto-closes brackets in stack order).
export function robustParseJson(text) {
  if (!text) throw new Error("Réponse vide");
  let s = text
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "")
    .trim();
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) s = s.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(s);
  } catch {}
  let cleaned = s.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(cleaned);
  } catch {}
  cleaned = autoCloseJson(cleaned);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`JSON invalide: ${e.message}. Premiers 200 chars: ${s.slice(0, 200)}…`);
  }
}

export function autoCloseJson(s) {
  const stack = [];
  let inStr = false,
    escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const open = stack.pop();
      if (!open) break;
    }
  }
  if (inStr) {
    const lastComma = s.lastIndexOf(",", s.length - 1);
    if (lastComma > 0) s = s.slice(0, lastComma);
  }
  if (stack.length > 0) {
    s = s.replace(/,\s*"[^"]*":\s*[^,\]}]*$/, "");
    s = s.replace(/,\s*\{[^}]*$/, "");
    s = s.replace(/,\s*\[[^\]]*$/, "");
    while (stack.length > 0) {
      const open = stack.pop();
      s += open === "{" ? "}" : "]";
    }
  }
  return s;
}
