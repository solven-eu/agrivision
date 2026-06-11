// AgriVision RE — persistence module (storage-AGNOSTIC core).
// Session/manifest/local-mirror/save-scheduling/restore + the storage panel. The actual cloud I/O
// is delegated to a pluggable storage DRIVER (one module per provider under ./storage/), selected
// at runtime via `activeDriver`. Adding a provider = a new driver module; this file is unchanged.
//
// Driver interface (see ./storage/dropbox.js, ./storage/gdrive.js):
//   { id, label, isEnabled(), isConnected(), accountLabel(), startAuth(), disconnect(),
//     uploadFile(path, body, mode), downloadFile(path) → Response, listSessions() → [{crop,id,path}],
//     deleteFolder(path), registerPointer() }
// All file ops are PATH-based (/crops/<crop>/cultures/<id>/culture.json, .../photos/<id>.<ext>);
// each driver emulates that scheme on its own backend.
//
// Externals are passed in via the `app` object, populated by main.js.

import { loadFromAgriVision } from "./share.js";
import { ensureSoilForSelected } from "./soil.js";
import { ensureAltitudeForSelected } from "./elevation.js";
import { safeSetItem } from "./storage-health.js";
import { toast } from "./toast.js";
import { createDropboxDriver } from "./storage/dropbox.js";
import { createGDriveDriver } from "./storage/gdrive.js";

/**
 * @param {object} app - dependency bundle:
 *   - Direct refs (mutated in place):
 *       selectedParcels (Map), photos (Array), conversation (Array), userProfile (Object)
 *       map (Leaflet), placePhotoMarker (fn), parcelArea (fn), cropMeta (fn), featureKey (fn)
 *       inputFingerprint (fn)
 *       renderMetrics, renderDiseases, renderChat, renderPhotos,
 *       renderParcelHighlight, renderParcelInfoPanel,
 *       updateLockHint, updateAnalyzeAvailability  (all fns)
 *   - Accessors (for reassigned scalars):
 *       getAnalysisCombined / setAnalysisCombined
 *       getCurrentAddress / setCurrentAddress
 *       getBioMode / setBioMode
 *       getLastAnalyzedFingerprint / setLastAnalyzedFingerprint
 */
