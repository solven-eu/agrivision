// AgriVision RE — debug panel (only enabled when ?debug is in the URL).
// Surfaces: localStorage dump, dbx_token copy, force auto-reload, purge SW + caches, clear LS.

/**
 * @param {object} app - { dbx: DBX module from createDbx() } — needed to force autoReload.
 */
export function initDebug(app) {
  if (!new URLSearchParams(location.search).has("debug")) return;
  const panel = document.getElementById("debug-panel");
  if (!panel) return;
  panel.style.display = "block";
  const out = document.getElementById("dbg-output");
  const show = (txt) => {
    out.textContent = txt;
  };

  document.getElementById("dbg-dump").onclick = () => {
    const dump = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      dump[k] = localStorage.getItem(k);
    }
    show(JSON.stringify(dump, null, 2));
    navigator.clipboard?.writeText(JSON.stringify(dump, null, 2));
  };

  document.getElementById("dbg-token").onclick = () => {
    const t = localStorage.getItem("dbx_token");
    if (!t) {
      show("(pas de dbx_token en localStorage)");
      return;
    }
    navigator.clipboard?.writeText(t);
    show(`dbx_token copié dans le presse-papier (${t.length} chars, prefix: ${t.slice(0, 12)}…)`);
  };

  document.getElementById("dbg-reload").onclick = async () => {
    show("Lancement autoReloadLatest…");
    try {
      await app.dbx.autoReloadLatest();
      show("Auto-reload terminé. Voir console pour les logs.");
    } catch (e) {
      show(`Erreur : ${e.message}`);
    }
  };

  document.getElementById("dbg-sw").onclick = async () => {
    const regs = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistrations() : [];
    for (const r of regs) await r.unregister();
    const keys = window.caches ? await caches.keys() : [];
    for (const k of keys) await caches.delete(k);
    show(`Purgés : ${regs.length} SW · ${keys.length} caches. Rechargez la page (Cmd+Shift+R).`);
  };

  document.getElementById("dbg-clear").onclick = () => {
    if (!confirm("Vider TOUT localStorage (token, session, préférences) ?")) return;
    localStorage.clear();
    show("localStorage vidé. Rechargez.");
  };
}
