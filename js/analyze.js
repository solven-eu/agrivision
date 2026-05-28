// AgriVision RE — full report generation + analyze-button availability state.
// `generateReport` is the "📊 Rapport" path: one heavy call returning the full structured
// schema (identification + health + phenology + yield + market + diseases + photo_tags +
// cross_check). Distinct from the conversational chat module (which makes lighter, cheaper turns).

import { WORKER_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "./config.js";
import { SYSTEM_PROMPT, buildContextBlock } from "./prompts.js";
import { FULL_REPORT_SCHEMA } from "./schemas.js";
import { aggregateParcels } from "./state.js";
import { robustParseJson } from "./util.js";

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
    if (start && app.conversation.length === 0) start.disabled = !hasInputs || app.isChatBusy();
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

  return {
    inputFingerprint,
    setButtonsDisabled,
    updateAnalyzeAvailability,
    generateReport,
    getLastFingerprint,
    setLastFingerprint,
  };
}
