// Model chain for /api/plan: Groq (primary) -> one NVIDIA attempt (fallback) -> null.
// null means "no usable AI answer": the frontend then shows its own deterministic template.
// Raw provider errors never leave this file; callers only see short attempt codes.

export type Source = "groq" | "nvidia";
export type Validate<T> = (raw: unknown) => { ok: true; value: T } | { ok: false; reason: string };

export interface Attempt {
  source: Source;
  outcome: "ok" | "skipped_no_config" | "timeout" | "http_error" | "network_error" | "bad_json" | "invalid_output" | "budget";
  detail?: string; // short code only (HTTP status or validation reason), never provider text
  latency_ms?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface CallOpts<T> {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  validate: Validate<T>;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Called before each provider request; return false to stop (daily cap). */
  beforeCall?: () => boolean;
}

export interface CallResult<T> {
  result: { source: Source; json: T } | null;
  attempts: Attempt[];
}

const PER_CALL_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 2000;
const TEMPERATURE = 0.4;
const FALLBACK_RESERVE_MS = 10_000;

interface Provider {
  source: Source;
  url?: string;
  model?: string;
  key?: string;
  structured: boolean; // Groq: response_format json_schema. NVIDIA: schema in the prompt, strict parse.
}

function providers(env: Record<string, string | undefined>): Provider[] {
  return [
    { source: "groq", url: env.ADHVAGA_PRIMARY_URL, model: env.ADHVAGA_PRIMARY_MODEL, key: env.GROQ_API_KEY, structured: true },
    { source: "nvidia", url: env.ADHVAGA_FALLBACK_URL, model: env.ADHVAGA_FALLBACK_MODEL, key: env.NVIDIA_API_KEY, structured: false },
  ];
}

/** Total time this request may spend on models (Vercel maxDuration is 30 s for api/*.js). */
function budgetMs(env: Record<string, string | undefined>): number {
  const n = Number(env.ADHVAGA_MODEL_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 27_000;
}

/** Drops <think> blocks and ``` fences, then takes the outermost JSON object. Anything else is rejected. */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  if (!t.startsWith("{")) {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("no json");
    t = t.slice(a, b + 1);
  }
  return JSON.parse(t);
}

/** Removes any "reasoning"-like keys a model may put in its JSON answer. */
export function stripReasoning(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripReasoning);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (!/^(reasoning|reasoning_content|thinking|thoughts?)$/i.test(k)) out[k] = stripReasoning(v);
    return out;
  }
  return x;
}

function body(p: Provider, o: CallOpts<unknown>) {
  const system = p.structured
    ? o.system
    : `${o.system}\nReply with ONE JSON object only, no prose, no markdown, matching this JSON Schema:\n${JSON.stringify(o.jsonSchema)}`;
  const b: Record<string, unknown> = {
    model: p.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: o.user },
    ],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false,
  };
  if (p.structured) {
    b.response_format = { type: "json_schema", json_schema: { name: o.schemaName, strict: true, schema: o.jsonSchema } };
    b.reasoning_effort = "low";
  } else {
    // Nemotron reasoning models: thinking off (about 1 s instead of 15 s+, and no reasoning text to strip).
    b.chat_template_kwargs = { enable_thinking: false };
  }
  return b;
}

export async function callModel<T>(o: CallOpts<T>): Promise<CallResult<T>> {
  const env = o.env ?? process.env;
  const doFetch = o.fetch ?? fetch;
  const deadline = Date.now() + budgetMs(env);
  const attempts: Attempt[] = [];

  const list = providers(env);
  for (const [i, p] of list.entries()) {
    if (!p.url || !p.model || !p.key) {
      attempts.push({ source: p.source, outcome: "skipped_no_config" });
      continue;
    }
    const left = deadline - Date.now();
    if (left < 2_000) {
      attempts.push({ source: p.source, outcome: "budget" });
      continue;
    }
    if (o.beforeCall && !o.beforeCall()) {
      attempts.push({ source: p.source, outcome: "budget", detail: "daily_cap" });
      break;
    }
    const t0 = Date.now();
    const ac = new AbortController();
    // Keep FALLBACK_RESERVE_MS of the budget for the next provider, so a hung primary does not eat the fallback.
    const next = list.slice(i + 1).some((q) => q.url && q.model && q.key);
    const timer = setTimeout(() => ac.abort(), Math.min(PER_CALL_TIMEOUT_MS, next ? Math.max(2_000, left - FALLBACK_RESERVE_MS) : left));
    const a: Attempt = { source: p.source, outcome: "ok" };
    try {
      const r = await doFetch(p.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}`, Accept: "application/json" },
        body: JSON.stringify(body(p, o as CallOpts<unknown>)),
        signal: ac.signal,
      });
      if (!r.ok) {
        a.outcome = "http_error";
        a.detail = String(r.status);
        await r.text().catch(() => "");
        continue;
      }
      const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: Attempt["usage"] };
      if (j.usage) a.usage = { prompt_tokens: j.usage.prompt_tokens, completion_tokens: j.usage.completion_tokens, total_tokens: j.usage.total_tokens };
      const content = j.choices?.[0]?.message?.content; // message.reasoning / reasoning_content are ignored
      let parsed: unknown;
      try {
        if (typeof content !== "string") throw new Error("no content");
        parsed = stripReasoning(p.structured ? JSON.parse(content) : extractJson(content));
      } catch {
        a.outcome = "bad_json";
        continue;
      }
      const v = o.validate(parsed);
      if (!v.ok) {
        a.outcome = "invalid_output";
        a.detail = v.reason;
        continue;
      }
      a.latency_ms = Date.now() - t0;
      attempts.push(a);
      return { result: { source: p.source, json: v.value }, attempts };
    } catch (e) {
      a.outcome = (e as Error)?.name === "AbortError" ? "timeout" : "network_error";
    } finally {
      clearTimeout(timer);
      a.latency_ms ??= Date.now() - t0;
      if (!attempts.includes(a)) attempts.push(a);
    }
  }
  return { result: null, attempts };
}
