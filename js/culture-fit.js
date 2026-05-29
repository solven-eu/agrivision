// AgriVision RE — soil × crop suitability scoring.
// Rules-based first cut for the most common RPG crops on La Réunion. Inputs come from
// the soil module (`parcel.soil.summary.median`); output is a 0-100 score + a short FR
// label + the dominant reason(s). When data is missing we return null rather than
// guess — the AI prompt is the place for nuanced reasoning under uncertainty.
//
// Scoring weights (sum to 100):
//   - pH:  40 pts   (most universal lever; out-of-range = score zeroed unless very close)
//   - CEC: 30 pts   (nutrient-holding capacity, big for heavy feeders)
//   - K:   30 pts   (potassium for banana / sugarcane especially)
// Crops without K rules skip the K block and re-normalize over the remaining 70 pts.

// [min_ok, max_ok, optimum] — values outside (min_ok, max_ok) get 0; closer to optimum = higher.
const SUITABILITY = {
  // Canne à sucre — tolère un éventail large, optimum sub-neutre.
  CSU: {
    pH: [5.0, 8.0, 6.5],
    CEC: [8, null, 16],
    K_ex: [0.15, null, 0.4],
  },
  // Banane — exigeante en K et CEC, sensible aux extrêmes de pH.
  BAN: {
    pH: [5.5, 7.0, 6.3],
    CEC: [15, null, 22],
    K_ex: [0.3, null, 0.8],
  },
  // Agrumes — bien drainé, légèrement acide.
  AGR: {
    pH: [5.5, 6.8, 6.2],
    CEC: [10, null, 16],
  },
  // Vigne de cuve — peu exigeante en matière organique, neutre.
  VRC: {
    pH: [6.0, 7.5, 6.8],
    CEC: [8, null, 14],
  },
  // Maraîchage diversifié — plage très large pour ne pas pénaliser.
  MDI: {
    pH: [5.5, 7.5, 6.5],
    CEC: [10, null, 18],
    K_ex: [0.2, null, 0.5],
  },
  // Vergers (autres) — comme agrumes par défaut.
  VRG: {
    pH: [5.5, 7.0, 6.3],
    CEC: [10, null, 16],
  },
  // Fallback générique pour codes non listés.
  DEFAULT: {
    pH: [5.5, 7.5, 6.5],
    CEC: [6, null, 12],
  },
};

// Component-level scorer. Returns a normalized 0..1 score for a single value+range.
// All scorers share the same "tolerance shape": full score inside [lo, hi] (centered on
// opt), graceful falloff just outside, zero further away.
function scorePh(pH, rules) {
  if (pH == null || !rules.pH) return null;
  const [lo, hi, opt] = rules.pH;
  if (pH < lo - 0.3 || pH > hi + 0.3) return 0;
  const dist = Math.abs(pH - opt);
  const tol = Math.max(opt - lo, hi - opt);
  return Math.max(0, 1 - dist / (tol + 0.5));
}

function scoreCec(cec, rules) {
  if (cec == null || !rules.CEC) return null;
  const [lo, hi, opt] = rules.CEC;
  if (cec < lo * 0.5) return 0;
  if (cec >= opt) return hi == null ? 1 : Math.max(0, 1 - Math.max(0, cec - hi) / hi);
  return Math.max(0, (cec - lo * 0.5) / (opt - lo * 0.5));
}

function scoreK(k, rules) {
  if (k == null || !rules.K_ex) return null;
  const [lo, , opt] = rules.K_ex;
  if (k >= opt) return 1;
  if (k < lo * 0.3) return 0;
  return Math.max(0, (k - lo * 0.3) / (opt - lo * 0.3));
}

const COMPONENT_WEIGHTS = { pH: 40, CEC: 30, K: 30 };

// Full evaluation — returns the headline score + per-component breakdown including the
// raw value, the rules range, the normalized 0..1 score, and the points contributed to
// the headline. Used by the UI to draw sliders and by `scoreSuitability` as a thin
// wrapper for backwards compat.
export function evaluateParcel(soil, cropCode) {
  if (!soil?.summary?.median) return null;
  const m = soil.summary.median;
  const rules = SUITABILITY[cropCode] || SUITABILITY.DEFAULT;
  const components = {};
  const reasons = [];
  let weighted = 0;
  let totalWeight = 0;
  const fillComponent = (key, label, value, rangeKey, normFn, unit) => {
    const range = rules[rangeKey];
    if (!range) return;
    const norm = normFn(value, rules);
    if (norm == null) return;
    const max = COMPONENT_WEIGHTS[key];
    const pts = norm * max;
    components[key] = {
      label,
      value,
      unit,
      range, // [min_ok, max_ok, opt]
      normalized: norm,
      contribution_pts: Math.round(pts),
      max_pts: max,
    };
    weighted += pts;
    totalWeight += max;
    if (norm < 0.4) {
      if (key === "pH") reasons.push(`pH ${value} hors plage`);
      else if (key === "CEC") reasons.push(`CEC ${value} faible`);
      else if (key === "K") reasons.push(`K éch. ${value} faible`);
    }
  };
  fillComponent("pH", "pH (H₂O)", m.pH_H2O, "pH", scorePh, "");
  fillComponent("CEC", "CEC", m.CEC_cmol_kg, "CEC", scoreCec, "cmol(+)/kg");
  fillComponent("K", "K échangeable", m.K_ex_cmol_kg, "K_ex", scoreK, "cmol(+)/kg");
  if (totalWeight === 0) return null;
  const score = Math.round((weighted / totalWeight) * 100);
  return { score, label: scoreLabel(score), reasons, components };
}

// Thin wrapper preserving the original signature.
export function scoreSuitability(soil, cropCode) {
  const e = evaluateParcel(soil, cropCode);
  if (!e) return null;
  return { score: e.score, label: e.label, reasons: e.reasons };
}

// Score every known crop and return them sorted best-first. Used by the "Cultures
// recommandées" panel to suggest what to grow given the soil, independent of what the
// RPG currently says is on the parcel. Drops DEFAULT (it's a fallback, not a crop).
export function scoreAllCrops(soil) {
  if (!soil?.summary?.median) return [];
  const out = [];
  for (const crop of Object.keys(SUITABILITY)) {
    if (crop === "DEFAULT") continue;
    const e = evaluateParcel(soil, crop);
    if (!e) continue;
    out.push({ crop, score: e.score, label: e.label });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function scoreLabel(s) {
  if (s >= 80) return "très adapté";
  if (s >= 60) return "bien adapté";
  if (s >= 40) return "moyennement adapté";
  return "peu adapté";
}

export function colorForScore(s) {
  if (s == null) return "var(--muted)";
  if (s >= 80) return "var(--accent)";
  if (s >= 60) return "var(--text)";
  if (s >= 40) return "var(--warn)";
  return "var(--bad)";
}
