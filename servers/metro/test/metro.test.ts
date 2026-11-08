// Metro server: real Kochi timetable (answers cross-checked by hand against stop_times.txt), labels,
// absence vs failure, and change logic on a small two-line test feed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LoadedCity } from "../src/cities.ts";
import { parseCsv, parseGtfsTime, rupeesToPaise } from "../src/gtfs.ts";
import { buildServer } from "../src/server.ts";
import { MetroService, istIso } from "../src/service.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_KEYS = ["confidence", "data", "data_as_of", "error", "label", "retrieved_at", "source", "status"];
// 8 Nov 2026, 12:00 India time (a Sunday)
const svc = new MetroService({ clock: () => new Date("2026-11-08T06:30:00Z") });
const any = (x: unknown) => x as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const BOM = String.fromCharCode(0xfeff);

const TWO_LINE: LoadedCity = {
  key: "testcity", name: "Testcity", aliases: [], operator: "Test Metro", operator_short: "TM", feed_dir: "test/feeds/twoline",
  source: "test-gtfs", official: false, how_obtained: "hand-made test feed", attribution: "test", station_aliases: {}, line_names: {},
};
const two = new MetroService({ cities: [TWO_LINE], root: join(HERE, ".."), clock: () => new Date("2026-03-02T00:00:00Z") });

describe("GTFS basics", () => {
  test("CSV with quotes, BOM and CRLF", () => {
    const rows = parseCsv(`${BOM}a,b\r\n"x, y","say ""hi"""\r\n`);
    assert.deepEqual(rows, [{ a: "x, y", b: 'say "hi"' }]);
  });
  test("times past midnight and prices in paise without floating point", () => {
    assert.equal(parseGtfsTime("24:03:45"), 86625);
    assert.equal(rupeesToPaise("60.0"), 6000);
    assert.equal(rupeesToPaise("35.5"), 3550);
    assert.equal(rupeesToPaise("12.05"), 1205);
    assert.equal(istIso("2026-11-20", 86625), "2026-11-21T00:03:45+05:30");
  });
  test("the envelope helper is the same file as the Trip server's (no drift)", () => {
    const a = readFileSync(join(HERE, "../src/envelope.ts"), "utf8");
    const b = readFileSync(join(HERE, "../../trip/src/envelope.ts"), "utf8");
    assert.equal(a, b);
  });
});

