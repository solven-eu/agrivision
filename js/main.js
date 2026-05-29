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
          alert("Valeur invalide (0–100 attendu).");
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

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (placingPhotoId || aimingPhotoId)) {
    placingPhotoId = null;
    aimingPhotoId = null;
    mapEl.classList.remove("map-placing");
    aStatus.textContent = "Annulé.";
  }
});

async function handlePhotoFiles(files) {
  if (files.length === 0) return;
  aStatus.textContent = `Préparation de ${files.length} photo(s)…`;
  for (const f of files) await addPhotoFromFile(f);
  renderPhotos();
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
function showTutorial() {
  const modal = document.getElementById("tutorial-modal");
  if (!modal) return;
  let page = 1;
  const pages = [
    document.getElementById("tuto-page-1"),
    document.getElementById("tuto-page-2"),
    document.getElementById("tuto-page-3"),
  ];
  const dots = document.getElementById("tuto-dots");
  const prev = document.getElementById("tuto-prev");
  const next = document.getElementById("tuto-next");
  const skip = document.getElementById("tuto-skip");
  function render() {
    pages.forEach((el, i) => el && (el.style.display = i === page - 1 ? "block" : "none"));
    if (dots) {
      dots.innerHTML = [1, 2, 3]
        .map(
          (n) =>
            `<span style="width:8px;height:8px;border-radius:50%;background:${n === page ? "var(--accent)" : "var(--border)"}"></span>`
        )
        .join("");
    }
    if (prev) prev.style.visibility = page > 1 ? "visible" : "hidden";
    if (next) next.textContent = page === 3 ? "Commencer ✓" : "Suivant →";
  }
  function close() {
    modal.style.display = "none";
    localStorage.setItem("agri_tutorial_seen", "1");
  }
  prev?.addEventListener("click", () => {
    if (page > 1) {
      page--;
      render();
    }
  });
  next?.addEventListener("click", () => {
    if (page < 3) {
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
if (!localStorage.getItem("agri_tutorial_seen")) {
  // Small delay so it doesn't fight with the page initial paint / geolocation prompts.
  setTimeout(showTutorial, 400);
}
window.showTutorial = showTutorial; // exposed so the hamburger can re-launch it

// Handle Stripe Checkout return URL: ?billing=success → toast + refetch the user's
// plan/quota so the new tier appears immediately in the share panel.
handleBillingReturn(() => share.fetchQuota());
document.getElementById("show-tutorial-btn")?.addEventListener("click", () => {
  document.getElementById("app-menu-panel").style.display = "none";
  showTutorial();
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
import { renderPlansCard, handleBillingReturn } from "./billing.js";
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
  flashLockHint: parcels.flashLockHint,
  showZoomTooLowMessage: parcels.showZoomTooLowMessage,
});
