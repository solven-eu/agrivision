// AgriVision RE — persistence module.
// Dropbox PKCE OAuth + App-folder save/load + localStorage status badge.
//
// Externals are passed in via the `app` object, populated by main.js. This keeps the module
// portable: it doesn't reach into main.js's scope; main.js explicitly wires the dependencies.

import { DROPBOX_APP_KEY, DROPBOX_REDIRECT_URI } from "./config.js";
import {
  tradeDropboxIdTokenForSession,
  logoutSession,
  registerStoragePointer,
  loadFromAgriVision,
} from "./share.js";
import { ensureSoilForSelected } from "./soil.js";
import { ensureAltitudeForSelected } from "./elevation.js";

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
    token: "dbx_token",
    refresh: "dbx_refresh",
    verifier: "dbx_verifier",
    session: "agri_culture_id",
    crop: "agri_culture_crop",
    uploaded: "agri_uploaded_photos", // photoId → true (per culture)
  };
  const state = {
    enabled: !!DROPBOX_APP_KEY,
    token: localStorage.getItem(LS.token) || null,
    refresh: localStorage.getItem(LS.refresh) || null,
    sessionId: localStorage.getItem(LS.session) || null,
    cropCode: localStorage.getItem(LS.crop) || null, // path prefix /crops/<cropCode>/cultures/<id>
    uploaded: JSON.parse(localStorage.getItem(LS.uploaded) || "{}"),
    lastAnalysis: null,
    lastConversation: [],
    lastUserProfile: null,
    // If we have a token at startup, an auto-reload is imminent. Block any save until it finishes.
    suspendSave: !!localStorage.getItem(LS.token),
    saveStatus: "idle", // idle | dirty | saving | saved | loading | error
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
  }
  function persistUploaded() {
    localStorage.setItem(LS.uploaded, JSON.stringify(state.uploaded));
  }

  // PKCE helpers
  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  function randomVerifier() {
    const a = new Uint8Array(64);
    crypto.getRandomValues(a);
    return b64url(a);
  }
  async function challengeFor(verifier) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(hash);
  }

  async function startAuth() {
    const verifier = randomVerifier();
    sessionStorage.setItem(LS.verifier, verifier);
    const challenge = await challengeFor(verifier);
    const params = new URLSearchParams({
      client_id: DROPBOX_APP_KEY,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
      // OpenID Connect: requesting `openid` gets us an id_token (JWT) in the token response.
      // The JWT's `sub` claim is the user's stable Dropbox account_id, so the Worker can
      // identify the user by signature-verifying the JWT — no need to forward the bearer.
      // The app must have the `openid` scope enabled in the Dropbox App console too.
      scope: "openid",
    });
    if (DROPBOX_REDIRECT_URI) params.set("redirect_uri", DROPBOX_REDIRECT_URI);
    const url = `https://www.dropbox.com/oauth2/authorize?${params}`;
    window.open(url, "_blank", "noopener");
  }

  async function exchangeCode(code) {
    const verifier = sessionStorage.getItem(LS.verifier);
    if (!verifier) throw new Error("Code verifier introuvable (relancer la connexion).");
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: DROPBOX_APP_KEY,
      code_verifier: verifier,
    });
    if (DROPBOX_REDIRECT_URI) body.set("redirect_uri", DROPBOX_REDIRECT_URI);
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error_summary || JSON.stringify(j));
    state.token = j.access_token;
    state.refresh = j.refresh_token || null;
    localStorage.setItem(LS.token, state.token);
    if (state.refresh) localStorage.setItem(LS.refresh, state.refresh);
    // OpenID Connect id_token (JWT). Present when scope=openid was granted. Used ONCE to
    // mint an AgriVision session JWT at /api/auth/dropbox/login; after that we use the
    // AgriVision session (`agri_session` in localStorage) for all backend calls.
    if (j.id_token) {
      localStorage.setItem("dbx_id_token", j.id_token);
      // Identity vs storage are decoupled. If the user is ALREADY signed in (e.g. via
      // Google), connecting Dropbox is a STORAGE action — keep their existing identity and
      // just record where the data lives. Only when there's no session does Dropbox double
      // as the identity provider (trade the id_token for an AgriVision session).
      const haveSession = !!localStorage.getItem("agri_session");
      const ready = haveSession
        ? Promise.resolve()
        : tradeDropboxIdTokenForSession(j.id_token, DROPBOX_APP_KEY);
      // Fire-and-forget — if the Worker is unreachable / not configured, share calls just
      // stay anonymous. Register the storage pointer once a session exists.
      ready.then(() => registerDropboxPointer()).catch(() => {});
    }
    sessionStorage.removeItem(LS.verifier);
  }

  // Record a non-secret pointer (which Dropbox account holds this user's data) so other
  // devices know where to send the user to restore. Reads the account from Dropbox; the
  // access token never leaves the browser. Best-effort.
  async function registerDropboxPointer() {
    if (!state.token) return;
    try {
      const r = await dbxFetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
      });
      if (!r.ok) return;
      const acct = await r.json();
      await registerStoragePointer({
        provider: "dropbox",
        account_id: acct.account_id,
        email: acct.email || null,
        root_path: "/Apps/AgriVision",
      });
    } catch (e) {
      console.warn("dropbox pointer register failed:", e.message);
    }
  }

  async function refreshToken() {
    if (!state.refresh) return false;
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refresh,
        client_id: DROPBOX_APP_KEY,
      }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    state.token = j.access_token;
    localStorage.setItem(LS.token, state.token);
    if (j.id_token) {
      localStorage.setItem("dbx_id_token", j.id_token);
      // Only (re)mint a Dropbox-backed session if Dropbox is the identity (no other session
      // present). A Google/Facebook session is refreshed separately via maybeRefreshSession.
      if (!localStorage.getItem("agri_session")) {
        tradeDropboxIdTokenForSession(j.id_token, DROPBOX_APP_KEY).catch(() => {});
      }
    }
    return true;
  }

  async function dbxFetch(url, opts, retry = true) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${state.token}` },
    });
    if (res.status === 401 && retry && state.refresh) {
      const ok = await refreshToken();
      if (ok) return dbxFetch(url, opts, false);
    }
    return res;
  }

  function disconnect() {
    state.token = null;
    state.refresh = null;
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.refresh);
    localStorage.removeItem("dbx_id_token");
    // Server-side logout: revokes the JWT jti in KV so a leaked copy can't be reused
    // for the remainder of its TTL. Clears local agri_session keys too. Fire-and-forget.
    logoutSession().catch(() => {});
  }

  async function uploadFile(path, body, mode = "overwrite") {
    const args = JSON.stringify({ path, mode, autorename: false, mute: true });
    const r = await dbxFetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": args,
      },
      body,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Upload ${path} failed: ${r.status} ${t.slice(0, 200)}`);
    }
    return r.json();
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

  async function saveNow() {
    if (!state.enabled || !state.token) return;
    if (state.suspendSave) return; // load in progress — don't save half-rehydrated state
    setSaveStatus("saving");
    ensureSession();
    const base = basePath();

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

    // Build manifest (no base64 — photo bytes already uploaded).
    const manifest = {
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
    try {
      await uploadFile(`${base}/culture.json`, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
      setSaveStatus("saved");
      renderPanel(
        `✓ ${new Date().toLocaleTimeString("fr-FR")} · ${manifest.parcels.length} parc. · ${manifest.photos.length} ph.`
      );
      // Opt-in "Share with AgriVision" — fire-and-forget mirror of the manifest into KV.
      // Runs after the Dropbox save is confirmed so KV never gets ahead of the user's
      // own copy. Silent if disabled.
      app.onShareSync?.(manifest);
    } catch (e) {
      setSaveStatus("error");
      renderPanel(`Erreur : ${e.message}`);
    }
  }

  function schedule() {
    if (!state.enabled || !state.token || state.suspendSave) return;
    if (state.saveStatus !== "saving" && state.saveStatus !== "loading") setSaveStatus("dirty");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveInFlight = saveNow()
        .catch((e) => console.error(e))
        .finally(() => {
          saveInFlight = null;
        });
    }, 1500);
  }

  async function listSessions() {
    // Recursive listing of /crops; pick out folders at depth 2 (= cultures).
    const r = await dbxFetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/crops", recursive: true }),
    });
    if (r.status === 409) return [];
    if (!r.ok) throw new Error("list_folder " + r.status);
    const j = await r.json();
    const cultures = [];
    for (const e of j.entries || []) {
      if (e[".tag"] !== "folder") continue;
      const parts = e.path_display.split("/").filter(Boolean); // ["crops","BAN","cultures","2026-..."]
      if (parts.length === 4 && parts[0] === "crops" && parts[2] === "cultures") {
        cultures.push({ crop: parts[1], id: parts[3], path: e.path_display });
      }
    }
    return cultures.sort((a, b) => b.id.localeCompare(a.id));
  }

  async function downloadFile(path) {
    const r = await dbxFetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: { "Dropbox-API-Arg": JSON.stringify({ path }) },
    });
    if (!r.ok) throw new Error(`download ${path}: ${r.status}`);
    return r;
  }

  async function deleteFolder(path) {
    const r = await dbxFetch("https://api.dropboxapi.com/2/files/delete_v2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`delete ${path}: ${r.status} ${t.slice(0, 150)}`);
    }
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
    state.suspendSave = true;
    setSaveStatus("loading");
    showLoading(opts.manifest ? "Restauration…" : `Chargement du manifeste…`, 0);
    try {
      let manifest = opts.manifest;
      if (!manifest) {
        const r = await downloadFile(`/crops/${cropCode}/cultures/${sid}/culture.json`);
        manifest = await r.json();
      }
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
            state.uploaded[photo.id] = { name: photo.name, mime: photo.mime };
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
      // Keep suspendSave true long enough for the MutationObservers triggered by
      // app.renderPhotos / app.renderParcelInfoPanel to fire and be debounced. Otherwise
      // load → render → observer → schedule() → spurious save of unchanged data.
      setTimeout(() => {
        state.suspendSave = false;
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
      "[dbx] autoReload: enabled=",
      state.enabled,
      "token=",
      !!state.token,
      "sessionId=",
      state.sessionId,
      "cropCode=",
      state.cropCode
    );
    if (!state.enabled) {
      state.suspendSave = false;
      app.setPendingDbxLoad(false);
      window.__initBasemap?.();
      window.__hideLoading?.();
      return;
    }
    if (!state.token) {
      state.suspendSave = false;
      app.setPendingDbxLoad(false);
      window.__initBasemap?.();
      window.__setLoadingMsg?.("Configurez un crop");
      setTimeout(() => window.__hideLoading?.(), 1200);
      renderPanel("Non connecté — connectez Dropbox pour sauvegarder.");
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
        hideLoading();
        state.suspendSave = false;
        window.__setLoadingMsg?.("Configurez un crop");
        setTimeout(() => window.__hideLoading?.(), 1200);
        renderPanel("Aucun crop sauvegardé — créez-en un.");
        setTimeout(app.refreshChips, 300);
      }
    } catch (e) {
      console.warn("[dbx] auto-reload failed:", e);
      hideLoading();
      state.suspendSave = false;
      renderPanel(`Auto-reload échoué : ${e.message}`);
      setTimeout(app.refreshChips, 300);
    } finally {
      // Always release the gate so subsequent user actions (move/click) behave normally.
      app.setPendingDbxLoad(false);
      window.__initBasemap?.();
    }
  }
  // Fire after the rest of the script has set up event listeners + the app.map is ready.
  // Using window.load ensures all init code has run; setTimeout fires if load already happened.
  if (document.readyState === "complete") setTimeout(autoReloadLatest, 200);
  else window.addEventListener("load", () => setTimeout(autoReloadLatest, 200));

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
    if (!state.enabled) {
      panel.innerHTML = `Désactivé : configure <code>DROPBOX_APP_KEY</code> en haut du script.`;
      return;
    }
    if (!state.token) {
      panel.innerHTML = `
        <button class="secondary" id="dbx-connect" style="font-size:11px;padding:4px 8px">☁ Connecter Dropbox</button>
        <div id="dbx-code-row" style="display:none;margin-top:6px">
          <input id="dbx-code" type="text" placeholder="Coller le code…" autocomplete="off" data-lpignore="true" data-form-type="other" style="font-size:11px;padding:4px 6px" />
          <button class="secondary" id="dbx-submit" style="font-size:11px;padding:4px 8px;margin-top:4px">Valider</button>
        </div>
        <div id="dbx-msg" class="small" style="margin-top:6px"></div>
      `;
      document.getElementById("dbx-connect").onclick = async () => {
        await startAuth();
        document.getElementById("dbx-code-row").style.display = "block";
        document.getElementById("dbx-msg").textContent =
          "Autoriser dans l'onglet Dropbox puis coller le code ici.";
      };
      document.getElementById("dbx-submit").onclick = async () => {
        const code = document.getElementById("dbx-code").value.trim();
        if (!code) return;
        try {
          await exchangeCode(code);
          renderPanel();
          schedule(); // initial save
        } catch (e) {
          document.getElementById("dbx-msg").textContent = "Erreur : " + e.message;
        }
      };
      return;
    }
    const cm = state.cropCode ? app.cropMeta(state.cropCode) : null;
    const cropLabel = state.sessionId
      ? `${cm ? cm.emoji + " " + cm.fr + " · " : ""}<code>${state.sessionId}</code>`
      : "(aucun crop actif)";
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <div style="flex:1">✓ Connecté · ${cropLabel}</div>
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
      disconnect();
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
              alert("Erreur : " + e.message);
            }
          })
      );
    } catch (e) {
      target.innerHTML = `<div class="small">Erreur : ${e.message}</div>`;
    }
  }
  renderPanel();
  // `connect` exposes the Dropbox OAuth flow so other UI (the login panel / tutorial) can
  // start it without owning the dbx-panel button.
  return {
    schedule,
    setAnalysis,
    autoReloadLatest,
    listSessions,
    connect: startAuth,
    restoreFromAgriVision,
  };
}
