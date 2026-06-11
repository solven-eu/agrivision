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
  shrinkDataUrl,
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
  renderDiseases as _renderDiseasesRaw,
  renderCrossCheck,
  treatmentTotalCost,
} from "./metrics.js";

// Forwards a disease's missing_information item(s) as a user turn in the chat.
// Used by the "Demander" / "Poser au chat" buttons on disease cards.
function askMissingInfo({ disease, items }) {
  const dn = disease?.name_fr || "cette maladie";
  const lines = items
    .map(
      (m) =>
        `• ${m.what ?? "?"}${m.how_to_obtain ? ` — ${m.how_to_obtain}` : ""}${m.why ? ` (${m.why})` : ""}`
    )
    .join("\n");
  const text = `Pour clarifier le diagnostic de **${dn}**, il me manque :\n${lines}\n\nAide-moi à les fournir — explique comment procéder ou pose les questions précises dont tu as besoin.`;
  // Open mobile drawer if hidden + the chat section.
  const side = document.getElementById("side");
  if (side?.classList.contains("peek")) {
    side.classList.remove("peek");
    side.classList.add("half");
  }
  const sec = document.getElementById("chat-section");
  if (sec && !sec.open) sec.open = true;
  chat?.sendTurn({ kind: "text", text });
}

// Wrap renderDiseases so every call site gets the missing-info hook injected
// without needing to know about chat.
function renderDiseases(diseases, ctx) {
  return _renderDiseasesRaw(diseases, {
    ...(ctx || {}),
    onAskMissing: askMissingInfo,
    onGenerateDiseases: () => generateDiseases?.(),
  });
}

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
          toast("Prix invalide.", { kind: "warn" });
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
          photos,
        });
      }
      DBX.setAnalysis({ analysis: analysisCombined, conversation, user_profile: userProfile });
    },
    onLostOutputEdit: (trimmed) => {
      analysisCombined.health = analysisCombined.health || {};
      if (trimmed === "") {
        delete analysisCombined.health.user_lost_output_ratio_0_1;
      } else {
        const pct = parseFloat(trimmed);
        if (isNaN(pct) || pct < 0 || pct > 100) {
          toast("Valeur invalide (0–100 attendu).", { kind: "warn" });
          return;
        }
        analysisCombined.health.user_lost_output_ratio_0_1 = pct / 100;
      }
      renderMetrics(analysisCombined);
      DBX.setAnalysis({ analysis: analysisCombined, conversation, user_profile: userProfile });
    },
    onGenerateMarket: () => generateField?.("market"),
    onGenerateNotes: () => generateField?.("notes"),
  });
}

// Trigger external catalog merge (fire-and-forget; inline catalog is the fallback).
loadCatalogJson();

// ============ Map ============
const map = L.map("map", { zoomControl: true }).setView(DEFAULT_VIEW, 10);
window.map = map; // expose for Playwright / DevTools debugging

// Basemap + RPG tiles are deferred when a Dropbox restore is imminent — otherwise
// we'd fetch tiles for the default view, then again after fitBounds to the actual parcels.
// `initBasemap()` is called either by autoReload (after view is set) or as a fallback
// after the geolocation timeout / when there's no token at startup.
let _basemapInstalled = false;
function initBasemap() {
  if (_basemapInstalled) return;
  _basemapInstalled = true;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }).addTo(map);
}
// Basemap install is now ALWAYS deferred to avoid the boot-time tile cascade:
//   1. setView(DEFAULT_VIEW) → tiles for La Réunion fetched
//   2. Geolocation succeeds → setView([lat,lon]) → tiles for GPS fetched
//   3. Dropbox restore completes → fitBounds(parcels) → tiles for parcels fetched
// Only the last view matters. The basemap is installed exactly once, when one of these
// signals has set the *final* viewport:
//   - geolocation success/failure → geocode.js calls window.__initBasemap()
//   - Dropbox restore completes → persistence.js calls window.__initBasemap()
//   - Hard safety net at 8 s (covers the case where geolocation is ignored + no token)
setTimeout(() => {
  if (!_basemapInstalled) initBasemap();
}, 8000);
window.__initBasemap = initBasemap; // exposed so persistence.js + geocode.js can trigger it

import { installSunCompass } from "./sun.js";
const sunCompass = installSunCompass(map);

// Geolocation: center on user if available, else keep default.

