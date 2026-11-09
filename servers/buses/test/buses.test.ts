// Buses server: simulated buses are always labelled, low confidence, demo-only and repeatable;
// a bus you booked becomes a You entered leg; personal data and bad input are refused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { BusesService, istIsoAt, rupeesToPaise } from "../src/service.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_KEYS = ["confidence", "data", "data_as_of", "error", "label", "retrieved_at", "source", "status"];
// 9 Nov 2026, 12:00 India time
const svc = new BusesService({ clock: () => new Date("2026-11-09T06:30:00Z") });
const any = (x: unknown) => x as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("simulated buses", () => {
  test("Jaipur to Ajmer: labelled Simulated, low confidence, demo group, never verified (T10-03)", () => {
    const env = any(svc.searchBuses({ from: "Jaipur", to: "Ajmer", date: "2026-11-21" }));
    assert.equal(env.status, "success");
    assert.equal(env.label, "simulated");
    assert.equal(env.source, "simulated");
    assert.equal(env.confidence.level, "low");
    assert.equal(env.data.group, "demo_options");
    assert.equal(env.data.verified_replacement, false);
    assert.equal(env.data.demo_options.length, 4);
    for (const o of env.data.demo_options) {
      assert.equal(o.demo_only, true);
      assert.equal(o.trip_leg.label, "simulated");
      assert.equal(o.trip_leg.source, "simulated");
      assert.equal(o.trip_leg.kind, "bus");
      assert.match(o.trip_leg.operator, /Simulated/);
      assert.ok(Date.parse(o.arrive_at) > Date.parse(o.depart_at));
    }
    assert.match(env.data.notice, /MADE UP/);
  });

  test("same search, same date -> same demo buses (repeatable for tests and evals)", () => {
    const a = any(svc.searchBuses({ from: "Delhi", to: "Jaipur", date: "2026-11-20" }));
    const b = any(svc.searchBuses({ from: "new delhi", to: "JAIPUR", date: "2026-11-20" }));
    assert.deepEqual(a.data.demo_options, b.data.demo_options);
  });

  test("distance, duration and fare are plausible for Delhi to Jaipur (about 280 km straight, 1.3 road factor)", () => {
    const env = any(svc.searchBuses({ from: "Delhi", to: "Jaipur", date: "2026-11-20" }));
    assert.ok(env.data.road_km_estimate > 300 && env.data.road_km_estimate < 400, String(env.data.road_km_estimate));
    const ordinary = env.data.demo_options[0];
    assert.ok(ordinary.duration_min >= 360 && ordinary.duration_min <= 600, String(ordinary.duration_min));
    assert.ok(Number(ordinary.simulated_fare_rupees) >= 300 && Number(ordinary.simulated_fare_rupees) <= 600);
    assert.equal(Number(ordinary.simulated_fare_rupees) % 10, 0);
  });

  test("depart_after filters, and the night bus is marked overnight", () => {
    const env = any(svc.searchBuses({ from: "Bengaluru", to: "Chennai", date: "2026-11-25", depart_after: "20:00" }));
    assert.equal(env.data.demo_options.length, 1);
    assert.equal(env.data.demo_options[0].overnight, true);
  });

  test("today defaults to buses after now (12:00 India time)", () => {
    const env = any(svc.searchBuses({ from: "Jaipur", to: "Ajmer" }));
    for (const o of env.data.demo_options) assert.ok(o.depart_at >= "2026-11-09T12:00");
  });

  test("unknown city is an answer (found false), not a failure", () => {
    const env = any(svc.searchBuses({ from: "Atlantis", to: "Jaipur", date: "2026-11-20" }));
    assert.equal(env.status, "success");
    assert.equal(env.data.found, false);
    assert.equal(env.data.code, "CITY_NOT_KNOWN");
    assert.deepEqual(env.data.demo_options, []);
  });

  test("too short and too far", () => {
    assert.equal(any(svc.searchBuses({ from: "Delhi", to: "Delhi ISBT", date: "2026-11-20" })).error.code, "BAD_INPUT");
    assert.equal(any(svc.searchBuses({ from: "Delhi", to: "Guwahati", date: "2026-11-20" })).data.code, "TOO_FAR");
  });

  test("bad date and time are refused", () => {
    assert.equal(any(svc.searchBuses({ from: "Delhi", to: "Jaipur", date: "2026-02-30" })).error.code, "BAD_INPUT");
    assert.equal(any(svc.searchBuses({ from: "Delhi", to: "Jaipur", depart_after: "25:00" })).error.code, "BAD_INPUT");
  });
});

describe("a bus you booked", () => {
  test("becomes a You entered leg with record_booking details (T01-09)", () => {
    const env = any(svc.addUserBus({ from: "Jaipur", to: "Ajmer", depart_at: "2026-11-21T07:00:00+05:30", arrive_at: "2026-11-21T10:00:00+05:30", operator: "RSRTC", price_rupees: "450" }));
    assert.equal(env.status, "success");
    assert.equal(env.label, "user_entered");
    assert.equal(env.data.trip_leg.label, "user_entered");
    assert.equal(env.data.trip_leg.source, "user");
    assert.deepEqual(env.data.record_booking, { operator: "RSRTC", service_no: undefined, travel_date: "2026-11-21", price_rupees: "450" });
    assert.notEqual(env.confidence.level, "high");
  });

  test("PNR, phone numbers and bad times are refused", () => {
    const base = { from: "Jaipur", to: "Ajmer", depart_at: "2026-11-21T07:00:00+05:30", arrive_at: "2026-11-21T10:00:00+05:30" };
    assert.equal(any(svc.addUserBus({ ...base, service_no: "PNR 4512345678" })).error.code, "PII_NOT_ALLOWED");
    assert.equal(any(svc.addUserBus({ ...base, operator: "call 9876543210" })).error.code, "PII_NOT_ALLOWED");
    assert.equal(any(svc.addUserBus({ ...base, arrive_at: "2026-11-21T06:00:00+05:30" })).error.code, "BAD_INPUT");
    assert.equal(any(svc.addUserBus({ ...base, depart_at: "2026-11-21 07:00" })).error.code, "BAD_INPUT");
    assert.equal(any(svc.addUserBus({ ...base, price_rupees: "4.505" })).error.code, "BAD_INPUT");
  });
});

describe("helpers and MCP", () => {
  test("money in paise without floating point; times past midnight roll to the next day", () => {
    assert.equal(rupeesToPaise("450"), 45000);
    assert.equal(rupeesToPaise("333.3"), 33330);
    assert.equal(istIsoAt("2026-11-20", 24 * 60 + 35), "2026-11-21T00:35:00+05:30");
  });

  test("the envelope helper is the same file as the Trip server's (no drift)", () => {
    const mine = readFileSync(join(HERE, "..", "src", "envelope.ts"), "utf8");
    const trip = readFileSync(join(HERE, "..", "..", "trip", "src", "envelope.ts"), "utf8");
    assert.equal(mine, trip);
  });

  test("over MCP: 3 read-only tools, envelope on every answer, bad shape refused", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = buildServer(svc);
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["add_user_bus", "list_bus_cities", "search_buses"]);
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true);
      assert.ok(t.description?.startsWith("[read]"));
    }
    const r = any(await client.callTool({ name: "search_buses", arguments: { from: "Jaipur", to: "Ajmer", date: "2026-11-21" } }));
    const env = JSON.parse(r.content[0].text);
    assert.deepEqual(Object.keys(env).sort(), ENVELOPE_KEYS);
    assert.equal(env.label, "simulated");
    await client.close();
  });
});
