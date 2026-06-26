// AgriVision RE — metrics + disease + cross-check rendering.
// Pure rendering: takes a parsed-analysis object and writes to the DOM. Side effects on
// `analysisCombined` (price override) are delegated back via the `onPriceEdit` callback,
// so this module never touches main.js state directly.

import { formatRelativeDays, fmtEUR, numOr } from "./util.js";
import { CULTU_LABELS, DISEASE_CATALOG, lookupCropImage, lookupTaxonImage } from "./catalog.js";
import { toast } from "./toast.js";

// FR labels for the application_method enum (matches the prompt taxonomy).
const APPLICATION_METHOD_LABELS = {
  mechanized_spray: "🚜 pulvé tractée",
  manual_backpack: "🎒 atomiseur dos",
  per_plant_manual: "🌳 plant par plant",
  aerial: "✈️ drone/avion",
};

// Lightweight in-app lightbox for reference images (crops, diseases, photo bank).
// Reuses a single backdrop element; closes on backdrop click, ESC, or the close button.
let _imageModalEl = null;
function ensureImageModal() {
  if (_imageModalEl) return _imageModalEl;
  const el = document.createElement("div");
  el.id = "image-modal";
  el.style.cssText =
    "display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.85);" +
    "align-items:center;justify-content:center;flex-direction:column;padding:16px;gap:12px";
  el.innerHTML = `
    <button id="image-modal-close" aria-label="Fermer" style="position:absolute;top:12px;right:16px;background:transparent;color:#fff;border:0;font-size:28px;cursor:pointer;line-height:1">×</button>
    <img id="image-modal-img" alt="" style="max-width:min(100%,1400px);max-height:80vh;object-fit:contain;border-radius:4px;background:#222" />
    <div id="image-modal-caption" style="color:#eee;font-size:13px;text-align:center;max-width:90vw">
      <a id="image-modal-link" target="_blank" rel="noopener" style="color:#9cf;text-decoration:underline">Ouvrir la source ↗</a>
    </div>`;
  document.body.appendChild(el);
  const close = () => {
    el.style.display = "none";
    el.querySelector("#image-modal-img").src = "";
  };
  el.addEventListener("click", (e) => {
    if (e.target === el) close();
  });
  el.querySelector("#image-modal-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.style.display !== "none") close();
  });
  _imageModalEl = el;
  return el;
}

export function openImageModal(url, captionHtml, sourceUrl) {
  const el = ensureImageModal();
  el.querySelector("#image-modal-img").src = url;
  const captionDiv = el.querySelector("#image-modal-caption");
  const link = el.querySelector("#image-modal-link");
  link.href = sourceUrl || url;
  // Caption text precedes the source-link anchor. Rebuild safely.
  captionDiv.innerHTML = `${captionHtml || ""} <a id="image-modal-link" href="${sourceUrl || url}" target="_blank" rel="noopener" style="color:#9cf;text-decoration:underline">Ouvrir la source ↗</a>`;
  el.style.display = "flex";
}

// Wires a slot's child <a> to open the modal instead of navigating away. Idempotent.
function wireSlotModal(slot, sourceUrl, captionHtml) {
  const a = slot.querySelector("a");
  if (!a) return;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const img = a.querySelector("img");
    openImageModal(img?.src || sourceUrl, captionHtml, sourceUrl);
  });
}

// Read the user's labor-rate override from localStorage at every cost computation,
// so changes take effect immediately without a page reload.
function userLaborRateOverride() {
  const v = parseFloat(localStorage.getItem("agri_labor_rate_eur_per_h") || "");
  return isFinite(v) && v > 0 ? v : null;
}

/** Total per-ha treatment cost = materials + (prep+apply) × labor_rate + equipment. */
export function treatmentTotalCost(t) {
  const c = t.cost_breakdown || {};
  // numOr: the model may emit these as strings ("35") — coerce so the arithmetic below stays
  // numeric (string "+" would concatenate and break every downstream .toFixed).
  const mat = numOr(c.materials_eur_per_ha, 0);
  const equip = numOr(c.equipment_eur_per_ha, 0);
  const prep = numOr(c.prep_time_h_per_ha, 0);
  const apply = numOr(c.application_time_h_per_ha, 0);
  const override = userLaborRateOverride();
  const rate = override ?? numOr(c.labor_eur_per_h, 0);
  const labor = (prep + apply) * rate;
  const method = c.application_method || null;
  return {
    total: mat + labor + equip,
    materials: mat,
    labor,
    equipment: equip,
    prep,
    apply,
    rate,
    rateOverridden: override != null,
    totalTime: prep + apply,
    method,
    methodLabel: method ? APPLICATION_METHOD_LABELS[method] || method : null,
  };
}

/**
 * @param {object} m - combined analysis (identification, parcels_summary, health, phenology, yield, market, notes)
 * @param {object} [hooks] - { onPriceEdit(rawAnswer: string|null) — called when user submits a new price }
 */
