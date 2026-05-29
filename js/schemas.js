// JSON schemas sent to Claude. Each value is a TYPE DESCRIPTION (string), not data — the
// model fills the structure with real values and returns JSON of the same shape.

// Per-photo tagging — Claude returns one entry per uploaded photo.
export const PHOTO_TAG_SCHEMA = {
  photo_index: "number (1-based) matching the photo's order in the prompt",
  // Coarse content classifier — drives which conversational scenario applies. Tag this
  // FIRST: if it's not a crop photo, most other fields below are null and the chat module
  // picks a different action set (document synthesis, label decoding, etc.).
  content_type:
    "string — one of: 'crop_field' (vue large d'un champ cultivé), 'single_plant' (plant individuel ou détail de plant), 'plant_detail' (zoom sur feuille/fruit/symptôme), 'administrative_document' (facture, courrier, déclaration, MSA, PAC, etc.), 'phyto_label' (étiquette/emballage produit phyto), 'map_or_plan' (carte, plan de parcelle, croquis), 'equipment' (matériel agricole : tracteur, pulvé, irrigation, etc.), 'unknown_or_unrelated' (rien d'identifiable ou clairement hors agriculture)",
  shot_type:
    "string — 'overview' (vue large du champ), 'single_plant' (plant individuel), 'detail' (zoom sur feuille/fruit), 'unknown'. Met 'unknown' si content_type n'est pas 'crop_field'/'single_plant'/'plant_detail'.",
  crop_code: "string|null — RPG code_cultu si identifiable (BAN, CSU, VRC, etc.) sinon null",
  plant_count_visible: "number|null — nombre total de plants estimé dans la photo",
  fruiting_plant_count_visible:
    "number|null — sous-ensemble de plant_count_visible qui présente actuellement des fruits visibles",
  fruit_count_visible: "number|null — nombre de fruits visibles (si comptable)",
  maturity_pct_visible: "number 0-100 — maturité estimée pour ce plant/cette zone",
  health_visible_0_100: "number — santé visible (0=mort, 100=parfait)",
  quality_score_0_100: "number — qualité de la photo (luminosité, netteté, cadrage)",
  representative_likely: "boolean — vraisemblance que ce plant représente la moyenne du champ",
  observation: "string courte — ce qui est observable spécifiquement sur cette photo",
};

// Disease detection — one entry per visible occurrence of a disease on a photo.
// Coordinates are PERCENTAGES of the photo dimensions (0-100), origin top-left,
// so they survive any display scaling/zoom. severity_0_1 controls the annotation tint.
export const DETECTION_SCHEMA = {
  photo_index: "number (1-based) matching the photo's order in the prompt",
  x_pct: "number 0-100 — center X of the affected zone, % of photo width",
  y_pct: "number 0-100 — center Y of the affected zone, % of photo height",
  radius_pct:
    "number 0-100 — radius of the circle (relative to min(width, height)), large enough to enclose the symptomatic area",
  severity_0_1: "number — local severity (0=mild discoloration, 1=full necrosis)",
  observation: "string courte — what is symptomatic at this location ('taches huileuses', 'nécrose', …)",
};

