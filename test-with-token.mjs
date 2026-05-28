// Reproduces F5 with a real Dropbox token to verify autoReload path end-to-end.
import { chromium } from "playwright";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("usage: node test-with-token.mjs <dbx_token>");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();

const logs = [];
const netCalls = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("response", async (resp) => {
  const u = resp.url();
  if (/dropboxapi|dropbox\.com/.test(u)) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 200);
    } catch {}
    netCalls.push(`${resp.status()} ${resp.request().method()} ${u.slice(0, 90)} → ${body}`);
  }
});

await page.goto("http://localhost:8000", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(800);

// Inject the real token + force a reload to trigger autoReload
await page.evaluate((t) => {
  localStorage.setItem("dbx_token", t);
}, TOKEN);
console.log("Token injected. Reloading…");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000); // allow auto-reload to fetch from Dropbox

// Read state
const ls = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    let v = localStorage.getItem(k);
    if (k === "dbx_token" || k === "dbx_refresh") v = `<${v.length} chars>`;
    out[k] = v;
  }
  return out;
});
const panel = await page.locator("#dbx-panel").innerText();
const photosLen = await page.evaluate(() => photos?.length ?? -1);
const parcelsLen = await page.evaluate(() => selectedParcels?.size ?? -1);

console.log("\n=== localStorage after reload ===");
console.log(JSON.stringify(ls, null, 2));
console.log("\n=== #dbx-panel ===");
console.log(panel);
console.log("\n=== state.photos.length =", photosLen, ", selectedParcels.size =", parcelsLen);
console.log("\n=== Dropbox API calls ===");
netCalls.forEach((c) => console.log(c));
console.log("\n=== console (relevant) ===");
logs
  .filter((l) => /dbx|culture|crop|err|warn/i.test(l))
  .slice(-15)
  .forEach((l) => console.log(l));

await browser.close();