let currentAddress = null; // { label, lat, lon, city, postcode, context }
// Storage-agnostic "a restore is pending" gate. TRUE at startup whenever ANY storage backend has a
// session to restore — the auto-reload will then dictate the final map view (fitBounds to the
// parcels). While pending we skip eager view-driven work (geoloc auto-pan + basemap install) so we
// don't load tiles around the GPS position and then visibly jump to the parcels; the restore sets
// the final view and installs the basemap once. The 8 s safety net covers a restore that never fires.
//
// SINGLE SOURCE OF TRUTH for "is there a stored session?": add any future storage backend (e.g. a
// KV-only restore) here and the whole map-deferral chain stays correct — it's transverse to the
// storage solution, not Dropbox-specific.
function hasStoredSession() {
  return (
    !!localStorage.getItem("dbx_token") ||
    !!localStorage.getItem("gdrive_connected") ||
    !!localStorage.getItem("agri_local_session")
  );
}
let pendingRestore = hasStoredSession();

// Address geocoding + browser geolocation — extracted to js/geocode.js
import { installGeocoding } from "./geocode.js";
installGeocoding({
  map,
  setCurrentAddress: (a) => {
    currentAddress = a;
  },
  getPendingRestore: () => pendingRestore,
  // So geolocation can skip its auto-pan once a restore has already set the view + basemap
  // (geoloc can resolve AFTER the restore, which would otherwise yank the map to GPS).
  isBasemapInstalled: () => _basemapInstalled,
});

// RPG/cadastre WMS layers + layer control — extracted to js/chips.js
import { installChips } from "./chips.js";
const { refreshChips, refreshRpgLayer } = installChips({
  map,
  getPendingRestore: () => pendingRestore,
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
  // Live photo list (declared below) — used for the 📷-per-parcel count + the parcel sheet.
  get photos() {
    return photos;
  },
  renderPhotos: () => renderPhotos(),
});
const {
  featureKey,
  toggleParcelAt,
  renderParcelHighlight,
  fitToSelectedParcels,
  renderParcelInfoPanel,
  updateSelectHint,
  updateLockHint,
  refreshPhotoAssociations,
  openParcelDetail,
} = parcels;
// "Discuter de cette parcelle" (from the on-map parcel sheet) → open chat + send a focused turn.
window.addEventListener("agrivision:discuss-parcel", (e) => {
  openChatSection();
  sendTurn({ kind: "text", text: e.detail?.text || "" });
});
// Helper for any place that adds/moves a photo: recompute parcel association + re-render.
function onPhotosChanged() {
  refreshPhotoAssociations?.();
  renderPhotos();
  renderParcelInfoPanel(); // 📷 N badge updates on the parcel row
}
window.__onPhotosChanged = onPhotosChanged;

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
  get analyzePhoto() {
    return analyzePhoto;
  },
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

// Prominent "the app is waiting for a map click" banner over the map, shown during photo
// place / aim modes (the subtle sidebar status line was too easy to miss). Created lazily.
let _mapWaitBanner = null;
function showMapWaitBanner(message) {
  if (!_mapWaitBanner) {
    _mapWaitBanner = document.createElement("div");
    _mapWaitBanner.id = "map-wait-banner";
    document.getElementById("map").appendChild(_mapWaitBanner);
  }
  _mapWaitBanner.innerHTML = `<span>${message}</span><button type="button" id="map-wait-cancel">✕ Annuler</button>`;
  _mapWaitBanner.style.display = "flex";
  document.getElementById("map-wait-cancel").onclick = cancelPlacingMode;
}
function hideMapWaitBanner() {
  if (_mapWaitBanner) _mapWaitBanner.style.display = "none";
}
function cancelPlacingMode() {
  placingPhotoId = null;
  aimingPhotoId = null;
  mapEl.classList.remove("map-placing");
  hideMapWaitBanner();
  aStatus.textContent = "Annulé.";
}
// Exposed so photos.js (enter mode) and router.js (click completes the mode) can drive the banner.
window.__mapWaitBanner = showMapWaitBanner;
window.__hideMapWaitBanner = hideMapWaitBanner;

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (placingPhotoId || aimingPhotoId)) cancelPlacingMode();
});

async function handlePhotoFiles(files) {
  if (files.length === 0) return;
  aStatus.textContent = `Préparation de ${files.length} photo(s)…`;
  for (const f of files) await addPhotoFromFile(f);
  onPhotosChanged(); // recompute parcel association + refresh both panels
  analyzeBtn.disabled = photos.length === 0;
  const compressed = photos.filter((p) => p.recompressed).length;
  aStatus.textContent = `${photos.length} photo(s) prête(s)${compressed ? ` (${compressed} recompressée(s))` : ""}.`;
}

// Hidden inputs — triggered by the two visible buttons.
photoEl.addEventListener("change", async () => {
  await handlePhotoFiles([...(photoEl.files || [])]);
  photoEl.value = "";
});
const photoCamEl = document.getElementById("photo-cam");
photoCamEl?.addEventListener("change", async () => {
  await handlePhotoFiles([...(photoCamEl.files || [])]);
  photoCamEl.value = "";
});

// Camera-first capture (opens camera on mobile via capture="environment").
document.getElementById("photo-camera")?.addEventListener("click", () => photoCamEl?.click());
// File picker fallback.
document.getElementById("photo-file")?.addEventListener("click", () => photoEl.click());