describe("Kochi (real KMRL timetable)", () => {
  test("25 stations on one line, attribution shown", () => {
    const e = any(svc.listStations({ city: "Kochi" }));
    assert.equal(e.status, "success");
    assert.equal(e.data.stations.length, 25);
    assert.equal(e.data.attribution, "Contains data provided by Kochi Metro Rail Limited.");
    assert.deepEqual(e.data.timetable_valid, { from: "2024-08-12", to: "2025-12-31" });
  });

  test("inside the timetable's dates: label Timetable, exact published times", () => {
    const e = any(svc.routeBetweenStations({ city: "Kochi", from: "Aluva", to: "Tripunithura", date: "2025-03-10", depart_after: "08:00" }));
    assert.equal(e.label, "timetable");
    assert.equal(e.confidence.level, "medium");
    const times = e.data.options.map((o: any) => [o.depart_at, o.arrive_at]);
    assert.deepEqual(times, [
      ["2025-03-10T08:03:25+05:30", "2025-03-10T08:54:12+05:30"],
      ["2025-03-10T08:10:25+05:30", "2025-03-10T09:01:12+05:30"],
      ["2025-03-10T08:17:25+05:30", "2025-03-10T09:08:12+05:30"],
    ]);
    const o = e.data.options[0];
    assert.equal(o.fare.paise, 6000);
    assert.equal(o.fare.label, "estimated");
    assert.equal(o.trip_leg.kind, "metro");
    assert.equal(o.trip_leg.label, "timetable");
    assert.equal(o.trip_leg.estimated_rupees, "60");
  });

  test("T01-06 / T10-05 rule: a 2026 date is Estimated with low confidence and says why (timetable ended 2025)", () => {
    const e = any(svc.routeBetweenStations({ city: "Kochi", from: "Aluva", to: "Tripunithura", date: "2026-11-20", depart_after: "08:00" }));
    assert.equal(e.label, "estimated");
    assert.equal(e.confidence.level, "low");
    assert.ok(e.confidence.reasons.some((r: string) => r.includes("valid to 2025-12-31")));
    assert.match(e.data.note, /ends 2025-12-31/);
    assert.equal(e.data.options[0].depart_at, "2026-11-20T08:03:25+05:30"); // Friday = weekday (WK) pattern
    for (const o of e.data.options) { assert.equal(o.label, "estimated"); assert.equal(o.trip_leg.label, "estimated"); }
  });

  test("Sunday uses the Sunday timetable", () => {
    const e = any(svc.routeBetweenStations({ city: "Kochi", from: "Aluva", to: "Tripunithura", date: "2026-11-22", depart_after: "08:00" }));
    assert.equal(e.data.options[0].depart_at, "2026-11-22T08:10:00+05:30");
  });

  test("other direction, and today/now by default", () => {
    const back = any(svc.routeBetweenStations({ city: "Kochi", from: "Tripunithura", to: "Aluva", date: "2026-11-20", depart_after: "08:00" }));
    assert.equal(back.data.options[0].depart_at, "2026-11-20T08:00:00+05:30");
    const now = any(svc.routeBetweenStations({ city: "Kochi", from: "MG Road", to: "Kaloor" }));
    assert.equal(now.data.date, "2026-11-08");
    assert.equal(now.data.options[0].depart_at, "2026-11-08T12:08:07+05:30");
    assert.equal(now.data.options[0].fare.rupees, "20");
  });

  test("metro is never Live", () => {
    for (const d of ["2025-03-10", "2026-11-20"]) {
      const e = any(svc.routeBetweenStations({ city: "Kochi", from: "Edappally", to: "Vyttila", date: d, depart_after: "09:00" }));
      assert.notEqual(e.label, "live");
      for (const o of e.data.options) assert.notEqual(o.label, "live");
    }
  });

  test("other spellings people use", () => {
    for (const [q, name] of [["CUSAT", "Cochin University"], ["Edappally", "Edapally"], ["Petta", "Pettah"], ["Maharaja's College", "Maharajas College"], ["aluva metro station", "Aluva"], ["ALVA", "Aluva"]]) {
      assert.equal(any(svc.findStation({ city: "cochin", query: q })).data.station.name, name, q);
    }
  });

  test("after the last train: an answer (no service) with the first train next day, not a failure", () => {
    const e = any(svc.routeBetweenStations({ city: "Kochi", from: "Aluva", to: "Tripunithura", date: "2026-11-20", depart_after: "23:55" }));
    assert.equal(e.status, "success");
    assert.equal(e.data.found, false);
    assert.equal(e.data.code, "NO_SERVICE");
    assert.equal(e.data.first_train_next_day, "2026-11-21T06:00:00+05:30");
  });
});

