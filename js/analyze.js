// AgriVision RE — full report generation + analyze-button availability state.
// `generateReport` is the "📊 Rapport" path: one heavy call returning the full structured
// schema (identification + health + phenology + yield + market + diseases + photo_tags +
// cross_check). Distinct from the conversational chat module (which makes lighter, cheaper turns).

import { WORKER_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, MISTRAL_MODEL } from "./config.js";
import { ask } from "./ai-providers.js";
import { SYSTEM_PROMPT, buildContextBlock } from "./prompts.js";
import { FULL_REPORT_SCHEMA, DISEASES_SCHEMA, PHOTO_TAG_SCHEMA } from "./schemas.js";
import { aggregateParcels } from "./state.js";
import { robustParseJson } from "./util.js";
import { shareAttribHeaders } from "./share.js";
import { handleAiAccessError } from "./billing.js";

/**
 * @param {object} app - dependency bundle:
 *   - selectedParcels (Map), photos (Array)
 *   - conversation (Array), userProfile (Object) — both passed to DBX save envelope
 *   - map (Leaflet), aStatus (DOM)
 *   - getAnalysisCombined / setAnalysisCombined — accessors
 *   - getBioMode, getCurrentAddress — accessors
 *   - isChatBusy (fn) — main.js delegates to chat module's busy flag
 *   - renderMetrics, renderDiseases, renderCrossCheck, renderParcelHighlight, renderPhotos (fns)
 *   - saveAnalysis (fn) — DBX.setAnalysis envelope writer
 */
