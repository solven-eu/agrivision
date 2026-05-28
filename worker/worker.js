// AgriVision Cloudflare Worker — proxies Anthropic so the API key stays server-side.
//
// Dashboard: https://dash.cloudflare.com/ef022c9a994ccb0772ab8b3b43f25ffe/workers/services/view/agrivision-api/production
//
// Routes:
//   OPTIONS *               → CORS preflight
//   POST    /api/analyze    → forward to https://api.anthropic.com/v1/messages
//
// Secrets:
//   ANTHROPIC_API_KEY       (set via: wrangler secret put ANTHROPIC_API_KEY)
//
// Optional environment:
//   ALLOWED_ORIGIN          (defaults to "*"; set to your hosting origin to lock it down)

const ALLOWED_HEADERS = "content-type,anthropic-version";
const MAX_BODY_BYTES = 25 * 1024 * 1024;  // 25 MB cap (several large images + context)

const corsHeaders = (origin) => ({
  "access-control-allow-origin": origin || "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": ALLOWED_HEADERS,
  "access-control-max-age": "86400",
  "vary": "Origin"
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== "/api/analyze" || req.method !== "POST") {
      return new Response("not found", { status: 404, headers: corsHeaders(origin) });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "ANTHROPIC_API_KEY secret not configured" }, 500, origin);
    }

    const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: `payload exceeds ${MAX_BODY_BYTES} bytes` }, 413, origin);
    }

    let body;
    try { body = await req.text(); }
    catch (e) { return json({ error: "could not read body: " + e.message }, 400, origin); }

    // OAuth tokens (sk-ant-oat-*) use Bearer auth + the oauth beta header;
    // long-lived API keys (sk-ant-api*) use x-api-key.
    const key = env.ANTHROPIC_API_KEY;
    // OAuth tokens look like sk-ant-oat01-…, sk-ant-oat02-…, etc.
    const isOAuth = /^sk-ant-oat\d*-/.test(key);
    const upstreamHeaders = {
      "content-type": "application/json",
      "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01"
    };
    if (isOAuth) {
      upstreamHeaders["Authorization"] = `Bearer ${key}`;
      upstreamHeaders["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      upstreamHeaders["x-api-key"] = key;
    }
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: upstreamHeaders, body
    });

    // Stream the upstream response back with CORS.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        ...corsHeaders(origin)
      }
    });
  }
};

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) }
  });
}
