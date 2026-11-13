// /api/plan with mocked providers: no network, no keys. Checks the chain, invariants, caps and HTTP edges.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { makePlanHandler, resetPlanCounters } from "../src/plan/plan.ts";
import { extractJson } from "../src/plan/providers.ts";

const ENV = {
  GROQ_API_KEY: "test-g",
  NVIDIA_API_KEY: "test-n",
  ADHVAGA_PRIMARY_URL: "https://groq.test/v1/chat/completions",
  ADHVAGA_PRIMARY_MODEL: "g-model",
  ADHVAGA_FALLBACK_URL: "https://nvidia.test/v1/chat/completions",
  ADHVAGA_FALLBACK_MODEL: "n-model",
};
const MYSURU = { name: "Mysuru", state: "Karnataka", lat: 12.2958, lng: 76.6394 };
const any = (x: unknown) => x as any; // eslint-disable-line @typescript-eslint/no-explicit-any

type Reply = { status?: number; content?: string; throws?: boolean; hang?: boolean };
let script: Record<string, Reply[]> = {};
let calls: { host: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const mockFetch = (async (url: string, init: RequestInit) => {
  const host = new URL(url).host;
  calls.push({ host, body: JSON.parse(String(init.body)) });
  const r = script[host]?.shift() ?? { status: 500 };
  if (r.throws) throw new TypeError("fetch failed");
  if (r.hang)
    await new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  return new Response(JSON.stringify({ choices: [{ message: { content: r.content ?? "", reasoning: "hidden" } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), {
    status: r.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}) as unknown as typeof fetch;

const profile = (cats: string[]) => JSON.stringify({ categories: cats, summary: "Palace city with gardens and markets.", cautions: ["Check palace closing days."] });
const draft = (n: number, idea = "Walk the old market lanes") =>
  JSON.stringify({ days: Array.from({ length: n }, (_, i) => ({ theme: `Day ${i + 1} theme`, ideas: [idea] })), researchChecklist: ["Check weekly closing days"] });

let server: Server;
let base = "";
let env: Record<string, string | undefined> = { ...ENV };

before(async () => {
  const h = makePlanHandler({ env: new Proxy({}, { get: (_t, k) => env[k as string] }) as Record<string, string | undefined>, fetch: mockFetch });
  server = createServer((req, res) => void h(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plan`;
});
after(() => server.close());
beforeEach(() => {
  script = {};
  calls = [];
  env = { ...ENV };
  resetPlanCounters();
});

// Each test uses its own forwarded IP so the 10/min limiter does not interfere.
let ipN = 0;
async function post(body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.0.${++ipN}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { code: r.status, headers: r.headers, json: any(await r.json().catch(() => null)) };
}

describe("/api/plan", () => {
  test("city-profile from Groq, structured output requested, label and envelope", async () => {
    script["groq.test"] = [{ content: profile(["heritage", "markets-shopping", "heritage"]) }];
    const r = await post({ op: "city-profile", city: MYSURU });
    assert.equal(r.code, 200);
    assert.equal(r.json.status, "success");
    assert.equal(r.json.source, "groq");
    assert.equal(r.json.label, "AI-suggested - not checked");
    assert.deepEqual(r.json.data.categories, ["heritage", "markets-shopping"]);
    assert.equal(calls[0].body.response_format.type, "json_schema");
    assert.equal(calls[0].body.max_tokens, 2000);
    assert.equal(calls[0].body.temperature, 0.4);
    assert.ok(!JSON.stringify(r.json).includes("hidden"), "reasoning never leaks");
  });

  test("category outside the vocabulary -> invalid -> NVIDIA fallback (fenced + think output parsed)", async () => {
    script["groq.test"] = [{ content: profile(["volcanoes"]) }];
    script["nvidia.test"] = [{ content: "<think>hmm</think>\n```json\n" + profile(["heritage"]) + "\n```" }];
    const r = await post({ op: "city-profile", city: MYSURU });
    assert.equal(r.json.source, "nvidia");
    assert.equal(r.json.meta.attempts[0].outcome, "invalid_output");
    assert.equal(calls[1].body.response_format, undefined);
  });

  test("both providers fail -> unavailable, data null, no provider text", async () => {
    script["groq.test"] = [{ throws: true }];
    script["nvidia.test"] = [{ status: 502, content: "upstream secret stack" }];
    const r = await post({ op: "city-profile", city: MYSURU });
    assert.equal(r.code, 200);
    assert.equal(r.json.status, "unavailable");
    assert.equal(r.json.data, null);
    assert.equal(calls.length, 2, "exactly one fallback attempt");
    assert.ok(!JSON.stringify(r.json).includes("secret"));
  });

  test("hung primary times out early enough to leave the fallback its reserve", async () => {
    env.ADHVAGA_MODEL_BUDGET_MS = "12500"; // primary gets 2.5 s, NVIDIA the remaining ~10 s
    script["groq.test"] = [{ hang: true }];
    script["nvidia.test"] = [{ content: profile(["heritage"]) }];
    const r = await post({ op: "city-profile", city: MYSURU });
    assert.equal(r.json.source, "nvidia");
    assert.equal(r.json.meta.attempts[0].outcome, "timeout");
    assert.ok(r.json.meta.attempts[0].latency_ms < 4000);
    assert.deepEqual(calls[1].body.chat_template_kwargs, { enable_thinking: false });
  });

  test("inspiration-draft: day count, clock times, prices and hotel names are invariants", async () => {
    script["groq.test"] = [{ content: draft(6) }];
    script["nvidia.test"] = [{ content: draft(7) }];
    let r = await post({ op: "inspiration-draft", city: MYSURU, days: 7 });
    assert.equal(r.json.source, "nvidia");
    assert.equal(r.json.meta.attempts[0].detail, "day_count");
    assert.equal(r.json.data.days.length, 7);

    for (const [bad, reason] of [["Palace at 10:30", "clock_time"], ["Entry \u20B9200", "price"], ["Entry Rs 200", "price"], ["Stay at Lalitha Resort", "property_name"]]) {
      script["groq.test"] = [{ content: draft(3, bad) }];
      script["nvidia.test"] = [{ content: draft(3, bad) }];
      r = await post({ op: "inspiration-draft", city: MYSURU, days: 3 });
      assert.equal(r.json.status, "unavailable", bad);
      assert.equal(r.json.meta.attempts[0].detail, reason, bad);
    }
  });

  test("request validation: unknown op, extra field, long name, missing days, bad JSON", async () => {
    for (const b of [
      { op: "itinerary", city: MYSURU },
      { op: "city-profile", city: MYSURU, extra: 1 },
      { op: "city-profile", city: { ...MYSURU, name: "x".repeat(61) } },
      { op: "inspiration-draft", city: MYSURU },
      { op: "inspiration-draft", city: MYSURU, days: 15 },
      { op: "city-profile", city: MYSURU, interests: Array(9).fill("food") },
      "{not json",
    ]) {
      const r = await post(b);
      assert.equal(r.code, 400, JSON.stringify(b));
      assert.equal(r.json.status, "error");
    }
    assert.equal(calls.length, 0);
  });

  test("body over 4 KB -> 413", async () => {
    const r = await post({ op: "city-profile", city: MYSURU, pad: "x".repeat(5000) });
    assert.equal(r.code, 413);
  });

  test("CORS: allowed origin echoed, other origins refused, preflight 204", async () => {
    const pre = await fetch(base, { method: "OPTIONS", headers: { Origin: "https://mridulsaravanan.com", "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://mridulsaravanan.com");
    const bad = await post({ op: "city-profile", city: MYSURU }, { Origin: "https://evil.example" });
    assert.equal(bad.code, 403);
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
    assert.equal(calls.length, 0);
  });

  test("kill switch -> 503 disabled, no provider call", async () => {
    env.ADHVAGA_AI_DISABLED = "1";
    const r = await post({ op: "city-profile", city: MYSURU });
    assert.equal(r.code, 503);
    assert.equal(r.json.disabled, true);
    assert.equal(calls.length, 0);
  });

  test("daily call cap -> 429", async () => {
    env.ADHVAGA_DAILY_CALL_CAP = "1";
    script["groq.test"] = [{ content: profile(["heritage"]) }];
    assert.equal((await post({ op: "city-profile", city: MYSURU })).code, 200);
    const r = await post({ op: "city-profile", city: MYSURU });
    assert.equal(r.code, 429);
    assert.equal(r.json.error.code, "DAILY_CAP");
  });

  test("per-IP rate limit -> 429 after 10 a minute", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post({ op: "nope" }, { "X-Forwarded-For": "10.9.9.9" })).code;
    assert.equal(last, 429);
  });

  test("GET -> 405", async () => {
    assert.equal((await fetch(base)).status, 405);
  });

  test("extractJson rejects prose", () => {
    assert.throws(() => extractJson("Sure! Here are some ideas."));
  });
});
