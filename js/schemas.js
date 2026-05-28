// JSON schemas sent to Claude. Each value is a TYPE DESCRIPTION (string), not data — the
// model fills the structure with real values and returns JSON of the same shape.

// Per-photo tagging — Claude returns one entry per uploaded photo.
export const PHOTO_TAG_SCHEMA = {
  photo_index: "number (1-based) matching the photo's order in the prompt",
  shot_type:
    "string — 'overview' (vue large du champ), 'single_plant' (plant individuel), 'detail' (zoom sur feuille/fruit), 'unknown'",
  crop_code: "string|null — RPG code_cultu si identifiable (BAN, CSU, VRC, etc.) sinon null",
  plant_count_visible: "number|null — nombre de plants estimé dans la photo",
  maturity_pct_visible: "number 0-100 — maturité estimée pour ce plant/cette zone",
  health_visible_0_100: "number — santé visible (0=mort, 100=parfait)",
  quality_score_0_100: "number — qualité de la photo (luminosité, netteté, cadrage)",
  representative_likely: "boolean — vraisemblance que ce plant représente la moyenne du champ",
  observation: "string courte — ce qui est observable spécifiquement sur cette photo",
};

export const FULL_REPORT_SCHEMA = {
  identification: { dominant_crop_fr: "string", scientific_name: "string", confidence_0_1: "number" },
  parcels_summary: {
    count: "number",
    total_area_ha: "number",
    crops_breakdown: "array of {code_cultu, area_ha, share_pct}",
  },
  health: {
    vigor_0_100: "number",
    disease_pressure_0_100: "number",
    spatial_observations: "array of {photo_index, observation}",
  },
  phenology: {
    current_stage: "string",
    maturity_pct: "number 0-100",
    expected_harvest_in_days: "number",
    expected_harvest_window_iso: "string",
  },
  yield: { estimated_t_per_ha: "number", estimated_total_t: "number", confidence_0_1: "number" },
  market: {
    indicative_price_eur_per_kg:
      "number — prix DÉPART PRODUCTEUR (€/kg vendu par l'agriculteur en gros, hors transport et marge aval). Référentiel RNM FranceAgriMer / cours départemental.",
    estimated_total_value_eur: "number",
    source_hint: "string",
    notes: "string",
  },
  diseases:
    "array of {name_fr, name_local, scientific, presence_probability_0_1, yield_impact_pct_if_untreated, treatments: [{name, name_local, type, success_probability_0_1, recovery_pct, cost_breakdown: {materials_eur_per_ha, prep_time_h_per_ha, application_time_h_per_ha, labor_eur_per_h, equipment_eur_per_ha}}]}",
  photo_tags: `array of objects, one per uploaded photo, each conforming to: ${JSON.stringify(PHOTO_TAG_SCHEMA)}`,
  cross_check: {
    consistent_0_1: "number — cohérence entre les photos (overview vs single_plant)",
    discrepancies:
      "array of strings — ex: 'photo 2 (plant unique) montre health=30 mais photo 1 (overview) montre 85 — possiblement un plant non représentatif ou un foyer localisé'",
  },
  notes: "string — caveats",
};

export const QUICK_SCHEMA = {
  identification: { dominant_crop_fr: "string", scientific_name: "string", confidence_0_1: "number" },
  parcels_summary: {
    count: "number",
    total_area_ha: "number",
    crops_breakdown: "array of {code_cultu, area_ha, share_pct}",
  },
  health: {
    vigor_0_100: "number",
    disease_pressure_0_100:
      "number — visible overall pressure (the per-disease drill-down is a separate call)",
    spatial_observations: "array of {photo_index, observation}",
  },
  phenology: {
    current_stage: "string",
    maturity_pct: "number 0-100",
    expected_harvest_in_days: "number — days from today",
    expected_harvest_window_iso: "string YYYY-MM",
  },
  notes: "string — caveats",
};

export const DISEASES_SCHEMA = {
  diseases:
    "array of disease objects (3-6 most relevant for the identified crop in this region/season). Each: {name_fr, name_local, scientific, presence_probability_0_1, yield_impact_pct_if_untreated, treatments: [{name, name_local, type, success_probability_0_1, recovery_pct, cost_breakdown: {materials_eur_per_ha, prep_time_h_per_ha, application_time_h_per_ha, labor_eur_per_h, equipment_eur_per_ha}}]}",
};

export const MARKET_SCHEMA = {
  yield: { estimated_t_per_ha: "number", estimated_total_t: "number", confidence_0_1: "number" },
  market: {
    indicative_price_eur_per_kg:
      "number — prix DÉPART PRODUCTEUR (€/kg vendu par l'agriculteur en gros, hors transport et marge aval). Référentiel RNM FranceAgriMer / cours départemental.",
    estimated_total_value_eur: "number — total_t × price × 1000",
    source_hint: "string — e.g. 'RNM FranceAgriMer'",
    notes: "string",
  },
};

// Legacy combined schema kept for reload of older culture.json manifests.
export const METRIC_SCHEMA = {
  identification: {
    dominant_crop_fr: "string — nom commun FR (ex: vigne, canne à sucre, banane)",
    scientific_name: "string",
    confidence_0_1: "number",
  },
  parcels_summary: {
    count: "number — total parcels analyzed",
    total_area_ha: "number",
    crops_breakdown: "array of {code_cultu, area_ha, share_pct}",
  },
  health: {
    vigor_0_100: "number — visible plant vigor across photos",
    disease_pressure_0_100: "number — overall visible disease/pest pressure",
    spatial_observations:
      "array of {photo_index (1-based), observation} — what is seen WHERE; mention if a photo shows healthier/diseased zones",
  },
  phenology: {
    current_stage: "string — BBCH or common stage name",
    maturity_pct: "number 0-100",
    expected_harvest_in_days:
      "number — days from today (positive=future, negative=past); compute relative to today's date",
    expected_harvest_window_iso: "string — YYYY-MM or YYYY-MM to YYYY-MM (for reference)",
  },
  yield: {
    estimated_t_per_ha: "number",
    estimated_total_t: "number — t_per_ha × total_area_ha; null if area unknown",
    confidence_0_1: "number",
  },
  market: {
    indicative_price_eur_per_kg:
      "number|null — prix DÉPART PRODUCTEUR (€/kg vendu par l'agriculteur en gros, hors transport)",
    estimated_total_value_eur: "number|null — total_t × price × 1000",
    source_hint: "string — e.g. 'RNM FranceAgriMer'",
    notes: "string",
  },
  diseases:
    "array of disease objects — list the 3-6 most relevant for the identified crop in this region/season. Each: {name_fr, name_local (vernacular name in the requested dialect, null if dialect=fr or unknown), scientific, presence_probability_0_1, yield_impact_pct_if_untreated (negative number, e.g. -25), treatments: [{name, name_local (null if dialect=fr), type ('chimique'|'biologique'|'agronomique'), success_probability_0_1, recovery_pct (positive yield points recovered, e.g. +18), cost_breakdown: {materials_eur_per_ha, prep_time_h_per_ha, application_time_h_per_ha, labor_eur_per_h (default FR ~25), equipment_eur_per_ha}}]}",
  notes: "string — caveats, limitations, what was not assessable",
};
