// POST /api/plan: AI suggestions for the trip planner (city profile, inspiration draft). JSON in, JSON out.
// This endpoint spends money, so: exact-origin CORS, 4 KB body cap, per-instance rate limit, a daily call cap,
// and a kill switch. When no model gives a valid answer it says "unavailable" and the frontend uses its template.
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientIp, makeLimiter } from "../http.ts";
import { callModel, type Attempt, type Source } from "./providers.ts";
import {
  CATEGORIES,
  CITY_PROFILE_JSON_SCHEMA,
  INSPIRATION_JSON_SCHEMA,
  PlanRequest,
  validateCityProfile,
  validateInspiration,
} from "./schemas.ts";

type Req = IncomingMessage & { body?: unknown };
type Env = Record<string, string | undefined>;

export const ALLOWED_ORIGINS = ["https://mridulsaravanan.com", "http://127.0.0.1:8080", "http://127.0.0.1:8090"];
const MAX_BODY = 4096;
const LABEL = "AI-suggested - not checked";

const limited = makeLimiter(10); // per IP per minute, per warm instance

// Daily in-memory counter of provider calls (per warm instance, resets at midnight India time).
const daily = { day: "", n: 0 };
function istDay(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
function dailyCap(env: Env): number {
  const n = Number(env.ADHVAGA_DAILY_CALL_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 300;
}
function capReached(env: Env): boolean {
  const d = istDay();
  if (daily.day !== d) Object.assign(daily, { day: d, n: 0 });
  return daily.n >= dailyCap(env);
}
function takeCall(env: Env): boolean {
  if (capReached(env)) return false;
  daily.n += 1;
  return true;
}
/** Test hook. */
export function resetPlanCounters() {
  Object.assign(daily, { day: "", n: 0 });
}

function send(res: ServerResponse, code: number, payload: Record<string, unknown>, extra: Record<string, string> = {}) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function envelope(status: "success" | "unavailable" | "error", source: Source | null, data: unknown, error: { code: string; message: string } | null, meta?: unknown) {
  return { status, source, label: LABEL, retrieved_at: new Date().toISOString(), data, error, ...(meta === undefined ? {} : { meta }) };
}
const err = (code: string, message: string) => envelope("error", null, null, { code, message });

class BodyError extends Error {
  code: number;
  tag: string;
  constructor(code: number, tag: string) {
    super(tag);
    this.code = code;
    this.tag = tag;
  }
}

async function readBody(req: Req): Promise<unknown> {
  if (req.body !== undefined) {
    // Vercel already parsed it; re-measure.
    const s = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);
    if (Buffer.byteLength(s) > MAX_BODY) throw new BodyError(413, "BODY_TOO_LARGE");
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    try {
      return JSON.parse(s);
    } catch {
      throw new BodyError(400, "BAD_JSON");
    }
  }
  const len = Number(req.headers["content-length"]);
  if (Number.isFinite(len) && len > MAX_BODY) throw new BodyError(413, "BODY_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new BodyError(413, "BODY_TOO_LARGE");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError(400, "BAD_JSON");
  }
}

// Model input is never raw user text in the system prompt: city fields are length-checked by zod and quoted as JSON.
function prompts(r: PlanRequest): { system: string; user: string } {
  const where = `${r.city.name}, ${r.city.state}`;
  const facts = JSON.stringify({ city: r.city.name, state: r.city.state, lat: r.city.lat, lng: r.city.lng, interests: r.interests ?? [] });
  if (r.op === "city-profile") {
    return {
      system:
        `You classify what a visitor can plausibly find in ${where}, India. Choose ONLY from the given category list. If unsure, omit. ` +
        `Never invent geography (no beaches for inland cities; "beaches" only if the city itself is on the sea coast). ` +
        `Fields: categories (from the list), summary (plain, at most 300 characters), cautions (0 to 4 short general cautions, at most 150 characters each). ` +
        `No clock times, no prices, no hotel or business names.`,
      user: `Category list: ${JSON.stringify(CATEGORIES)}\nCity: ${facts}`,
    };
  }
  return {
    system:
      `Day themes and research pointers for ${where}, India. No times, no prices, no hotel names. Generic honest themes. ` +
      `Include rest/open days when days > 5 (at least one day whose theme starts with "Rest day" or "Open day"). Return exactly ${r.days} entries in "days", in order. ` +
      `Each theme at most 60 characters; 2 to 4 ideas per day, each at most 90 characters; researchChecklist 3 to 8 items of things the traveller should verify themselves (opening days, local rules, weather). ` +
      `Do not write clock times, durations like 10.30, prices, currency, or any hotel/resort/homestay mention.`,
    user: `Days: ${r.days}\nCity: ${facts}`,
  };
}

export interface PlanDeps {
  env?: Env;
  fetch?: typeof fetch;
}

export function makePlanHandler(deps: PlanDeps = {}) {
  return async function planHandler(req: Req, res: ServerResponse) {
    const env = deps.env ?? process.env;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    res.setHeader("Vary", "Origin");
    if (origin !== undefined) {
      if (!ALLOWED_ORIGINS.includes(origin)) return send(res, 403, err("ORIGIN_NOT_ALLOWED", "This origin may not call the planner AI."));
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "POST") return send(res, 405, err("METHOD_NOT_ALLOWED", "Use POST."), { Allow: "POST, OPTIONS" });

    if (env.ADHVAGA_AI_DISABLED === "1") return send(res, 503, { ...envelope("unavailable", null, null, { code: "AI_DISABLED", message: "AI suggestions are switched off." }), disabled: true });

    if (limited(clientIp(req))) return send(res, 429, err("RATE_LIMITED", "Too many requests, try again in a minute."), { "Retry-After": "60" });
    if (capReached(env)) return send(res, 429, err("DAILY_CAP", "The planner AI has reached today's limit. Try again tomorrow; the template plan still works."), { "Retry-After": "3600" });

    const ct = String(req.headers["content-type"] ?? "");
    if (!/application\/json/i.test(ct)) return send(res, 415, err("UNSUPPORTED_MEDIA_TYPE", "Send Content-Type: application/json."));

    let raw: unknown;
    try {
      raw = await readBody(req);
    } catch (e) {
      if (e instanceof BodyError) return send(res, e.code, err(e.tag, e.code === 413 ? "Request body is over 4 KB." : "Body is not valid JSON."));
      return send(res, 400, err("BAD_REQUEST", "Could not read the request body."));
    }
    const parsed = PlanRequest.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
      return send(res, 400, err("INVALID_REQUEST", issues.slice(0, 300)));
    }
    const r = parsed.data;
    const { system, user } = prompts(r);
    let attempts: Attempt[] = [];
    try {
      const out =
        r.op === "city-profile"
          ? await callModel({ system, user, schemaName: "city_profile", jsonSchema: CITY_PROFILE_JSON_SCHEMA, validate: validateCityProfile, env, fetch: deps.fetch, beforeCall: () => takeCall(env) })
          : await callModel({ system, user, schemaName: "inspiration_draft", jsonSchema: INSPIRATION_JSON_SCHEMA, validate: (x) => validateInspiration(x, r.days!), env, fetch: deps.fetch, beforeCall: () => takeCall(env) });
      attempts = out.attempts;
      if (out.result) return send(res, 200, envelope("success", out.result.source, out.result.json, null, { op: r.op, attempts }));
    } catch {
      // fall through to unavailable
    }
    return send(res, 200, envelope("unavailable", null, null, { code: "AI_UNAVAILABLE", message: "No AI suggestion right now; use the template plan." }, { op: r.op, attempts }));
  };
}

export const planHandler = makePlanHandler();