export function createDbx(app) {
  const LS = {
    session: "agri_culture_id",
    crop: "agri_culture_crop",
    uploaded: "agri_uploaded_photos", // photoId → true (per culture)
    // Local working-session mirror, split in two so the small part can be rewritten cheaply on
    // every change while the large photo bytes are rewritten only when they actually change:
    //   localSession: { manifest, cropCode, sessionId }   — parcels + photo METADATA + analysis…
    //   localPhotos:  [{ id, mime, b64 }]                 — inline photo bytes (the bulk)
    // Together they let the whole session survive a reload WITHOUT any cloud, and seed the upload
    // when the user connects a provider later. See saveLocalManifest / restoreFromLocal.
    localSession: "agri_local_session",
    localPhotos: "agri_local_photos",
    activeProvider: "agri_storage_provider", // "dropbox" | "gdrive" — which cloud is active
  };

  // ===== Storage drivers (one per provider). The agnostic core below talks only to activeDriver.
  // onConnected fires after a successful (re)connect → mark active, re-render, schedule initial save.
  const dropbox = createDropboxDriver({ onConnected: () => onProviderConnected("dropbox") });
  const gdrive = createGDriveDriver({ onConnected: () => onProviderConnected("gdrive") });
  const drivers = [dropbox, gdrive];
  let activeDriver = null;
  function driverById(id) {
    return drivers.find((d) => d.id === id) || null;
  }
  function anyDriverEnabled() {
    return drivers.some((d) => d.isEnabled());
  }
  function anyDriverConnected() {
    return drivers.some((d) => d.isConnected());
  }
  // Active = the user's preferred provider if it's connected, else any connected one, else null.
  function pickActiveDriver() {
    const pref = localStorage.getItem(LS.activeProvider);
    const prefDrv = pref ? driverById(pref) : null;
    activeDriver = prefDrv && prefDrv.isConnected() ? prefDrv : drivers.find((d) => d.isConnected()) || null;
    return activeDriver;
  }
  function setActiveProvider(id) {
    const d = driverById(id);
    if (!d) return;
    activeDriver = d;
    localStorage.setItem(LS.activeProvider, id);
  }
  function onProviderConnected(id) {
    setActiveProvider(id);
    renderPanel();
    schedule(); // initial save
  }
  pickActiveDriver();

  // Signature of the photo bytes last written to LS.localPhotos — lets saveLocalManifest skip
  // re-serializing megabytes of base64 when only the manifest (parcels/analysis/chat) changed.
  let lastLocalPhotosSig = null;
  const state = {
    sessionId: localStorage.getItem(LS.session) || null,
    cropCode: localStorage.getItem(LS.crop) || null, // path prefix /crops/<cropCode>/cultures/<id>
    uploaded: JSON.parse(localStorage.getItem(LS.uploaded) || "{}"),
    lastAnalysis: null,
    lastConversation: [],
    lastUserProfile: null,
    // An auto-reload is imminent at startup whenever there's anything to restore — a connected
    // cloud OR a local mirror. Block saves until it finishes; otherwise the empty initial render
    // triggers a schedule() that fires saveLocalManifest with empty state and WIPES the mirror
    // before autoReload can restore it. (This is the no-cloud "lost on reload" bug.)
    suspendSave: anyDriverConnected() || !!localStorage.getItem(LS.localSession),
    saveStatus: "idle", // idle | dirty | saving | saved | loading | error
    baseHash: null, // content_hash of the remote version we loaded (for divergence detection)
  };
  const SAVE_BADGES = {
    idle: { txt: "—", color: "var(--muted)" },
    dirty: { txt: "● Modifié", color: "var(--warn)" },
    saving: { txt: "↑ Sauvegarde…", color: "var(--accent)" },
    saved: { txt: "✓ Sauvegardé", color: "var(--accent)" },
    loading: { txt: "↓ Chargement…", color: "var(--accent)" },
    error: { txt: "⚠ Erreur", color: "var(--bad)" },
  };
  function setSaveStatus(s) {
    state.saveStatus = s;
    const el = document.getElementById("dbx-status-badge");
    if (el) {
      const b = SAVE_BADGES[s] || SAVE_BADGES.idle;
      el.textContent = b.txt;
      el.style.color = b.color;
    }
    const saveBtn = document.getElementById("dbx-save");
    if (saveBtn) saveBtn.disabled = s === "saved" || s === "saving" || s === "loading";
  }

  // Dominant crop = largest area in current selection, else "UNK".
  function dominantCropFromSelection() {
    if (app.selectedParcels.size === 0) return "UNK";
    const totals = {};
    for (const [, p] of app.selectedParcels) {
      const code = p.props?.code_cultu || "UNK";
      totals[code] = (totals[code] || 0) + app.parcelArea(p.props);
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0];
  }
  function basePath() {
    const crop = state.cropCode || "UNK";
    return `/crops/${crop}/cultures/${state.sessionId}`;
  }

  function genSessionId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const rand = Math.random().toString(36).slice(2, 6);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_${rand}`;
  }
  function ensureSession() {
    if (!state.sessionId) {
      state.sessionId = genSessionId();
      state.uploaded = {};
      localStorage.setItem(LS.session, state.sessionId);
      localStorage.setItem(LS.uploaded, "{}");
    }
    // Lock in cropCode at first save (sticky path; "Nouvelle culture" resets it).
    if (!state.cropCode) {
      state.cropCode = dominantCropFromSelection();
      localStorage.setItem(LS.crop, state.cropCode);
    }
    return state.sessionId;
  }
  function resetSession() {
    state.sessionId = null;
    state.cropCode = null;
    state.uploaded = {};
    localStorage.removeItem(LS.session);
    localStorage.removeItem(LS.crop);
    localStorage.removeItem(LS.uploaded);
    // Don't let a new culture resurrect the old local mirror.
    localStorage.removeItem(LS.localSession);
    localStorage.removeItem(LS.localPhotos);
    lastLocalPhotosSig = null;
    state.baseHash = null; // fresh culture — no remote version to diverge from yet
  }
  function persistUploaded() {
    localStorage.setItem(LS.uploaded, JSON.stringify(state.uploaded));
  }

  // ===== Cloud I/O routes through the active storage driver (Dropbox / Google Drive). =====
  // Path-based ops; each driver emulates the /crops/<crop>/cultures/<id>/… scheme on its backend.
  function uploadFile(path, body, mode) {
    return activeDriver.uploadFile(path, body, mode);
  }
  function downloadFile(path) {
    if (!activeDriver) throw new Error("Aucun stockage connecté");
    return activeDriver.downloadFile(path);
  }
  function deleteFolder(path) {
    if (!activeDriver) throw new Error("Aucun stockage connecté");
    return activeDriver.deleteFolder(path);
  }
  async function listSessions() {
    return activeDriver ? activeDriver.listSessions() : [];
  }

  // ===== Public: save the current session =====
  let saveTimer = null;
  let saveInFlight = null;
  function bytesFromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ===== Divergence detection (content fingerprint, à la git) =====
  // A stable SHA-256 over the canonical manifest lets us tell whether two copies are the SAME
  // (no false conflict on idempotent re-saves) and detect when a remote changed under us. It's
  // the only cross-provider-comparable identity (Dropbox's content_hash ≠ Drive's md5). Volatile
  // fields (saved_at + the hash itself) are excluded; keys are sorted recursively so order can't
  // affect the result. `state.baseHash` = the version the in-memory state was loaded from.
  function canonicalize(v) {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
      return out;
    }
    return v;
  }
  async function contentHash(manifest) {
    const { saved_at, content_hash, ...rest } = manifest;
    const json = JSON.stringify(canonicalize(rest));
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Build the session manifest (photo bytes referenced by file, not inlined). Shared by the
  // cloud save (saveNow) and the local mirror (saveLocalManifest).
  function buildManifest() {
    return {
      schema: 2,
      culture_id: state.sessionId,
      crop_code: state.cropCode,
      bio_mode: app.getBioMode(),
      saved_at: new Date().toISOString(),
      address: app.getCurrentAddress(),
      parcels: [...app.selectedParcels.values()].map((p) => ({
        props: p.props,
        geometry: p.geometry,
        latlng: p.latlng,
        // Persisted enrichments — so a reload (and other devices) skip re-fetching from the
        // soil / IGN-altimetry / Copernicus APIs. NDVI especially costs CDSE quota.
        soil: p.soil ?? null,
        altitude: p.altitude ?? null,
        ndvi: p.ndvi ?? null,
      })),
      photos: app.photos.map((p) => ({
        id: p.id,
        name: p.name,
        mime: p.mime,
        width: p.width,
        height: p.height,
        lat: p.lat,
        lon: p.lon,
        locSource: p.locSource,
        direction: p.direction,
        takenAt: p.takenAt ? p.takenAt.toISOString() : null,
        takenAtSource: p.takenAtSource || null,
        representative: p.representative ?? null,
        tags: p.tags || null,
        file: `photos/${p.id}.${(p.mime || "image/jpeg").split("/")[1] || "jpg"}`,
      })),
      analysis: state.lastAnalysis,
      conversation: state.lastConversation || [],
      conversation_dialect: app.getConversationDialect?.() || null,
      user_profile: state.lastUserProfile || null,
    };
  }

  // ===== Local working-session mirror (localStorage) =====
  // Persist the FULL session — manifest + inline photo bytes (base64) — to localStorage, so it
  // survives a reload with no Dropbox at all. Photos are inlined (unlike the Dropbox manifest,
  // where bytes live in separate files), which is what makes a reload self-sufficient. When the
  // store can't hold the photos, safeSetItem returns false and raises the storage-full warning;
  // we then fall back to caching the manifest WITHOUT photos so at least parcels/analysis survive.
  function saveLocalManifest() {
    // A load/restore is in progress — the in-memory state is being rehydrated and may be
    // transiently empty. Never touch the mirror now (a debounce timer armed before the restore
    // could otherwise fire here and wipe it). saves resume when suspendSave releases.
    if (state.suspendSave) {
      console.log("[local] saveLocalManifest skipped (load in progress)");
      return;
    }
    // Nothing meaningful to cache → drop any stale mirror so a reload starts clean.
    if (app.selectedParcels.size === 0 && app.photos.length === 0 && !state.lastAnalysis) {
      localStorage.removeItem(LS.localSession);
      localStorage.removeItem(LS.localPhotos);
      lastLocalPhotosSig = null;
      console.log("[local] saveLocalManifest: nothing to cache → cleared mirror");
      return;
    }
    ensureSession(); // make sure we have a sessionId/cropCode to restore under
    // Small part — manifest (parcels + photo metadata + analysis + chat). Cheap to rewrite often.
    const manifest = buildManifest();
    const okManifest = safeSetItem(
      LS.localSession,
      JSON.stringify({ manifest, cropCode: state.cropCode, sessionId: state.sessionId })
    );
    // Large part — inline photo bytes. Only rewrite when the photo set/bytes changed (a parcel
    // click or chat turn shouldn't re-serialize megabytes of base64).
    const sig = app.photos.map((p) => `${p.id}:${p.b64 ? p.b64.length : 0}`).join(",");
    if (sig === lastLocalPhotosSig) {
      console.log(
        `[local] saved manifest ✓ (${manifest.parcels.length} parc, ${manifest.photos.length} ph) — photo bytes unchanged, skipped`
      );
      return;
    }
    const photos = app.photos.filter((p) => p.b64).map((p) => ({ id: p.id, mime: p.mime, b64: p.b64 }));
    // Guard: if photos exist but none have bytes yet (e.g. mid-restore, still loading), don't
    // overwrite the cache with an empty list — that would lose the very photos we're restoring.
    if (app.photos.length > 0 && photos.length === 0) {
      console.log("[local] photos still loading (no bytes yet) — deferring photo write");
      return;
    }
    const okPhotos = safeSetItem(LS.localPhotos, JSON.stringify(photos));
    if (okPhotos) {
      lastLocalPhotosSig = sig;
      console.log(
        `[local] saved ✓ manifest(${manifest.parcels.length} parc) + ${photos.length} photo bytes [manifestOk=${okManifest}]`
      );
    } else {
      // Photos didn't fit. Drop the photo cache so the manifest (parcels/analysis) still survives;
      // the storage-full toast already fired (via safeSetItem) prompting compression / Dropbox.
      localStorage.removeItem(LS.localPhotos);
      lastLocalPhotosSig = "";
      console.warn("[local] photos did NOT fit localStorage — kept manifest only (compress/connect Dropbox)");
    }
  }

  function loadLocalManifest() {
    try {
      const s = JSON.parse(localStorage.getItem(LS.localSession) || "null");
      if (!s?.manifest) return null;
      const photos = JSON.parse(localStorage.getItem(LS.localPhotos) || "[]");
      return { ...s, photos: Array.isArray(photos) ? photos : [] };
    } catch {
      return null;
    }
  }

  // Restore the full session from the localStorage mirror. Mirrors restoreFromAgriVision but reads
  // photo bytes inline from the cache. Returns true if a cached session was applied.
  async function restoreFromLocal() {
    const data = loadLocalManifest();
    if (!data?.manifest) {
      console.log("[local] restoreFromLocal: no cached session found");
      return false;
    }
    console.log(
      `[local] restoreFromLocal: found session ${data.sessionId} — ${data.manifest.parcels?.length || 0} parc, ${data.photos?.length || 0} photo bytes`
    );
    const byId = new Map((data.photos || []).map((p) => [p.id, p]));
    const getPhotoData = async (photo) => {
      const p = byId.get(photo.id);
      if (!p) throw new Error("photo absente du cache local");
      return { b64: p.b64, dataUrl: `data:${p.mime || "image/jpeg"};base64,${p.b64}` };
    };
    await loadSession(data.cropCode || data.manifest.crop_code || "UNK", data.sessionId || data.manifest.culture_id, {
      manifest: data.manifest,
      getPhotoData,
      local: true, // these photos are NOT in Dropbox — don't mark them uploaded
    });
    return true;
  }

  async function saveNow(force = false) {
    if (!activeDriver || !activeDriver.isConnected()) return;
    if (state.suspendSave) return; // load in progress — don't save half-rehydrated state
    setSaveStatus("saving");
    ensureSession();
    const base = basePath();

    // Fingerprint the manifest up front (cheap, no network) so we can (a) skip idempotent saves
    // and (b) detect divergence BEFORE writing any photo bytes.
    const manifest = buildManifest();
    manifest.content_hash = await contentHash(manifest);

    // Nothing changed since the last successful sync → no write needed.
    if (state.baseHash && manifest.content_hash === state.baseHash) {
      setSaveStatus("saved");
      return;
    }

    // Divergence check (optimistic concurrency): if the remote moved to a version that is neither
    // what we loaded (baseHash) nor what we're about to write, another device/provider changed it
    // → surface a conflict instead of clobbering it. Skipped on a forced "keep mine".
    if (!force) {
      let remoteHash = null;
      try {
        const r = await downloadFile(`${base}/culture.json`);
        const remote = await r.json();
        remoteHash = remote.content_hash || (await contentHash(remote));
      } catch {
        remoteHash = null; // no remote yet (new culture / first save) → nothing to diverge from
      }
      if (remoteHash && remoteHash !== state.baseHash && remoteHash !== manifest.content_hash) {
        setSaveStatus("error");
        renderConflict();
        return;
      }
    }

    // Upload any new app.photos.
    for (const p of app.photos) {
      if (state.uploaded[p.id]) continue;
      const ext = (p.mime || "image/jpeg").split("/")[1] || "jpg";
      try {
        await uploadFile(`${base}/photos/${p.id}.${ext}`, bytesFromB64(p.b64));
        state.uploaded[p.id] = { name: p.name, mime: p.mime };
        persistUploaded();
      } catch (e) {
        setSaveStatus("error");
        renderPanel(`Erreur photo : ${e.message}`);
        return;
      }
    }
    // Drop entries for app.photos no longer present.
    const currentIds = new Set(app.photos.map((p) => p.id));
    for (const id of Object.keys(state.uploaded)) {
      if (!currentIds.has(id)) delete state.uploaded[id];
    }
    persistUploaded();

    try {
      await uploadFile(`${base}/culture.json`, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
      state.baseHash = manifest.content_hash; // in sync with the remote we just wrote
      setSaveStatus("saved");
      renderPanel(
        `✓ ${new Date().toLocaleTimeString("fr-FR")} · ${manifest.parcels.length} parc. · ${manifest.photos.length} ph.`
      );
      // Opt-in "Share with AgriVision" — fire-and-forget mirror of the manifest into KV.
      // Runs after the cloud save is confirmed so KV never gets ahead of the user's own copy.
      app.onShareSync?.(manifest);
    } catch (e) {
      setSaveStatus("error");
      renderPanel(`Erreur : ${e.message}`);
    }
  }

  // Save-conflict resolver: the remote culture.json changed elsewhere since we loaded it. Offer
  // the two safe choices — overwrite with our version, or discard ours and load the remote.
  function renderConflict() {
    toast("Conflit de sauvegarde : la copie distante a changé ailleurs.", {
      kind: "warn",
      id: "save-conflict",
      durationMs: 15000,
    });
    panel.innerHTML = `
      <div style="color:var(--bad);font-size:11px;line-height:1.5">
        ⚠ La version distante de cette culture a été modifiée ailleurs (autre appareil ou stockage).
        « Garder ma version » écrasera la distante ; « Charger la distante » abandonnera tes
        changements non sauvegardés.
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button class="secondary" id="conflict-mine" style="font-size:11px;padding:4px 8px">Garder ma version</button>
        <button class="secondary" id="conflict-theirs" style="font-size:11px;padding:4px 8px">Charger la distante</button>
      </div>`;
    document.getElementById("conflict-mine").onclick = () => saveNow(true);
    document.getElementById("conflict-theirs").onclick = async () => {
      try {
        await loadSession(state.cropCode, state.sessionId);
      } catch (e) {
        renderPanel(`Erreur : ${e.message}`);
      }
    };
  }

  function schedule() {
    // Save while loading would persist half-rehydrated state; and a fully empty session has
    // nothing to mirror. Note: NO connection check here — the local mirror must run even without a
    // cloud (that's what makes a no-login session survive a reload).
    if (!anyDriverEnabled() || state.suspendSave) {
      console.log("[save] schedule() ignored (suspended/disabled):", { suspended: state.suspendSave });
      return;
    }
    // The save badge tracks the CLOUD sync; with no provider connected there's no remote save to
    // flag as pending, so don't strand the badge on "dirty" (the local mirror writes silently).
    if (activeDriver?.isConnected() && state.saveStatus !== "saving" && state.saveStatus !== "loading")
      setSaveStatus("dirty");
    const reset = saveTimer != null;
    clearTimeout(saveTimer);
    console.log(`[save] debounce ${reset ? "RESET" : "armed"} (1.5s) → save will fire if idle`);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      console.log("[save] debounce ELAPSED → saving now");
      // 1) Always mirror the full session (incl. photo bytes) to localStorage.
      try {
        saveLocalManifest();
      } catch (e) {
        console.warn("[local] save failed:", e?.message);
      }
      // 2) Push to the connected cloud too, when one is active.
      if (activeDriver?.isConnected()) {
        console.log("[cloud] saveNow() start (async upload)…");
        saveInFlight = saveNow()
          .then(() => console.log("[cloud] saveNow() done ✓"))
          .catch((e) => console.error("[cloud] saveNow() failed:", e))
          .finally(() => {
            saveInFlight = null;
          });
      }
    }, 1500);
  }

  async function deleteSession(cropCode, sid) {
    await deleteFolder(`/crops/${cropCode}/cultures/${sid}`);
    // If we just deleted the active culture, clear local pointers.
    if (state.cropCode === cropCode && state.sessionId === sid) {
      state.sessionId = null;
      state.cropCode = null;
      state.uploaded = {};
      localStorage.removeItem(LS.session);
      localStorage.removeItem(LS.crop);
      localStorage.setItem(LS.uploaded, "{}");
      // Clear in-memory state too.
      app.photos.forEach((p) => {
        if (p.marker) app.map.removeLayer(p.marker);
        if (p.fovLayer) app.map.removeLayer(p.fovLayer);
      });
      app.photos.length = 0;
      app.selectedParcels.clear();
      app.renderParcelHighlight();
      app.renderParcelInfoPanel();
      app.renderPhotos();
      app.updateLockHint();
      app.updateAnalyzeAvailability();
    }
  }

  function showLoading(msg, fraction) {
    const ov = document.getElementById("loading-overlay");
    document.getElementById("loading-msg").textContent = msg || "Chargement…";
    const bar = document.getElementById("loading-bar");
    if (fraction != null) {
      bar.classList.add("show");
      document.getElementById("loading-bar-fill").style.width =
        Math.round(Math.max(0, Math.min(1, fraction)) * 100) + "%";
    } else {
      bar.classList.remove("show");
    }
    ov.classList.add("show");
  }
  function hideLoading() {
    document.getElementById("loading-overlay").classList.remove("show");
  }

  // Rehydrate a culture into the running app. Source-agnostic: by default it downloads the
  // manifest + photos from Dropbox, but `opts.manifest` + `opts.getPhotoData` let the
  // AgriVision-backup restore feed an already-loaded manifest and inline photo bytes — so
  // the same rehydration runs whether the data comes from the user's cloud or our mirror.
  async function loadSession(cropCode, sid, opts = {}) {
    console.log(
      `[restore] loadSession start: ${cropCode}/${sid} (source=${opts.local ? "local" : opts.manifest ? "inline" : "dropbox"}) — suspendSave ON`
    );
    state.suspendSave = true;
    setSaveStatus("loading");
    showLoading(opts.manifest ? "Restauration…" : `Chargement du manifeste…`, 0);
    try {
      let manifest = opts.manifest;
      if (!manifest) {
        const r = await downloadFile(`/crops/${cropCode}/cultures/${sid}/culture.json`);
        manifest = await r.json();
      }
      // Record the version we're loading from, so the next save can detect if the remote
      // diverged under us. Trust the stored hash; recompute for older manifests without one.
      state.baseHash = manifest.content_hash || (await contentHash(manifest));
      // Resolve each photo's bytes. Default = Dropbox download; restore passes its own getter.
      const getPhotoData =
        opts.getPhotoData ||
        (async (photo) => {
          const pr = await downloadFile(
            `/crops/${cropCode}/cultures/${sid}${photo._file.startsWith("/") ? photo._file : "/" + photo._file}`
          );
          const blob = await pr.blob();
          const dataUrl = await new Promise((res, rej) => {
            const rd = new FileReader();
            rd.onload = () => res(rd.result);
            rd.onerror = rej;
            rd.readAsDataURL(blob);
          });
          return { b64: dataUrl.split(",")[1], dataUrl };
        });

      // Clear current state
      app.photos.forEach((p) => {
        if (p.marker) app.map.removeLayer(p.marker);
        if (p.fovLayer) app.map.removeLayer(p.fovLayer);
      });
      app.photos.length = 0;
      app.selectedParcels.clear();
      app.renderParcelHighlight();

      // BIO mode
      if (manifest.bio_mode) {
        app.setBioMode(manifest.bio_mode);
        localStorage.setItem("agri_bio_mode", app.getBioMode());
      }
      // Address
      if (manifest.address) {
        app.setCurrentAddress(manifest.address);
        document.getElementById("addr").value = manifest.address.label || "";
        document.getElementById("status").textContent = manifest.address.label || "";
        if (manifest.address.lat) app.map.setView([manifest.address.lat, manifest.address.lon], 15);
      }

      // Parcels
      for (const p of manifest.parcels || []) {
        const id = app.featureKey({ properties: p.props });
        app.selectedParcels.set(id, {
          props: p.props,
          geometry: p.geometry,
          latlng: p.latlng,
          // Restore persisted enrichments; the `*Fetched` flags let ensureSoil/ensureAltitude
          // skip them (only missing ones re-fetch). NDVI has no auto-fetch, so this is the
          // only thing that restores it without a CDSE call.
          soil: p.soil ?? null,
          soilFetched: p.soil != null,
          altitude: p.altitude ?? null,
          altitudeFetched: p.altitude != null,
          ndvi: p.ndvi ?? null,
        });
      }
      // Auto-lock parcels after restore — UX safety only (prevents accidental
      // add/remove on tapping the map). No business / AI / persistence impact.
      // The user can unlock explicitly from the parcel info panel.
      if (app.selectedParcels.size > 0 && app.setParcelsLocked) {
        app.setParcelsLocked(true);
      }
      app.renderParcelHighlight();
      app.renderParcelInfoPanel();
      app.updateLockHint();
      // After restore, kick off soil + altitude lookups for each parcel so the AI context
      // block + the soil card pick them up. Fire-and-forget — the panel re-renders
      // progressively.
      ensureSoilForSelected(app.selectedParcels, () => app.renderParcelInfoPanel());
      ensureAltitudeForSelected(app.selectedParcels, () => app.renderParcelInfoPanel());

      // Photos: rehydrate metadata IMMEDIATELY (no network), download blobs IN BACKGROUND.
      // This way the app becomes interactive as soon as the manifest is back; photo
      // thumbnails fill in progressively (in order) while the user can already use the
      // map, edit conversation, etc.
      const total = (manifest.photos || []).length;
      // Step 1 (sync): push placeholder photo objects so renderPhotos has something
      // to draw. `dataUrl` is null until the blob arrives — photos.js shows a small
      // "..." placeholder for photos without a dataUrl yet.
      for (const meta of manifest.photos || []) {
        app.photos.push({
          id: meta.id,
          name: meta.name,
          mime: meta.mime || "image/jpeg",
          b64: null,
          dataUrl: null,
          loading: true,
          width: meta.width,
          height: meta.height,
          lat: meta.lat,
          lon: meta.lon,
          locSource: meta.locSource,
          direction: meta.direction,
          takenAt: meta.takenAt ? new Date(meta.takenAt) : null,
          takenAtSource: meta.takenAtSource || (meta.takenAt ? "exif" : null),
          representative: meta.representative ?? null,
          tags: meta.tags || null,
          exifFound: true,
          recompressed: false,
          marker: null,
          fovLayer: null,
          _file: meta.file,
        });
      }
      // Step 2 (async, fire-and-forget): download each blob in the background and
      // patch the corresponding photo object. Re-render after each so thumbnails
      // appear progressively. Failures don't block the rest.
      (async () => {
        let done = 0;
        for (const photo of app.photos) {
          if (!photo._file) continue;
          try {
            const data = await getPhotoData(photo);
            photo.b64 = data.b64;
            photo.dataUrl = data.dataUrl;
            photo.loading = false;
            // Local restore: these bytes came from localStorage, NOT Dropbox — leave them
            // un-"uploaded" so that connecting Dropbox later actually pushes them up.
            if (!opts.local) state.uploaded[photo.id] = { name: photo.name, mime: photo.mime };
            if (photo.lat != null) app.placePhotoMarker(photo);
          } catch (e) {
            console.warn("photo reload failed", photo._file, e);
            photo.loading = false;
            photo.error = e.message;
          }
          done++;
          app.renderPhotos();
        }
      })().catch((e) => console.warn("photo batch error", e));
      persistUploaded();
      app.renderPhotos();

      // Analysis
      if (manifest.analysis) {
        app.setAnalysisCombined(manifest.analysis);
        app.renderParcelHighlight(); // emojis follow the identification
        app.renderMetrics(app.getAnalysisCombined());
        if (app.getAnalysisCombined().diseases) {
          app.renderDiseases(app.getAnalysisCombined().diseases, {
            photos: app.photos,
            t_per_ha: app.getAnalysisCombined().yield?.estimated_t_per_ha,
            price_eur_per_kg: app.getAnalysisCombined().market?.indicative_price_eur_per_kg,
            total_area_ha: app.getAnalysisCombined().parcels_summary?.total_area_ha,
          });
        }
        state.lastAnalysis = app.getAnalysisCombined();
        app.setLastAnalyzedFingerprint(app.inputFingerprint());
      }
      // Restore conversation + user profile — mutate in place so main.js sees the change.
      if (Array.isArray(manifest.conversation)) {
        app.conversation.length = 0;
        app.conversation.push(...manifest.conversation);
        state.lastConversation = manifest.conversation;
      }
      // Restore conversation-level dialect (if absent, falls back to the dialect of the
      // last turn that snapshotted one; older manifests stay at null and the next user
      // turn will resnapshot from the preference select).
      if (manifest.conversation_dialect) {
        app.setConversationDialect?.(manifest.conversation_dialect);
      } else if (Array.isArray(manifest.conversation)) {
        const lastDialect = [...manifest.conversation].reverse().find((m) => m.dialect)?.dialect;
        if (lastDialect) app.setConversationDialect?.(lastDialect);
      }
      if (manifest.user_profile) {
        for (const k of Object.keys(app.userProfile)) delete app.userProfile[k];
        Object.assign(app.userProfile, manifest.user_profile);
        state.lastUserProfile = manifest.user_profile;
      }
      app.renderChat();

      // Adopt the loaded culture as current
      state.sessionId = sid;
      state.cropCode = cropCode;
      localStorage.setItem(LS.session, sid);
      localStorage.setItem(LS.crop, cropCode);
      app.analyzeBtn.disabled = app.photos.length === 0;
      app.updateAnalyzeAvailability();
      // Center the map on what we just loaded.
      if (app.selectedParcels.size > 0) app.fitToSelectedParcels();
      else if (app.getCurrentAddress()?.lat)
        app.map.setView([app.getCurrentAddress().lat, app.getCurrentAddress().lon], 15);
      // Now that the view is correct, install the basemap (was deferred at boot).
      window.__initBasemap?.();
      const cm = app.cropMeta(cropCode);
      renderPanel(`Culture ${cm.emoji || ""} ${cm.fr || cropCode} — ${sid} rechargée.`);
      setSaveStatus("saved");
    } catch (e) {
      setSaveStatus("error");
      throw e;
    } finally {
      console.log(
        `[restore] loadSession done: ${app.selectedParcels.size} parc, ${app.photos.length} ph in memory — suspendSave releases in 3s`
      );
      // Keep suspendSave true long enough for the MutationObservers triggered by
      // app.renderPhotos / app.renderParcelInfoPanel to fire and be debounced. Otherwise
      // load → render → observer → schedule() → spurious save of unchanged data.
      setTimeout(() => {
        state.suspendSave = false;
        console.log("[restore] suspendSave released — saves re-enabled");
      }, 3000);
      hideLoading();
    }
  }

  // Restore from the AgriVision backup (the opt-in KV mirror), keyed by the signed-in
  // identity — used on a fresh device, or when the user can't / won't reconnect their own
  // cloud. Photos arrive inline (base64) in the payload, so no storage provider is needed.
  // Returns true if a backup was found and applied.
  async function restoreFromAgriVision(cultureId) {
    const data = await loadFromAgriVision(cultureId);
    if (!data?.manifest) {
      renderPanel("Aucune sauvegarde AgriVision trouvée.");
      return false;
    }
    const byId = new Map((data.photos || []).map((p) => [p.id, p]));
    const getPhotoData = async (photo) => {
      const p = byId.get(photo.id);
      if (!p) throw new Error("photo absente de la sauvegarde");
      return { b64: p.b64, dataUrl: `data:${p.mime || "image/jpeg"};base64,${p.b64}` };
    };
    const cropCode = data.crop_code || data.manifest.crop_code || "UNK";
    const sid = data.culture_id || data.manifest.culture_id;
    await loadSession(cropCode, sid, { manifest: data.manifest, getPhotoData });
    return true;
  }

  // ===== Auto-reload latest culture on startup =====
  // Two strategies: (1) if localStorage already remembers sessionId + cropCode,
  // load that directly. (2) otherwise, list cultures and load the most recent one.
  async function autoReloadLatest() {
    console.log(
      "[cloud] autoReload: enabled=",
      anyDriverEnabled(),
      "provider=",
      activeDriver?.id || null,
      "connected=",
      !!activeDriver?.isConnected(),
      "sessionId=",
      state.sessionId,
      "cropCode=",
      state.cropCode
    );
    if (!anyDriverEnabled()) {
      state.suspendSave = false;
      app.setPendingRestore(false);
      window.__initBasemap?.();
      window.__hideLoading?.();
      return;
    }
    if (!activeDriver || !activeDriver.isConnected()) {
      // No cloud connected — restore the full session from the local mirror so a no-login session
      // survives reloads. loadSession (inside restoreFromLocal) sets the view, basemap and the
      // suspendSave timer itself; we only handle the "nothing cached" path.
      let restored = false;
      try {
        restored = await restoreFromLocal();
      } catch (e) {
        console.warn("[local] restore failed:", e?.message);
      }
      app.setPendingRestore(false);
      if (restored) {
        window.__hideLoading?.();
      } else {
        state.suspendSave = false;
        window.__initBasemap?.();
        window.__setLoadingMsg?.("Configurez un crop");
        setTimeout(() => window.__hideLoading?.(), 1200);
        renderPanel("Non connecté — session conservée en local ; connectez un stockage cloud pour la sauvegarder.");
      }
      setTimeout(app.refreshChips, 300); // fallback chip refresh for the default view
      return;
    }
    window.__setLoadingMsg?.("Chargement de votre crop…");
    try {
      if (state.sessionId && state.cropCode) {
        console.log("[dbx] direct reload", state.cropCode, state.sessionId);
        await loadSession(state.cropCode, state.sessionId);
        return;
      }
      showLoading("Recherche de la dernière culture…", 0);
      const list = await listSessions();
      console.log("[dbx] listSessions →", list.length, "cultures");
      if (list.length > 0) {
        const latest = list[0];
        await loadSession(latest.crop, latest.id);
      } else {
        // Dropbox is empty — fall back to the local mirror (may hold work made before connecting).
        // Once restored, nudge a save after the suspend window so it propagates up to Dropbox.
        let restored = false;
        try {
          restored = await restoreFromLocal();
        } catch (e) {
          console.warn("[local] restore failed:", e?.message);
        }
        if (restored) {
          setTimeout(() => schedule(), 3500); // suspendSave clears at ~3s; then push to Dropbox
        } else {
          hideLoading();
          state.suspendSave = false;
          window.__setLoadingMsg?.("Configurez un crop");
          setTimeout(() => window.__hideLoading?.(), 1200);
          renderPanel("Aucun crop sauvegardé — créez-en un.");
          setTimeout(app.refreshChips, 300);
        }
      }
    } catch (e) {
      console.warn("[dbx] auto-reload failed:", e);
      hideLoading();
      state.suspendSave = false;
      renderPanel(`Auto-reload échoué : ${e.message}`);
      setTimeout(app.refreshChips, 300);
    } finally {
      // Always release the gate so subsequent user actions (move/click) behave normally.
      app.setPendingRestore(false);
      window.__initBasemap?.();
      // Ensure the RPG parcel layer is on the map. Its initial render is deferred at boot when a
      // Dropbox reload is pending (see chips.js), so the restored-view path (loadSession → return)
      // must add it here — otherwise the map shows no agricultural parcels after a logged-in
      // reload. refreshChips is idempotent (adds the layer only if absent).
      setTimeout(app.refreshChips, 300);
    }
  }
  // Fire after the rest of the script has set up event listeners + the app.map is ready.
  // Using window.load ensures all init code has run; setTimeout fires if load already happened.
  if (document.readyState === "complete") setTimeout(autoReloadLatest, 200);
  else window.addEventListener("load", () => setTimeout(autoReloadLatest, 200));

  // Flush the local mirror SYNCHRONOUSLY when the page is hidden/closed/reloaded. The debounced
  // save can be reset repeatedly by the soil/altitude re-renders that fire after a parcel is
  // selected, so a quick reload could otherwise lose the just-made change. localStorage writes are
  // synchronous, so this is a reliable last-chance save. pagehide is more reliable than
  // beforeunload (esp. on mobile / bfcache).
  window.addEventListener("pagehide", () => {
    if (state.suspendSave) {
      console.log("[dbx] pagehide: save suspended (load in progress) — skipping flush");
      return;
    }
    try {
      console.log("[dbx] pagehide → flushing local mirror");
      saveLocalManifest();
    } catch (e) {
      console.warn("[dbx] pagehide flush failed:", e?.message);
    }
  });

  function setAnalysis(payload) {
    // Accept either flat metrics or { analysis, app.conversation, user_profile } envelope.
    if (
      payload &&
      typeof payload === "object" &&
      ("app.conversation" in payload || "user_profile" in payload)
    ) {
      state.lastAnalysis = payload.analysis || null;
      state.lastConversation = payload.conversation || [];
      state.lastUserProfile = payload.user_profile || null;
    } else {
      state.lastAnalysis = payload;
    }
    schedule();
  }

  // ===== Panel UI =====
  const panel = document.getElementById("dbx-panel");
  function renderPanel(extra) {
    if (!anyDriverEnabled()) {
      panel.innerHTML = `Désactivé : configure un fournisseur de stockage (<code>DROPBOX_APP_KEY</code> ou <code>GDRIVE_ENABLED</code>) dans <code>config.js</code>.`;
      return;
    }
    // Keep activeDriver in sync with reality (a driver may have just connected/disconnected).
    if (!activeDriver || !activeDriver.isConnected()) pickActiveDriver();

    if (!activeDriver || !activeDriver.isConnected()) {
      // Disconnected: offer every enabled provider. Dropbox keeps its manual code-paste fallback.
      const dbxRow = dropbox.isEnabled()
        ? `<button class="secondary" id="dbx-connect" style="font-size:11px;padding:4px 8px">☁ Connecter Dropbox</button>
           <div id="dbx-code-row" style="display:none;margin-top:6px">
             <input id="dbx-code" type="text" placeholder="Coller le code…" autocomplete="off" data-lpignore="true" data-form-type="other" style="font-size:11px;padding:4px 6px" />
             <button class="secondary" id="dbx-submit" style="font-size:11px;padding:4px 8px;margin-top:4px">Valider</button>
           </div>`
        : "";
      const gdrRow = gdrive.isEnabled()
        ? `<button class="secondary" id="gdrive-connect" style="font-size:11px;padding:4px 8px">📁 Connecter Google Drive</button>`
        : "";
      panel.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start">${dbxRow}${gdrRow}</div>
        <div id="dbx-msg" class="small" style="margin-top:6px"></div>
      `;
      const msgEl = () => document.getElementById("dbx-msg");
      document.getElementById("dbx-connect")?.addEventListener("click", async () => {
        try {
          msgEl().textContent = "Ouverture de Dropbox…";
          const res = await dropbox.startAuth();
          if (res?.manual) {
            // file:// / localhost without a registered redirect → reveal the paste box.
            document.getElementById("dbx-code-row").style.display = "block";
            msgEl().textContent = "Autoriser dans l'onglet Dropbox puis coller le code ici.";
          } else if (!res?.done) {
            msgEl().textContent = res?.redirected ? "Redirection vers Dropbox…" : "";
          }
          // res.done → onConnected already re-rendered the panel.
        } catch (e) {
          msgEl().textContent = "Erreur : " + e.message;
        }
      });
      document.getElementById("dbx-submit")?.addEventListener("click", async () => {
        const code = document.getElementById("dbx-code").value.trim();
        if (!code) return;
        try {
          await dropbox.exchangeCode(code);
          onProviderConnected("dropbox");
        } catch (e) {
          msgEl().textContent = "Erreur : " + e.message;
        }
      });
      document.getElementById("gdrive-connect")?.addEventListener("click", async () => {
        try {
          msgEl().textContent = "Connexion à Google Drive…";
          const res = await gdrive.startAuth();
          if (!res?.done) msgEl().textContent = "Connexion Google Drive annulée.";
          // res.done → onConnected already re-rendered.
        } catch (e) {
          msgEl().textContent = "Erreur : " + e.message;
        }
      });
      return;
    }
    const cm = state.cropCode ? app.cropMeta(state.cropCode) : null;
    const cropLabel = state.sessionId
      ? `${cm ? cm.emoji + " " + cm.fr + " · " : ""}<code>${state.sessionId}</code>`
      : "(aucun crop actif)";
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <div style="flex:1">✓ ${activeDriver.label} · ${cropLabel}</div>
        <div id="dbx-status-badge" style="font-size:11px;font-weight:700;white-space:nowrap"></div>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button class="secondary" id="dbx-new"  style="font-size:11px;padding:4px 8px">Nouvelle</button>
        <button class="secondary" id="dbx-save" style="font-size:11px;padding:4px 8px">Sauver</button>
        <button class="secondary" id="dbx-load" style="font-size:11px;padding:4px 8px">Reprendre…</button>
        <button class="secondary" id="dbx-disc" style="font-size:11px;padding:4px 8px">Déconnecter</button>
      </div>
      <div id="dbx-sessions" style="margin-top:6px"></div>
      <div class="small" style="margin-top:6px">${extra || ""}</div>
    `;
    // Re-apply current status to refresh the badge + button disabled state.
    setSaveStatus(state.saveStatus);
    document.getElementById("dbx-new").onclick = () => {
      resetSession();
      renderPanel("Nouveau crop prêt.");
    };
    document.getElementById("dbx-save").onclick = () => saveNow();
    document.getElementById("dbx-disc").onclick = () => {
      activeDriver.disconnect();
      localStorage.removeItem(LS.activeProvider);
      pickActiveDriver(); // fall through to another connected provider, if any
      renderPanel();
    };
    document.getElementById("dbx-load").onclick = () => renderCropsList();
  }

  // List of crops with switch action. Delete is intentionally NOT exposed in the UI
  // for now — too easy to misclick. Restore with ?debug if needed.
  const showDelete = new URLSearchParams(location.search).has("debug");

  async function renderCropsList() {
    const target = document.getElementById("dbx-sessions");
    target.innerHTML = `<div class="small">Recherche…</div>`;
    try {
      const list = await listSessions();
      if (list.length === 0) {
        target.innerHTML = `<div class="small">Aucun crop sauvegardé.</div>`;
        return;
      }
      const byCrop = {};
      for (const c of list) (byCrop[c.crop] ||= []).push(c);
      const cropOrder = Object.entries(byCrop)
        .map(([cc, items]) => [cc, items.sort((a, b) => b.id.localeCompare(a.id))[0].id])
        .sort((a, b) => b[1].localeCompare(a[1]))
        .map(([cc]) => cc);
      let html = "";
      for (const cc of cropOrder) {
        const cm = app.cropMeta(cc);
        html += `<div style="margin-top:6px;font-weight:600;font-size:11px;color:var(--muted)">${cm.emoji || "🌱"} ${cm.fr || cc}</div>`;
        for (const c of byCrop[cc]) {
          const isCurrent = state.cropCode === cc && state.sessionId === c.id;
          html += `
            <div style="display:flex;gap:4px;margin-top:2px;align-items:center;padding:3px 6px;border-radius:4px;background:${isCurrent ? "var(--accent)" : "var(--panel2)"};color:${isCurrent ? "#0a0e13" : "var(--text)"}">
              <button class="dbx-sess-switch" data-crop="${cc}" data-id="${c.id}"
                style="flex:1;font-size:10px;padding:2px 4px;text-align:left;background:transparent;color:inherit;border:none;cursor:pointer">
                ${isCurrent ? "● " : ""}<code style="font-size:10px;color:inherit">${c.id}</code>
              </button>
              ${
                showDelete
                  ? `<button class="dbx-sess-del" data-crop="${cc}" data-id="${c.id}" title="Supprimer ce crop"
                style="font-size:11px;padding:2px 6px;background:var(--bad);color:#fff;border:none;border-radius:3px;cursor:pointer">×</button>`
                  : ""
              }
            </div>`;
        }
      }
      target.innerHTML = html;

      target.querySelectorAll(".dbx-sess-switch").forEach(
        (b) =>
          (b.onclick = async () => {
            const cc = b.dataset.crop,
              sid = b.dataset.id;
            target.innerHTML = `<div class="small">Chargement…</div>`;
            try {
              await loadSession(cc, sid);
              renderCropsList();
            } catch (e) {
              target.innerHTML = `<div class="small">Erreur : ${e.message}</div>`;
            }
          })
      );
      target.querySelectorAll(".dbx-sess-del").forEach(
        (b) =>
          (b.onclick = async () => {
            const cc = b.dataset.crop,
              sid = b.dataset.id;
            if (!confirm(`Supprimer définitivement le crop ${app.cropMeta(cc).fr || cc} / ${sid} ?`)) return;
            try {
              await deleteSession(cc, sid);
              renderCropsList();
              renderPanel();
            } catch (e) {
              toast("Erreur : " + e.message, { kind: "warn" });
            }
          })
      );
    } catch (e) {
      target.innerHTML = `<div class="small">Erreur : ${e.message}</div>`;
    }
  }
  renderPanel();
  // (The Dropbox driver completes any popup-blocked full-page redirect itself, on its own init.)
  // `connect` / `connectDrive` expose the storage OAuth flows so other UI (the login panel /
  // tutorial / storage hint) can start them without owning the dbx-panel button.
  return {
    schedule,
    setAnalysis,
    autoReloadLatest,
    listSessions,
    connect: () => dropbox.startAuth(),
    connectDrive: () => gdrive.startAuth(),
    isStorageConnected: () => anyDriverConnected(),
    restoreFromAgriVision,
  };
}
