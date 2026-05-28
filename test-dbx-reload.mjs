import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

// First visit — does nothing useful, just to log
const page = await ctx.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:8000', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// Inject a fake token + culture pointers to test the reload path
await page.evaluate(() => {
  localStorage.setItem("dbx_token", "fake_token_xxx");
  localStorage.setItem("agri_culture_id", "2026-05-28_1200_aaaa");
  localStorage.setItem("agri_culture_crop", "BAN");
});
// Reload to fire autoReloadLatest with state present
console.log("\n=== Reloading with fake LS to test autoReload path ===\n");
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Read localStorage to see what's there
const ls = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    let v = localStorage.getItem(k);
    if (k === 'dbx_token' || k === 'dbx_refresh') v = `<present, ${v.length} chars>`;
    out[k] = v;
  }
  return out;
});

// Read what's currently in the dbx panel
const panel = await page.locator('#dbx-panel').innerText().catch(() => '');

console.log('=== localStorage ===');
console.log(JSON.stringify(ls, null, 2));
console.log('\n=== #dbx-panel ===');
console.log(panel);
console.log('\n=== console (last 30) ===');
logs.slice(-30).forEach(l => console.log(l));

await browser.close();
