// Validates every curated image URL in catalog.json with a HEAD request.
// Exits non-zero on the first failure. Intended for CI / pre-commit.
//
// Usage: node test-catalog-urls.mjs
import { readFile } from "fs/promises";

const catalog = JSON.parse(await readFile(new URL("./catalog.json", import.meta.url), "utf8"));

const urls = [];
function collect(category, dict) {
  if (!dict) return;
  for (const [key, entry] of Object.entries(dict)) {
    if (key.startsWith("_")) continue; // schema-example entries
    const url = typeof entry === "string" ? entry : entry?.image;
    if (url && url.startsWith("http")) urls.push({ category, key, url });
  }
}
collect("crops", catalog.crops);
collect("diseases", catalog.diseases);

if (urls.length === 0) {
  console.log("No curated image URLs in catalog.json — nothing to validate.");
  process.exit(0);
}

console.log(`Validating ${urls.length} image URL(s)…\n`);

let failures = 0;
for (const { category, key, url } of urls) {
  try {
    // HEAD is enough; some CDNs disallow it → fall back to range GET.
    let r = await fetch(url, { method: "HEAD" });
    if (r.status === 405 || r.status === 403) {
      r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1023" } });
    }
    const ok = r.ok || r.status === 206;
    const tag = ok ? "✓" : "✗";
    console.log(`${tag} [${category}] ${key} → ${r.status} ${url.slice(0, 80)}`);
    if (!ok) failures++;
  } catch (e) {
    console.log(`✗ [${category}] ${key} → ${e.message} ${url.slice(0, 80)}`);
    failures++;
  }
}

console.log(`\n${urls.length - failures}/${urls.length} valid.`);
process.exit(failures > 0 ? 1 : 0);