// Re-compress every in-memory photo at a lower dimension/quality to reclaim localStorage space
// (the local session mirror inlines photo bytes — see persistence.js). Re-renders + triggers a
// save afterwards. Triggered by the photos-section button and the `agrivision:compress-photos`
// event (e.g. from the storage-full toast).
async function compressAllPhotos() {
  if (!photos.length) {
    toast("Aucune photo à compresser.");
    return;
  }
  const bytes = (p) => (p.b64 ? p.b64.length : 0);
  const before = photos.reduce((s, p) => s + bytes(p), 0);
  let changed = 0;
  for (const p of photos) {
    const src = p.dataUrl || (p.b64 ? `data:${p.mime || "image/jpeg"};base64,${p.b64}` : null);
    if (!src) continue;
    try {
      const r = await shrinkDataUrl(src, { maxDim: 1280, quality: 0.6 });
      // Only adopt the result if it actually got smaller (already-tiny photos stay as-is).
      if (r.b64.length < bytes(p)) {
        p.dataUrl = r.dataUrl;
        p.b64 = r.b64;
        p.mime = r.mime;
        p.width = r.width;
        p.height = r.height;
        p.recompressed = true;
        changed++;
      }
    } catch (e) {
      console.warn("[compress] photo failed:", e?.message);
    }
  }
  renderPhotos();
  onInputsChanged(); // re-save (local mirror + Dropbox) with the smaller bytes
  const after = photos.reduce((s, p) => s + bytes(p), 0);
  const savedMb = Math.max(0, (before - after) * 0.75) / (1024 * 1024); // b64 → ~0.75 bytes/char
  toast(
    changed
      ? `${changed} photo(s) compressée(s) · ~${savedMb.toFixed(1)} Mo libérés.`
      : "Photos déjà au minimum — rien à compresser.",
    { kind: "info" }
  );
}
document.getElementById("photo-compress")?.addEventListener("click", compressAllPhotos);
window.addEventListener("agrivision:compress-photos", compressAllPhotos);

// Floating Action Button — primary mobile action.
// Default: open camera. Once we're mid-conversation, switches to opening the drawer to half.
const fabBtn = document.getElementById("fab");
fabBtn?.addEventListener("click", () => {
  if (conversation.length > 0) {
    // Mid-conversation: bring the drawer up so the user can see Claude's response.
    setDrawerSnap("half");
    return;
  }
  photoCamEl?.click();
});

// Auto-open the advanced sections that hold valuable data once they're filled in.
// (Watches the metrics + diseases panels for content; opens their <details> on first content.)
function autoOpenWhenPopulated(detailsId, contentSelector) {
  const detailsEl = document.getElementById(detailsId);
  const target = detailsEl?.querySelector(contentSelector);
  if (!detailsEl || !target) return;
  new MutationObserver(() => {
    if (target.children.length > 0 && !detailsEl.open) detailsEl.open = true;
  }).observe(target, { childList: true });
}
autoOpenWhenPopulated("grid-section", "#metrics");
autoOpenWhenPopulated("diseases-section", "#diseases");

// buildContextBlock moved to ./prompts.js

// ============ Chat (extracted to js/chat.js) ============
// Shared mutable state that the chat module also touches (kept in main.js so it can be passed
// directly to persistence + analyze; chat module mutates in place).
let analysisCombined = null;
const conversation = [];
// The dialect (ISO 639-3) under which the current conversation was started. Captured at
// the first turn from the preference select. Compared on every subsequent turn so a change
// can be flagged to the AI as a context update.
let conversationDialect = null;
const userProfile = {
  scores: { farmer: 0, agronomist: 0, investor: 0, consumer: 0, researcher: 0 },
  primary_concerns: [],
  expertise_0_100: 0,
  inferred_from_turns: [],
};

// ============ Token tracking ============
import { createTokenTracker, fmtTokens, fmtCost } from "./tokens.js";
const TOKEN_SOFT_LIMIT = 200_000; // warn above this many tokens per culture
const TOKEN_HARD_LIMIT = 500_000; // block above this; user must reset to continue
const tokenTracker = createTokenTracker({ softLimit: TOKEN_SOFT_LIMIT, hardLimit: TOKEN_HARD_LIMIT });

