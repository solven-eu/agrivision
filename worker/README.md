# AgriVision Worker

Tiny Cloudflare Worker that proxies `POST /api/analyze` to the Anthropic API, keeping the API key server-side.

## One-time setup

```sh
cd worker
npm install -g wrangler          # if not already installed
wrangler login                   # opens browser, OAuth with your Cloudflare account
wrangler secret put ANTHROPIC_API_KEY
# paste the sk-ant-... key when prompted (it never touches git)
```

## Run locally

```sh
wrangler dev
# → http://localhost:8787/api/analyze
```

Point `WORKER_URL` in `index.html` to `http://localhost:8787` and you can test end-to-end on your machine without deploying.

## Deploy

```sh
wrangler deploy
# → https://agrivision-api.<your-subdomain>.workers.dev/api/analyze
```

Copy that URL into `WORKER_URL` in `index.html` (top of the `<script>`).

## Lock down CORS

By default the worker allows any origin (`*`). Once you have a stable hosting URL, edit `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "https://agrivision.example.com"
```

Then redeploy.

## Costs

Free tier covers 100 000 requests/day and 10 ms CPU per request — well beyond what a personal/demo deployment will use. Beyond that: $5/month for 10 M requests.
