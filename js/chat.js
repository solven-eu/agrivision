// AgriVision RE — conversational chat module.
// Owns the turn-by-turn message loop + action-handler registry. Talks to Claude via the
// same /api/analyze worker endpoint as analyses; merges any returned metrics_update into
// the shared analysis state.

import { WORKER_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./config.js";
import { CHAT_SYSTEM_PROMPT, buildContextBlock } from "./prompts.js";
import { aggregateParcels } from "./state.js";
import { robustParseJson } from "./util.js";

/**
 * @param {object} app - dependency bundle:
 *   - selectedParcels (Map), photos (Array, mutated in place)
 *   - conversation (Array), userProfile (Object) — both mutated in place
 *   - map (Leaflet)
 *   - aStatus (DOM)
 *   - addPhotoFromFile (fn), renderPhotos (fn), renderMetrics (fn), renderDiseases (fn),
 *     renderParcelHighlight (fn), updateAnalyzeAvailability (fn), setButtonsDisabled (fn)
 *   - onSchedule (fn) — DBX.schedule
 *   - getAnalysisCombined / setAnalysisCombined — accessors for the shared analysis state
 *   - getBioMode — accessor
 *   - getCurrentAddress — accessor
 *   - saveAnalysis (fn) — DBX.setAnalysis envelope writer
 */
export function createChat(app) {
  let chatBusy = false;
  let freeTextOpen = false;

  // ---------- Action handlers (user-facing UI actions Claude can suggest) ----------
  const ACTION_HANDLERS = {
    take_photo: async (action) => {
      const tags = action.tags || [];
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        if (tags.includes("camera") || tags.includes("now")) input.capture = "environment";
        input.onchange = async () => {
          const files = [...(input.files || [])];
          if (files.length === 0) {
            resolve(null);
            return;
          }
          const added = [];
          for (const f of files) added.push(await app.addPhotoFromFile(f, tags));
          app.renderPhotos();
          app.onSchedule();
          const types = added.map((p) => p.tags?.shot_type || "?").join(", ");
          const rep = added.some((p) => p.representative === true) ? " (marquée représentative)" : "";
          resolve({ followup_text: `[Action: ${added.length} photo(s) ajoutée(s) — type: ${types}${rep}]` });
        };
        input.click();
      });
    },

    mark_typical: async () => {
      if (app.photos.length === 0) return { followup_text: "[Aucune photo à marquer.]" };
      const list = app.photos
        .map((p, i) => `${i + 1}. ${p.name}${p.tags?.shot_type ? " (" + p.tags.shot_type + ")" : ""}`)
        .join("\n");
      const ans = prompt(
        `Quelle photo est représentative du champ ?\n${list}\n\nEntrer son numéro (1-${app.photos.length}), ou rien pour annuler :`
      );
      const idx = parseInt(ans, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= app.photos.length) return null;
      app.photos.forEach((p) => {
        p.representative = null;
      });
      app.photos[idx].representative = true;
      app.renderPhotos();
      app.onSchedule();
      return { followup_text: `[Action: photo ${idx + 1} (${app.photos[idx].name}) marquée représentative]` };
    },

    retake_photo: async (action) => {
      return ACTION_HANDLERS.take_photo({ ...action, tags: [...(action.tags || []), "camera", "now"] });
    },

    add_parcel: async () => {
      alert("Cliquez une parcelle supplémentaire sur la carte (zoom ≥ 12).");
      return null;
    },
  };

  // ---------- Rendering ----------
  function renderChat() {
    const log = document.getElementById("chat-log");
    const actEl = document.getElementById("chat-actions");
    log.innerHTML = "";
    for (const m of app.conversation) {
      const div = document.createElement("div");
      div.className = "chat-msg " + m.role;
      div.textContent = m.role === "user" ? m.display || m.content : m.message || m.content;
      log.appendChild(div);
    }
    if (chatBusy) {
      const t = document.createElement("div");
      t.className = "chat-typing";
      t.textContent = "Claude réfléchit…";
      log.appendChild(t);
    }
    log.scrollTop = log.scrollHeight;

    actEl.innerHTML = "";
    const last = [...app.conversation].reverse().find((m) => m.role === "assistant");
    if (last?.next_actions && !chatBusy) {
      for (const a of last.next_actions) {
        const b = document.createElement("button");
        b.className = "chat-action";
        b.textContent = a.label;
        b.onclick = async () => {
          if (a.id === "free_text") {
            freeTextOpen = true;
            renderChat();
            return;
          }
          const handler = ACTION_HANDLERS[a.id];
          if (handler) {
            chatBusy = true;
            renderChat();
            try {
              const result = await handler(a);
              chatBusy = false;
              if (result?.followup_text) sendTurn({ kind: "text", text: result.followup_text });
              else renderChat();
            } catch (err) {
              chatBusy = false;
              renderChat();
              console.error(err);
            }
            return;
          }
          sendTurn({ kind: "action", id: a.id, label: a.label });
        };
        actEl.appendChild(b);
      }
      const other = document.createElement("button");
      other.className = "chat-action";
      other.style.opacity = "0.7";
      other.textContent = "✏ Autre…";
      other.onclick = () => {
        freeTextOpen = true;
        renderChat();
      };
      actEl.appendChild(other);
    }
    document.getElementById("chat-input-row").style.display = freeTextOpen ? "flex" : "none";
    if (freeTextOpen) document.getElementById("chat-text").focus();
  }

  function resetChat() {
    app.conversation.length = 0;
    // Reset profile in place so direct refs in main.js + persistence stay valid.
    const up = app.userProfile;
    if (up.scores) for (const k of Object.keys(up.scores)) up.scores[k] = 0;
    else up.scores = { farmer: 0, agronomist: 0, investor: 0, consumer: 0, researcher: 0 };
    if (up.primary_concerns) up.primary_concerns.length = 0;
    else up.primary_concerns = [];
    up.expertise_0_100 = 0;
    if (up.inferred_from_turns) up.inferred_from_turns.length = 0;
    else up.inferred_from_turns = [];
    app.setAnalysisCombined(null);
    freeTextOpen = false;
    renderChat();
    app.updateAnalyzeAvailability();
    app.saveAnalysis(null);
  }

  // ---------- Turn loop ----------
  async function sendTurn(userInput) {
    if (!WORKER_URL && !ANTHROPIC_API_KEY) {
      app.aStatus.textContent = "Configure WORKER_URL ou ANTHROPIC_API_KEY.";
      return;
    }
    if (chatBusy) return;
    const turnIndex = app.conversation.length / 2;
    const isFirstTurn = app.conversation.length === 0;

    const userContent = [];
    const userDisplay = !userInput
      ? "Démarrer l'analyse"
      : userInput.kind === "action"
        ? userInput.label
        : userInput.text;

    if (isFirstTurn) {
      for (const p of app.photos) {
        userContent.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.b64 } });
      }
      const bioMode = app.getBioMode();
      const bio = bioMode === "bio" ? "BIO strict" : bioMode === "conventional" ? "Conventionnel" : "Auto";
      const photoAges = app.photos
        .map((p, i) => {
          const age = p.takenAt ? Math.round((Date.now() - p.takenAt.getTime()) / 86400000) : null;
          return `${i + 1}. ${p.lat != null ? `📍 ${p.lat.toFixed(4)},${p.lon.toFixed(4)}` : "sans GPS"}${p.direction != null ? ` 🧭${Math.round(p.direction)}°` : ""}${age != null ? ` 🕒 ${age}j` : ""}`;
        })
        .join("\n");
      const ctx = `${buildContextBlock({
        selectedParcels: app.selectedParcels,
        photos: app.photos,
        currentAddress: app.getCurrentAddress(),
        bioMode,
        map: app.map,
      })}

Photos disponibles (${app.photos.length}) :
${photoAges || "(aucune)"}

Mode de conduite : ${bio}`;
      userContent.push({
        type: "text",
        text: ctx + "\n\nDémarrons. Identifie ce qu'on voit ou propose des actions selon le contexte.",
      });
    } else {
      const text =
        userInput.kind === "action"
          ? `[Action choisie : ${userInput.id}] — ${userInput.label}`
          : userInput.text;
      userContent.push({ type: "text", text });
    }

    app.conversation.push({
      role: "user",
      content: isFirstTurn
        ? "(contexte initial + photos)"
        : userInput.kind === "action"
          ? `[${userInput.id}]`
          : userInput.text,
      display: userDisplay,
      turn: turnIndex,
    });
    chatBusy = true;
    app.setButtonsDisabled(true);
    renderChat();

    const apiMessages = app.conversation.map((m, i) => {
      if (m.role === "user" && i === 0) return { role: "user", content: userContent };
      if (m.role === "user") return { role: "user", content: [{ type: "text", text: m.content }] };
      return { role: "assistant", content: [{ type: "text", text: m.raw || m.message || "" }] };
    });

    const payload = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: CHAT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: apiMessages,
    });

    const useWorker = !!WORKER_URL;
    const url = useWorker
      ? `${WORKER_URL.replace(/\/$/, "")}/api/analyze`
      : "https://api.anthropic.com/v1/messages";
    const headers = useWorker
      ? { "content-type": "application/json", "anthropic-version": "2023-06-01" }
      : {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        };

    try {
      const r = await fetch(url, { method: "POST", headers, body: payload });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      const rawText = j.content?.[0]?.text || "";
      document.getElementById("raw").textContent = rawText;
      const parsed = robustParseJson(rawText);

      if (parsed.profile_update) {
        const newScores = parsed.profile_update.scores || {};
        app.userProfile.scores = { ...app.userProfile.scores, ...newScores };
        if (parsed.profile_update.primary_concerns)
          app.userProfile.primary_concerns = parsed.profile_update.primary_concerns;
        if (parsed.profile_update.expertise_0_100 != null)
          app.userProfile.expertise_0_100 = parsed.profile_update.expertise_0_100;
        app.userProfile.inferred_from_turns = [...(app.userProfile.inferred_from_turns || []), turnIndex];
      }
      if (parsed.metrics_update) {
        let analysisCombined = app.getAnalysisCombined();
        analysisCombined = { ...(analysisCombined || {}), ...parsed.metrics_update };
        if (app.selectedParcels.size > 0) {
          const { totalArea, byCrop } = aggregateParcels(app.selectedParcels);
          analysisCombined.parcels_summary = analysisCombined.parcels_summary || {};
          analysisCombined.parcels_summary.count = app.selectedParcels.size;
          analysisCombined.parcels_summary.total_area_ha = totalArea;
          analysisCombined.parcels_summary.crops_breakdown = Object.entries(byCrop).map(([code, a]) => ({
            code_cultu: code,
            area_ha: a.area,
            share_pct: totalArea > 0 ? (a.area / totalArea) * 100 : 0,
          }));
        }
        app.setAnalysisCombined(analysisCombined);
        app.renderMetrics(analysisCombined);
        if (analysisCombined.diseases) {
          app.renderDiseases(analysisCombined.diseases, {
            t_per_ha: analysisCombined.yield?.estimated_t_per_ha,
            price_eur_per_kg: analysisCombined.market?.indicative_price_eur_per_kg,
            total_area_ha: analysisCombined.parcels_summary?.total_area_ha,
          });
        }
        app.renderParcelHighlight();
      }

      app.conversation.push({
        role: "assistant",
        message: parsed.message || "(réponse vide)",
        next_actions: parsed.next_actions || [],
        raw: rawText,
        turn: turnIndex,
      });

      app.saveAnalysis({
        analysis: app.getAnalysisCombined(),
        conversation: app.conversation,
        user_profile: app.userProfile,
      });
    } catch (e) {
      app.conversation.push({
        role: "system",
        message: "Erreur : " + e.message,
        content: "Erreur : " + e.message,
        turn: turnIndex,
      });
    } finally {
      chatBusy = false;
      app.setButtonsDisabled(false);
      renderChat();
      app.updateAnalyzeAvailability();
    }
  }

  function setFreeTextOpen(v) {
    freeTextOpen = v;
  }
  function isChatBusy() {
    return chatBusy;
  }

  return { renderChat, sendTurn, resetChat, ACTION_HANDLERS, setFreeTextOpen, isChatBusy };
}
