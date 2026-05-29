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

  // Image-discovery export: dumps every image URL that lookupTaxonImage has resolved via the
  // fallback chain (Wikipedia / iNaturalist). Use this to harvest URLs and merge them into
  // catalog.json so they become first-class catalog entries (no more dynamic probing).
  const exportBtn = document.getElementById("dbg-export-images");
  if (exportBtn)
    exportBtn.onclick = () => {
      const discoveries = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith("img:") && !k.startsWith("inat:")) continue;
        const v = localStorage.getItem(k);
        if (!v || v === "MISS") continue;
        const taxon = k.slice(k.indexOf(":") + 1);
        const [source, url] = v.includes("|") ? v.split("|", 2) : ["iNaturalist", v];
        discoveries[taxon] = { source, image: url };
      }
      const json = JSON.stringify(discoveries, null, 2);
      show(json);
      navigator.clipboard?.writeText(json);
    };

  // Compare Claude vs Mistral on the first available photo. Useful PoC tool to see
  // the orthogonal failure modes between providers before wiring Mistral into a real path.
  const compareBtn = document.getElementById("dbg-compare-ai");
  if (compareBtn)
    compareBtn.onclick = async () => {
      const photo = app.getPhotos?.()[0] || app.photos?.[0];
      if (!photo) {
        show("Pas de photo dans la banque. Uploade-en une et réessaie.");
        return;
      }
      show("Appel Claude + Mistral en parallèle…");
      const { ask } = await import("./ai-providers.js");
      const payload = {
        max_tokens: 600,
        system: "Tu es un expert agronome. Identifie en français la culture sur la photo en 1-2 phrases.",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: photo.mime, data: photo.b64 } },
              { type: "text", text: "Qu'est-ce que tu vois ?" },
            ],
          },
        ],
      };
      const [a, m] = await Promise.all([ask("anthropic", payload), ask("mistral", payload)]);
      const lines = [];
      lines.push("=== Claude ===");
      lines.push(
        a.ok
          ? a.body?.content?.[0]?.text || JSON.stringify(a.body)
          : "ERR " + a.status + " " + (a.body?.error || "")
      );
      lines.push("usage: " + JSON.stringify(a.body?.usage || {}));
      lines.push("");
      lines.push("=== Mistral ===");
      lines.push(
        m.ok
          ? m.body?.content?.[0]?.text || JSON.stringify(m.body)
          : "ERR " + m.status + " " + (m.body?.error || "")
      );
      lines.push("usage: " + JSON.stringify(m.body?.usage || {}));
      show(lines.join("\n"));
    };
}