export function renderMetrics(m, hooks = {}) {
  const el = document.getElementById("metrics");
  el.innerHTML = "";
  // Explicit empty state — without this the "Grille normalisée" section just looked blank/broken
  // when no analysis had run. Show what's missing and a one-tap way to trigger the AI analysis.
  if (!m || !m.identification) {
    const box = document.createElement("div");
    box.style.cssText = "grid-column:1/-1;text-align:center;padding:12px 6px;color:var(--muted)";
    // Analysis in flight (launched from here or the chat) → show progress in place; the cells
    // fill when the analysis returns, without bouncing the user to the Conversation IA section.
    if (hooks.busy) {
      box.innerHTML = `<div class="small" style="display:flex;align-items:center;justify-content:center;gap:8px"><span class="spinner sm"></span> Analyse en cours… la grille se remplit dès que c'est prêt.</div>`;
      el.appendChild(box);
      return;
    }
    box.innerHTML = `<div class="small" style="margin-bottom:8px">Aucune analyse IA pour l'instant — la grille se remplit après une analyse.</div>`;
    const btn = document.createElement("button");
    btn.style.cssText = "font-size:12px;padding:6px 12px";
    btn.textContent = "🔬 Lancer l'analyse IA";
    btn.onclick = () => {
      // Run inline: start the analysis without opening/jumping to the Conversation IA section.
      // The grid's own "analyse en cours" state (above) is the feedback; the chat section's
      // status line still reports if inputs are missing or an upstream error blocks it.
      hooks.onLaunchAnalysis?.();
    };
    box.appendChild(btn);
    el.appendChild(box);
    return;
  }
  const cell = (k, v, opts = {}) => {
    const d = document.createElement("div");
    d.className = "cell" + (opts.full ? " full" : "");
    d.innerHTML = `<div class="k">${k}</div><div class="v">${v ?? "—"}</div>`;
    if (opts.bar != null) {
      const cls =
        opts.bar > 66 ? (opts.invert ? "bad" : "") : opts.bar > 33 ? "warn" : opts.invert ? "" : "bad";
      const bar = document.createElement("div");
      bar.className = "bar " + cls;
      bar.innerHTML = `<div style="width:${Math.max(0, Math.min(100, opts.bar))}%"></div>`;
      d.appendChild(bar);
    }
    el.appendChild(d);
  };
  const id = m.identification || {};
  const ps = m.parcels_summary || {};
  const h = m.health || {};
  const ph = m.phenology || {};
  const y = m.yield || {};
  const mk = m.market || {};

  // Display order: "Bananier Cavendish" (common + cultivar), then scientific name in small.
  const displayName = id.cultivar_or_variety_fr
    ? `${id.dominant_crop_fr ?? "—"} <b>${id.cultivar_or_variety_fr}</b>`
    : `${id.dominant_crop_fr ?? "—"}`;
  cell(
    "Culture dominante",
    `<span id="crop-ref-slot" style="float:right;width:56px;height:56px;background:var(--panel);border:1px solid var(--border);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted);margin-left:8px">…</span>${displayName}${id.scientific_name ? ` <span class="small">(${id.scientific_name})</span>` : ""}`,
    { full: true }
  );
  if (id.dominant_crop_fr || id.scientific_name) {
    lookupCropImage(id.scientific_name, id.dominant_crop_fr).then((res) => {
      const slot = document.getElementById("crop-ref-slot");
      if (!slot) return;
      if (res?.url) {
        slot.innerHTML = `<a href="${res.url}" target="_blank" rel="noopener" title="Photo de référence — ${res.source} (cliquer pour agrandir)"><img src="${res.url}" style="width:100%;height:100%;object-fit:cover;border-radius:3px;cursor:zoom-in" /></a>`;
        slot.style.padding = "0";
        wireSlotModal(
          slot,
          res.url,
          `<b>${displayName}</b>${id.scientific_name ? ` <i>${id.scientific_name}</i>` : ""} — source : ${res.source}`
        );
      } else {
        slot.textContent = "pas de réf.";
      }
    });
  }
  cell("Confiance détection", id.confidence_0_1 != null ? Math.round(id.confidence_0_1 * 100) + " %" : "—", {
    bar: (id.confidence_0_1 ?? 0) * 100,
  });
  const totalAreaHa = numOr(ps.total_area_ha);
  cell(
    "Parcelles",
    `${ps.count ?? "—"} (${totalAreaHa != null ? totalAreaHa.toFixed(2) + " ha" : "?"})`
  );
  cell("Vigueur", h.vigor_0_100 ?? "—", { bar: h.vigor_0_100 });
  cell("Pression maladies", h.disease_pressure_0_100 ?? "—", { bar: h.disease_pressure_0_100, invert: true });

  // Plant counts + fruiting ratio (from the report's photo_tags aggregation).
  const totalP = h.total_plants_estimate;
  const fruitP = h.fruiting_plants_estimate;
  const ratio = h.fruiting_ratio_0_1 ?? (totalP > 0 && fruitP != null ? fruitP / totalP : null);
  if (totalP != null) cell("Plants visibles", String(totalP));
  if (fruitP != null) cell("Avec fruits", String(fruitP));
  if (ratio != null) cell("Ratio fructification", Math.round(ratio * 100) + " %", { bar: ratio * 100 });

  // Lost output ratio — Claude's estimate, editable by the user (override stored on health).
  const userLost = h.user_lost_output_ratio_0_1;
  const modelLost = h.lost_output_ratio_0_1;
  const effLost = userLost != null ? userLost : modelLost;
  if (effLost != null) {
    const src = userLost != null ? "votre estimation" : "défaut modèle";
    const color = userLost != null ? "var(--accent)" : "var(--muted)";
    cell(
      "Pertes attendues",
      `${Math.round(effLost * 100)} % <span style="font-size:9px;color:${color};font-weight:400">${src}</span> <button id="lost-edit" title="Modifier" style="margin-left:6px;background:transparent;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:1px 5px;border-radius:3px;cursor:pointer">✏</button>`,
      { bar: effLost * 100, invert: true }
    );
  }

  cell("Stade", ph.current_stage);
  cell("Maturité", ph.maturity_pct != null ? ph.maturity_pct + " %" : "—", { bar: ph.maturity_pct });
  cell(
    "Récolte attendue",
    `${formatRelativeDays(ph.expected_harvest_in_days)}${ph.expected_harvest_window_iso ? ` <span class="small">(${ph.expected_harvest_window_iso})</span>` : ""}`,
    { full: true }
  );
  const tPerHa = numOr(y.estimated_t_per_ha);
  const totalT = numOr(y.estimated_total_t);
  cell("Rendement t/ha", tPerHa != null ? tPerHa.toFixed(1) : "—");
  cell("Production totale", totalT != null ? totalT.toFixed(1) + " t" : "—");

  // Effective price = user override if set, else model default.
  const userPrice = numOr(mk.user_price_eur_per_kg);
  const modelPrice = numOr(mk.indicative_price_eur_per_kg);
  const effPrice = userPrice != null ? userPrice : modelPrice;
  const priceSource = userPrice != null ? "votre prix" : "défaut RNM";
  const priceColor = userPrice != null ? "var(--accent)" : "var(--muted)";
  const priceVal =
    effPrice != null
      ? `${effPrice.toFixed(2)} €/kg <span style="font-size:9px;color:${priceColor};font-weight:400">${priceSource}</span> <button id="price-edit" title="Modifier" style="margin-left:6px;background:transparent;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:1px 5px;border-radius:3px;cursor:pointer">✏</button>`
      : `— <button id="price-edit" title="Définir" style="background:transparent;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:1px 5px;border-radius:3px;cursor:pointer">✏ définir</button>`;
  cell("Prix vente (départ producteur)", priceVal);
  let totalValue = numOr(mk.estimated_total_value_eur);
  if (effPrice != null && totalT != null) totalValue = totalT * 1000 * effPrice;
  cell("Valeur estimée", fmtEUR(totalValue), { full: false });

  if (Array.isArray(ps.crops_breakdown) && ps.crops_breakdown.length > 1) {
    const txt = ps.crops_breakdown
      .map((c) => {
        const a = numOr(c.area_ha);
        const sh = numOr(c.share_pct);
        return `${CULTU_LABELS[c.code_cultu] || c.code_cultu}: ${a != null ? a.toFixed(2) : "?"} ha (${sh != null ? sh.toFixed(0) : "?"}%)`;
      })
      .join(" · ");
    cell("Répartition cultures", txt, { full: true });
  }
  const obs = (h.spatial_observations || [])
    .map((o) => `photo ${o.photo_index}: ${o.observation}`)
    .join(" · ");
  if (obs) cell("Observations terrain", obs, { full: true });
  // Marché + Notes are lazy: they cost extra context-free reasoning and are rarely
  // consulted in the first pass. Render an empty stub with a "Générer" button by default,
  // and a small "↻ Mettre à jour" when already populated. The hook owns the API call.
  const marketText = `${mk.source_hint || ""} ${mk.notes || ""}`.trim();
  const marketBtnId = "market-gen-btn";
  const marketBody = marketText
    ? `${marketText} <button id="${marketBtnId}" class="secondary" style="font-size:10px;padding:2px 6px;margin-left:6px" title="Régénérer ce bloc">↻</button>`
    : `<span class="small" style="color:var(--muted)">Information non générée. </span><button id="${marketBtnId}" class="secondary" style="font-size:11px;padding:3px 8px">✨ Générer maintenant</button>`;
  cell("Marché", marketBody, { full: true });

  const notesBtnId = "notes-gen-btn";
  const notesBody = m.notes
    ? `${m.notes} <button id="${notesBtnId}" class="secondary" style="font-size:10px;padding:2px 6px;margin-left:6px" title="Régénérer ce bloc">↻</button>`
    : `<span class="small" style="color:var(--muted)">Aucune note pour l'instant. </span><button id="${notesBtnId}" class="secondary" style="font-size:11px;padding:3px 8px">✨ Générer maintenant</button>`;
  cell("Notes", notesBody, { full: true });

  // Lazy-generation buttons for Marché and Notes.
  const marketBtn = document.getElementById(marketBtnId);
  if (marketBtn && hooks.onGenerateMarket) {
    marketBtn.onclick = () => {
      marketBtn.disabled = true;
      marketBtn.textContent = "…";
      hooks.onGenerateMarket();
    };
  }
  const notesBtn = document.getElementById(notesBtnId);
  if (notesBtn && hooks.onGenerateNotes) {
    notesBtn.onclick = () => {
      notesBtn.disabled = true;
      notesBtn.textContent = "…";
      hooks.onGenerateNotes();
    };
  }

  // Wire the price edit button — delegate the actual save logic back to main.js.
  const editBtn = document.getElementById("price-edit");
  if (editBtn && hooks.onPriceEdit)
    editBtn.onclick = () => {
      const current = mk.user_price_eur_per_kg ?? mk.indicative_price_eur_per_kg ?? "";
      const ans = prompt(
        "Prix de vente départ producteur (€/kg) — laisser vide pour revenir au défaut RNM :",
        current
      );
      if (ans === null) return;
      hooks.onPriceEdit(String(ans).trim().replace(",", "."));
    };

  // Lost-output edit (same pattern). Input as percent (0-100); we convert back to 0-1.
  const lostBtn = document.getElementById("lost-edit");
  if (lostBtn && hooks.onLostOutputEdit)
    lostBtn.onclick = () => {
      const cur = h.user_lost_output_ratio_0_1 ?? h.lost_output_ratio_0_1;
      const ans = prompt(
        "Pertes attendues (%) — laisser vide pour revenir au défaut du modèle :",
        cur != null ? Math.round(cur * 100) : ""
      );
      if (ans === null) return;
      hooks.onLostOutputEdit(String(ans).trim().replace(",", "."));
    };
}