function renderTokenBadge() {
  const summary = document.getElementById("token-summary");
  if (!summary) return; // debug panel not open
  const t = tokenTracker.snapshot();
  if (t.turns === 0) {
    summary.textContent = "Tokens : aucun appel encore";
    document.getElementById("token-warning").textContent = "";
    document.getElementById("token-details").style.display = "none";
    return;
  }
  const totalIn = t.input + t.cache_creation + t.cache_read;
  summary.textContent = `🪙 ${t.turns} tour(s) · ${fmtTokens(totalIn)} in / ${fmtTokens(t.output)} out · ${fmtCost(t.cost_usd)}`;
  const warnEl = document.getElementById("token-warning");
  if (tokenTracker.atHardLimit()) warnEl.textContent = "⛔ Limite atteinte";
  else if (tokenTracker.atSoftLimit())
    warnEl.textContent = `⚠ ${Math.round((100 * (totalIn + t.output)) / TOKEN_HARD_LIMIT)}% de la limite`;
  else warnEl.textContent = "";
  const details = document.getElementById("token-details");
  details.style.display = "block";
  details.innerHTML =
    `• Input frais : ${fmtTokens(t.input)}<br>` +
    `• Cache écriture : ${fmtTokens(t.cache_creation)} (premium +25%)<br>` +
    `• Cache lecture : ${fmtTokens(t.cache_read)} (rabais -90%)<br>` +
    `• Output : ${fmtTokens(t.output)}<br>` +
    `• Limite douce : ${fmtTokens(TOKEN_SOFT_LIMIT)} · Limite dure : ${fmtTokens(TOKEN_HARD_LIMIT)}`;
}

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
  getConversationDialect: () => conversationDialect,
  setConversationDialect: (v) => {
    conversationDialect = v;
  },
  getCurrentDialect: () => document.getElementById("dialect")?.value || "fr",
  getBioMode: () => bioMode,
  getCurrentAddress: () => currentAddress,
  saveAnalysis: (payload) => DBX.setAnalysis(payload),
  onUsage: (usage, model) => {
    tokenTracker.accumulate(usage, model);
    renderTokenBadge();
  },
  isOverHardLimit: () => tokenTracker.atHardLimit(),
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
  onUsage: (usage, model) => {
    tokenTracker.accumulate(usage, model);
    renderTokenBadge();
  },
  isOverHardLimit: () => tokenTracker.atHardLimit(),
});
const {
  inputFingerprint,
  setButtonsDisabled,
  updateAnalyzeAvailability,
  generateReport,
  generateField,
  generateDiseases,
  analyzePhoto,
} = analyze;
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
  const attachPhotos = chat.takeComposerAttachments();
  // Allow sending photo-only (no text) — provide a default prompt so Claude has something to anchor on.
  if (!text && attachPhotos.length === 0) return;
  inp.value = "";
  chat.setFreeTextOpen(false);
  sendTurn({
    kind: "text",
    text: text || "(photo jointe sans commentaire)",
    attachPhotos: attachPhotos.length ? attachPhotos : undefined,
  });
});

// Composer attach button — opens a file picker, stages photos for the next send.
document.getElementById("chat-attach")?.addEventListener("click", () => chat.composerPickPhoto());
document.getElementById("chat-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("chat-send").click();
});
document.getElementById("chat-reset").addEventListener("click", () => {
  if (confirm("Recommencer la conversation ? L'historique sera perdu.")) {
    resetChat();
    tokenTracker.reset();
    renderTokenBadge();
  }
});

// ============ Speech-to-text (WIP) ============
import { createSpeech } from "./speech.js";
const speech = createSpeech({
  input: document.getElementById("chat-text"),
  button: document.getElementById("chat-mic"),
  getLang: () => {
    const d = document.getElementById("dialect")?.value || "fr";
    // Web Speech doesn't have a Creole locale; fall back to FR/Antilles for rcf/gcf.
    return d === "rcf" ? "fr-RE" : d === "gcf" ? "fr-GP" : "fr-FR";
  },
  onSubmit: (text) => {
    chat.setFreeTextOpen(false);
    sendTurn({ kind: "text", text });
    document.getElementById("chat-text").value = "";
  },
  onStatus: (msg) => {
    if (msg) aStatus.textContent = msg;
  },
});
document.getElementById("chat-mic")?.addEventListener("click", () => speech.toggle());

document.getElementById("report-btn").addEventListener("click", generateReport);

// Initial chat render so the empty state shows.
renderChat();

// ============ Drawer (mobile only) — snap points + tap + swipe gestures ============
// Snap points: "peek" (only the handle visible), "half" (50% of screen), "full" (everything).
const drawerSnaps = ["peek", "half", "full"];
function setDrawerSnap(snap) {
  const side = document.getElementById("side");
  if (!side) return;
  drawerSnaps.forEach((s) => side.classList.remove(s));
  side.classList.add(snap);
  side.classList.remove("open"); // legacy class
  const chev = document.getElementById("drawer-chevron");
  if (chev) chev.textContent = snap === "peek" ? "▲" : snap === "half" ? "◆" : "▼";
}
window.setDrawerSnap = setDrawerSnap; // for inline use elsewhere if needed

