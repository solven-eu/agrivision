// Live collaboration session. Launches a headed Chromium and keeps it open.
// Stream-logs console + network for `localhost:8000` to stdout so the agent can read.
import { chromium } from "playwright";

const userDataDir = "/tmp/agriv-pw-profile";

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1500, height: 950 },
  args: ["--auto-open-devtools-for-tabs"],
});

const page = ctx.pages()[0] || (await ctx.newPage());

page.on("console", (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
page.on("response", (resp) => {
  const u = resp.url();
  if (/anthropic|dropbox|geopf|api-adresse|localhost:8787/.test(u)) {
    console.log(`[net] ${resp.status()} ${resp.request().method()} ${u.slice(0, 140)}`);
  }
});

await page.goto("http://localhost:8000");

console.log("--- Live Playwright session running. Browser window is open. ---");
console.log("Profile dir (localStorage persists here):", userDataDir);
console.log("Close the browser window to exit.");

// Keep alive
await new Promise(() => {});
