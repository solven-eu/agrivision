// AgriVision RE — metrics + disease + cross-check rendering.
// Pure rendering: takes a parsed-analysis object and writes to the DOM. Side effects on
// `analysisCombined` (price override) are delegated back via the `onPriceEdit` callback,
// so this module never touches main.js state directly.

import { formatRelativeDays, fmtEUR } from "./util.js";
import { CULTU_LABELS, lookupCropImage, lookupTaxonImage } from "./catalog.js";

/** Total per-ha treatment cost = materials + (prep+apply) × labor_rate + equipment. */
export function treatmentTotalCost(t) {
  const c = t.cost_breakdown || {};
  const mat = c.materials_eur_per_ha ?? 0;
  const equip = c.equipment_eur_per_ha ?? 0;
  const prep = c.prep_time_h_per_ha ?? 0;
  const apply = c.application_time_h_per_ha ?? 0;
  const rate = c.labor_eur_per_h ?? 0;
  const labor = (prep + apply) * rate;
  return {
    total: mat + labor + equip,
    materials: mat,
    labor,
    equipment: equip,
    prep,
    apply,
    rate,
    totalTime: prep + apply,
  };
}

/**
 * @param {object} m - combined analysis (identification, parcels_summary, health, phenology, yield, market, notes)
 * @param {object} [hooks] - { onPriceEdit(rawAnswer: string|null) — called when user submits a new price }
 */
export function renderMetrics(m, hooks = {}) {
  const el = document.getElementById("metrics");
  el.innerHTML = "";
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

  cell(
    "Culture dominante",
    `<span id="crop-ref-slot" style="float:right;width:56px;height:56px;background:var(--panel);border:1px solid var(--border);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted);margin-left:8px">…</span>${id.dominant_crop_fr ?? "—"}${id.scientific_name ? ` <span class="small">(${id.scientific_name})</span>` : ""}`,
    { full: true }
  );
  if (id.dominant_crop_fr || id.scientific_name) {
    lookupCropImage(id.scientific_name, id.dominant_crop_fr).then((res) => {
      const slot = document.getElementById("crop-ref-slot");
      if (!slot) return;
      if (res?.url) {
        slot.innerHTML = `<a href="${res.url}" target="_blank" title="Photo de référence — ${res.source}"><img src="${res.url}" style="width:100%;height:100%;object-fit:cover;border-radius:3px" /></a>`;
        slot.style.padding = "0";
      } else {
        slot.textContent = "pas de réf.";
      }
    });
  }
  cell("Confiance détection", id.confidence_0_1 != null ? Math.round(id.confidence_0_1 * 100) + " %" : "—", {
    bar: (id.confidence_0_1 ?? 0) * 100,
  });
  cell(
    "Parcelles",
    `${ps.count ?? "—"} (${ps.total_area_ha != null ? ps.total_area_ha.toFixed(2) + " ha" : "?"})`
  );
  cell("Vigueur", h.vigor_0_100 ?? "—", { bar: h.vigor_0_100 });
  cell("Pression maladies", h.disease_pressure_0_100 ?? "—", { bar: h.disease_pressure_0_100, invert: true });
  cell("Stade", ph.current_stage);
  cell("Maturité", ph.maturity_pct != null ? ph.maturity_pct + " %" : "—", { bar: ph.maturity_pct });
  cell(
    "Récolte attendue",
    `${formatRelativeDays(ph.expected_harvest_in_days)}${ph.expected_harvest_window_iso ? ` <span class="small">(${ph.expected_harvest_window_iso})</span>` : ""}`,
    { full: true }
  );
  cell("Rendement t/ha", y.estimated_t_per_ha != null ? y.estimated_t_per_ha.toFixed(1) : "—");
  cell("Production totale", y.estimated_total_t != null ? y.estimated_total_t.toFixed(1) + " t" : "—");

  // Effective price = user override if set, else model default.
  const userPrice = mk.user_price_eur_per_kg;
  const modelPrice = mk.indicative_price_eur_per_kg;
  const effPrice = userPrice != null ? userPrice : modelPrice;
  const priceSource = userPrice != null ? "votre prix" : "défaut RNM";
  const priceColor = userPrice != null ? "var(--accent)" : "var(--muted)";
  const priceVal =
    effPrice != null
      ? `${effPrice.toFixed(2)} €/kg <span style="font-size:9px;color:${priceColor};font-weight:400">${priceSource}</span> <button id="price-edit" title="Modifier" style="margin-left:6px;background:transparent;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:1px 5px;border-radius:3px;cursor:pointer">✏</button>`
      : `— <button id="price-edit" title="Définir" style="background:transparent;border:1px solid var(--border);color:var(--muted);font-size:10px;padding:1px 5px;border-radius:3px;cursor:pointer">✏ définir</button>`;
  cell("Prix vente (départ producteur)", priceVal);
  let totalValue = mk.estimated_total_value_eur;
  if (effPrice != null && y.estimated_total_t != null) totalValue = y.estimated_total_t * 1000 * effPrice;
  cell("Valeur estimée", fmtEUR(totalValue), { full: false });

  if (Array.isArray(ps.crops_breakdown) && ps.crops_breakdown.length > 1) {
    const txt = ps.crops_breakdown
      .map(
        (c) =>
          `${CULTU_LABELS[c.code_cultu] || c.code_cultu}: ${c.area_ha?.toFixed(2)} ha (${c.share_pct?.toFixed(0)}%)`
      )
      .join(" · ");
    cell("Répartition cultures", txt, { full: true });
  }
  const obs = (h.spatial_observations || [])
    .map((o) => `photo ${o.photo_index}: ${o.observation}`)
    .join(" · ");
  if (obs) cell("Observations terrain", obs, { full: true });
  if (mk.source_hint || mk.notes)
    cell("Marché", `${mk.source_hint || ""} ${mk.notes || ""}`.trim(), { full: true });
  if (m.notes) cell("Notes", m.notes, { full: true });

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
}