const drawerHandle = document.getElementById("drawer-handle");
const sideEl = document.getElementById("side");
if (drawerHandle && sideEl) {
  // Initialize to peek on first load (mobile only — desktop ignores the classes).
  if (window.matchMedia("(max-width: 768px)").matches) setDrawerSnap("peek");

  // Tap: cycle through snap points.
  drawerHandle.addEventListener("click", () => {
    const current = drawerSnaps.find((s) => sideEl.classList.contains(s)) || "peek";
    const next = drawerSnaps[(drawerSnaps.indexOf(current) + 1) % drawerSnaps.length];
    setDrawerSnap(next);
  });

  // Swipe: drag the handle to switch snap.
  let touchStartY = null;
  drawerHandle.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
  });
  drawerHandle.addEventListener("touchend", (e) => {
    if (touchStartY == null) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartY = null;
    if (Math.abs(dy) < 30) return; // tap, not swipe
    const current = drawerSnaps.find((s) => sideEl.classList.contains(s)) || "peek";
    const idx = drawerSnaps.indexOf(current);
    // Negative dy = swipe up = more open; positive dy = swipe down = more closed.
    const newIdx = Math.max(0, Math.min(drawerSnaps.length - 1, idx + (dy > 0 ? -1 : 1)));
    setDrawerSnap(drawerSnaps[newIdx]);
  });
}

// Build/instance tag — random hex generated at page-load. If you ever see the same value
// after a hard reload, the page is being served from cache (browser or SW).
document.getElementById("ver").textContent = [...crypto.getRandomValues(new Uint8Array(4))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

// Bottom banner offering to reload into a newly-installed SW. Self-contained (no toast lib).
function showUpdateBanner(onReload) {
  if (document.getElementById("sw-update-banner")) return; // already showing
  const bar = document.createElement("div");
  bar.id = "sw-update-banner";
  bar.style.cssText =
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10050;" +
    "background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;" +
    "padding:10px 14px;display:flex;align-items:center;gap:12px;font-size:13px;max-width:92vw;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.4)";
  bar.innerHTML =
    `<span>🆕 Nouvelle version disponible.</span>` +
    `<button id="sw-update-reload" style="font-size:12px;padding:6px 12px">Recharger</button>` +
    `<button id="sw-update-dismiss" class="secondary" style="font-size:12px;padding:6px 10px">Plus tard</button>`;
  document.body.appendChild(bar);
  bar.querySelector("#sw-update-reload").onclick = () => {
    bar.remove();
    onReload();
  };
  bar.querySelector("#sw-update-dismiss").onclick = () => bar.remove();
}

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
    // Reload exactly once, and only when WE accepted an update (not on first-install claim).
    let updateAccepted = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updateAccepted) location.reload();
    });
    // updateViaCache:"none" → the browser bypasses the HTTP cache when checking sw.js, so a new
    // deploy is detected on the next visit regardless of host cache headers (GitHub Pages, etc.).
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((reg) => {
        const offerWaiting = (worker) => {
          if (!worker) return;
          showUpdateBanner(() => {
            updateAccepted = true;
            worker.postMessage({ type: "SKIP_WAITING" });
          });
        };
        // A new SW that finished installing on a previous visit and is parked in "waiting".
        if (reg.waiting && navigator.serviceWorker.controller) offerWaiting(reg.waiting);
        // A new SW discovered during this session.
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          nw?.addEventListener("statechange", () => {
            // Prompt only on an UPDATE (a controller already exists), never on first install.
            if (nw.state === "installed" && navigator.serviceWorker.controller) offerWaiting(nw);
          });
        });
      })
      .catch((e) => console.warn("SW reg failed:", e));
  }
}

// Dialect dropdown: persist, re-evaluate Analyser availability on change.
const dialectEl = document.getElementById("dialect");
dialectEl.value = localStorage.getItem("agri_dialect") || "fr";
dialectEl.addEventListener("change", () => {
  localStorage.setItem("agri_dialect", dialectEl.value);
  updateAnalyzeAvailability();
});

// Labor-rate override (€/h) — used by metrics.js treatmentTotalCost when set.
const _laborRateEl = document.getElementById("labor-rate");
if (_laborRateEl) {
  _laborRateEl.value = localStorage.getItem("agri_labor_rate_eur_per_h") || "";
  _laborRateEl.addEventListener("change", () => {
    const v = _laborRateEl.value.trim();
    if (v === "") localStorage.removeItem("agri_labor_rate_eur_per_h");
    else localStorage.setItem("agri_labor_rate_eur_per_h", v);
    // Re-render anything that depends on it.
    if (analysisCombined?.diseases) {
      renderDiseases(analysisCombined.diseases, {
        t_per_ha: analysisCombined.yield?.estimated_t_per_ha,
        price_eur_per_kg:
          analysisCombined.market?.user_price_eur_per_kg ??
          analysisCombined.market?.indicative_price_eur_per_kg,
        total_area_ha: analysisCombined.parcels_summary?.total_area_ha,
        photos,
      });
    }
  });
}