/**
 * @param {Array} diseases - the diseases array from the analysis
 * @param {object} ctx - { t_per_ha, price_eur_per_kg, total_area_ha } — used for benefit calculation
 */
/**
 * Compute combined treatment scenarios using a multiplicative loss model.
 *
 * Yield ratio under a strategy S (subset of diseases to treat) is approximated as:
 *   product over diseases d of (1 - presence(d) × residual_impact(d, S))
 * where residual_impact = max(0, |yield_impact_pct| - recovery_pct × success_prob) if d ∈ S
 *                       = |yield_impact_pct| if d ∉ S
 *
 * Probability of "all treatments succeed" = product of treatment success probabilities for d ∈ S.
 * Total treatment cost = sum of selected treatments' totals.
 *
 * Returns the strategies sorted by expected net benefit (descending). The full 2^N enumeration
 * is fine here since N is typically ≤ 6 diseases.
 */
function computeTreatmentScenarios(diseases, cropValuePerHa) {
  if (!cropValuePerHa || !Array.isArray(diseases) || diseases.length === 0) return [];
  // Pick the best treatment per disease (highest standalone net benefit) as the candidate.
  const candidates = diseases
    .filter((d) => d.presence_probability_0_1 != null && d.yield_impact_pct_if_untreated != null)
    .map((d) => {
      const presence = d.presence_probability_0_1;
      const impactPct = Math.abs(d.yield_impact_pct_if_untreated) / 100; // 0-1
      // Best treatment = highest standalone net benefit (recovery_pct × success_prob × presence × V − cost)
      let best = null;
      let bestNet = -Infinity;
      for (const t of d.treatments || []) {
        if (t.recovery_pct == null || t.success_probability_0_1 == null) continue;
        const breakdown = treatmentTotalCost(t);
        const standaloneRecovery = (t.recovery_pct / 100) * cropValuePerHa * presence;
        const net = standaloneRecovery - breakdown.total;
        if (net > bestNet) {
          bestNet = net;
          best = { t, cost: breakdown.total, time: breakdown.totalTime };
        }
      }
      return {
        name: d.name_fr,
        presence,
        impactPct,
        treatment: best?.t || null,
        treatmentCost: best?.cost ?? 0,
        treatmentTime: best?.time ?? 0,
      };
    });

  // Baseline: no treatment.
  const baselineYieldRatio = candidates.reduce((acc, d) => acc * (1 - d.presence * d.impactPct), 1);
  const baselineYield = baselineYieldRatio * cropValuePerHa;

  // Enumerate all subsets (excluding none for the "treat nothing" row which we add explicitly).
  const N = candidates.length;
  const scenarios = [];
  for (let mask = 0; mask < 1 << N; mask++) {
    const selected = candidates.filter((_, i) => mask & (1 << i));
    let yieldRatio = 1;
    let cost = 0;
    let totalTime = 0;
    let pAllSucceed = 1;
    const includedNames = [];
    candidates.forEach((d, i) => {
      const isSelected = !!(mask & (1 << i));
      let effectiveImpact = d.impactPct;
      if (isSelected && d.treatment) {
        // Treatment: assume on success it knocks recovery_pct points off the impact.
        const recPct = (d.treatment.recovery_pct || 0) / 100;
        const sProb = d.treatment.success_probability_0_1;
        // Expected residual impact = (1-s) × full + s × max(0, full − rec)
        const residualOnSuccess = Math.max(0, d.impactPct - recPct);
        effectiveImpact = (1 - sProb) * d.impactPct + sProb * residualOnSuccess;
        cost += d.treatmentCost;
        totalTime += d.treatmentTime;
        pAllSucceed *= sProb;
        includedNames.push(d.name);
      }
      yieldRatio *= 1 - d.presence * effectiveImpact;
    });
    const yieldVal = yieldRatio * cropValuePerHa;
    const recovery = yieldVal - baselineYield; // vs no-treatment baseline
    const netBenefit = recovery - cost;
    scenarios.push({
      mask,
      included: includedNames,
      yieldRatio,
      yieldVal,
      cost,
      totalTime,
      recovery,
      netBenefit,
      pAllSucceed: includedNames.length > 0 ? pAllSucceed : null,
    });
  }
  // Sort: highest net benefit first.
  scenarios.sort((a, b) => b.netBenefit - a.netBenefit);
  return { baseline: { yieldRatio: baselineYieldRatio, yieldVal: baselineYield }, scenarios };
}