describe("absence is never shown as failure", () => {
  test("T10-04 unsupported city says so (status success, found false)", () => {
    const e = any(svc.routeBetweenStations({ city: "Shillong", from: "Police Bazar", to: "Laitumkhrah" }));
    assert.equal(e.status, "success");
    assert.equal(e.data.found, false);
    assert.equal(e.data.code, "NO_VERIFIED_DATA");
    assert.match(e.data.message, /No verified metro data for Shillong yet/);
  });
  test("Delhi explains why it is not loaded yet", () => {
    const e = any(svc.routeBetweenStations({ city: "New Delhi", from: "Rajiv Chowk", to: "New Delhi" }));
    assert.equal(e.data.code, "NO_VERIFIED_DATA");
    assert.equal(e.data.city_status, "feed_pending");
  });
  test("unknown station: suggestions, not a guess", () => {
    const e = any(svc.routeBetweenStations({ city: "Kochi", from: "Aluwa", to: "Kaloor" }));
    assert.equal(e.data.code, "STATION_NOT_FOUND");
    assert.deepEqual(e.data.did_you_mean, ["Aluva"]);
    const air = any(svc.findStation({ city: "Kochi", query: "Kochi airport" }));
    assert.equal(air.data.found, false);
  });
  test("bad input is an error envelope", () => {
    const same = any(svc.routeBetweenStations({ city: "Kochi", from: "Aluva", to: "ALVA" }));
    assert.equal(same.status, "error");
    assert.equal(same.error.code, "BAD_INPUT");
    assert.equal(any(svc.routeBetweenStations({ city: "Kochi", from: "Aluva", to: "Kaloor", date: "2026-02-30" })).error.code, "BAD_INPUT");
    assert.equal(any(svc.routeBetweenStations({ city: "Kochi", from: "Aluva", to: "Kaloor", depart_after: "25:00" })).error.code, "BAD_INPUT");
  });
});

