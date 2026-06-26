// AgriVision RE — conversational chat module.
// Owns the turn-by-turn message loop + action-handler registry. Talks to Claude via the
// same /api/analyze worker endpoint as analyses; merges any returned metrics_update into
// the shared analysis state.

import { WORKER_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./config.js";
import { CHAT_SYSTEM_PROMPT, buildContextBlock } from "./prompts.js";
import { toast } from "./toast.js";
import { aggregateParcels } from "./state.js";
import { robustParseJson } from "./util.js";
import { workerAuthHeader } from "./share.js";
import { handleAiAccessError } from "./billing.js";

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

  // User-initiated composer state. Photos attached here are sent with the next text turn.
  // Cleared after submit.
  let composerPhotos = [];

  // Adds files to the composer attachments; shared by all source paths.
  async function attachFiles(fileList) {
    const files = [...(fileList || [])];
    for (const f of files) {
      const p = await app.addPhotoFromFile(f, []);
      composerPhotos.push(p);
    }
    app.renderPhotos();
    app.onSchedule();
    renderComposerAttachments();
  }

  // Modal asking the user *how* they want to attach a photo: pick from bank,
  // take a new one (mobile camera or desktop fallback), or drag-drop / browse.
  async function showPhotoSourceChooser() {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.style.cssText =
        "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px";
      const bankCount = app.photos?.length || 0;
      modal.innerHTML = `
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;max-width:420px;width:100%;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h3 style="margin:0;font-size:16px">Envoyer une photo</h3>
            <button data-close aria-label="Fermer" style="background:transparent;border:0;color:var(--muted);font-size:22px;cursor:pointer;line-height:1">×</button>
          </div>
          ${
            bankCount > 0
              ? `<button class="src-bank" style="text-align:left;padding:10px;background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer;font-size:13px">📂 Choisir dans la banque (${bankCount} dispo${bankCount > 1 ? "s" : ""})</button>`
              : `<div class="small" style="color:var(--muted)">Aucune photo dans la banque pour l'instant.</div>`
          }
          <button class="src-camera" style="text-align:left;padding:10px;background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer;font-size:13px">📷 Prendre une photo</button>
          <div class="src-drop" style="padding:18px;text-align:center;border:2px dashed var(--border);border-radius:6px;color:var(--muted);cursor:pointer;font-size:12px">🖼 Glisser-déposer ici ou cliquer pour parcourir</div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => {
        if (modal.parentNode) modal.remove();
        resolve();
      };
      modal.querySelector("[data-close]").onclick = close;
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });

      modal.querySelector(".src-bank")?.addEventListener("click", () => {
        modal.remove();
        showBankPicker().then(resolve);
      });

      modal.querySelector(".src-camera").onclick = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.capture = "environment";
        input.onchange = async () => {
          await attachFiles(input.files);
          close();
        };
        input.click();
      };

      const drop = modal.querySelector(".src-drop");
      drop.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.onchange = async () => {
          await attachFiles(input.files);
          close();
        };
        input.click();
      });
      drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        drop.style.background = "var(--panel2)";
      });
      drop.addEventListener("dragleave", () => {
        drop.style.background = "";
      });
      drop.addEventListener("drop", async (e) => {
        e.preventDefault();
        drop.style.background = "";
        const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
        if (files.length) {
          await attachFiles(files);
          close();
        }
      });
    });
  }

  // Secondary modal: pick one or more photos from the existing bank.
  async function showBankPicker() {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.style.cssText =
        "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px";
      const grid = (app.photos || [])
        .map(
          (p, i) =>
            `<button class="bank-pick" data-id="${p.id}" style="background:transparent;border:1px solid var(--border);border-radius:4px;padding:4px;cursor:pointer;color:var(--text)">
              <img src="${p.dataUrl}" style="width:96px;height:96px;object-fit:cover;display:block;border-radius:2px"/>
              <div style="font-size:9px;margin-top:2px;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i + 1}. ${p.name}</div>
            </button>`
        )
        .join("");
      modal.innerHTML = `
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;max-width:640px;width:100%;max-height:80vh;overflow:auto">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0;font-size:16px">Choisir dans la banque</h3>
            <button data-close aria-label="Fermer" style="background:transparent;border:0;color:var(--muted);font-size:22px;cursor:pointer;line-height:1">×</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">${grid}</div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => {
        if (modal.parentNode) modal.remove();
        resolve();
      };
      modal.querySelector("[data-close]").onclick = close;
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close();
      });
      modal.querySelectorAll(".bank-pick").forEach((b) => {
        b.addEventListener("click", () => {
          const id = b.dataset.id;
          const p = app.photos.find((x) => x.id === id);
          if (p && !composerPhotos.find((x) => x.id === id)) composerPhotos.push(p);
          renderComposerAttachments();
          close();
        });
      });
    });
  }

  // Backwards-compat: keep composerPickPhoto exported for the 📎 button.
  // Now routes through the chooser so the UX is the same everywhere.
  async function composerPickPhoto() {
    return showPhotoSourceChooser();
  }

  function renderComposerAttachments() {
    const host = document.getElementById("chat-attachments");
    if (!host) return;
    if (composerPhotos.length === 0) {
      host.style.display = "none";
      host.innerHTML = "";
      return;
    }
    host.style.display = "flex";
    host.innerHTML = composerPhotos
      .map(
        (p, i) =>
          `<div style="display:inline-flex;align-items:center;gap:4px;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:10px">
             <img src="${p.dataUrl}" style="width:24px;height:24px;object-fit:cover;border-radius:2px"/>
             ${p.name.slice(0, 14)}${p.name.length > 14 ? "…" : ""}
             <button data-composer-remove="${i}" style="background:transparent;border:none;color:var(--bad);cursor:pointer;font-weight:700;padding:0 2px">×</button>
           </div>`
      )
      .join("");
    host.querySelectorAll("[data-composer-remove]").forEach(
      (b) =>
        (b.onclick = (e) => {
          const idx = parseInt(e.target.dataset.composerRemove, 10);
          composerPhotos.splice(idx, 1);
          renderComposerAttachments();
        })
    );
  }

  // Apply Claude-supplied tags to an existing photo (used when the user reuses one from the bank
  // instead of taking a new one for the take_photo action).
  function applyTagsToPhoto(p, tags) {
    if (!tags?.length) return;
    const shot = tags.includes("single_plant")
      ? "single_plant"
      : tags.includes("overview")
        ? "overview"
        : tags.includes("detail")
          ? "detail"
          : null;
    if (shot) p.tags = { ...(p.tags || {}), shot_type: shot };
    if (tags.includes("typical")) p.representative = true;
  }

  // ---------- Action handlers (user-facing UI actions Claude can suggest) ----------
  // Each handler returns either { followup_text, attachPhotos? } — the latter is sent as image
  // content blocks in the next turn so Claude actually SEES the newly-added / reused photos.
  const ACTION_HANDLERS = {
    take_photo: async (action) => {
      const tags = action.tags || [];

      // If the bank has photos, offer reuse first — saves the user from re-shooting.
      if (app.photos.length > 0) {
        const list = app.photos
          .map((p, i) => `${i + 1}. ${p.name}${p.tags?.shot_type ? " (" + p.tags.shot_type + ")" : ""}`)
          .join("\n");
        const ans = prompt(
          `Photo : choisir dans la bibliothèque ou en prendre une nouvelle ?\n\n${list}\n${app.photos.length + 1}. 📷 Prendre une nouvelle photo\n\nEntrez le numéro :`
        );
        if (ans === null) return null;
        const choice = parseInt(ans, 10);
        if (!isNaN(choice) && choice >= 1 && choice <= app.photos.length) {
          const p = app.photos[choice - 1];
          applyTagsToPhoto(p, tags);
          app.renderPhotos();
          app.onSchedule();
          const rep = p.representative === true ? " (marquée représentative)" : "";
          return {
            followup_text: `[Action: photo ${choice} (${p.name}) réutilisée${rep}]`,
            attachPhotos: [p],
          };
        }
        // Any other input (including choice = N+1) → fall through to camera capture.
      }

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
          resolve({
            followup_text: `[Action: ${added.length} photo(s) ajoutée(s) — type: ${types}${rep}]`,
            attachPhotos: added,
          });
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
      return {
        followup_text: `[Action: photo ${idx + 1} (${app.photos[idx].name}) marquée représentative]`,
        attachPhotos: [app.photos[idx]],
      };
    },

    retake_photo: async (action) => {
      return ACTION_HANDLERS.take_photo({ ...action, tags: [...(action.tags || []), "camera", "now"] });
    },

    add_parcel: async () => {
      toast("Clique une parcelle supplémentaire sur la carte (zoom ≥ 12).", { kind: "info" });
      return null;
    },

    // Off-topic / bug / feature request → open the contact form. The submitted feedback
    // goes to the Worker `/api/feedback` route which stores it in KV under the user's
    // account. The user gets a "merci, on regarde ça" confirmation; the AI then has a
    // canonical "user has been redirected to the form, drop this thread" cue to come back.
    contact_admin: async () => {
      const result = await openFeedbackModal();
      if (!result) return null;
      return {
        followup_text: `[contact_admin] L'utilisateur a soumis le formulaire (sujet: "${result.subject}"). Confirme-lui en une phrase que l'équipe AgriVision a bien reçu sa demande, et reviens sur le contexte agricole — il n'y a rien à ajouter sur la demande envoyée.`,
      };
    },
  };

  // Lightweight feedback form modal. Submits to /api/feedback with the AgriVision session
  // bearer when present (admin can correlate by sub); falls back to anonymous otherwise.
  async function openFeedbackModal() {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.style.cssText =
        "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px";
      modal.innerHTML = `
        <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:480px;width:100%;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h3 style="margin:0;font-size:16px">✉️ Contacter l'équipe AgriVision</h3>
            <button data-close style="background:transparent;border:0;color:var(--muted);font-size:22px;cursor:pointer;line-height:1">×</button>
          </div>
          <div class="small" style="color:var(--muted)">Bug, suggestion, ou question hors agriculture ? Écris-nous ici — on lit tout.</div>
          <label class="small" style="margin-top:6px">Sujet</label>
          <select id="fb-subject" autocomplete="off" data-lpignore="true" data-form-type="other" style="padding:6px;border-radius:4px;border:1px solid var(--border);background:var(--panel2);color:var(--text);font-size:12px">
            <option value="bug">🐛 Bug</option>
            <option value="feature">💡 Demande de fonctionnalité</option>
            <option value="account">🤝 Question sur le compte / facturation</option>
            <option value="offtopic">🤔 Question hors agriculture</option>
            <option value="other">Autre</option>
          </select>
          <label class="small">Message</label>
          <textarea id="fb-message" rows="5" placeholder="Décris ta demande…" autocomplete="off" data-lpignore="true" data-form-type="other" style="padding:6px;border-radius:4px;border:1px solid var(--border);background:var(--panel2);color:var(--text);font-size:12px;resize:vertical;min-height:80px"></textarea>
          <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:4px">
            <button data-cancel class="secondary" style="font-size:12px;padding:6px 12px">Annuler</button>
            <button data-send style="font-size:12px;padding:6px 12px">Envoyer</button>
          </div>
          <div id="fb-status" class="small" style="margin-top:2px"></div>
        </div>`;
      document.body.appendChild(modal);
      const close = (v) => {
        modal.remove();
        resolve(v);
      };
      modal.querySelector("[data-close]").onclick = () => close(null);
      modal.querySelector("[data-cancel]").onclick = () => close(null);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) close(null);
      });
      modal.querySelector("[data-send]").onclick = async () => {
        const subject = modal.querySelector("#fb-subject").value;
        const message = modal.querySelector("#fb-message").value.trim();
        const statusEl = modal.querySelector("#fb-status");
        if (!message) {
          statusEl.textContent = "Le message ne peut pas être vide.";
          statusEl.style.color = "var(--bad)";
          return;
        }
        statusEl.textContent = "Envoi…";
        statusEl.style.color = "var(--muted)";
        try {
          const session = localStorage.getItem("agri_session");
          const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/api/feedback`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(session ? { authorization: `Bearer ${session}` } : {}),
            },
            body: JSON.stringify({
              subject,
              message,
              context: {
                user_agent: navigator.userAgent,
                conversation_turns: app.conversation.length,
                analysis_dominant_crop: app.getAnalysisCombined?.()?.identification?.dominant_crop_fr || null,
              },
            }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${r.status}`);
          }
          close({ subject, message });
        } catch (e) {
          statusEl.textContent = "Erreur : " + e.message;
          statusEl.style.color = "var(--bad)";
        }
      };
    });
  }

  // ---------- Rendering ----------
  function renderChat() {
    const log = document.getElementById("chat-log");
    const actEl = document.getElementById("chat-actions");
    // Note: don't auto-open the chat section from this function — it's also called
    // during Dropbox restore (which would force-open every page load). The auto-open
    // is now done from sendTurn (user-initiated) so reloads keep everything folded.
    log.innerHTML = "";
    for (const m of app.conversation) {
      const div = document.createElement("div");
      div.className = "chat-msg " + m.role;
      // Language-change marker, rendered above the bubble so the user can see what was
      // signalled to the model on this turn.
      if (m.role === "user" && m.dialectChangedFrom && m.dialect) {
        const chip = document.createElement("div");
        chip.textContent = `🌐 Langue : ${m.dialectChangedFrom} → ${m.dialect}`;
        chip.style.cssText =
          "font-size:10px;color:var(--accent);margin-bottom:4px;padding:2px 6px;background:var(--panel);border:1px solid var(--border);border-radius:8px;display:inline-block";
        chip.title = "Le changement de langue a été signalé à l'IA dans ce message.";
        div.appendChild(chip);
      }
      const textPart = document.createElement("div");
      textPart.textContent = m.role === "user" ? m.display || m.content : m.message || m.content;
      div.appendChild(textPart);
      // User photo attachments: render a thumbnail strip so the conversation context is visible.
      if (m.role === "user" && m.attachPhotoIds?.length) {
        const strip = document.createElement("div");
        strip.style.cssText =
          "display:flex;gap:4px;margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.15);flex-wrap:wrap;align-items:center";
        const label = document.createElement("span");
        label.textContent = `📎 ${m.attachPhotoIds.length} photo${m.attachPhotoIds.length > 1 ? "s" : ""} :`;
        label.style.cssText = "font-size:10px;color:var(--muted);margin-right:2px";
        strip.appendChild(label);
        for (const id of m.attachPhotoIds) {
          const p = app.photos.find((x) => x.id === id);
          if (!p) {
            const missing = document.createElement("span");
            missing.textContent = "(supprimée)";
            missing.style.cssText = "font-size:10px;color:var(--bad);font-style:italic";
            strip.appendChild(missing);
            continue;
          }
          if (!p.dataUrl) continue; // blob still loading during restore → skip (avoids GET /null 404)
          const thumb = document.createElement("img");
          thumb.src = p.dataUrl;
          thumb.alt = p.name;
          thumb.title = `${p.name} — cliquer pour agrandir`;
          thumb.style.cssText =
            "width:40px;height:40px;object-fit:cover;border-radius:3px;border:1px solid var(--border);cursor:zoom-in";
          thumb.addEventListener("click", () => {
            import("./metrics.js").then(({ openImageModal }) => {
              openImageModal(p.dataUrl, `<b>${p.name}</b>`, p.dataUrl);
            });
          });
          strip.appendChild(thumb);
        }
        div.appendChild(strip);
      }
      log.appendChild(div);
    }
    if (chatBusy) {
      const t = document.createElement("div");
      t.className = "chat-typing";
      t.style.display = "flex";
      t.style.alignItems = "center";
      t.style.gap = "8px";
      t.innerHTML = `<span class="spinner sm"></span> Claude réfléchit…`;
      log.appendChild(t);
    }
    log.scrollTop = log.scrollHeight;

    actEl.innerHTML = "";
    const last = [...app.conversation].reverse().find((m) => m.role === "assistant");
    if (last?.next_actions && !chatBusy) {
      // Filter out any free-text / send-photo style action the model may still produce —
      // the permanent composer below already provides both, so duplicates clutter the UI.
      const filteredActions = last.next_actions.filter((a) => {
        const id = (a.id || "").toLowerCase();
        if (id === "free_text" || id === "other" || id === "autre" || id === "send_photo") return false;
        const label = (a.label || "").toLowerCase();
        if (/^(autre|poser une question|envoyer une photo|free.?text)/.test(label.trim())) return false;
        return true;
      });
      for (const a of filteredActions) {
        const b = document.createElement("button");
        b.className = "chat-action";
        b.textContent = a.label;
        b.onclick = async () => {
          const handler = ACTION_HANDLERS[a.id];
          if (handler) {
            chatBusy = true;
            renderChat();
            try {
              const result = await handler(a);
              chatBusy = false;
              if (result?.followup_text)
                sendTurn({ kind: "text", text: result.followup_text, attachPhotos: result.attachPhotos });
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
      // Two always-available user-initiated forks (replaces the vague "Autre…").
      // Both open the same composer; the photo variant pre-triggers the file picker.
      const askBtn = document.createElement("button");
      askBtn.className = "chat-action";
      askBtn.textContent = "✏ Poser une question";
      askBtn.onclick = () => {
        freeTextOpen = true;
        renderChat();
      };
      actEl.appendChild(askBtn);

      const photoBtn = document.createElement("button");
      photoBtn.className = "chat-action";
      photoBtn.textContent = "📷 Envoyer une photo";
      photoBtn.onclick = async () => {
        freeTextOpen = true;
        renderChat();
        await showPhotoSourceChooser();
      };
      actEl.appendChild(photoBtn);
    }
    // Empty state (no conversation yet): offer the composer directly so the user can ask a
    // question or get help WITHOUT first selecting a parcel/photo — e.g. "comment utiliser
    // l'app ?" or attaching a document. The "Démarrer l'analyse" button stays input-gated (an
    // analysis with nothing to analyse is meaningless); this is the free-form chat entry point.
    if (app.conversation.length === 0 && !chatBusy) {
      const askBtn = document.createElement("button");
      askBtn.className = "chat-action";
      askBtn.textContent = "✏ Poser une question";
      askBtn.onclick = () => {
        freeTextOpen = true;
        renderChat();
      };
      actEl.appendChild(askBtn);

      const photoBtn = document.createElement("button");
      photoBtn.className = "chat-action";
      photoBtn.textContent = "📷 Envoyer une photo";
      photoBtn.onclick = async () => {
        freeTextOpen = true;
        renderChat();
        await showPhotoSourceChooser();
      };
      actEl.appendChild(photoBtn);
    }
    document.getElementById("chat-input-row").style.display = freeTextOpen ? "flex" : "none";
    if (freeTextOpen) document.getElementById("chat-text").focus();
  }

  function resetChat() {
    app.conversation.length = 0;
    app.setConversationDialect?.(null);
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
  async function sendTurn(userInput, opts = {}) {
    if (!WORKER_URL && !ANTHROPIC_API_KEY) {
      app.aStatus.textContent = "Configure WORKER_URL ou ANTHROPIC_API_KEY.";
      return;
    }
    if (chatBusy) return;
    // User-initiated turn → open the chat section so the user sees the result. NOT
    // called from renderChat, so Dropbox restore doesn't pop the section every reload.
    // `keepClosed` skips the jump for callers that surface progress elsewhere (e.g. the
    // "Lancer l'analyse IA" button in the Grille normalisée runs inline, grid-only).
    if (!opts.keepClosed) {
      const sec = document.getElementById("chat-section");
      if (sec && !sec.open) sec.open = true;
    }
    if (app.isOverHardLimit?.()) {
      app.aStatus.textContent = "⛔ Limite de tokens atteinte — Recommencer pour continuer.";
      return;
    }
    const turnIndex = app.conversation.length / 2;
    const isFirstTurn = app.conversation.length === 0;

    // Conversation language tracking. On the first turn, snapshot the current preference.
    // On every subsequent turn, detect a change and surface it to the model as a context note.
    const currentDialect = app.getCurrentDialect?.() ?? "fr";
    let dialectChangeNote = null;
    let previousDialect = null;
    if (isFirstTurn) {
      app.setConversationDialect?.(currentDialect);
    } else {
      const stored = app.getConversationDialect?.();
      if (stored && stored !== currentDialect) {
        previousDialect = stored;
        dialectChangeNote = `[Changement de langue : ${stored} → ${currentDialect}. À partir de maintenant, adapte la langue de tes réponses${currentDialect === "fr" ? " (français standard, sans terme vernaculaire forcé)" : currentDialect === "rcf" ? " (créole réunionnais — kréol rénioné — utilise name_local pour les maladies et traitements)" : currentDialect === "gcf" ? " (créole antillais — utilise name_local pour les maladies et traitements)" : ` (code ${currentDialect})`}.]`;
        app.setConversationDialect?.(currentDialect);
      }
    }

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
      // Subsequent turn: attach any photos the action handler delivered, then the text.
      if (userInput?.attachPhotos?.length) {
        for (const p of userInput.attachPhotos) {
          userContent.push({
            type: "image",
            source: { type: "base64", media_type: p.mime, data: p.b64 },
          });
        }
      }
      const baseText =
        userInput?.kind === "action"
          ? `[Action choisie : ${userInput.id}] — ${userInput.label}`
          : userInput?.text || "(continuer)";
      const text = dialectChangeNote ? `${dialectChangeNote}\n\n${baseText}` : baseText;
      userContent.push({ type: "text", text });
    }

    app.conversation.push({
      role: "user",
      content: isFirstTurn
        ? "(contexte initial + photos)"
        : userInput?.kind === "action"
          ? `[${userInput.id}]`
          : userInput?.text || "(continuer)",
      display: userDisplay,
      // First turn bundles all current photos with the context block; subsequent turns
      // only attach the explicit composer/action photos. Track both so the chat strip
      // shows the right thumbnails.
      attachPhotoIds: isFirstTurn
        ? app.photos.map((p) => p.id)
        : userInput?.attachPhotos?.map((p) => p.id) || [],
      // Snapshot of the dialect under which this turn was sent + previous dialect if changed.
      dialect: currentDialect,
      dialectChangedFrom: previousDialect,
      turn: turnIndex,
    });
    chatBusy = true;
    app.setButtonsDisabled(true);
    renderChat();
    // Reflect "analyse en cours" in the Grille normalisée so a grid-launched analysis shows
    // progress in place (rather than only inside the chat log).
    app.renderMetrics?.(app.getAnalysisCombined());

    const apiMessages = app.conversation.map((m, i) => {
      if (m.role === "user" && i === 0) return { role: "user", content: userContent };
      if (m.role === "user") {
        const content = [];
        // Re-attach any photos referenced by this turn (skipped if the user has since deleted them).
        if (m.attachPhotoIds?.length) {
          for (const id of m.attachPhotoIds) {
            const p = app.photos.find((x) => x.id === id);
            if (p) {
              content.push({
                type: "image",
                source: { type: "base64", media_type: p.mime, data: p.b64 },
              });
            }
          }
        }
        content.push({ type: "text", text: m.content });
        return { role: "user", content };
      }
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
      ? { "content-type": "application/json", "anthropic-version": "2023-06-01", ...workerAuthHeader() }
      : {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        };

    try {
      const r = await fetch(url, { method: "POST", headers, body: payload });
      const j = await r.json();
      if (j.error) {
        if (handleAiAccessError(j)) return;
        throw new Error(j.message || j.error.message || JSON.stringify(j.error));
      }
      app.onUsage?.(j.usage, ANTHROPIC_MODEL);
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
            photos: app.photos,
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
      // Clear the grid's "analyse en cours" state: fills with results if a metrics_update
      // arrived, otherwise falls back to the empty-state button (e.g. an error or no metrics).
      app.renderMetrics?.(app.getAnalysisCombined());
    }
  }

  function setFreeTextOpen(v) {
    freeTextOpen = v;
  }
  function isChatBusy() {
    return chatBusy;
  }

  // Drain any pending composer attachments — called by main.js when the send button fires.
  function takeComposerAttachments() {
    const drained = composerPhotos;
    composerPhotos = [];
    renderComposerAttachments();
    return drained;
  }

  return {
    renderChat,
    sendTurn,
    resetChat,
    ACTION_HANDLERS,
    setFreeTextOpen,
    isChatBusy,
    composerPickPhoto,
    takeComposerAttachments,
    renderComposerAttachments,
  };
}