// Tutorial modal — shows on first visit (skippable, persisted in localStorage).
// Reachable later via the hamburger menu in case the user wants to re-see it.
function showTutorial(opts = {}) {
  const modal = document.getElementById("tutorial-modal");
  if (!modal) return;
  // Pages are discovered from the DOM so adding/removing a .tuto-page slide needs no JS edit.
  const pages = Array.from(modal.querySelectorAll(".tuto-page"));
  const total = pages.length;
  // Returning, logged-out users jump straight to the login slide; first-timers see the full
  // walk-through (whose last slide is the login panel anyway).
  const loginIdx = pages.findIndex((el) => el?.id === "tuto-page-login");
  let page = opts.startAtLogin && loginIdx >= 0 ? loginIdx + 1 : 1;
  const dots = document.getElementById("tuto-dots");
  const prev = document.getElementById("tuto-prev");
  const next = document.getElementById("tuto-next");
  const skip = document.getElementById("tuto-skip");
  function render() {
    pages.forEach((el, i) => el && (el.style.display = i === page - 1 ? "block" : "none"));
    if (dots) {
      dots.innerHTML = pages
        .map(
          (_, i) =>
            `<span style="width:8px;height:8px;border-radius:50%;background:${i + 1 === page ? "var(--accent)" : "var(--border)"}"></span>`
        )
        .join("");
    }
    if (prev) prev.style.visibility = page > 1 ? "visible" : "hidden";
    if (next) next.textContent = page === total ? "Commencer ✓" : "Suivant →";
    // When the login slide becomes visible, (re)mount the provider buttons — Google's button
    // needs a visible, sized container, which it only has once this page is shown.
    if (pages[page - 1]?.id === "tuto-page-login") window.auth?.render();
  }
  function close() {
    modal.style.display = "none";
    localStorage.setItem("agri_tutorial_seen", "1");
    window.removeEventListener("agrivision:login", close);
  }
  // Signing in from inside the modal dismisses it automatically.
  window.addEventListener("agrivision:login", close);
  prev?.addEventListener("click", () => {
    if (page > 1) {
      page--;
      render();
    }
  });
  next?.addEventListener("click", () => {
    if (page < total) {
      page++;
      render();
    } else {
      close();
    }
  });
  skip?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  render();
  modal.style.display = "flex";
}
window.showTutorial = showTutorial; // exposed so the hamburger can re-launch it
// On every load, offer login — unless already signed in. First visit shows the full tutorial
// (its last slide is the login panel); later logged-out visits jump straight to that slide.
// Small delay so it doesn't fight with the page initial paint / geolocation prompts, and so
// `window.auth` (created lower in this module) exists by the time the callback runs.
setTimeout(() => {
  if (window.auth?.isLoggedIn?.()) return;
  showTutorial({ startAtLogin: !!localStorage.getItem("agri_tutorial_seen") });
}, 400);

// Handle Stripe Checkout return URL: ?billing=success → toast + refetch the user's
// plan/quota so the new tier appears immediately in the share panel.
handleBillingReturn(() => share.fetchQuota());
document.getElementById("show-tutorial-btn")?.addEventListener("click", () => {
  document.getElementById("app-menu-panel").style.display = "none";
  showTutorial();
});

// Force-refresh: clear the service-worker asset caches + unregister the SW, then hard-reload so
// the very latest HTML/JS/CSS is fetched from the network. Deliberately does NOT touch
// localStorage — the user's session mirror, tokens and prefs must survive. Useful when a stale
// service-worker copy is serving old code.
document.getElementById("force-refresh-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("force-refresh-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "🔄 Mise à jour…";
  }
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      console.log("[refresh] cleared", keys.length, "cache(s)");
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      console.log("[refresh] unregistered", regs.length, "service worker(s)");
    }
  } catch (e) {
    console.warn("[refresh] cleanup failed:", e?.message);
  }
  // Cache-bust the navigation itself so even the HTML isn't served from HTTP cache.
  const url = new URL(location.href);
  url.searchParams.set("_r", String(Date.now()));
  location.replace(url.toString());
});

// Hamburger menu (top-right of sidebar header) — toggles the preferences panel.
// Click anywhere outside closes it.
const _appMenuBtn = document.getElementById("app-menu-btn");
const _appMenuPanel = document.getElementById("app-menu-panel");
if (_appMenuBtn && _appMenuPanel) {
  _appMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _appMenuPanel.style.display = _appMenuPanel.style.display === "none" ? "block" : "none";
    if (_appMenuPanel.style.display === "block") {
      share.render();
      share.fetchQuota();
      // Plans card: fetch quota first so we know the current tier, then render.
      // Falls back to "free" when offline / unauthenticated.
      const tier = (window.__lastPlanTier ||= "free");
      renderPlansCard("plans-panel", tier);
    }
  });
  document.addEventListener("click", (e) => {
    if (
      _appMenuPanel.style.display !== "none" &&
      !_appMenuPanel.contains(e.target) &&
      e.target !== _appMenuBtn
    ) {
      _appMenuPanel.style.display = "none";
    }
  });
}

