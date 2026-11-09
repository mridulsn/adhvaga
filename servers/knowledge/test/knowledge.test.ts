// Knowledge server: right passage for each spec question, quotes are word for word from the official
// sources, replaced passages never used as current, "not found" is an answer, rule kept apart from fit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadLibrary } from "../src/library.ts";
import { buildServer } from "../src/server.ts";
import { KnowledgeService, queryTerms } from "../src/service.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_KEYS = ["confidence", "data", "data_as_of", "error", "label", "retrieved_at", "source", "status"];
const svc = new KnowledgeService();
const any = (x: unknown) => x as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ask = (question: string, booking?: Record<string, string>) => any(svc.searchRules({ question, booking }));
const topId = (e: any) => e.data.passages[0].what_the_rule_says.passage_id; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("library", () => {
  const lib = loadLibrary();
  test("3 official documents, every passage linked to its document, every replaced passage points to a current one", () => {
    assert.equal(lib.documents.length, 3);
    for (const d of lib.documents) {
      assert.match(d.link, /^https:\/\/(www\.dgca\.gov\.in|www\.indianrail\.gov\.in|contents\.irctc\.co\.in)\//);
      assert.match(d.sha256, /^[0-9a-f]{64}$/);
      assert.ok(d.fetched && d.caveat);
    }
    for (const p of lib.passages.filter((x) => x.status === "superseded")) {
      const now = lib.passages.find((x) => x.passage_id === p.replaced_by);
      assert.equal(now?.status, "current", p.passage_id);
    }
  });

  test("key amounts are exactly as published (spot checks against the official text)", () => {
    const by = (id: string) => lib.passages.find((p) => p.passage_id === id)!.text;
    assert.match(by("dgca-3.3.2"), /INR 5,000 or booked one-way basic fare plus airline fuel charge, whichever is less/);
    assert.match(by("dgca-3.4.1"), /block time of up to 2 1\/2 hrs/); // the half must not be lost in extraction
    assert.match(by("dgca-3.2.2"), /subject to maximum of INR 10,000/);
    assert.match(by("ir-2015-clerkage"), /Unreserved \(second class\): Rs\. 30\./);
    assert.match(by("ir-pre2015-clerkage"), /Unreserved \(second class\): Rs\. 15\./);
    assert.match(by("irctc-tdr-deadlines"), /upto four hours before the scheduled departure/);
    for (const p of lib.passages) assert.doesNotMatch(p.text, /Rev\. 4, dated|6TH AUGUST, 2010/, `page header inside ${p.passage_id}`);
  });
});

describe("spec questions (group 6)", () => {
  test("T06-01 cancelled train, ticket type unknown: quotes with section and date, and asks", () => {
    const e = ask("My train was cancelled, do I get a full refund?");
    assert.equal(e.data.found, true);
    const ids = e.data.passages.map((p: any) => p.what_the_rule_says.passage_id); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.ok(ids.includes("irctc-train-cancelled") && ids.includes("ir-2015-obj-iv"));
    assert.ok(e.data.questions_to_ask.length >= 1);
    assert.notEqual(e.confidence.level, "high");
    const w = e.data.passages[0].what_the_rule_says;
    assert.ok(w.quote && w.section && w.document.link && w.document.fetched);
  });

  test("T06-02 counter ticket: the counter-ticket passage, and the e-ticket-only passage does not fit", () => {
    const e = ask("Counter ticket, train cancelled", { ticket_channel: "counter", who_cancelled: "railway" });
    assert.equal(topId(e), "ir-2015-train-cancelled");
    assert.match(e.data.passages[0].what_the_rule_says.quote, /No change for counter PRS ticket/);
    const auto = svc.fit(loadLibrary().passages.find((p) => p.passage_id === "ir-2015-obj-iv")!, { ticket_channel: "counter", who_cancelled: "railway" });
    assert.equal(auto.verdict, "does_not_fit");
  });

  test("T06-03 TDR deadline", () => {
    const e = ask("When must I file TDR?");
    assert.equal(topId(e), "irctc-tdr-deadlines");
  });

  test("T06-04 flight cancelled: DGCA 3.3.x and it depends on notice and cause", () => {
    const e = ask("IndiGo cancelled my flight, what am I owed?");
    assert.match(topId(e), /^dgca-3\.3\./);
    assert.ok(e.data.questions_to_ask.some((q: string) => /how early/i.test(q)));
    assert.equal(e.data.passages[0].what_the_rule_says.document.version, "Rev. 4, dated 25 Jan 2023");
  });

  test("T06-05 flight 3 hours late, food: DGCA 3.4.1 and 3.8.1", () => {
    const e = ask("Flight 3 h late, do I get food?");
    const ids = e.data.passages.map((p: any) => p.what_the_rule_says.passage_id); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(ids.slice(0, 2), ["dgca-3.4.1", "dgca-3.8.1"]);
  });

  test("T06-06 rule not in the library: says so, as an answer not a failure", () => {
    const e = ask("Refund rules for Vande Bharat sleeper upgrade");
    assert.equal(e.status, "success");
    assert.equal(e.data.found, false);
    assert.equal(e.data.code, "NO_MATCHING_RULE");
    assert.deepEqual(e.data.passages, []);
  });

  test("T06-07 replaced rule never used as current; history only when asked, and marked", () => {
    const e = ask("clerkage on RAC ticket cancellation");
    for (const p of e.data.passages) assert.equal(p.what_the_rule_says.status, "current");
    assert.equal(topId(e), "ir-2015-clerkage");
    const h = any(svc.searchRules({ question: "clerkage on RAC ticket cancellation", include_superseded: true, limit: 5 }));
    const old = h.data.passages.find((p: any) => p.what_the_rule_says.passage_id === "ir-pre2015-clerkage"); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.ok(old);
    assert.equal(old.what_the_rule_says.replaced_by, "ir-2015-clerkage");
    assert.match(old.what_the_rule_says.warning, /REPLACED/);
  });

  test("T06-08 waitlisted: what the rule says and whether it fits are separate parts", () => {
    const e = ask("Will I get a refund for waitlisted ticket?");
    assert.equal(topId(e), "ir-2015-racwl");
    const p = e.data.passages[0];
    assert.ok(p.what_the_rule_says.quote);
    assert.equal(p.does_it_fit_your_booking.verdict, "unknown");
    const known = ask("Will I get a refund for waitlisted ticket?", { ticket_status: "waitlisted" });
    assert.equal(known.data.passages[0].does_it_fit_your_booking.verdict, "seems_to_fit");
  });

  test("T06-09 / T06-10: metro card and airline change fees are not in the library yet -> said plainly", () => {
    assert.equal(ask("Can I get my Delhi metro card deposit back?").data.code, "NO_MATCHING_RULE");
    assert.equal(ask("Change fee for Air India domestic?").data.code, "NO_MATCHING_RULE");
  });

  test("T06-11 legal advice is out of scope", () => {
    const e = ask("Can I sue the railway?");
    assert.equal(e.data.found, false);
    assert.equal(e.data.code, "OUT_OF_SCOPE");
  });
});

describe("helpers and MCP", () => {
  test("everyday words map to the documents' words", () => {
    assert.ok(queryTerms("flight late food").terms.has("delay"));
    assert.ok(queryTerms("flight late food").terms.has("meal"));
  });

  test("get_passage gives the replacement for an old passage; unknown id is an answer", () => {
    const e = any(svc.getPassage({ passage_id: "ir-pre2015-racwl" }));
    assert.equal(e.data.status, "superseded");
    assert.equal(e.data.replaced_by.passage_id, "ir-2015-racwl");
    assert.equal(e.confidence.level, "low");
    assert.equal(any(svc.getPassage({ passage_id: "nope" })).data.found, false);
  });

  test("the envelope helper is the same file as the Trip server's (no drift)", () => {
    assert.equal(readFileSync(join(HERE, "..", "src", "envelope.ts"), "utf8"), readFileSync(join(HERE, "..", "..", "trip", "src", "envelope.ts"), "utf8"));
  });

  test("over MCP: 3 read-only tools, envelope on every answer", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer(svc).connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_passage", "list_rule_documents", "search_rules"]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
    const r = any(await client.callTool({ name: "search_rules", arguments: { question: "When must I file TDR?" } }));
    assert.deepEqual(Object.keys(JSON.parse(r.content[0].text)).sort(), ENVELOPE_KEYS);
    const bad = any(await client.callTool({ name: "search_rules", arguments: { question: "x", booking: { ticket_channel: "fax" } } }));
    // a wrong input SHAPE is refused by the MCP library before the server code runs
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /ticket_channel/);
    await client.close();
  });
});
