# References

External documents and resources informing the design and agronomic content of AgriVision.

## Theses & academic work

- **Cyprien Terppa (2022)** — Master 2 thesis, Université de Montpellier / DUMAS.
  Topic: agronomy + decision-support for La Réunion crops.
  PDF: https://dumas.ccsd.cnrs.fr/dumas-04023231/file/2022_Terppa_Cyprien.pdf
- **CIRAD Agritrop publication #544321**
  PDF: https://agritrop.cirad.fr/544321/1/544321.pdf

## Data sources used by the app

- **IGN Géoplateforme RPG** — parcel geometries, RPG codes, bio flag.
  https://geoservices.ign.fr/ (WMS + WFS via `data.geopf.fr`)
- **BAN** — French address geocoding (free, no key).
  https://adresse.data.gouv.fr/
- **RNM FranceAgriMer** — départ-producteur prices (referenced by Claude prompts; not currently scraped).
  https://rnm.franceagrimer.fr/
- **Wikipedia REST API** — fallback crop / disease reference photos.
  https://en.wikipedia.org/api/rest_v1/
- **iNaturalist API** — taxon photos when Wikipedia doesn't have one.
  https://api.inaturalist.org/v1/

## Taxonomy / phytosanitary

- **EPPO Global Database** — 6-letter codes for plants, pests, diseases (used in `catalog.json` `eppo` field).
  https://gd.eppo.int/
- **GBIF Backbone Taxonomy** — canonical scientific names + numeric taxon keys (`gbif` field).
  https://www.gbif.org/
- **Wikidata** — cross-reference QIDs (`wikidata` field).
  https://www.wikidata.org/
- **e-phy ANSES** — official FR pesticide & treatment authorizations.
  https://ephy.anses.fr/
