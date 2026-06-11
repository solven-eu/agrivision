// AgriVision RE — Google Drive storage driver (GIS token client + Drive API v3).
//
// Implements the common storage-driver interface consumed by persistence.js. Storage-ONLY: it never
// mints identity. Auth uses the Google Identity Services token client (short-lived access tokens,
// refreshed silently) with the `drive.file` scope — app-created files only. No refresh token is
// persisted, no client secret, no Worker round-trip; the token never leaves the browser.
//
// Drive is ID-based, so the Dropbox path scheme (/crops/<crop>/cultures/<id>/…) is emulated with
// nested Drive folders under a single "AgriVision" root, cached path→folderId in memory.

import { GOOGLE_CLIENT_ID, GDRIVE_ENABLED, GDRIVE_SCOPE, GDRIVE_APP_ROOT, GIS_SCRIPT_URL } from "../config.js";
import { registerStoragePointer } from "../share.js";

const LS = { connected: "gdrive_connected", rootId: "gdrive_root_id" };
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Lazy, promise-cached load of the GIS script (only when the user first touches Drive).
let gisPromise = null;
function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google);
    const s = document.createElement("script");
    s.src = GIS_SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => reject(new Error("Google Identity Services failed to load"));
    document.head.appendChild(s);
  });
  return gisPromise;
}