// Auto-open the chat section when conversation activity starts.
const _chatSectionEl = document.getElementById("chat-section");
function openChatSection() {
  if (_chatSectionEl && !_chatSectionEl.open) _chatSectionEl.open = true;
}
document.getElementById("chat-start")?.addEventListener("click", openChatSection);
document.getElementById("report-btn")?.addEventListener("click", openChatSection);

// ============ Share with AgriVision (opt-in KV mirror) ============
import { createShare, tradeDropboxIdTokenForSession, maybeRefreshSession } from "./share.js";
import { renderPlansCard, handleBillingReturn, openPlansModal } from "./billing.js";
import { installGateToasts, toast } from "./toast.js";
import { checkStorageHealth } from "./storage-health.js";
// Boot-time identity housekeeping:
// 1. If an old id_token is present without a session, mint one (backfill for users
//    who connected before /api/auth/dropbox/login existed).
// 2. Otherwise opportunistically refresh a near-expiry session so the user doesn't
//    hit a 401 mid-action.
(() => {
  if (!localStorage.getItem("agri_session")) {
    const idTok = localStorage.getItem("dbx_id_token");
    if (idTok) tradeDropboxIdTokenForSession(idTok, DROPBOX_APP_KEY).catch(() => {});
  } else {
    maybeRefreshSession().catch(() => {});
  }
})();
const share = createShare({
  get photos() {
    return photos;
  },
  getAnalysisCombined: () => analysisCombined,
});
window.share = share; // expose for debugging

// ============ Login UI (identity providers: Google / Facebook / Dropbox) ============
import { createAuth } from "./auth.js";
const auth = createAuth();
auth.render();
window.auth = auth; // expose for debugging
// Sharing depends on identity — when login state changes, refresh the share panel/quota.
window.addEventListener("agrivision:login", () => {
  share.render();
  share.fetchQuota();
});
window.addEventListener("agrivision:logout", () => share.render());

// ============ Gating: turn plan/login limits into actionable toasts ============
// Any feature blocked by plan/quota/login dispatches `agrivision:plan-blocked`; installGateToasts
// renders the toast, whose action re-dispatches one of the two events handled here. See CLAUDE.md
// "Gating: make plan/login limits loud and actionable".
installGateToasts();
window.addEventListener("agrivision:open-plans", async () => {
  // Refresh the quota FIRST so __lastPlanTier reflects the real (possibly org-inherited) tier,
  // then open the centered plans modal. Awaiting avoids opening with a stale "free" tier — which
  // would wrongly offer to BUY a plan the user already has via Early Birds. Best-effort: if the
  // fetch fails we still open with the last known tier.
  try {
    await share.fetchQuota?.();
  } catch {}
  openPlansModal(window.__lastPlanTier || "free");
});
window.addEventListener("agrivision:open-login", () => showTutorial({ startAtLogin: true }));

