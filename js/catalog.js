// Crop catalog, lookups, and external image fetcher.
// CROP_CATALOG is keyed by RPG code_cultu. Loaded from catalog.json at startup
// over the inline defaults (which act as offline fallback).

// Inline defaults — overridden by catalog.json on startup.
export const CROP_CATALOG = {
  BAN: {
    scientific: "Musa × paradisiaca",
    fr: "Bananier",
    emoji: "🍌",
    locals: { rcf: "Bananyé", gcf: "Bannann" },
  },
  CSU: {
    scientific: "Saccharum officinarum",
    fr: "Canne à sucre",
    emoji: "🎋",
    locals: { rcf: "Kann", gcf: "Kann" },
  },
  BTH: { scientific: "Triticum aestivum", fr: "Blé tendre d'hiver", emoji: "🌾" },
  BTP: { scientific: "Triticum aestivum", fr: "Blé tendre de printemps", emoji: "🌾" },
  TTH: { scientific: "× Triticosecale", fr: "Triticale d'hiver", emoji: "🌾" },
  ORH: { scientific: "Hordeum vulgare", fr: "Orge d'hiver", emoji: "🌾" },
  MIS: { scientific: "Zea mays", fr: "Maïs", emoji: "🌽" },
  MIE: { scientific: "Zea mays", fr: "Maïs ensilage", emoji: "🌽" },
  CZH: { scientific: "Brassica napus", fr: "Colza d'hiver", emoji: "🌼" },
  TRN: { scientific: "Helianthus annuus", fr: "Tournesol", emoji: "🌻" },
  VRC: { scientific: "Vitis vinifera", fr: "Vigne raisin de cuve", emoji: "🍇" },
  VRT: { scientific: "Vitis vinifera", fr: "Vigne raisin de table", emoji: "🍇" },
  PPH: { fr: "Prairie permanente herbe", emoji: "🌿" },
  SPH: { fr: "Surface pastorale herbacée", emoji: "🌿" },
  SPL: { fr: "Surface pastorale ligneuse", emoji: "🌳" },
  PPR: { fr: "Prairie en rotation longue", emoji: "🌿" },
  PTR: { fr: "Prairie temporaire", emoji: "🌱" },
  PVT: { fr: "Verger", emoji: "🍎" },
  AGR: { scientific: "Citrus", fr: "Agrumes", emoji: "🍊", locals: { rcf: "Sitron" } },
  JAC: { fr: "Jachère", emoji: "🪶" },
  LDH: { scientific: "Lavandula", fr: "Lavande / lavandin", emoji: "💜" },
  FVP: { scientific: "Vicia faba", fr: "Féverole", emoji: "🫘" },
  MLC: { fr: "Mélange légumineuses / céréales", emoji: "🌾" },
  MDI: { fr: "Maraîchage diversifié", emoji: "🥬" },
};

// Backward-compatible {code → FR label} map derived from CROP_CATALOG.
export const CULTU_LABELS = {};

export function cropMeta(code) {
  return CROP_CATALOG[code] || { fr: code, emoji: "🌱" };
}

// Find the catalog entry that matches Claude's identification (by scientific name first, then FR).
// Used to override the parcel emoji when the latest analysis identifies the crop.
export function resolveIdentifiedCropMeta(identification) {
  const id = identification || null;
  if (!id) return null;
  const sci = (id.scientific_name || "").trim().toLowerCase();
  const fr = (id.dominant_crop_fr || "").trim().toLowerCase();
  if (!sci && !fr) return null;
  for (const meta of Object.values(CROP_CATALOG)) {
    if (sci && meta.scientific?.toLowerCase() === sci) return meta;
    if (fr && meta.fr?.toLowerCase() === fr) return meta;
  }
  const sciGenus = sci.split(/\s+/)[0];
  for (const meta of Object.values(CROP_CATALOG)) {
    const mFr = meta.fr?.toLowerCase() || "";
    const mSci = meta.scientific?.toLowerCase() || "";
    if (fr && (mFr.includes(fr) || fr.includes(mFr))) return meta;
    if (sciGenus && mSci.startsWith(sciGenus)) return meta;
  }
  return null;
}

export function rebuildCultuLabels() {
  for (const k of Object.keys(CULTU_LABELS)) delete CULTU_LABELS[k];
  for (const [code, m] of Object.entries(CROP_CATALOG)) CULTU_LABELS[code] = m.fr;
}

// Load external catalog (catalog.json) and merge over the inline defaults.
export async function loadCatalogJson() {
  try {
    const r = await fetch("catalog.json");
    if (!r.ok) return;
    const j = await r.json();
    if (j?.crops) {
      Object.assign(CROP_CATALOG, j.crops);
      rebuildCultuLabels();
    }
  } catch {
    /* offline / file:// — inline catalog stands */
  }
}

// Generic taxon image lookup: local catalog → Wikipedia (FR then EN) → iNaturalist.
// Caches each (key, source) hit in localStorage. Returns { url, source } or null.
export async function lookupTaxonImage(sciName, commonFr, catalog = CROP_CATALOG) {
  const tryKeys = [sciName, commonFr].filter(Boolean);

  // 1. Local catalog
  for (const k of tryKeys) {
    const hit = catalog[k] || catalog[k.toLowerCase()];
    if (hit) return { url: hit, source: "catalogue local" };
  }

  // 2. Wikipedia FR + EN, per key
  for (const k of tryKeys) {
    const cacheKey = `img:${k}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached && cached !== "MISS") {
      const [src, url] = cached.split("|", 2);
      return { url, source: src + " (cache)" };
    }
    if (cached === "MISS") continue;
    for (const lang of ["fr", "en"]) {
      try {
        const r = await fetch(
          `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(k)}`
        );
        if (!r.ok) continue;
        const j = await r.json();
        const url = j.thumbnail?.source || j.originalimage?.source;
        if (url) {
          const src = `Wikipedia ${lang.toUpperCase()}`;
          localStorage.setItem(cacheKey, `${src}|${url}`);
          return { url, source: src };
        }
      } catch {}
    }
  }

  // 3. iNaturalist taxa search
  for (const k of tryKeys) {
    const cacheKey = `inat:${k}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached && cached !== "MISS") return { url: cached, source: "iNaturalist (cache)" };
    if (cached === "MISS") continue;
    try {
      const r = await fetch(
        `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(k)}&per_page=1&locale=fr`
      );
      if (!r.ok) continue;
      const j = await r.json();
      const url = j.results?.[0]?.default_photo?.medium_url || j.results?.[0]?.default_photo?.square_url;
      if (url) {
        localStorage.setItem(cacheKey, url);
        return { url, source: "iNaturalist" };
      }
    } catch {}
    localStorage.setItem(cacheKey, "MISS");
  }

  for (const k of tryKeys) localStorage.setItem(`img:${k}`, "MISS");
  return null;
}

// Backwards-compatible alias
export const lookupCropImage = lookupTaxonImage;

// Populate CULTU_LABELS immediately so it's usable from import time.
rebuildCultuLabels();