/**
 * @param {Array} diseases - the diseases array from the analysis
 * @param {object} ctx - { t_per_ha, price_eur_per_kg, total_area_ha } — used for benefit calculation
 */
export function renderDiseases(diseases, ctx) {
  const el = document.getElementById("diseases");
  if (!Array.isArray(diseases) || diseases.length === 0) {
    el.innerHTML = `<div class="small">Aucune maladie listée par le modèle.</div>`;
    return;
  }
  el.innerHTML = "";
  const tPerHa = ctx?.t_per_ha;
  const pricePerKg = ctx?.price_eur_per_kg;
  const cropValuePerHa = tPerHa && pricePerKg ? tPerHa * 1000 * pricePerKg : null;

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
              <span style="${benefitClass}">Bénéfice espéré ${benefitTxt}</span>
            </div>
            <button class="secondary" data-toggle="${detailsId}" style="font-size:10px;padding:2px 6px;margin-top:4px">Détails</button>
            <div id="${detailsId}" style="display:none;margin-top:6px;padding:6px;background:var(--panel);border-radius:4px;font-size:11px">
              <div>Intrants : ${fmtEUR(cost.materials)}/ha</div>
              <div>Main d'œuvre : ${cost.totalTime.toFixed(1)} h × ${fmtEUR(cost.rate)}/h = ${fmtEUR(cost.labor)}/ha
                <span class="small">(prép. ${cost.prep.toFixed(1)} h + applic. ${cost.apply.toFixed(1)} h)</span></div>
              <div>Matériel / carburant / EPI : ${fmtEUR(cost.equipment)}/ha</div>
              <div style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><b>Total ${fmtEUR(cost.total)}/ha</b></div>
              ${ctx?.total_area_ha ? `<div class="small">Sur ${ctx.total_area_ha.toFixed(2)} ha : ${fmtEUR(cost.total * ctx.total_area_ha)} total</div>` : ""}
            </div>
          </li>`;
        })
        .join("");

      const refId = `dis-ref-${di}`;
      card.innerHTML = `
        <div class="head">
          <div style="display:flex;gap:8px;align-items:flex-start">
            <span id="${refId}" style="width:48px;height:48px;background:var(--panel);border:1px solid var(--border);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted);flex-shrink:0">…</span>
            <div><span class="name">${d.name_fr ?? "?"}</span>${d.name_local ? ` <span style="color:var(--accent);font-size:11px">≈ ${d.name_local}</span>` : ""} <span class="sci">${d.scientific ?? ""}</span></div>
          </div>
          <div style="font-size:11px">${prob != null ? prob + "% prob." : ""}</div>
        </div>
        <div class="row2">
          <div><span class="k">Probabilité présence</span><div class="bar ${prob > 66 ? "bad" : prob > 33 ? "warn" : ""}"><div style="width:${prob ?? 0}%"></div></div></div>
          <div><span class="k">Impact si non traité</span><div style="font-weight:600;color:var(--bad)">${impact != null ? impact + " %" : "—"}</div></div>
        </div>
        ${treatments ? `<div class="tx"><h4>Traitements possibles</h4><ul style="list-style:none;padding-left:0;margin:0">${treatments}</ul></div>` : ""}
      `;
      el.appendChild(card);

      if (d.scientific || d.name_fr) {
        lookupTaxonImage(d.scientific, d.name_fr, {}).then((res) => {
          const slot = document.getElementById(refId);
          if (!slot) return;
          if (res?.url) {
            slot.innerHTML = `<a href="${res.url}" target="_blank" title="${d.scientific ?? d.name_fr} — ${res.source}"><img src="${res.url}" style="width:100%;height:100%;object-fit:cover;border-radius:3px" /></a>`;
            slot.style.padding = "0";
          } else {
            slot.textContent = "?";
            slot.title = "Aucune image trouvée";
          }
        });
      }
    });

  el.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const target = document.getElementById(btn.dataset.toggle);
      const open = target.style.display !== "none";
      target.style.display = open ? "none" : "block";
      btn.textContent = open ? "Détails" : "Masquer";
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