// Escape a value for a Drive `q=` query (single quotes must be backslash-escaped).
const qEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function guessMime(name) {
  if (name.endsWith(".json")) return "application/json";
  if (/\.(jpe?g)$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "application/octet-stream";
}

// Decode the AgriVision session sub (for the storage pointer's account_id) — non-secret, display-only.
function sessionSub() {
  try {
    const t = localStorage.getItem("agri_session");
    const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p.sub || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} deps - { onConnected?: () => void }
 */
export function createGDriveDriver(deps = {}) {
  const onConnected = deps.onConnected || (() => {});
  let tokenClient = null;
  let accessToken = null;
  let expiresAt = 0;
  let tokenInFlight = null;
  let rootId = localStorage.getItem(LS.rootId) || null;
  const pathToId = new Map(); // "/crops/BAN/cultures/<id>" → folderId

  function isEnabled() {
    return !!GDRIVE_ENABLED && !!GOOGLE_CLIENT_ID;
  }
  function isConnected() {
    return !!localStorage.getItem(LS.connected);
  }
  function accountLabel() {
    return null;
  }

  // ---- Token lifecycle (GIS token client) ----
  async function ensureTokenClient() {
    await loadGis();
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GDRIVE_SCOPE,
        callback: () => {}, // replaced per-request
      });
    }
    return tokenClient;
  }

  // prompt: "consent" (first connect, shows the screen) | "" (silent refresh). Serialized so
  // parallel ops (photo uploads) share one token request instead of racing the GIS callback.
  function requestToken(prompt) {
    if (tokenInFlight) return tokenInFlight;
    tokenInFlight = new Promise((resolve, reject) => {
      ensureTokenClient()
        .then((tc) => {
          tc.callback = (resp) => {
            if (resp && resp.error) return reject(new Error(resp.error));
            accessToken = resp.access_token;
            expiresAt = Date.now() + (Number(resp.expires_in || 3600) * 1000) - 60000;
            resolve(accessToken);
          };
          tc.requestAccessToken({ prompt });
        })
        .catch(reject);
    }).finally(() => {
      tokenInFlight = null;
    });
    return tokenInFlight;
  }

  async function ensureToken() {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    return requestToken(""); // silent
  }

  async function startAuth() {
    try {
      await requestToken("consent");
      localStorage.setItem(LS.connected, "1");
      registerPointer().catch(() => {});
      onConnected();
      return { done: true };
    } catch (e) {
      console.warn("[gdrive] connect failed:", e.message);
      return { manual: false };
    }
  }

  function disconnect() {
    const tok = accessToken;
    accessToken = null;
    expiresAt = 0;
    rootId = null;
    pathToId.clear();
    localStorage.removeItem(LS.connected);
    localStorage.removeItem(LS.rootId);
    try {
      if (tok && window.google?.accounts?.oauth2?.revoke) window.google.accounts.oauth2.revoke(tok);
    } catch {}
  }

  async function driveFetch(url, opts = {}, retry = true) {
    const tok = await ensureToken();
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` },
    });
    if (res.status === 401 && retry) {
      accessToken = null;
      try {
        await requestToken("");
      } catch {
        return res;
      }
      return driveFetch(url, opts, false);
    }
    return res;
  }

  // ---- Path emulation: find-or-create nested folders, query files by name ----
  async function driveList(q, fields = "files(id,name)") {
    const base =
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
      `&spaces=drive&fields=${encodeURIComponent("nextPageToken," + fields)}&pageSize=1000`;
    let out = [];
    let pageToken = null;
    do {
      const r = await driveFetch(pageToken ? `${base}&pageToken=${pageToken}` : base);
      if (!r.ok) throw new Error("drive list " + r.status);
      const j = await r.json();
      out = out.concat(j.files || []);
      pageToken = j.nextPageToken || null;
    } while (pageToken);
    return out;
  }

  async function createFolder(name, parentId) {
    const meta = { name, mimeType: FOLDER_MIME };
    if (parentId) meta.parents = [parentId];
    const r = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta),
    });
    if (!r.ok) throw new Error("create folder " + r.status);
    return (await r.json()).id;
  }

  // Find a child folder by name under a parent (deterministic on accidental duplicates: oldest wins).
  async function findFolder(parentId, name) {
    const found = await driveList(
      `'${parentId}' in parents and name='${qEsc(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      "files(id,name,createdTime)"
    );
    if (!found.length) return null;
    found.sort((a, b) => (a.createdTime || "").localeCompare(b.createdTime || ""));
    return found[0].id;
  }

  async function ensureRoot() {
    if (rootId) return rootId;
    const found = await driveList(
      `name='${qEsc(GDRIVE_APP_ROOT)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      "files(id,name,createdTime)"
    );
    if (found.length) {
      found.sort((a, b) => (a.createdTime || "").localeCompare(b.createdTime || ""));
      rootId = found[0].id;
    } else {
      rootId = await createFolder(GDRIVE_APP_ROOT, null);
    }
    localStorage.setItem(LS.rootId, rootId);
    return rootId;
  }

  function pathParts(path) {
    return path.split("/").filter(Boolean);
  }

  async function resolveFolder(path, { create } = {}) {
    if (pathToId.has(path)) return pathToId.get(path);
    let parent = await ensureRoot();
    let cur = "";
    for (const seg of pathParts(path)) {
      cur += "/" + seg;
      if (pathToId.has(cur)) {
        parent = pathToId.get(cur);
        continue;
      }
      let id = await findFolder(parent, seg);
      if (!id) {
        if (!create) return null;
        id = await createFolder(seg, parent);
      }
      pathToId.set(cur, id);
      parent = id;
    }
    return parent;
  }

  async function findFileInParent(parentId, name) {
    const found = await driveList(
      `'${parentId}' in parents and name='${qEsc(name)}' and trashed=false`,
      "files(id,name)"
    );
    return found.length ? found[0].id : null;
  }

  async function resolveFile(path) {
    const cut = path.lastIndexOf("/");
    const dir = path.slice(0, cut) || "/";
    const name = path.slice(cut + 1);
    const parent = await resolveFolder(dir, { create: false });
    if (!parent) return null;
    return findFileInParent(parent, name);
  }

  // ---- The 6 ops (PATH-based, matching the Dropbox driver) ----
  async function uploadFile(path, body, mode = "overwrite") {
    const cut = path.lastIndexOf("/");
    const dir = path.slice(0, cut);
    const name = path.slice(cut + 1);
    const parent = await resolveFolder(dir, { create: true });
    const existing = await findFileInParent(parent, name);
    const contentType = guessMime(name);
    if (existing) {
      // Update bytes only (simpler + avoids duplicate-create races on repeat saves).
      const r = await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=media&fields=id`,
        { method: "PATCH", headers: { "Content-Type": contentType }, body }
      );
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`update ${path}: ${r.status} ${t.slice(0, 150)}`);
      }
      return r.json();
    }
    // Create via multipart (metadata + bytes in one call).
    const boundary = "agri" + b36(8);
    const meta = JSON.stringify({ name, parents: [parent] });
    const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
    const post = `\r\n--${boundary}--`;
    const blob = new Blob([pre, body, post]);
    const r = await driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: blob }
    );
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`create ${path}: ${r.status} ${t.slice(0, 150)}`);
    }
    return r.json();
  }

  async function downloadFile(path) {
    const id = await resolveFile(path);
    if (!id) throw new Error(`download ${path}: not found`);
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    if (!r.ok) throw new Error(`download ${path}: ${r.status}`);
    return r; // raw Response → .json()/.blob() both work
  }

  async function listSessions() {
    if (!isConnected()) return [];
    await ensureRoot();
    const cropsId = await resolveFolder("/crops", { create: false });
    if (!cropsId) return [];
    const crops = await driveList(`'${cropsId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`);
    const out = [];
    for (const crop of crops) {
      const culturesId = await findFolder(crop.id, "cultures");
      if (!culturesId) continue;
      pathToId.set(`/crops/${crop.name}/cultures`, culturesId);
      const cultures = await driveList(
        `'${culturesId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`
      );
      for (const cul of cultures) {
        const path = `/crops/${crop.name}/cultures/${cul.name}`;
        pathToId.set(path, cul.id);
        out.push({ crop: crop.name, id: cul.name, path });
      }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  async function deleteFolder(path) {
    const id = await resolveFolder(path, { create: false });
    if (!id) return;
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error(`delete ${path}: ${r.status}`);
    for (const k of [...pathToId.keys()]) if (k === path || k.startsWith(path + "/")) pathToId.delete(k);
  }

  async function registerPointer() {
    try {
      await registerStoragePointer({
        provider: "gdrive",
        account_id: sessionSub() || "gdrive",
        email: null, // drive.file grant carries no email scope; the pointer is identity-keyed anyway
        root_path: "/" + GDRIVE_APP_ROOT,
      });
    } catch (e) {
      console.warn("[gdrive] pointer register failed:", e.message);
    }
  }

  return {
    id: "gdrive",
    label: "Google Drive",
    isEnabled,
    isConnected,
    accountLabel,
    startAuth,
    disconnect,
    uploadFile,
    downloadFile,
    listSessions,
    deleteFolder,
    registerPointer,
  };
}

// Short random base36 (boundary suffix). Module-level so it's not recreated per call.
function b36(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join("");
}