describe("Hyderabad (real HMRL timetable, three lines)", () => {
  // Expected times were read separately from stop_times.txt with a short Python script (8 Nov 2026).
  const hyd = (a: Record<string, unknown>) => any(svc.routeBetweenStations({ city: "Hyderabad", ...a } as any));
  const firstRide = (e: any) => e.data.options[0];

  test("57 stations (entrances and platforms are not stations), attribution, published Apr 2025", () => {
    const e = any(svc.listStations({ city: "Hyderabad" }));
    assert.equal(e.data.stations.length, 57);
    assert.equal(e.data.attribution, "Contains data provided by Hyderabad Metro Rail Ltd.");
    assert.equal(e.data_as_of, "2025-04-08");
    assert.equal(e.data.corrections_to_feed.length, 2);
  });

  test("weekday, Saturday and Sunday each use their own timetable (feed calendar overlap corrected)", () => {
    const mon = firstRide(hyd({ from: "Miyapur", to: "LB Nagar", date: "2026-11-09", depart_after: "04:00", count: 1 }));
    const sat = firstRide(hyd({ from: "Miyapur", to: "LB Nagar", date: "2026-11-14", depart_after: "04:00", count: 1 }));
    const sun = firstRide(hyd({ from: "Miyapur", to: "LB Nagar", date: "2026-11-15", depart_after: "04:00", count: 1 }));
    assert.deepEqual([mon.depart_at, mon.arrive_at], ["2026-11-09T04:39:10+05:30", "2026-11-09T05:26:33+05:30"]);
    assert.equal(sat.depart_at, "2026-11-14T06:00:00+05:30");
    assert.equal(sun.depart_at, "2026-11-15T07:00:00+05:30");
  });

  test("inside the feed's dates (to 2030): Timetable, but confidence capped at medium with the reasons", () => {
    const e = hyd({ from: "Miyapur", to: "LB Nagar", date: "2026-11-09", depart_after: "09:00" });
    assert.equal(e.label, "timetable");
    assert.equal(e.confidence.level, "medium");
    assert.ok(e.confidence.reasons.some((r: string) => r.includes("weekday timetable also runs at weekends")));
    assert.ok(e.confidence.reasons.some((r: string) => r.includes("published Apr 2025")));
  });

  test("Red to Blue: change at Ameerpet, at least 5 minutes", () => {
    const o = firstRide(hyd({ from: "Miyapur", to: "Raidurg", date: "2026-11-09", depart_after: "09:00", count: 1 }));
    assert.deepEqual(o.legs.map((l: any) => l.kind), ["ride", "change", "ride"]);
    assert.equal(o.legs[1].at, "Ameerpet");
    assert.deepEqual([o.depart_at, o.arrive_at], ["2026-11-09T09:04:16+05:30", "2026-11-09T09:51:00+05:30"]);
  });

  test("Blue to Green: walk between Parade Ground and JBS Parade Ground (one interchange), not via Ameerpet", () => {
    const o = firstRide(hyd({ from: "Nagole", to: "MGBS", date: "2026-11-09", depart_after: "09:00", count: 1 }));
    assert.deepEqual(o.legs.map((l: any) => l.kind), ["ride", "walk", "ride"]);
    assert.deepEqual([o.legs[1].from, o.legs[1].to], ["Parade Ground", "JBS Parade Ground"]);
    // 09:01 and 09:03 Blue trains both make the 09:28:43 Green train; the later one is offered.
    assert.deepEqual([o.depart_at, o.arrive_at], ["2026-11-09T09:03:03+05:30", "2026-11-09T09:43:34+05:30"]);
  });

  test("starting at a linked station: the walk comes first and is counted in the journey", () => {
    const o = firstRide(hyd({ from: "Parade Ground", to: "MGBS", date: "2026-11-09", depart_after: "09:00", count: 1 }));
    assert.deepEqual(o.legs.map((l: any) => l.kind), ["walk", "ride"]);
    assert.equal(o.legs[1].depart_at, "2026-11-09T09:16:43+05:30");
    assert.equal(o.depart_at, "2026-11-09T09:10:43+05:30");
  });

  test("fare: May 2025 HMRL chart by distance, Estimated, with the other possible fare near a zone edge", () => {
    const end = firstRide(hyd({ from: "Miyapur", to: "LB Nagar", date: "2026-11-09", depart_after: "09:00", count: 1 }));
    assert.deepEqual([end.fare.rupees, end.fare.label], ["69", "estimated"]);
    assert.match(end.fare.method, /23 May 2025/);
    const edge = firstRide(hyd({ from: "Miyapur", to: "Raidurg", date: "2026-11-09", depart_after: "09:00", count: 1 }));
    assert.deepEqual([edge.fare.rupees, edge.fare.could_be_rupees], ["65", "61"]);
    assert.equal(edge.trip_leg.estimated_rupees, "65");
  });

  test("the distance method reproduces the feed's own (Apr 2025) fares when given the old chart", () => {
    // Old HMRL chart, read off the feed itself: fare_rules match these km edges on 98% of all pairs, and every
    // mismatch is within 0.4 km of an edge. Here: pairs well away from an edge must match exactly.
    const OLD: NonNullable<LoadedCity["fare_chart"]> = {
      name: "old", in_force_from: "2017-11-29", edge_km: 0.4,
      slabs: [[2, 10], [4, 15], [6, 25], [8, 30], [10, 35], [14, 40], [18, 45], [22, 50], [26, 55], [null, 60]].map(([k, r]) => ({ up_to_km: k as number | null, rupees: r as number })),
    };
    const hydCfg = (svc as any).cities.get("hyderabad").cfg as LoadedCity;
    const old = new MetroService({ cities: [{ ...hydCfg, fare_chart: OLD }] });
    const pairs = [["Miyapur", "Ameerpet"], ["Nagole", "Raidurg"], ["Uppal", "MGBS"], ["LB Nagar", "Parade Ground"], ["KPHB Colony", "Paradise"], ["Tarnaka", "Khairatabad"]];
    let checked = 0;
    for (const [from, to] of pairs) {
      const o = any(old.routeBetweenStations({ city: "Hyderabad", from, to, date: "2026-11-09", depart_after: "10:00", count: 1 })).data.options[0];
      if (o.fare.could_be_rupees) continue;
      const plain = new MetroService({ cities: [{ ...hydCfg, fare_chart: undefined }] });
      const f = any(plain.routeBetweenStations({ city: "Hyderabad", from, to, date: "2026-11-09", depart_after: "10:00", count: 1 })).data.options[0].fare;
      assert.equal(o.fare.rupees, f.rupees, `${from} to ${to}`);
      checked++;
    }
    assert.ok(checked >= 4);
  });

  test("names people use: HITEC City spellings, MGBS, and Secunderabad (two stations) is ambiguous", () => {
    assert.equal(any(svc.findStation({ city: "Hyderabad", query: "hitech city" })).data.station.name, "HITEC City");
    assert.equal(any(svc.findStation({ city: "Hyderabad", query: "MGBS" })).data.station.name, "Mahatma Gandhi Bus Station");
    const s = any(svc.findStation({ city: "Hyderabad", query: "Secunderabad" }));
    assert.equal(s.data.code, "STATION_AMBIGUOUS");
    assert.deepEqual(s.data.did_you_mean.sort(), ["Secunderabad East", "Secunderabad West"]);
    assert.equal(any(svc.listStations({ city: "Secunderabad" })).data.city, "Hyderabad");
  });

  test("after the last train: NO_SERVICE with tomorrow's first train", () => {
    const e = hyd({ from: "HITEC City", to: "Ameerpet", date: "2026-11-09", depart_after: "23:50" });
    assert.equal(e.data.code, "NO_SERVICE");
    assert.equal(e.data.first_train_next_day, "2026-11-10T05:43:18+05:30");
  });
});

