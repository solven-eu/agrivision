// AgriVision RE — main UI module.
// All DOM wiring, business logic, and dynamic UI updates live here.
// Leaf data/utility modules: ./config.js, ./schemas.js, ./util.js, ./catalog.js, ./prompts.js, ./state.js

import {
  WORKER_URL,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL,
  DROPBOX_APP_KEY,
  DROPBOX_REDIRECT_URI,
  IGN_WMS,
  IGN_WFS,
  RPG_LAYER,
  RPG_WFS_TYPE,
  CADASTRE_LAYER,
  BAN,
  DEFAULT_VIEW,
  RPG_CATEGORIES,
} from "./config.js";
import {
  PHOTO_TAG_SCHEMA,
  FULL_REPORT_SCHEMA,
  QUICK_SCHEMA,
  DISEASES_SCHEMA,
  MARKET_SCHEMA,
  METRIC_SCHEMA,
} from "./schemas.js";
import {
  formatRelativeDays,
  fmtEUR,
  bearingTo,
  destPoint,
  cardinal,
  pointInRing,
  pointInPolygon,
  pointInGeom,
  compressImage,
  robustParseJson,
  autoCloseJson,
} from "./util.js";
import {
  CROP_CATALOG,
  CULTU_LABELS,
  cropMeta,
  resolveIdentifiedCropMeta,
  rebuildCultuLabels,
  loadCatalogJson,
  lookupTaxonImage,
  lookupCropImage,
} from "./catalog.js";
import { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, seasonFromDate, buildContextBlock } from "./prompts.js";
import { parcelArea, aggregateParcels } from "./state.js";
import { createPhotos } from "./photos.js";
import {
  renderMetrics as _renderMetricsRaw,
  renderDiseases,
  renderCrossCheck,
  treatmentTotalCost,
} from "./metrics.js";

// renderMetrics wrapper: supplies the price-edit hook that mutates analysisCombined + saves.
function renderMetrics(m) {
  _renderMetricsRaw(m, {
    onPriceEdit: (trimmed) => {
      analysisCombined.market = analysisCombined.market || {};
      if (trimmed === "") {
        delete analysisCombined.market.user_price_eur_per_kg;
      } else {
        const n = parseFloat(trimmed);
        if (isNaN(n) || n < 0) {
          alert("Prix invalide.");
          return;
        }
        analysisCombined.market.user_price_eur_per_kg = n;
      }
      const eff =
        analysisCombined.market.user_price_eur_per_kg ?? analysisCombined.market.indicative_price_eur_per_kg;
      const totT = analysisCombined.yield?.estimated_total_t;
      if (eff != null && totT != null) analysisCombined.market.estimated_total_value_eur = totT * 1000 * eff;
      renderMetrics(analysisCombined);
      if (analysisCombined.diseases) {
        renderDiseases(analysisCombined.diseases, {
          t_per_ha: analysisCombined.yield?.estimated_t_per_ha,
          price_eur_per_kg: eff,
          total_area_ha: analysisCombined.parcels_summary?.total_area_ha,
        });
      }
      DBX.setAnalysis({ analysis: analysisCombined, conversation, user_profile: userProfile });
    },
  });
}

// Trigger external catalog merge (fire-and-forget; inline catalog is the fallback).
loadCatalogJson();

// ============ Map ============
const map = L.map("map", { zoomControl: true }).setView(DEFAULT_VIEW, 10);
window.map = map; // expose for Playwright / DevTools debugging

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
}).addTo(map);

import { installSunCompass } from "./sun.js";
const sunCompass = installSunCompass(map);

// Geolocation: center on user if available, else keep default.

let currentAddress = null; // { label, lat, lon, city, postcode, context }
// If a Dropbox token is present at startup, an auto-reload is imminent and will
// dictate the final map view. Skip eager view-driven work (chip prefetch, geoloc auto-pan)
// until autoReload concludes.
let pendingDbxLoad = !!localStorage.getItem("dbx_token");

// Address geocoding + browser geolocation — extracted to js/geocode.js
import { installGeocoding } from "./geocode.js";
installGeocoding({
  map,
  setCurrentAddress: (a) => {
    currentAddress = a;
  },
  getPendingDbxLoad: () => pendingDbxLoad,
});

// Chip filter + RPG/cadastre WMS layers — extracted to js/chips.js
import { installChips } from "./chips.js";
const { refreshChips, refreshRpgLayer } = installChips({
  map,
  getPendingDbxLoad: () => pendingDbxLoad,
});

// ============ Parcels (extracted to js/parcels.js) ============
const selectedParcels = new Map(); // id -> { props, geometry, latlng }
let parcelsLocked = false;
let bioMode = localStorage.getItem("agri_bio_mode") || "auto";
import { installParcels } from "./parcels.js";
const parcels = installParcels({
  map,
  selectedParcels,
  getAnalysisCombined: () => analysisCombined,
  getBioMode: () => bioMode,
  setBioMode: (v) => {
    bioMode = v;
  },
  getParcelsLocked: () => parcelsLocked,
  setParcelsLocked: (v) => {
    parcelsLocked = v;
  },
  get updateAnalyzeAvailability() {
    return updateAnalyzeAvailability;
  },
});
const {
  featureKey,
  toggleParcelAt,
  renderParcelHighlight,
  fitToSelectedParcels,
  renderParcelInfoPanel,
  updateSelectHint,
  updateLockHint,
} = parcels;