// ============ Satellite imagery (Sentinel-2 via Worker → CDSE) ============
import { createSatellite } from "./satellite.js";
const satellite = createSatellite({
  map,
  getSelectedParcels: () => selectedParcels,
  getPhotos: () => photos,
  openPhotos: () => {
    const el = document.getElementById("photos-section");
    if (el) {
      el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  },
});
satellite.render();
window.satellite = satellite;

// ============ Rain alerts (Web Push) ============
import { createAlerts } from "./alerts.js";
const alerts = createAlerts({ getSelectedParcels: () => selectedParcels });
alerts.render();
window.alerts = alerts;

// ============ Gamification — "Dossier de culture" completeness score ============
import { createGamification } from "./gamification.js";
const dossier = createGamification({
  getSelectedParcels: () => selectedParcels,
  getPhotos: () => photos,
  getAnalysisCombined: () => analysisCombined,
  openSection: (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  },
});
dossier.render();
window.dossier = dossier;
// Re-render the score when the parcels / photos / analysis panels change — event-driven
// (debounced MutationObserver), no polling. The dossier writes to its own panel, so there's
// no observer feedback loop.
{
  let t;
  const bump = () => {
    clearTimeout(t);
    t = setTimeout(() => dossier.render(), 250);
  };
  for (const id of ["thumbs", "parcel-info", "metrics"]) {
    const el = document.getElementById(id);
    if (el) new MutationObserver(bump).observe(el, { childList: true, subtree: true });
  }
}

// ============ Dropbox persistence (extracted) ============
import { createDbx } from "./persistence.js";
const DBX = createDbx({
  // Direct refs (mutated in place):
  selectedParcels,
  photos,
  conversation,
  userProfile,
  map,
  analyzeBtn,
  placePhotoMarker,
  parcelArea,
  cropMeta,
  featureKey,
  fitToSelectedParcels,
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
  // Lock setter so persistence can auto-lock parcels right after a restore — pure UI
  // safety to prevent the user from accidentally adding/removing parcels by tapping the
  // map. Doesn't affect business logic.
  setParcelsLocked: (v) => {
    parcelsLocked = v;
  },
  // Opt-in share-with-AgriVision hook: invoked by persistence.js after a confirmed save.
  onShareSync: (manifest) => share.syncNow(manifest),
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
  setPendingRestore: (v) => {
    pendingRestore = v;
  },
});
// The login panel / tutorial offer "Continuer avec Dropbox"; route that to the OAuth flow.
window.addEventListener("agrivision:connect-dropbox", () => DBX.connect());
window.addEventListener("agrivision:connect-gdrive", () => DBX.connectDrive());
window.DBX = DBX; // expose so the login panel's "Restaurer depuis AgriVision" can reach it

// ===== Wire save triggers on every data change =====
const _origPlace = placePhotoMarker; // ensure marker re-renders don't loop
function dbxOnChange() {
  console.log("[save] change detected (parcels/photos/analysis) → scheduling save");
  DBX.schedule();
  // Watch local storage as it grows with use (caches + prefs); warn once it nears the cap.
  // Cheap + de-duped per session, so calling it on every data change is fine.
  checkStorageHealth();
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
initDebug({
  dbx: DBX,
  get photos() {
    return photos;
  },
});

// Events feed (meteo + RSS aggregator) — extracted to js/events.js
import { createEvents } from "./events.js";
import { createVigicruesWidget } from "./vigicrues.js";
const _eventsAppCtx = {
  get map() {
    return map;
  },
  get selectedParcels() {
    return selectedParcels;
  },
  getCurrentAddress: () => currentAddress,
};
const events = createEvents(_eventsAppCtx);
const vigicrues = createVigicruesWidget(_eventsAppCtx);

// Static local climatology card. Renders on demand using the best available reference
// point: first selected parcel centroid → geocoded address → map center. No network.
import { renderClimateCard } from "./seasonal-normals.js";
function _refreshClimateCard() {
  let lat = null,
    lon = null,
    altM = null;
  if (selectedParcels.size > 0) {
    const first = selectedParcels.values().next().value;
    if (first?.latlng) {
      [lat, lon] = first.latlng;
      altM = first.altitude ?? null;
    }
  } else if (currentAddress?.lat != null) {
    lat = currentAddress.lat;
    lon = currentAddress.lon;
  } else {
    const c = map.getCenter();
    lat = c.lat;
    lon = c.lng;
  }
  renderClimateCard("climate-card", lat, lon, altM);
}
document
  .getElementById("climate-section")
  ?.addEventListener("toggle", (e) => e.target.open && _refreshClimateCard());

// ============ Weather / water (💧) — Météo-France obs + Open-Meteo forecast ============
import { createWeather } from "./weather.js";
function _weatherPoint() {
  if (selectedParcels.size > 0) {
    const first = selectedParcels.values().next().value;
    if (first?.latlng) return { lat: first.latlng[0], lon: first.latlng[1] };
  }
  if (currentAddress?.lat != null) return { lat: currentAddress.lat, lon: currentAddress.lon };
  return null;
}
const weather = createWeather({ getPoint: _weatherPoint });
window.weather = weather; // exposed so buildContextBlock can inject it into the AI context
// Lazy: fetch + render only when the user opens the section (an MF call per refresh).
document
  .getElementById("weather-section")
  ?.addEventListener("toggle", (e) => e.target.open && weather.ensureForSelection());
document.getElementById("events-refresh")?.addEventListener("click", () => {
  events.refresh();
  vigicrues.render();
});
// Auto-load once the user opens the section (no eager load at boot).
document.getElementById("events-section")?.addEventListener(
  "toggle",
  (e) => {
    if (e.target.open) {
      if (!document.getElementById("events-list").children.length) events.refresh();
      vigicrues.init();
    }
  },
  { once: false }
);

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
  closeParcelDetail: parcels.closeParcelDetail,
  flashLockHint: parcels.flashLockHint,
  showZoomTooLowMessage: parcels.showZoomTooLowMessage,
});

// Render the metrics grid's empty state at boot so "Grille normalisée" shows a clear "no analysis
// yet — lance l'analyse" prompt instead of looking blank/broken.
renderMetrics(analysisCombined);

// Proactive local-storage quota check at boot — warns once if the store is already near full
// from a previous session (caches accumulate across reloads). Deferred so the toast host and
// login state are ready. Subsequent checks ride on dbxOnChange.
setTimeout(() => checkStorageHealth(), 2000);