export const FULL_REPORT_SCHEMA = {
  identification: {
    dominant_crop_fr: "string — nom commun FR (ex: 'Bananier', 'Vigne', 'Pommier')",
    cultivar_or_variety_fr:
      "string|null — nom usuel du cultivar/de la variété si identifiable du contexte ou des photos (ex: 'Cavendish', 'Cabernet Sauvignon', 'Golden Delicious', 'Frangipanier de table'). null si non distinguable.",
    scientific_name: "string — nom binomial Linnéen, espèce + parents hybrides si pertinent",
    confidence_0_1: "number",
  },
  parcels_summary: {
    count: "number",
    total_area_ha: "number",
    crops_breakdown: "array of {code_cultu, area_ha, share_pct}",
  },
  health: {
    vigor_0_100: "number",
    disease_pressure_0_100: "number",
    spatial_observations: "array of {photo_index, observation}",
    total_plants_estimate: "number|null — total visible plants across all overview photos",
    fruiting_plants_estimate:
      "number|null — sub-count of plants currently bearing visible fruits (set null if not assessable, e.g. crop not at fruiting stage)",
    fruiting_ratio_0_1: "number|null — fruiting_plants_estimate / total_plants_estimate when both known",
    lost_output_ratio_0_1:
      "number 0-1 — estimated FRACTION of harvest currently lost vs a perfect field (visible damage, missing plants, abnormal stress). 0=no loss, 0.3=30% lost. Use crop-typical defaults if not directly assessable; the user can override.",
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
    "array of disease objects, 3-6 most plausible BASED ON CROP × RÉGION × SAISON. Each follows a 3-step rationale: (1) base rate a priori, (2) evidence on THIS field, (3) conclusion. Object: {name_fr, name_local, scientific, base_rate_in_region_0_1 (number 0-1 — fréquence d'occurrence chez cette culture × région × saison INDÉPENDAMMENT des photos de ce champ. Ex: cercosporiose noire = 0.8 sur bananeraies non traitées à La Réunion ; mildiou vigne en Gironde en juin humide = 0.6), base_rate_rationale (string courte — pourquoi ce taux : épidémiologie, climat, historique. Ex: 'endémique à La Réunion depuis 1972, présente sur >70% des bananeraies non traitées'), evidence: {supporting: array of {photo_index, x_pct, y_pct, observation} (observations visibles APPUYANT cette maladie sur ce champ ; [] si aucun signe vu), against: array of {observation} (observations qui PLAIDENT CONTRE sur ce champ ; [] si neutre), missing: array of {what (information manquante précise), why (pourquoi elle est nécessaire pour conclure), how_to_obtain (instruction pratique pour l'agriculteur, ex: 'photo en coupe transversale d'une bractée mâle au macro')} ([] si évidence suffisante)}, presence_probability_0_1 (number 0-1 — probabilité FINALE combinant base_rate ET evidence), unknown_rate_0_1 (number 0-1 — part d'incertitude due au manque d'information. 1.0 = on ne peut rien conclure sans plus d'info, 0.0 = on a assez. UTILE pour dire 'va prendre cette photo et reviens'), conclusion_rationale (string — pourquoi cette probabilité ET ce taux d'inconnu. Ex: 'p=0.30 mais unknown=0.60 : feuilles basses nettes mais sans gros plan d'une feuille V/VI, impossible de confirmer'), progression: {current_severity_on_field_0_1 (number 0-1 — gravité ACTUELLE de l'infection telle qu'observée. 0=juste détectable, 0.5=foyers étendus, 1=déjà généralisée), speed_pct_per_week (number 0-100 — vitesse de progression hebdomadaire SANS traitement, dans les conditions actuelles. Ex: mildiou en climat humide = 30-50, oïdium en climat sec = 5-10), weeks_to_full_impact (number — semaines typiques entre l'état actuel et l'impact maximal si non traité. Doit refléter la vitesse réelle), rationale (string — justification: pourquoi cette vitesse et ce délai, en lien avec phenology.expected_harvest_in_days)}, impact_scenarios: {optimistic: {probability_0_1 (number 0-1), impact_pct (number négatif, ex -3), rationale (string — ex: 'temps sec persiste, infection arrêtée naturellement avant véraison')}, neutral: {probability_0_1, impact_pct, rationale (string — scénario le plus probable étant donné climat saisonnier typique)}, pessimistic: {probability_0_1, impact_pct, rationale (string — climat défavorable continu, pas de traitement, progression jusqu'au plafond)}} (les trois probability_0_1 doivent sommer à ~1.0 ; la pessimiste pèse plus si harvest_in_days >> weeks_to_full_impact, moins si la récolte est imminente), yield_impact_pct_if_untreated (number négatif — VALEUR ATTENDUE E[impact] = Σ probability_i × impact_pct_i. C'est cette valeur qui pilote le calcul économique de traitement.), detections: array of {photo_index, x_pct, y_pct, radius_pct, severity_0_1, observation} ([] si pas de signe visible), treatments: [{name, name_local, type, success_probability_0_1, recovery_pct, cost_breakdown: {materials_eur_per_ha, application_method ('mechanized_spray' | 'manual_backpack' | 'per_plant_manual' | 'aerial'), prep_time_h_per_ha, application_time_h_per_ha, labor_eur_per_h, equipment_eur_per_ha}}]}",
  photo_tags: `array of objects, one per uploaded photo, each conforming to: ${JSON.stringify(PHOTO_TAG_SCHEMA)}`,
  cross_check: {
    consistent_0_1: "number — cohérence entre les photos (overview vs single_plant)",
    discrepancies:
      "array of strings — ex: 'photo 2 (plant unique) montre health=30 mais photo 1 (overview) montre 85 — possiblement un plant non représentatif ou un foyer localisé'",
  },
  notes: "string — caveats",
};

export const QUICK_SCHEMA = {
  identification: {
    dominant_crop_fr: "string — nom commun FR (ex: 'Bananier', 'Vigne', 'Pommier')",
    cultivar_or_variety_fr:
      "string|null — nom usuel du cultivar/de la variété si identifiable du contexte ou des photos (ex: 'Cavendish', 'Cabernet Sauvignon', 'Golden Delicious', 'Frangipanier de table'). null si non distinguable.",
    scientific_name: "string — nom binomial Linnéen, espèce + parents hybrides si pertinent",
    confidence_0_1: "number",
  },
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
  // notes + market + diseases sont générés à la demande (boutons "Générer maintenant"
  // dans la grille). Ne PAS les inclure ici, sinon la grille les pré-remplit au démarrage.
};

export const DISEASES_SCHEMA = {
  diseases:
    "array of disease objects (3-6 most plausible for crop × région × saison). Each: {name_fr, name_local, scientific, base_rate_in_region_0_1, base_rate_rationale, evidence: {supporting, against, missing}, presence_probability_0_1, unknown_rate_0_1, conclusion_rationale, progression: {current_severity_on_field_0_1, speed_pct_per_week, weeks_to_full_impact, rationale}, impact_scenarios: {optimistic: {probability_0_1, impact_pct, rationale}, neutral: {probability_0_1, impact_pct, rationale}, pessimistic: {probability_0_1, impact_pct, rationale}}, yield_impact_pct_if_untreated (E[impact] across scenarios), detections, treatments}",
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
    cultivar_or_variety_fr:
      "string|null — cultivar/variété usuelle (ex: 'Cavendish'). null si indéterminable.",
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
