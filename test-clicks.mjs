import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = "file://" + path.join(__dirname, "index.html");

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: [] });
const page = await ctx.newPage();

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.map && window.map.setView, { timeout: 10000 });

// Pan to a La Réunion area with actual parcels (Saint-Joseph / Saint-Pierre cane fields).
await page.evaluate(() => window.map.setView([-21.3, 55.62], 16));
await page.waitForTimeout(2500);

// Query WFS in current viewport to find one real parcel + its centroid.
const target = await page.evaluate(async () => {
  const b = window.map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},EPSG:4326`;
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: "IGNF_RPG_PARCELLES-AGRICOLES-CATEGORISEES_2024:parcelles_agricole_categorisees_2024",
    bbox,
    count: "20",
    outputFormat: "application/json",
    srsName: "EPSG:4326",
  });
  const r = await fetch(`https://data.geopf.fr/wfs/ows?${params}`);
  const j = await r.json();
  if (!j.features?.length) return null;
  // Centroid of the first parcel's first ring
  const ring = j.features[0].geometry.coordinates[0][0]; // MultiPolygon[0][0] = outer ring
  let sx = 0,
    sy = 0;
  ring.forEach(([x, y]) => {
    sx += x;
    sy += y;
  });
  const centroid = [sx / ring.length, sy / ring.length];
  return {
    code_cultu: j.features[0].properties.code_cultu,
    area: j.features[0].properties.sf_adm_de || j.features[0].properties.sf_adm_co,
    centroid, // [lon, lat]
    total: j.totalFeatures,
  };
});

if (!target) {
  console.log("No parcels in viewport — cannot test click");
  process.exit(1);
}
console.log("Target parcel:", JSON.stringify(target, null, 2));

// Center the map on the target so its centroid is at viewport center.
await page.evaluate((c) => window.map.setView([c[1], c[0]], 17), target.centroid);
await page.waitForTimeout(2000);

const mapBox = await page.locator("#map").boundingBox();
const cx = Math.round(mapBox.x + mapBox.width / 2);
const cy = Math.round(mapBox.y + mapBox.height / 2);

await page.screenshot({ path: "/tmp/agriv_before_click.png", fullPage: false });
console.log(`Clicking centroid at screen (${cx},${cy})…`);
await page.mouse.click(cx, cy);
await page.waitForTimeout(1500);

const panel = await page.locator("#parcel-info").innerText();
const selectedCount = await page.evaluate(
  () => window.selectedParcels?.size ?? "(no window.selectedParcels)"
);
await page.screenshot({ path: "/tmp/agriv_after_click.png", fullPage: false });

console.log("\n=== PARCEL PANEL AFTER CLICK ===");
console.log(panel);
console.log("\nSelected parcels count:", selectedCount);

// Verify: panel should now show a non-zero ha if our fix works
const hasSurface = /\d+\.\d{2} ha/.test(panel) && !/0\.00 ha/.test(panel);
console.log(hasSurface ? "✅ Surface > 0 displayed" : "❌ Surface bug NOT fixed");

console.log("\n=== CONSOLE ===");
logs.slice(-10).forEach((l) => console.log(l));

await browser.close();