export function createAnalyze(app) {
  let lastAnalyzedFingerprint = null;

  // Hash of inputs that would change the analysis output.
  function inputFingerprint() {
    const parts = [
      app.getCurrentAddress()?.label || "",
      [...app.selectedParcels.keys()].sort().join("|"),
      app.photos
        .map((p) => `${p.id}@${p.lat ?? "?"},${p.lon ?? "?"}|${p.direction ?? "?"}`)
        .sort()
        .join("||"),
      document.getElementById("dialect")?.value || "fr",
    ];
    return parts.join("§") + "§bio=" + app.getBioMode();
  }

  function setButtonsDisabled(d) {
    const start = document.getElementById("chat-start");
    if (start) start.disabled = d || app.conversation.length > 0;
    const send = document.getElementById("chat-send");
    if (send) send.disabled = d;
    const report = document.getElementById("report-btn");
    if (report) report.disabled = d || (app.photos.length === 0 && app.selectedParcels.size === 0);
  }

  function updateAnalyzeAvailability() {
    const hasPhotos = app.photos.length > 0;
    const hasParcels = app.selectedParcels.size > 0;
    const hasInputs = hasPhotos || hasParcels;
    const start = document.getElementById("chat-start");
    if (start) {
      // Démarrer = turn 0 only. Once the conversation has any turns, disable to avoid the
      // sendTurn(null)-after-restore code path that was throwing.
      if (app.conversation.length > 0) start.disabled = true;
      else start.disabled = !hasInputs || app.isChatBusy();
    }
    if (app.conversation.length > 0) {
      const top = Object.entries(app.userProfile.scores || {})
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v}`)
        .join(" / ");
      app.aStatus.textContent = `${app.conversation.length} tour(s)${top ? " · " + top : ""}`;
    } else if (!hasInputs) {
      app.aStatus.textContent = "Sélectionnez une parcelle ou ajoutez une photo pour démarrer.";
    } else {
      app.aStatus.textContent = `${app.photos.length} photo(s) · ${app.selectedParcels.size} parcelle(s) — prêt à démarrer.`;
    }
  }

  async function generateReport() {
    if (!WORKER_URL && !ANTHROPIC_API_KEY) {
      app.aStatus.textContent = "Configure le worker/clé.";
      return;
    }
    if (app.photos.length === 0 && app.selectedParcels.size === 0) return;
    setButtonsDisabled(true);
    app.aStatus.textContent = "📊 Génération du rapport complet…";

    const bioMode = app.getBioMode();
    const bioInstruction =
      bioMode === "bio"
        ? `\nMode BIO STRICT : traitements AB uniquement. Rendements + prix bio.`
        : bioMode === "conventional"
          ? `\nMode conventionnel.`
          : "";

    const userText = `${buildContextBlock({
      selectedParcels: app.selectedParcels,
      photos: app.photos,
      currentAddress: app.getCurrentAddress(),
      bioMode,
      map: app.map,
    })}

Schéma JSON cible :
${JSON.stringify(FULL_REPORT_SCHEMA, null, 2)}

Consigne : MODE RAPPORT COMPLET. Pour chaque photo (numérotée 1..N dans l'ordre fourni), retourne UN objet dans photo_tags avec son shot_type, plant_count_visible, maturity, health, qualité, et si elle semble représentative. Effectue ensuite cross_check : compare les photos overview vs single_plant. Si discrepancy détectée (ex: overview sain mais single_plant malade), liste-la dans cross_check.discrepancies — c'est crucial pour décider si re-photographier.${bioInstruction}

Format : UNIQUEMENT le JSON rempli. Pas de markdown.`;

    const content = [];
    for (const p of app.photos)
      content.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.b64 } });
    content.push({ type: "text", text: userText });

    const payload = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
    const useWorker = !!WORKER_URL;
    const url = useWorker
      ? `${WORKER_URL.replace(/\/$/, "")}/api/analyze`
      : "https://api.anthropic.com/v1/messages";
    const headers = useWorker
      ? { "content-type": "application/json", "anthropic-version": "2023-06-01", ...shareAttribHeaders() }
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

      if (app.selectedParcels.size > 0) {
        const { totalArea, byCrop } = aggregateParcels(app.selectedParcels);
        parsed.parcels_summary = parsed.parcels_summary || {};
        parsed.parcels_summary.count = app.selectedParcels.size;
        parsed.parcels_summary.total_area_ha = totalArea;
        parsed.parcels_summary.crops_breakdown = Object.entries(byCrop).map(([code, a]) => ({
          code_cultu: code,
          area_ha: a.area,
          share_pct: totalArea > 0 ? (a.area / totalArea) * 100 : 0,
        }));
        if (parsed.yield?.estimated_t_per_ha && totalArea > 0) {
          parsed.yield.estimated_total_t = parsed.yield.estimated_t_per_ha * totalArea;
          if (parsed.market?.indicative_price_eur_per_kg) {
            parsed.market.estimated_total_value_eur =
              parsed.yield.estimated_total_t * 1000 * parsed.market.indicative_price_eur_per_kg;
          }
        }
      }
      const merged = { ...(app.getAnalysisCombined() || {}), ...parsed };
      app.setAnalysisCombined(merged);

      if (Array.isArray(parsed.photo_tags)) {
        for (const tag of parsed.photo_tags) {
          const photo = app.photos[tag.photo_index - 1];
          if (photo) {
            photo.tags = { ...(photo.tags || {}), ...tag, analyzed_at: new Date().toISOString() };
          }
        }
        app.renderPhotos();
      }

      app.renderMetrics(merged);
      if (merged.diseases) {
        app.renderDiseases(merged.diseases, {
          photos: app.photos,
          t_per_ha: merged.yield?.estimated_t_per_ha,
          price_eur_per_kg: merged.market?.indicative_price_eur_per_kg,
          total_area_ha: merged.parcels_summary?.total_area_ha,
        });
      }
      app.renderCrossCheck(merged.cross_check);
      app.renderParcelHighlight();
      app.saveAnalysis({
        analysis: merged,
        conversation: app.conversation,
        user_profile: app.userProfile,
      });
      app.aStatus.textContent = "✓ Rapport complet généré.";
    } catch (e) {
      app.aStatus.textContent = "Erreur : " + e.message;
    } finally {
      setButtonsDisabled(false);
      updateAnalyzeAvailability();
    }
  }

  function getLastFingerprint() {
    return lastAnalyzedFingerprint;
  }
  function setLastFingerprint(v) {
    lastAnalyzedFingerprint = v;
  }

  // Lazy generation of the "Marché" or "Notes" cell. Lightweight call: no photo payload,
  // just the context block + the identification the parent already has, and a tight schema.
  async function generateField(scope) {
    if (!WORKER_URL && !ANTHROPIC_API_KEY) {
      app.aStatus.textContent = "Configure le worker/clé.";
      return;
    }
    const current = app.getAnalysisCombined() || {};
    const idBlock = current.identification || {};
    const yieldBlock = current.yield || {};
    const parcelsBlock = current.parcels_summary || {};
    const ctx = buildContextBlock({
      selectedParcels: app.selectedParcels,
      photos: app.photos,
      currentAddress: app.getCurrentAddress(),
      bioMode: app.getBioMode(),
      map: app.map,
    });
    const schema =
      scope === "market"
        ? `{"market":{"indicative_price_eur_per_kg":"number — prix DÉPART PRODUCTEUR (€/kg) selon RNM FranceAgriMer / cours départemental pour la culture+région+saison","source_hint":"string — référentiel cité (ex: 'RNM FranceAgriMer — banane export Réunion 2025')","notes":"string — caveats sur le prix : variabilité, conditions de campagne, écart vrac/conditionné"}}`
        : `{"notes":"string — caveats de l'analyse (3-5 phrases) : ce qui n'a pas pu être évalué faute de photos, les hypothèses prises, et un avertissement honnête sur les limites de la prédiction"}`;
    const knownCtx = `Culture identifiée : ${idBlock.dominant_crop_fr || "?"}${idBlock.cultivar_or_variety_fr ? ` (${idBlock.cultivar_or_variety_fr})` : ""}${idBlock.scientific_name ? ` — ${idBlock.scientific_name}` : ""}.
Surface totale : ${parcelsBlock.total_area_ha ?? "?"} ha.
Rendement estimé : ${yieldBlock.estimated_t_per_ha ?? "?"} t/ha.`;
    const userText = `${ctx}

${knownCtx}

Schéma JSON cible (rempli uniquement avec ${scope === "market" ? "les infos de marché" : "des notes / caveats"}) :
${schema}

Format : UNIQUEMENT le JSON rempli. Pas de markdown.`;
    app.aStatus.textContent = scope === "market" ? "🌾 Génération marché…" : "📝 Génération notes…";
    const useWorker = !!WORKER_URL;
    const url = useWorker
      ? `${WORKER_URL.replace(/\/$/, "")}/api/analyze`
      : "https://api.anthropic.com/v1/messages";
    const headers = useWorker
      ? { "content-type": "application/json", "anthropic-version": "2023-06-01", ...shareAttribHeaders() }
      : {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        };
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 800,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
        }),
      });
      const j = await r.json();
      if (j.error) {
        if (handleAiAccessError(j)) return;
        throw new Error(j.message || j.error.message || JSON.stringify(j.error));
      }
      app.onUsage?.(j.usage, ANTHROPIC_MODEL);
      const parsed = robustParseJson(j.content?.[0]?.text || "");
      const merged = { ...current };
      if (scope === "market" && parsed.market) {
        merged.market = { ...(merged.market || {}), ...parsed.market };
        // Recompute total value if price came in fresh.
        if (parsed.market.indicative_price_eur_per_kg && merged.yield?.estimated_total_t) {
          merged.market.estimated_total_value_eur =
            merged.yield.estimated_total_t * 1000 * parsed.market.indicative_price_eur_per_kg;
        }
      } else if (scope === "notes" && parsed.notes) {
        merged.notes = parsed.notes;
      }
      app.setAnalysisCombined(merged);
      app.renderMetrics(merged);
      app.saveAnalysis?.({
        analysis: merged,
        conversation: app.conversation,
        user_profile: app.userProfile,
      });
      app.aStatus.textContent = scope === "market" ? "✓ Marché à jour" : "✓ Notes à jour";
    } catch (e) {
      app.aStatus.textContent = "Erreur : " + e.message;
      app.renderMetrics(current); // restore button
    }
  }

  // Lazy generation of the disease section. Heavier than market/notes because we send the
  // photos: the model needs them to fill `evidence.supporting` + `detections` + photo-grounded
  // `missing` items. Uses DISEASES_SCHEMA to keep the response narrow (no health/yield/etc).
  async function generateDiseases() {
    if (!WORKER_URL && !ANTHROPIC_API_KEY) {
      app.aStatus.textContent = "Configure le worker/clé.";
      return;
    }
    const current = app.getAnalysisCombined() || {};
    const idBlock = current.identification || {};
    const phBlock = current.phenology || {};
    const ctx = buildContextBlock({
      selectedParcels: app.selectedParcels,
      photos: app.photos,
      currentAddress: app.getCurrentAddress(),
      bioMode: app.getBioMode(),
      map: app.map,
    });
    const knownCtx = `Culture identifiée : ${idBlock.dominant_crop_fr || "?"}${idBlock.cultivar_or_variety_fr ? ` (${idBlock.cultivar_or_variety_fr})` : ""}${idBlock.scientific_name ? ` — ${idBlock.scientific_name}` : ""}.
Stade phénologique : ${phBlock.current_stage || "?"}. Récolte dans ${phBlock.expected_harvest_in_days ?? "?"} j.`;
    const userText = `${ctx}

${knownCtx}

Schéma JSON cible :
${JSON.stringify(DISEASES_SCHEMA, null, 2)}

Consigne : applique LA MÉTHODE EN 6 ÉTAPES vue dans le system prompt (base rate → evidence → conclusion → progression → 3 scénarios → E[impact]). Si peu d'éléments visuels, déclare-le honnêtement via \`unknown_rate_0_1\` élevé et \`evidence.missing\` actionnable.

Format : UNIQUEMENT le JSON rempli. Pas de markdown.`;
    app.aStatus.textContent = "🔬 Analyse maladies en cours…";
    const content = [];
    for (const p of app.photos)
      content.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.b64 } });
    content.push({ type: "text", text: userText });
    const useWorker = !!WORKER_URL;
    const url = useWorker
      ? `${WORKER_URL.replace(/\/$/, "")}/api/analyze`
      : "https://api.anthropic.com/v1/messages";
    const headers = useWorker
      ? { "content-type": "application/json", "anthropic-version": "2023-06-01", ...shareAttribHeaders() }
      : {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        };
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 6000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content }],
        }),
      });
      const j = await r.json();
      if (j.error) {
        if (handleAiAccessError(j)) return;
        throw new Error(j.message || j.error.message || JSON.stringify(j.error));
      }
      app.onUsage?.(j.usage, ANTHROPIC_MODEL);
      const parsed = robustParseJson(j.content?.[0]?.text || "");
      const merged = { ...current };
      if (Array.isArray(parsed.diseases)) merged.diseases = parsed.diseases;
      app.setAnalysisCombined(merged);
      app.renderDiseases(merged.diseases, {
        t_per_ha: merged.yield?.estimated_t_per_ha,
        price_eur_per_kg: merged.market?.user_price_eur_per_kg ?? merged.market?.indicative_price_eur_per_kg,
        total_area_ha: merged.parcels_summary?.total_area_ha,
        photos: app.photos,
      });
      app.saveAnalysis?.({
        analysis: merged,
        conversation: app.conversation,
        user_profile: app.userProfile,
      });
      app.aStatus.textContent = `✓ ${parsed.diseases?.length || 0} maladie(s) analysée(s)`;
    } catch (e) {
      app.aStatus.textContent = "Erreur : " + e.message;
      // Restore previous render so the button comes back.
      app.renderDiseases(current.diseases, {
        t_per_ha: current.yield?.estimated_t_per_ha,
        price_eur_per_kg:
          current.market?.user_price_eur_per_kg ?? current.market?.indicative_price_eur_per_kg,
        total_area_ha: current.parcels_summary?.total_area_ha,
        photos: app.photos,
      });
    }
  }

  // Per-photo analysis. Fired automatically on upload and on the 🔬 button click.
  // Single-image payload, narrow PHOTO_TAG_SCHEMA. Mutates `photo.tags` and re-renders.
  //
  // v2: routes to Mistral Pixtral-12B (~1/7 the cost of Claude Haiku for the same task).
  // No prompt caching → use a tight system prompt instead of the giant SYSTEM_PROMPT.
  // Falls back to Anthropic automatically if the Worker reports MISTRAL_API_KEY missing.
  async function analyzePhoto(photo) {
    if (!WORKER_URL && !ANTHROPIC_API_KEY) {
      photo.analyzing = false;
      return;
    }
    const schema = JSON.stringify(PHOTO_TAG_SCHEMA, null, 2);
    const tightSystem = `Tu es un assistant agronome FR qui annote une photo soumise par un agriculteur.

ÉTAPE 1 — Classifie le contenu (\`content_type\`) :
- 'crop_field', 'single_plant', 'plant_detail' → photo agricole, remplis tous les champs normalement.
- 'administrative_document' → facture, courrier MSA, déclaration PAC, etc. Met shot_type='unknown' et la plupart des champs agronomiques à null. Mets dans \`observation\` un résumé d'1 phrase de ce que tu vois ("facture EDF, montant 245 €, échéance 15 juin").
- 'phyto_label' → étiquette/emballage produit phyto. observation = nom commercial + matière active + dose si lisibles.
- 'map_or_plan' → plan, carte. observation = ce que représente le plan.
- 'equipment' → matériel agricole. observation = type de matériel.
- 'unknown_or_unrelated' → hors cadre. observation = "photo non agricole".

ÉTAPE 2 — Remplis les autres champs uniquement si pertinents pour ce content_type.

Tu retournes UNIQUEMENT un objet JSON conforme au schéma. Pas de markdown, pas de texte hors JSON. Utilise null pour ce qui n'est pas évaluable — n'invente jamais.`;
    const userText = `Analyse cette UNIQUE photo. Renvoie un objet JSON conforme à ce schéma (photo_index = 1) :
${schema}`;
    const content = [
      { type: "image", source: { type: "base64", media_type: photo.mime, data: photo.b64 } },
      { type: "text", text: userText },
    ];
    const payload = {
      max_tokens: 800,
      system: tightSystem,
      messages: [{ role: "user", content }],
    };
    let providerUsed = "mistral";
    let modelUsed = MISTRAL_MODEL;
    let result;
    try {
      result = await ask("mistral", payload);
      // 503 = MISTRAL_API_KEY not configured on the Worker → automatic Anthropic fallback.
      if (!result.ok && result.status === 503) {
        result = await ask("anthropic", { ...payload, system: SYSTEM_PROMPT });
        providerUsed = "anthropic";
        modelUsed = ANTHROPIC_MODEL;
      }
      if (!result.ok) {
        if (handleAiAccessError(result.body)) return;
        throw new Error(result.body?.message || result.body?.error?.message || JSON.stringify(result.body));
      }
      app.onUsage?.(result.body.usage, modelUsed);
      const text = result.body?.content?.[0]?.text || "";
      const parsed = robustParseJson(text);
      photo.tags = {
        ...(photo.tags || {}),
        ...parsed,
        analyzed_at: new Date().toISOString(),
        analyzed_by: providerUsed,
      };
    } catch (e) {
      console.warn("analyzePhoto error:", e.message);
    } finally {
      photo.analyzing = false;
      app.renderPhotos();
      app.saveAnalysis?.({
        analysis: app.getAnalysisCombined(),
        conversation: app.conversation,
        user_profile: app.userProfile,
      });
    }
  }

  return {
    inputFingerprint,
    setButtonsDisabled,
    updateAnalyzeAvailability,
    generateReport,
    generateField,
    generateDiseases,
    analyzePhoto,
    getLastFingerprint,
    setLastFingerprint,
  };
}
