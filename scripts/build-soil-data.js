#!/usr/bin/env node
// AgriVision — preprocess the Réunion soil dataset into a slim, Worker-friendly format.
//
// Source:
//   Nature Scientific Data 2026:
//     https://www.nature.com/articles/s41597-026-07254-8
//   Dataset (CIRAD Dataverse — soil_run.csv, ~3.4 MB):
//     https://dataverse.cirad.fr/file.xhtml?fileId=32543
//   License: CC-BY (cite the Nature paper + the Dataverse DOI when redistributing).
//
// Input:  ~/Downloads/soil_run.csv (25k samples on La Réunion, UTM 40S coords)
// Output: worker/data/soil-reunion.json (slim array-of-arrays, ~600 KB gzipped)
//
// Run with: node scripts/build-soil-data.js [/path/to/soil_run.csv]
// Default input path:  ~/Downloads/soil_run.csv
//
// Output schema:
//   {
//     v: 1,
//     fields: ["lat", "lon", "soilCode", "landCode", "year",
//              "pH_H2O", "N_tot", "C_org", "P_OD", "CEC",
//              "K_ex", "Mg_ex", "Ca_ex", "Na_ex", "pF25", "pF42"],
//     soil_types: ["Andosols", "Vertisols", ...], // codes are indices into this
//     land_uses: ["Sugarcane", "Banana", ...],    // codes are indices into this
//     rows: [[-21.1234, 55.4567, 2, 0, 2012, 5.9, 3.2, 4.1, 120, 22, 0.45, 1.8, 8.2, 0.4, 39, 21], ...]
//   }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import proj4 from "proj4";

const INPUT = process.argv[2] || path.join(os.homedir(), "Downloads/soil_run.csv");
const OUTPUT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "worker/data/soil-reunion.json"
);

// EPSG:32740 (UTM zone 40 South) → WGS84 (EPSG:4326).
proj4.defs("EPSG:32740", "+proj=utm +zone=40 +south +datum=WGS84 +units=m +no_defs");
const toWgs84 = proj4("EPSG:32740", "EPSG:4326");

const SOIL_TYPES = [];
const LAND_USES = [];
const codeFor = (arr, val) => {
  if (!val) return null;
  let idx = arr.indexOf(val);
  if (idx === -1) {
    idx = arr.length;
    arr.push(val);
  }
  return idx;
};

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const num = (s) => {
  if (s == null || s === "") return null;
  const t = String(s).replace(",", ".").trim();
  if (!NUMBER_RE.test(t)) return null;
  return Math.round(parseFloat(t) * 100) / 100;
};

const csv = fs.readFileSync(INPUT, "utf8").replace(/^﻿/, "");
const lines = csv.split(/\r?\n/);
const header = lines[0].split(";").map((h) => h.trim());
// We skip line 1 (it's the units row).
const rows = [];
let dropped = 0;
for (let i = 2; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const cells = line.split(";");
  const get = (name) => cells[header.indexOf(name)];
  const easting = num(get("LONGITUDE"));
  const northing = num(get("LATITUDE"));
  if (easting == null || northing == null) {
    dropped++;
    continue;
  }
  // proj4 returns [lon, lat] in degrees.
  const [lon, lat] = toWgs84.forward([easting, northing]);
  if (!isFinite(lat) || !isFinite(lon)) {
    dropped++;
    continue;
  }
  const soilCode = codeFor(SOIL_TYPES, (get("SOIL") || "").trim());
  const landCode = codeFor(LAND_USES, (get("LAND USE") || "").trim());
  const dateStr = (get("DATE") || "").trim();
  // DD/MM/YYYY → YYYY
  let year = null;
  const dm = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (dm) year = parseInt(dm[3], 10);
  const pH = num(get("pH H2O"));
  // Drop rows with no pH — they're rare and the AI prompt depends on it as the headline.
  if (pH == null) {
    dropped++;
    continue;
  }
  rows.push([
    Math.round(lat * 100000) / 100000, // 5 dp = ~1m precision
    Math.round(lon * 100000) / 100000,
    soilCode,
    landCode,
    year,
    pH,
    num(get("N tot.")),
    num(get("C org.")),
    num(get("P O.-D.")),
    num(get("CEC")),
    num(get("K ex.")),
    num(get("Mg ex.")),
    num(get("Ca ex.")),
    num(get("Na ex.")),
    num(get("pF 2.5")),
    num(get("pF4.2")),
  ]);
}

const out = {
  v: 1,
  source:
    "Nature Scientific Data 2026 — soil_run.csv (CIRAD Dataverse fileId=32543, https://dataverse.cirad.fr/file.xhtml?fileId=32543)",
  generated_at: new Date().toISOString(),
  fields: [
    "lat",
    "lon",
    "soilCode",
    "landCode",
    "year",
    "pH_H2O",
    "N_tot",
    "C_org",
    "P_OD",
    "CEC",
    "K_ex",
    "Mg_ex",
    "Ca_ex",
    "Na_ex",
    "pF25",
    "pF42",
  ],
  soil_types: SOIL_TYPES,
  land_uses: LAND_USES,
  rows,
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(out));
const sizeKb = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
console.log(`✓ wrote ${OUTPUT}`);
console.log(`  rows: ${rows.length}  (dropped: ${dropped})`);
console.log(`  soil types: ${SOIL_TYPES.length}`);
console.log(`  land uses: ${LAND_USES.length}`);
console.log(`  size: ${sizeKb} KB raw (~${Math.round(sizeKb * 0.3)} KB gzipped est.)`);