// ============ Photos with map locations ============
const photoEl = document.getElementById("photo");
// Backward-compat: photo upload toggles "analyzeBtn" (now the chat-start button).
const analyzeBtn = document.getElementById("chat-start");
const aStatus = document.getElementById("analyze-status");
const thumbsEl = document.getElementById("thumbs");
const { placePhotoMarker, renderPhotos, addPhotoFromFile } = createPhotos({
  get photos() {
    return photos;
  },
  get map() {
    return map;
  },
  get mapEl() {
    return mapEl;
  },
  get aStatus() {
    return aStatus;
  },
  get analyzeBtn() {
    return analyzeBtn;
  },
  thumbsEl,
  onSchedule: () => DBX.schedule(),
  setPlacingPhotoId: (v) => {
    placingPhotoId = v;
  },
  setAimingPhotoId: (v) => {
    aimingPhotoId = v;
  },
});
const mapEl = document.getElementById("map");
const photos = []; // [{ id, name, mime, b64, dataUrl, lat?, lon?, marker? }]
let placingPhotoId = null; // when set, next non-placing map click drops a pin
let aimingPhotoId = null; // when set, next map click sets the photo's direction

function readFileAsB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ dataUrl: r.result, b64: r.result.split(",")[1] });
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (placingPhotoId || aimingPhotoId)) {
    placingPhotoId = null;
    aimingPhotoId = null;
    mapEl.classList.remove("map-placing");
    aStatus.textContent = "Annulé.";
  }
});

photoEl.addEventListener("change", async () => {
  const files = [...(photoEl.files || [])];
  aStatus.textContent = `Préparation de ${files.length} photo(s)…`;
  for (const f of files) await addPhotoFromFile(f);
  photoEl.value = ""; // allow re-adding same file
  renderPhotos();
  analyzeBtn.disabled = photos.length === 0;
  const compressed = photos.filter((p) => p.recompressed).length;
  aStatus.textContent = `${photos.length} photo(s) prête(s)${compressed ? ` (${compressed} recompressée(s))` : ""}.`;
});

// buildContextBlock moved to ./prompts.js

// ============ Chat (extracted to js/chat.js) ============
// Shared mutable state that the chat module also touches (kept in main.js so it can be passed
// directly to persistence + analyze; chat module mutates in place).
let analysisCombined = null;
const conversation = [];
const userProfile = {
  scores: { farmer: 0, agronomist: 0, investor: 0, consumer: 0, researcher: 0 },
  primary_concerns: [],
  expertise_0_100: 0,
  inferred_from_turns: [],
};

import { createChat } from "./chat.js";
const chat = createChat({
  get selectedParcels() {
    return selectedParcels;
  },
  get photos() {
    return photos;
  },
  conversation,
  userProfile,
  get map() {
    return map;
  },
  get aStatus() {
    return aStatus;
  },
  addPhotoFromFile,
  renderPhotos,
  renderMetrics,
  renderDiseases,
  get renderParcelHighlight() {
    return renderParcelHighlight;
  },
  get updateAnalyzeAvailability() {
    return updateAnalyzeAvailability;
  },
  get setButtonsDisabled() {
    return setButtonsDisabled;
  },
  onSchedule: () => DBX.schedule(),
  getAnalysisCombined: () => analysisCombined,
  setAnalysisCombined: (v) => {
    analysisCombined = v;
  },
  getBioMode: () => bioMode,
  getCurrentAddress: () => currentAddress,
  saveAnalysis: (payload) => DBX.setAnalysis(payload),
});
const { renderChat, sendTurn, resetChat, ACTION_HANDLERS } = chat;

// ============ Analyze (full-report) — extracted to js/analyze.js ============
import { createAnalyze } from "./analyze.js";
const analyze = createAnalyze({
  get selectedParcels() {
    return selectedParcels;
  },
  get photos() {
    return photos;
  },
  conversation,
  userProfile,
  get map() {
    return map;
  },
  get aStatus() {
    return aStatus;
  },
  getAnalysisCombined: () => analysisCombined,
  setAnalysisCombined: (v) => {
    analysisCombined = v;
  },
  getBioMode: () => bioMode,
  getCurrentAddress: () => currentAddress,
  isChatBusy: () => chat.isChatBusy(),
  renderMetrics,
  renderDiseases,
  renderCrossCheck,
  get renderParcelHighlight() {
    return renderParcelHighlight;
  },
  renderPhotos,
  saveAnalysis: (payload) => DBX.setAnalysis(payload),
});
const { inputFingerprint, setButtonsDisabled, updateAnalyzeAvailability, generateReport } = analyze;
let lastAnalyzedFingerprint = null; // kept here for compatibility with remaining call sites

