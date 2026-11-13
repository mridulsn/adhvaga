// Model chain for /api/plan: Groq (primary) -> one NVIDIA attempt (fallback) -> null.
// inspiration-draft only: Claude goes first when ANTHROPIC_API_KEY is set and its own daily cap allows.
// null means "no usable AI answer": the frontend then shows its own deterministic template.
// Raw provider errors never leave this file; callers only see short attempt codes.

export type Source = "claude" | "groq" | "nvidia";
export type Validate<T> = (raw: unknown) => { ok: true; value: T } | { ok: false; reason: string };

export interface Attempt {
  source: Source;
  outcome: "ok" | "skipped_no_config" | "skipped_daily_cap" | "timeout" | "http_error" | "network_error" | "bad_json" | "invalid_output" | "budget";
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
  /** Put Claude first in the chain (inspiration-draft). */
  useClaude?: boolean;
  /** Claude's own daily cap: return false to skip Claude silently and go on to Groq. */
  beforeClaude?: () => boolean;
}

export interface CallResult<T> {
  result: { source: Source; json: T } | null;
  attempts: Attempt[];
}

const PER_CALL_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 2000;
const TEMPERATURE = 0.4;
const FALLBACK_RESERVE_MS = 10_000;
const CLAUDE_MAX_TOKENS = 1500;
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface Provider {
  source: Source;
  url?: string;
  model?: string;
  key?: string;
  structured: boolean; // Groq: response_format json_schema. NVIDIA and Claude: schema in the prompt, strict parse.
}

function providers(env: Record<string, string | undefined>, useClaude: boolean): Provider[] {
  return [
    // Claude joins the chain only when its key is set; without one it is simply not there (no attempt recorded).
    ...(useClaude && env.ANTHROPIC_API_KEY
      ? [{ source: "claude" as const, url: env.ADHVAGA_CLAUDE_URL || CLAUDE_URL, model: env.ADHVAGA_CLAUDE_MODEL || "claude-sonnet-5-5", key: env.ANTHROPIC_API_KEY, structured: false }]
      : []),
    { source: "groq", url: env.ADHVAGA_PRIMARY_URL, model: env.ADHVAGA_PRIMARY_MODEL, key: env.GROQ_API_KEY, structured: true },
    { source: "nvidia", url: env.ADHVAGA_FALLBACK_URL, model: env.ADHVAGA_FALLBACK_MODEL, key: env.NVIDIA_API_KEY, structured: false },
  ];
}

/** Total time this request may spend on models (Vercel maxDuration is 30 s for api/*.js). */
function budgetMs(env: Record<string, string | undefined>): number {
  const n = Number(env.ADHVAGA_MODEL_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : 27_000;
}

/** Drops <think> blocks and ``` fences; parses the whole text, else the first balanced {...} block. Else rejected. */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const block = firstObject(t);
    if (!block) throw new Error("no json");
    return JSON.parse(block);
  }
}

/** The first balanced {...} block in prose (braces inside JSON strings are ignored), or null. */
function firstObject(t: string): string | null {
  const a = t.indexOf("{");
  if (a < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = a; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(a, i + 1);
  }
  return null;
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

function claudeBody(p: Provider, o: CallOpts<unknown>) {
  return {
    model: p.model,
    max_tokens: CLAUDE_MAX_TOKENS,
    // No temperature: the API rejects it for claude-sonnet-5-5 ("temperature is deprecated for this model", 400).
    system: `${o.system}\nReply with ONE JSON object only: no prose before or after, no markdown fences. It must match this JSON Schema:\n${JSON.stringify(o.jsonSchema)}`,
    messages: [{ role: "user", content: o.user }],
  };
}

function request(p: Provider, o: CallOpts<unknown>): { headers: Record<string, string>; body: unknown } {
  if (p.source === "claude")
    return { headers: { "Content-Type": "application/json", "x-api-key": p.key!, "anthropic-version": ANTHROPIC_VERSION }, body: claudeBody(p, o) };
  return { headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}`, Accept: "application/json" }, body: body(p, o) };
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

  const list = providers(env, o.useClaude === true);
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
    if (p.source === "claude" && o.beforeClaude && !o.beforeClaude()) {
      attempts.push({ source: p.source, outcome: "skipped_daily_cap" });
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
      const q = request(p, o as CallOpts<unknown>);
      const r = await doFetch(p.url, { method: "POST", headers: q.headers, body: JSON.stringify(q.body), signal: ac.signal });
      if (!r.ok) {
        a.outcome = "http_error";
        a.detail = String(r.status);
        await r.text().catch(() => "");
        continue;
      }
      let content: unknown;
      if (p.source === "claude") {
        // Messages API: text blocks only (thinking blocks, if any, are ignored).
        const j = (await r.json()) as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
        if (j.usage) a.usage = { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens, total_tokens: (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0) };
        const texts = (j.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text);
        content = texts.length ? texts.join("\n") : undefined;
      } else {
        const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: Attempt["usage"] };
        if (j.usage) a.usage = { prompt_tokens: j.usage.prompt_tokens, completion_tokens: j.usage.completion_tokens, total_tokens: j.usage.total_tokens };
        content = j.choices?.[0]?.message?.content; // message.reasoning / reasoning_content are ignored
      }
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
