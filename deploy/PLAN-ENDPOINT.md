# /api/plan - AI suggestions for the trip planner

One endpoint, two operations, chosen by `body.op`:

- `city-profile` - which categories (from a fixed list of 12) a visitor can plausibly find in a city, a short summary, general cautions.
- `inspiration-draft` - one theme and 1-5 ideas per day, plus a research checklist for the traveller.

Every answer is labelled `"AI-suggested - not checked"`. When no model gives a valid answer, the endpoint returns
`{"status":"unavailable","data":null}` and the website shows its own template plan. No template is made on the server.

Code: `src/plan/plan.ts` (handler), `src/plan/providers.ts` (model chain), `src/plan/schemas.ts` (zod shapes and rules).
Tests: `npm test` (mocked providers, no network, no keys).

## Request

```json
POST /api/plan
Content-Type: application/json

{ "op": "inspiration-draft",
  "city": { "name": "Mysuru", "state": "Karnataka", "lat": 12.2958, "lng": 76.6394 },
  "days": 7,
  "interests": ["heritage", "food"] }
```

- `city.name`, `city.state`: 1-60 characters. `lat` 6..38, `lng` 68..98 (India box). `days`: 1-14, required for `inspiration-draft`.
- `interests`: up to 8 strings of up to 40 characters. Unknown fields are rejected.

## Response

```json
{ "status": "success", "source": "groq", "label": "AI-suggested - not checked",
  "retrieved_at": "2026-11-14T10:00:00.000Z", "data": { ... }, "error": null,
  "meta": { "op": "city-profile", "attempts": [ { "source": "groq", "outcome": "ok", "latency_ms": 1021, "usage": { ... } } ] } }
```

`status` is `success`, `unavailable` (models failed: render the template) or `error` (bad request, limits).
`meta.attempts` holds short outcome codes only, never provider error text.

## Model chain

Groq (primary, structured JSON output) -> one NVIDIA attempt (fallback, thinking off, strict JSON parse) -> `unavailable`.

`inspiration-draft` runs Claude -> Groq -> NVIDIA when `ANTHROPIC_API_KEY` is set and Claude's own daily cap
(`ADHVAGA_CLAUDE_DAILY_CAP`, default 40, about $1/day) is not spent; otherwise Groq -> NVIDIA. `city-profile` never uses Claude.
Claude: Messages API, `ADHVAGA_CLAUDE_MODEL` (default `claude-sonnet-5-5`), max_tokens 1500, JSON asked for in the
system prompt, first `{...}` block taken from any prose. No temperature is sent: the API rejects it for this model.
Temperature 0.4, max_tokens 2000, per-call timeout 25 s, 27 s total per request (the function limit is 30 s);
when a fallback is configured the primary call stops early enough to leave it 10 s.

An answer is thrown away (and the next provider tried) when it fails the schema or any of these rules:
a clock time (`10:30`, `9.45`), a rupee sign or `Rs`/`INR` amount, `hotel`/`resort`/`homestay` in a theme or idea,
a category outside the list, or a day count different from the one asked for.

## Limits and switches

| What | Value | Where |
|---|---|---|
| Body size | 4 KB, else 413 | code |
| Per-IP rate | 10 requests a minute per warm instance, else 429 | code (same limiter as the MCP servers) |
| Daily model calls | `ADHVAGA_DAILY_CALL_CAP`, default 300 per warm instance, resets at midnight India time; else 429 | env |
| Kill switch | `ADHVAGA_AI_DISABLED=1` -> 503 `{"disabled":true}`, no model is called | env |
| Model time budget | `ADHVAGA_MODEL_BUDGET_MS`, default 27000 | env (optional) |

The rate limit and daily cap live in memory, so Vercel may run several instances, each with its own count.
They are brakes, not walls. The real spending wall is the free-tier limit on each provider account.

## CORS

Only these origins are allowed (echoed back exactly, never `*`): `https://mridulsaravanan.com`,
`http://127.0.0.1:8080`, `http://127.0.0.1:8090`. Any other `Origin` gets 403 before any model call.
Requests with no `Origin` header (curl, server-to-server) are served. Methods: POST, OPTIONS.
To allow `https://www.mridulsaravanan.com` as well, add it to `ALLOWED_ORIGINS` in `src/plan/plan.ts` and rebuild.

## Environment variables on Vercel (names only)

Required:

- `GROQ_API_KEY`
- `NVIDIA_API_KEY`
- `ADHVAGA_PRIMARY_MODEL`
- `ADHVAGA_PRIMARY_URL`
- `ADHVAGA_FALLBACK_MODEL`
- `ADHVAGA_FALLBACK_URL`

For Claude on `inspiration-draft` (leave `ANTHROPIC_API_KEY` out to run without Claude):

- `ANTHROPIC_API_KEY`
- `ADHVAGA_CLAUDE_MODEL` (optional, default `claude-sonnet-5-5`)
- `ADHVAGA_CLAUDE_DAILY_CAP` (optional, default 40 Claude calls a day per warm instance; when spent, Claude is skipped and Groq answers)

Optional: `ADHVAGA_DAILY_CALL_CAP` (counts Claude calls too), `ADHVAGA_AI_DISABLED`, `ADHVAGA_MODEL_BUDGET_MS`.

If a provider's URL, model or key is missing, that provider is skipped. With both missing, every call returns `unavailable`.

## Owner steps to deploy

1. On this Mac, in `deploy/`: `export PATH="$HOME/.local/node/bin:$PATH"`, then `npm ci`, `npm run bundle`, `npm test`.
   `api/plan.js` must now sit next to `api/metro.js`, `api/buses.js`, `api/knowledge.js`.
2. Open vercel.com -> project `adhvaga-mcp` -> Settings -> Environment Variables. Add the six required names above
   (plus `ANTHROPIC_API_KEY` for Claude) for the Production environment, pasting values from `~/.config/adhvaga/keys.env`.
   Mark the keys Sensitive.
3. Deploy the new build the same way the current live build was deployed (the bundled `api/` and `public/` folders are
   prebuilt; Vercel runs no install or build step). Environment variables only apply to deployments made after they are
   saved, so if the code was already deployed before step 2, use Deployments -> latest -> Redeploy.
4. Check:
   `curl -s -X POST https://adhvaga-mcp.vercel.app/api/plan -H 'Content-Type: application/json' -d '{"op":"city-profile","city":{"name":"Mysuru","state":"Karnataka","lat":12.2958,"lng":76.6394}}'`
   should return `"status":"success"` with no `"beaches"` in `categories`.
5. To switch AI off at any time: add `ADHVAGA_AI_DISABLED` = `1` and redeploy. Remove it and redeploy to switch back on.