// Loading overlay hooks (used by persistence.js) — extracted to js/loading.js
import { installGlobals as installLoadingGlobals } from "./loading.js";
installLoadingGlobals();

// Debug panel (?debug only) — extracted to js/debug.js
import { initDebug } from "./debug.js";

document.getElementById("chat-start").addEventListener("click", () => sendTurn(null));
document.getElementById("chat-send").addEventListener("click", () => {
  const inp = document.getElementById("chat-text");
  const text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  chat.setFreeTextOpen(false);
  sendTurn({ kind: "text", text });
});
document.getElementById("chat-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("chat-send").click();
});
document.getElementById("chat-reset").addEventListener("click", () => {
  if (confirm("Recommencer la conversation ? L'historique sera perdu.")) resetChat();
});

document.getElementById("report-btn").addEventListener("click", generateReport);

// Initial chat render so the empty state shows.
renderChat();

// Drawer toggle (mobile only — handle is display:none on desktop).
document.getElementById("drawer-handle").addEventListener("click", () => {
  const side = document.getElementById("side");
  side.classList.toggle("open");
  document.getElementById("drawer-chevron").textContent = side.classList.contains("open") ? "▼" : "▲";
});

// Build/instance tag — random hex generated at page-load. If you ever see the same value
// after a hard reload, the page is being served from cache (browser or SW).
document.getElementById("ver").textContent = [...crypto.getRandomValues(new Uint8Array(4))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

// PWA: register service worker, but NEVER on localhost (stale-cache hell during dev).
// Also: if a SW was previously registered on this origin, unregister it.
const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname);
if ("serviceWorker" in navigator) {
  if (isLocalhost) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister().then(() => console.log("[dev] unregistered stale SW")));
    });
    // Also clear all caches it may have populated.
    if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  } else if (location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW reg failed:", e));
  }
}

// Dialect dropdown: persist, re-evaluate Analyser availability on change.
const dialectEl = document.getElementById("dialect");
dialectEl.value = localStorage.getItem("agri_dialect") || "fr";
dialectEl.addEventListener("change", () => {
  localStorage.setItem("agri_dialect", dialectEl.value);
  updateAnalyzeAvailability();
});

// ============ Dropbox persistence (extracted) ============
import { createDbx } from "./persistence.js";
const DBX = createDbx({
  // Direct refs (mutated in place):
  selectedParcels,
  photos,
  conversation,
  userProfile,
  map,
  placePhotoMarker,
  parcelArea,
  cropMeta,
  featureKey,
  inputFingerprint,
  refreshChips,
  renderMetrics,
  renderDiseases,
  renderChat,
  renderPhotos,
  renderParcelHighlight,
  renderParcelInfoPanel,
  updateLockHint,
  updateAnalyzeAvailability,
  // Accessors for reassigned scalars:
  getAnalysisCombined: () => analysisCombined,
  setAnalysisCombined: (v) => {
    analysisCombined = v;
  },
  getCurrentAddress: () => currentAddress,
  setCurrentAddress: (v) => {
    currentAddress = v;
  },
  getBioMode: () => bioMode,
  setBioMode: (v) => {
    bioMode = v;
  },
  getLastAnalyzedFingerprint: () => lastAnalyzedFingerprint,
  setLastAnalyzedFingerprint: (v) => {
    lastAnalyzedFingerprint = v;
  },
  setPendingDbxLoad: (v) => {
    pendingDbxLoad = v;
  },
});

// ===== Wire save triggers on every data change =====
const _origPlace = placePhotoMarker; // ensure marker re-renders don't loop
function dbxOnChange() {
  DBX.schedule();
}

// Patch photo lifecycle: existing handlers stay; we just observe via wrapping.
const _origRenderPhotos = renderPhotos;
// Hook: after any successful parcel toggle / photo add / placement / aim / delete,
// the existing renderPhotos / renderParcelInfoPanel runs. We piggyback by also
// scheduling a save + re-evaluating the Analyser button. MutationObserver is the cheapest way.
function onInputsChanged() {
  dbxOnChange();
  updateAnalyzeAvailability();
}
new MutationObserver(onInputsChanged).observe(document.getElementById("thumbs"), {
  childList: true,
  subtree: true,
});
new MutationObserver(onInputsChanged).observe(document.getElementById("parcel-info"), {
  childList: true,
  subtree: true,
});

// Analysis → Dropbox save is now wired directly inside analyze() via DBX.setAnalysis.
initDebug({ dbx: DBX });

// Map click router — extracted to js/router.js
import { installMapClickRouter } from "./router.js";
installMapClickRouter({
  map,
  mapEl,
  aStatus,
  photos,
  getPlacingPhotoId: () => placingPhotoId,
  setPlacingPhotoId: (v) => {
    placingPhotoId = v;
  },
  getAimingPhotoId: () => aimingPhotoId,
  setAimingPhotoId: (v) => {
    aimingPhotoId = v;
  },
  getParcelsLocked: () => parcelsLocked,
  placePhotoMarker,
  renderPhotos,
  toggleParcelAt,
  flashLockHint: parcels.flashLockHint,
  showZoomTooLowMessage: parcels.showZoomTooLowMessage,
});