/** Build an HTML snippet showing a photo with an SVG circle overlay marking a detection. */
function annotatedPhotoSnippet(photo, det) {
  // Color by severity: green→amber→red
  const sev = det.severity_0_1 ?? 0.5;
  const color = sev < 0.34 ? "#fbbf24" : sev < 0.67 ? "#fb923c" : "#f87171";
  const title = `Photo ${det.photo_index} · sévérité ${Math.round(sev * 100)}%${det.observation ? " — " + det.observation : ""}`;
  return `
    <div style="position:relative;display:inline-block;width:120px;height:auto;border-radius:4px;overflow:hidden;border:1px solid var(--border)" title="${title}">
      <img src="${photo.dataUrl}" style="width:100%;height:auto;display:block" alt="" />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none"
           style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none">
        <circle cx="${det.x_pct}" cy="${det.y_pct}" r="${det.radius_pct}"
                stroke="${color}" stroke-width="2" fill="${color}" fill-opacity="0.18"
                vector-effect="non-scaling-stroke"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;right:0;font-size:9px;color:#fff;background:rgba(0,0,0,0.5);padding:1px 4px">
        photo ${det.photo_index}${det.observation ? " · " + det.observation.slice(0, 40) : ""}
      </div>
    </div>`;
}

export function renderDiseases(diseases, ctx) {
  const el = document.getElementById("diseases");
  if (!Array.isArray(diseases) || diseases.length === 0) {
    const btnId = "diseases-gen-btn";
    el.innerHTML = `
      <div class="small" style="color:var(--muted);margin-bottom:8px">
        Le diagnostic maladie n'est pas généré par défaut — c'est une analyse plus coûteuse.<br>
        Lancer le funnel : (1) maladies probables pour la culture × région × saison, (2) recherche des signes visibles sur les photos, (3) liste des informations manquantes à fournir pour un rapport complet.
      </div>
      <button id="${btnId}" class="primary-capture" style="font-size:13px;padding:8px 14px">✨ Lancer le diagnostic maladies</button>
    `;
    const btn = document.getElementById(btnId);
    if (btn && ctx?.onGenerateDiseases) {
      btn.onclick = () => {
        btn.disabled = true;
        btn.textContent = "🔬 Analyse en cours…";
        ctx.onGenerateDiseases();
      };
    }
    return;
  }
  el.innerHTML = "";
  const refreshBtnId = "diseases-refresh-btn";
  el.insertAdjacentHTML(
    "beforeend",
    `<div style="display:flex;justify-content:flex-end;margin-bottom:4px"><button id="${refreshBtnId}" class="secondary" style="font-size:10px;padding:2px 6px" title="Relancer le funnel maladie">↻ Mettre à jour</button></div>`
  );
  setTimeout(() => {
    const rb = document.getElementById(refreshBtnId);
    if (rb && ctx?.onGenerateDiseases) {
      rb.onclick = () => {
        rb.disabled = true;
        rb.textContent = "🔬 …";
        ctx.onGenerateDiseases();
      };
    }
  }, 0);
  const tPerHa = ctx?.t_per_ha;
  const pricePerKg = ctx?.price_eur_per_kg;
  const cropValuePerHa = tPerHa && pricePerKg ? tPerHa * 1000 * pricePerKg : null;
  const areaHa = numOr(ctx?.total_area_ha);

  // Combined-scenario panel: how do treating 0, 1, 2, … of the diseases compare?
  // Multiplicative loss model — addresses the "per-disease benefits don't sum" pitfall.
  if (cropValuePerHa != null && diseases.length > 1) {
    const out = computeTreatmentScenarios(diseases, cropValuePerHa);
    if (out?.scenarios?.length) {
      const top = out.scenarios.slice(0, 5);
      const recommended = top[0];
      const rows = top
        .map((s) => {
          const label =
            s.included.length === 0
              ? "<em>Ne rien faire</em>"
              : s.included.length === diseases.length
                ? `<b>Traiter les ${diseases.length}</b>`
                : `Traiter ${s.included.length}/${diseases.length} : ${s.included.slice(0, 3).join(", ")}${s.included.length > 3 ? "…" : ""}`;
          const isRec = s.mask === recommended.mask;
          const pAllTxt =
            s.pAllSucceed != null
              ? `<span title="Probabilité que TOUS les traitements sélectionnés fonctionnent">${Math.round(s.pAllSucceed * 100)} %</span>`
              : "—";
          const netColor = s.netBenefit >= 0 ? "var(--accent)" : "var(--bad)";
          const timeTxt =
            s.totalTime > 0
              ? `${s.totalTime.toFixed(1)} h/ha${areaHa ? ` <span class="small" style="color:var(--muted)">(${(s.totalTime * areaHa).toFixed(1)} h)</span>` : ""}`
              : "—";
          return `
            <tr style="${isRec ? "background: rgba(74,222,128,0.08)" : ""}">
              <td style="padding:4px 6px">${isRec ? "★ " : ""}${label}</td>
              <td style="padding:4px 6px;text-align:right">${fmtEUR(s.cost)}</td>
              <td style="padding:4px 6px;text-align:right">${timeTxt}</td>
              <td style="padding:4px 6px;text-align:right">${pAllTxt}</td>
              <td style="padding:4px 6px;text-align:right">${Math.round(s.yieldRatio * 100)} %</td>
              <td style="padding:4px 6px;text-align:right;color:${netColor};font-weight:600">${s.netBenefit >= 0 ? "+" : ""}${fmtEUR(s.netBenefit)}/ha</td>
            </tr>`;
        })
        .join("");
      const totalNote = areaHa
        ? `<div class="small" style="margin-top:6px">Étoile = stratégie recommandée. Sur ${areaHa.toFixed(2)} ha, ${recommended.netBenefit >= 0 ? "+" : ""}${fmtEUR(recommended.netBenefit * areaHa)} attendus.</div>`
        : `<div class="small" style="margin-top:6px">Étoile = stratégie recommandée.</div>`;
      const note = `
        <div class="cell full" style="margin-bottom:6px">
          <div class="k">Plan de traitement combiné — top stratégies</div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px">
            <thead><tr style="color:var(--muted);text-align:left">
              <th style="padding:4px 6px;font-weight:400">Stratégie</th>
              <th style="padding:4px 6px;text-align:right;font-weight:400">Coût</th>
              <th style="padding:4px 6px;text-align:right;font-weight:400">Temps</th>
              <th style="padding:4px 6px;text-align:right;font-weight:400">P(tout réussit)</th>
              <th style="padding:4px 6px;text-align:right;font-weight:400">Rendement</th>
              <th style="padding:4px 6px;text-align:right;font-weight:400">Bénéfice net</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${totalNote}
          <div class="small" style="margin-top:4px;color:var(--muted)">
            Modèle : impacts multiplicatifs (les pertes ne s'additionnent pas), P(succès combiné) = produit. Les bénéfices par maladie ci-dessous sont indicatifs en traitement <em>seul</em>.
          </div>
        </div>`;
      el.insertAdjacentHTML("beforeend", note);
    }
  }

  diseases
    .slice()
    .sort((a, b) => (b.presence_probability_0_1 ?? 0) - (a.presence_probability_0_1 ?? 0))
    .forEach((d, di) => {
      const card = document.createElement("div");
      card.className = "disease";
      const prob = d.presence_probability_0_1 != null ? Math.round(d.presence_probability_0_1 * 100) : null;
      const impact = d.yield_impact_pct_if_untreated;

      const treatments = (d.treatments || [])
        .map((t, ti) => {
          const cost = treatmentTotalCost(t);
          const newImpact = impact != null && t.recovery_pct != null ? impact + t.recovery_pct : null;
          let benefitTxt = "—",
            benefitClass = "";
          if (cropValuePerHa != null && t.recovery_pct != null && d.presence_probability_0_1 != null) {
            const expRecovery = (t.recovery_pct / 100) * cropValuePerHa * d.presence_probability_0_1;
            const net = expRecovery - cost.total;
            benefitTxt = (net >= 0 ? "+" : "") + fmtEUR(net) + "/ha";
            benefitClass = net >= 0 ? "color:var(--accent)" : "color:var(--bad)";
          } else if (cropValuePerHa == null) {
            benefitTxt = `Manque ${tPerHa ? "prix" : "rendement"} pour calculer`;
          }
          const detailsId = `tx-d-${di}-${ti}`;
          return `
          <li>
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
              <div><b>${t.name}</b>${t.name_local ? ` <span class="small" style="color:var(--accent)">≈ ${t.name_local}</span>` : ""} <span class="small">(${t.type ?? "?"})</span></div>
              <div style="font-weight:600">${fmtEUR(cost.total)}/ha</div>
            </div>
            <div class="small" style="margin-top:2px">
              Succès ${t.success_probability_0_1 != null ? Math.round(t.success_probability_0_1 * 100) + " %" : "—"} ·
              ${impact != null && newImpact != null ? `Impact ${impact}% → ${newImpact}%` : `Récup. +${t.recovery_pct ?? "?"}%`} ·
              <span style="${benefitClass}" title="Bénéfice si CE traitement est appliqué SEUL. Pour le bénéfice combiné, voir le plan en haut.">Bénéf. seul ${benefitTxt}</span>
            </div>
            <button class="secondary" data-toggle="${detailsId}" style="font-size:10px;padding:2px 6px;margin-top:4px">Détails</button>
            <div id="${detailsId}" style="display:none;margin-top:6px;padding:6px;background:var(--panel);border-radius:4px;font-size:11px">
              <div>Intrants : ${fmtEUR(cost.materials)}/ha</div>
              <div>Main d'œuvre : ${cost.totalTime.toFixed(1)} h/ha × ${fmtEUR(cost.rate)}/h = ${fmtEUR(cost.labor)}/ha
                <span class="small">${cost.methodLabel ? `(${cost.methodLabel} — ` : "("}prép. ${cost.prep.toFixed(1)} h/ha + applic. ${cost.apply.toFixed(1)} h/ha)</span></div>
              <div>Matériel / carburant / EPI : ${fmtEUR(cost.equipment)}/ha</div>
              <div style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><b>Total ${fmtEUR(cost.total)}/ha</b></div>
              ${areaHa != null ? `<div class="small">Sur ${areaHa.toFixed(2)} ha : ${fmtEUR(cost.total * areaHa)} total</div>` : ""}
            </div>
          </li>`;
        })
        .join("");

      const refId = `dis-ref-${di}`;
      const baseRate = d.base_rate_in_region_0_1;
      const baseRatePct = baseRate != null ? Math.round(baseRate * 100) : null;
      const baseRateLabel =
        baseRate == null
          ? null
          : baseRate >= 0.6
            ? "🔴 endémique"
            : baseRate >= 0.3
              ? "🟡 commune"
              : baseRate > 0
                ? "🟢 rare"
                : "—";
      const unknownPct = d.unknown_rate_0_1 != null ? Math.round(d.unknown_rate_0_1 * 100) : null;

      const ev = d.evidence || {};
      const supporting = Array.isArray(ev.supporting) ? ev.supporting : [];
      const against = Array.isArray(ev.against) ? ev.against : [];
      const missing = Array.isArray(ev.missing) ? ev.missing : [];

      const whyId = `dis-why-${di}`;
      const missId = `dis-miss-${di}`;
      const supportingHtml = supporting.length
        ? `<div style="margin-top:4px"><b style="color:var(--bad)">Pour cette maladie</b><ul style="margin:2px 0 0;padding-left:18px">${supporting.map((o) => `<li>${o.observation ?? "?"}${o.photo_index ? ` <span class="small">(photo ${o.photo_index})</span>` : ""}</li>`).join("")}</ul></div>`
        : "";
      const againstHtml = against.length
        ? `<div style="margin-top:4px"><b style="color:var(--accent)">Contre cette maladie</b><ul style="margin:2px 0 0;padding-left:18px">${against.map((o) => `<li>${o.observation ?? "?"}</li>`).join("")}</ul></div>`
        : "";
      const rationaleHtml = d.conclusion_rationale
        ? `<div class="small" style="margin-top:4px;font-style:italic">${d.conclusion_rationale}</div>`
        : "";
      const baseRateRatHtml = d.base_rate_rationale
        ? `<div style="margin-top:4px"><b>Pourquoi cette maladie est listée</b><div class="small">${d.base_rate_rationale}</div></div>`
        : "";
      const noEvidence =
        supporting.length === 0 && against.length === 0 && !d.conclusion_rationale && !d.base_rate_rationale;

      const missingHtml = missing.length
        ? `<div style="margin-top:6px"><div class="k" style="font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:0.5px;display:flex;justify-content:space-between;align-items:center">
            <span>📥 Informations manquantes (${missing.length})</span>
            <button class="secondary ask-all-missing" data-disease-idx="${di}" style="font-size:10px;padding:2px 6px">Poser au chat</button>
          </div>
          <ul style="margin:4px 0 0;padding-left:18px;font-size:11px">
            ${missing
              .map(
                (m, mi) => `<li style="margin-bottom:4px">
                <b>${m.what ?? "?"}</b>
                ${m.why ? `<div class="small">→ ${m.why}</div>` : ""}
                ${m.how_to_obtain ? `<div class="small" style="color:var(--accent)">↳ ${m.how_to_obtain}</div>` : ""}
                <button class="secondary ask-one-missing" data-disease-idx="${di}" data-missing-idx="${mi}" style="font-size:10px;padding:1px 5px;margin-top:2px">Demander</button>
              </li>`
              )
              .join("")}
          </ul></div>`
        : "";

      card.innerHTML = `
        <div class="head">
          <div style="display:flex;gap:8px;align-items:flex-start">
            <span id="${refId}" style="width:48px;height:48px;background:var(--panel);border:1px solid var(--border);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted);flex-shrink:0">…</span>
            <div>
              <div><span class="name">${d.name_fr ?? "?"}</span>${d.name_local ? ` <span style="color:var(--accent);font-size:11px">≈ ${d.name_local}</span>` : ""} <span class="sci">${d.scientific ?? ""}</span></div>
              ${baseRateLabel ? `<div class="small" style="margin-top:2px">${baseRateLabel} en région${baseRatePct != null ? ` (taux de base ${baseRatePct} %)` : ""}</div>` : ""}
            </div>
          </div>
          <div style="font-size:11px;text-align:right">${prob != null ? `<div><b>${prob} %</b> présence</div>` : ""}${unknownPct != null ? `<div class="small" style="color:var(--muted)">${unknownPct} % inconnu</div>` : ""}</div>
        </div>
        <div class="row2">
          <div>
            <span class="k">Probabilité présence</span>
            <div class="bar ${prob > 66 ? "bad" : prob > 33 ? "warn" : ""}"><div style="width:${prob ?? 0}%"></div></div>
          </div>
          <div>
            <span class="k">Inconnu (à éclairer)</span>
            <div class="bar warn" title="Part d'incertitude qui pourrait être levée en fournissant les informations manquantes ci-dessous"><div style="width:${unknownPct ?? 0}%;background:#a78bfa"></div></div>
          </div>
        </div>
        <div class="row2" style="margin-top:6px">
          <div><span class="k">Impact attendu E[X]</span><div style="font-weight:600;color:var(--bad)" title="Espérance pondérée sur les 3 scénarios (optimiste/neutre/pessimiste). Pilote la décision économique de traiter.">${impact != null ? impact + " %" : "—"}</div></div>
          <div></div>
        </div>
        ${(() => {
          const sc = d.impact_scenarios;
          if (!sc || (!sc.optimistic && !sc.neutral && !sc.pessimistic)) return "";
          const scenId = `dis-scen-${di}`;
          const rows = [
            ["🟢 Optimiste", sc.optimistic, "var(--accent)"],
            ["🟡 Neutre", sc.neutral, "var(--warn)"],
            ["🔴 Pessimiste", sc.pessimistic, "var(--bad)"],
          ];
          const html = rows
            .filter(([, s]) => s)
            .map(([label, s, color]) => {
              const p = s.probability_0_1 != null ? Math.round(s.probability_0_1 * 100) : null;
              const imp = s.impact_pct != null ? s.impact_pct : null;
              return `<div style="display:grid;grid-template-columns:80px 60px 50px 1fr;gap:6px;align-items:baseline;margin-bottom:3px">
                <div style="color:${color}">${label}</div>
                <div style="font-size:10px;color:var(--muted)">${p != null ? p + " %" : "—"}</div>
                <div style="font-weight:600;color:${color}">${imp != null ? imp + " %" : "—"}</div>
                <div class="small" style="color:var(--muted)">${s.rationale ?? ""}</div>
              </div>`;
            })
            .join("");
          const prog = d.progression;
          const progHtml = prog
            ? `<div class="small" style="margin-top:6px;padding-top:4px;border-top:1px solid var(--border);color:var(--muted)">
              <b>Progression :</b> sévérité actuelle ${prog.current_severity_on_field_0_1 != null ? Math.round(prog.current_severity_on_field_0_1 * 100) + " %" : "?"}
              · vitesse ${prog.speed_pct_per_week ?? "?"} %/sem
              · plafond dans ${prog.weeks_to_full_impact ?? "?"} sem
              ${prog.rationale ? `<div style="margin-top:2px;font-style:italic">${prog.rationale}</div>` : ""}
            </div>`
            : "";
          return `<button class="secondary" data-toggle="${scenId}" style="font-size:11px;padding:3px 8px;margin-top:6px">Scénarios d'impact ▾</button>
          <div id="${scenId}" style="display:none;margin-top:4px;padding:6px;background:var(--panel);border-radius:4px;font-size:11px">
            <div style="display:grid;grid-template-columns:80px 60px 50px 1fr;gap:6px;font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:0.5px;margin-bottom:4px">
              <div>Scénario</div><div>P</div><div>Impact</div><div>Justification</div>
            </div>
            ${html}
            ${progHtml}
          </div>`;
        })()}
        ${
          !noEvidence
            ? `<button class="secondary" data-toggle="${whyId}" style="font-size:11px;padding:3px 8px;margin-top:6px">Pourquoi ? ▾</button>
          <div id="${whyId}" style="display:none;margin-top:4px;padding:6px;background:var(--panel);border-radius:4px;font-size:11px">
            ${baseRateRatHtml}
            ${supportingHtml}
            ${againstHtml}
            ${rationaleHtml}
          </div>`
            : ""
        }
        ${missingHtml}
        ${(() => {
          if (!Array.isArray(d.detections) || d.detections.length === 0) return "";
          const photos = ctx?.photos || [];
          const annotated = d.detections
            .map((det) => {
              const p = photos[det.photo_index - 1];
              return p ? annotatedPhotoSnippet(p, det) : "";
            })
            .filter(Boolean);
          if (annotated.length === 0) return "";
          return `<div style="margin-top:6px"><div class="k" style="font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:0.5px">Détections visibles</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${annotated.join("")}</div></div>`;
        })()}
        ${treatments ? `<div class="tx"><h4>Traitements possibles</h4><ul style="list-style:none;padding-left:0;margin:0">${treatments}</ul></div>` : ""}
      `;
      el.appendChild(card);

      // Wire the "Demander" / "Poser au chat" buttons. The handler is passed in via ctx
      // so metrics.js stays UI-pure; chat module owns the actual append + send.
      if (ctx?.onAskMissing) {
        card.querySelectorAll(".ask-one-missing").forEach((btn) => {
          btn.addEventListener("click", () => {
            const mi = Number(btn.dataset.missingIdx);
            const m = missing[mi];
            if (!m) return;
            ctx.onAskMissing({ disease: d, items: [m] });
          });
        });
        card.querySelectorAll(".ask-all-missing").forEach((btn) => {
          btn.addEventListener("click", () => {
            if (!missing.length) return;
            ctx.onAskMissing({ disease: d, items: missing });
          });
        });
      }

      if (d.scientific || d.name_fr) {
        lookupTaxonImage(d.scientific, d.name_fr, DISEASE_CATALOG).then((res) => {
          const slot = document.getElementById(refId);
          if (!slot) return;
          if (res?.url) {
            slot.innerHTML = `<a href="${res.url}" target="_blank" rel="noopener" title="${d.scientific ?? d.name_fr} — ${res.source} (cliquer pour agrandir)"><img src="${res.url}" style="width:100%;height:100%;object-fit:cover;border-radius:3px;cursor:zoom-in" /></a>`;
            slot.style.padding = "0";
            wireSlotModal(
              slot,
              res.url,
              `<b>${d.name_fr ?? "?"}</b>${d.scientific ? ` <i>${d.scientific}</i>` : ""} — source : ${res.source}`
            );
          } else {
            slot.textContent = "?";
            slot.title = "Aucune image trouvée";
          }
        });
      }
    });

  el.querySelectorAll("[data-toggle]").forEach((btn) => {
    const baseLabel = btn.textContent.replace(/[▾▴]\s*$/, "").trim();
    btn.onclick = () => {
      const target = document.getElementById(btn.dataset.toggle);
      const open = target.style.display !== "none";
      target.style.display = open ? "none" : "block";
      btn.textContent = open ? `${baseLabel} ▾` : `${baseLabel} ▴`;
    };
  });
}

/** Cross-photo coherence indicator (rendered between metrics grid and diseases). */
export function renderCrossCheck(cc) {
  let host = document.getElementById("cross-check");
  if (!host) {
    host = document.createElement("div");
    host.id = "cross-check";
    document.getElementById("metrics").after(host);
  }
  if (!cc || (!cc.discrepancies?.length && cc.consistent_0_1 == null)) {
    host.innerHTML = "";
    return;
  }
  const score = cc.consistent_0_1 != null ? Math.round(cc.consistent_0_1 * 100) : null;
  const tone =
    score == null ? "" : score >= 70 ? "var(--accent)" : score >= 40 ? "var(--warn)" : "var(--bad)";
  host.innerHTML = `
    <div class="cell full" style="border-left:3px solid ${tone || "var(--border)"}">
      <div class="k">Cohérence inter-photos</div>
      <div class="v">${score != null ? score + " %" : "—"}</div>
      ${cc.discrepancies?.length ? `<ul style="margin:6px 0 0 16px;padding:0;font-size:11px">${cc.discrepancies.map((d) => `<li>${d}</li>`).join("")}</ul>` : ""}
    </div>`;
}