describe("changes between lines (two-line test feed)", () => {
  test("a change needs at least 5 minutes: the 08:12 connection is too tight, so the 08:16 is used", () => {
    const e = any(two.routeBetweenStations({ city: "Testcity", from: "Alpha One", to: "Beta Two", date: "2026-03-02", depart_after: "07:50", count: 1 }));
    assert.equal(e.label, "timetable");
    const o = e.data.options[0];
    assert.equal(o.changes, 1);
    assert.equal(o.arrive_at, "2026-03-02T08:26:00+05:30");
    assert.deepEqual(o.legs.map((l: any) => l.kind), ["ride", "change", "ride"]);
    assert.equal(o.fare.paise, 3550);
  });
  test("a train past midnight arrives the next calendar day", () => {
    const o = any(two.routeBetweenStations({ city: "Testcity", from: "Alpha One", to: "Alpha Two", date: "2026-03-02", depart_after: "23:45", count: 1 })).data.options[0];
    assert.equal(o.arrive_at, "2026-03-03T00:10:00+05:30");
  });
  test("a removed date in calendar_dates means no service that day; after the calendar ends it is Estimated", () => {
    assert.equal(any(two.routeBetweenStations({ city: "Testcity", from: "Alpha One", to: "Alpha Two", date: "2026-12-25", depart_after: "07:00" })).data.code, "NO_SERVICE");
    assert.equal(any(two.routeBetweenStations({ city: "Testcity", from: "Alpha One", to: "Alpha Two", date: "2027-01-05", depart_after: "07:00" })).label, "estimated");
  });
});

describe("MCP layer", () => {
  async function connect() {
    const server = buildServer(svc);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse((r.content as Array<{ text: string }>)[0].text);
    };
    return { client, call };
  }
  test("four read-only tools; every answer (good, absent, bad) uses the envelope", async () => {
    const { client, call } = await connect();
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["find_station", "list_cities", "list_stations", "route_between_stations"]);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    const answers = [
      await call("list_cities", {}),
      await call("route_between_stations", { city: "Kochi", from: "Aluva", to: "Kaloor", date: "2026-11-20", depart_after: "09:00" }),
      await call("route_between_stations", { city: "Shillong", from: "a", to: "b" }),
      // Wrong VALUES (shape is fine) reach our code and come back as a BAD_INPUT envelope.
      // Wrong SHAPES (e.g. count 99) are refused by the MCP library first, as on the Trip server.
      await call("route_between_stations", { city: "Kochi", from: "Aluva", to: "Kaloor", date: "2026-02-30" }),
    ];
    for (const e of answers) assert.deepEqual(Object.keys(e).sort(), ENVELOPE_KEYS);
    assert.equal(answers[3].error.code, "BAD_INPUT");
  });
});
