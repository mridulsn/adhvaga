// Metro tools. Every answer is a full envelope; labels follow the old-timetable rule in specs/02 Registers.md:
// inside the feed's own calendar = Timetable; outside it = Estimated (weekday pattern carried forward), low confidence.
// Metro is never Live. A city or station with no verified data is an ABSENCE (status success, found false),
// never a failure (status unavailable), so the two cannot be confused.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_ALIASES, LOADED, NOT_YET, norm } from "./cities.ts";
import type { LoadedCity } from "./cities.ts";
import { confidenceFrom, fail, nowIso } from "./envelope.ts";
import type { Envelope, Label } from "./envelope.ts";
import { addDays, compactDate, isoDate, loadFeed } from "./gtfs.ts";
import type { Feed, Stop } from "./gtfs.ts";
import { firstDeparture, route, stationGroup } from "./router.ts";
import type { Journey, RideLeg } from "./router.ts";

const SOURCE = "adhvaga-metro";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IST_OFFSET_MIN = 330;

interface City { cfg: LoadedCity; feed: Feed }

export type Clock = () => Date;

function istNow(clock: Clock): { date: string; sec: number } {
  const d = new Date(clock().getTime() + IST_OFFSET_MIN * 60000);
  return { date: d.toISOString().slice(0, 10), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() };
}

/** Seconds after midnight of `date` -> "2026-11-20T06:05:00+05:30" (rolls into the next day past 24:00). */
export function istIso(date: string, sec: number): string {
  const base = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const d = new Date(base + Math.floor(sec) * 1000);
  return `${d.toISOString().slice(0, 19)}+05:30`;
}

function hhmm(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

function paiseToRupees(p: number): string {
  return p % 100 === 0 ? String(p / 100) : `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;
}

class BadInput extends Error {}

function envelope<T>(data: T, label: Label, conf: { level: "high" | "medium" | "low"; reasons: string[] }, source: string, asOf: string | null): Envelope<T> {
  return { status: "success", source, label, retrieved_at: nowIso(), data_as_of: asOf, confidence: conf, data, error: null };
}

/** "Nothing verified here" - an answer, not a failure. */
function absent(code: string, message: string, extra: Record<string, unknown> = {}, source = SOURCE): Envelope {
  return envelope({ found: false, code, message, ...extra }, "unavailable", { level: "low", reasons: [code === "NO_VERIFIED_DATA" ? "no verified data for this city" : message] }, source, null);
}

function badInput(message: string): Envelope {
  return { ...fail("BAD_INPUT", message), source: SOURCE };
}

export class MetroService {
  private cities = new Map<string, City>();
  private clock: Clock;

  constructor(opts: { clock?: Clock; cities?: LoadedCity[]; root?: string } = {}) {
    this.clock = opts.clock ?? (() => new Date());
    for (const cfg of opts.cities ?? LOADED) {
      const feed = loadFeed(join(opts.root ?? ROOT, cfg.feed_dir));
      if (feed.agency.timezone !== "Asia/Kolkata") throw new Error(`${cfg.name}: only India time (Asia/Kolkata) is supported`);
      this.cities.set(cfg.key, { cfg, feed });
    }
  }

  private findCity(name: string): City | { missing: Envelope } {
    const n = norm(name);
    for (const c of this.cities.values()) if (norm(c.cfg.name) === n || c.cfg.aliases.includes(n)) return c;
    const canonical = CITY_ALIASES[n] ?? name.trim();
    const known = NOT_YET.find((x) => norm(x.name) === norm(canonical));
    if (known) return { missing: absent("NO_VERIFIED_DATA", `No verified metro data for ${known.name} yet. ${known.message}`, { city: known.name, city_status: known.status }) };
    return { missing: absent("NO_VERIFIED_DATA", `No verified metro data for ${name.trim()} yet.`, { city: name.trim(), city_status: "unknown" }) };
  }

  private stopsOf(c: City): Stop[] {
    // Stations people pick: parent stations, plus stops that have no parent.
    return [...c.feed.stops.values()].filter((s) => !s.parent).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolve what a person typed to one station, or explain why not. */
  private resolve(c: City, query: string): { stop: Stop } | { found: false; code: string; message: string; candidates: string[] } {
    const stations = this.stopsOf(c);
    const q = norm(query);
    if (!q) return { found: false, code: "STATION_NOT_FOUND", message: "Station name is empty.", candidates: [] };
    const byId = c.feed.stops.get(query.trim().toUpperCase()) ?? c.feed.stops.get(query.trim());
    if (byId) return { stop: byId.parent ? c.feed.stops.get(byId.parent) ?? byId : byId };
    const exact = stations.filter((s) => norm(s.name) === q);
    if (exact.length === 1) return { stop: exact[0] };
    const alias = c.cfg.station_aliases[q];
    if (alias && c.feed.stops.get(alias)) return { stop: c.feed.stops.get(alias)! };
    for (const tier of [stations.filter((s) => norm(s.name).startsWith(q)), stations.filter((s) => norm(s.name).includes(q))]) {
      if (tier.length === 1) return { stop: tier[0] };
      if (tier.length > 1) return { found: false, code: "STATION_AMBIGUOUS", message: `"${query}" matches more than one ${c.cfg.name} station.`, candidates: tier.map((s) => s.name) };
    }
    const near = stations.map((s) => ({ s, d: editDistance(norm(s.name), q) })).filter((x) => x.d <= Math.max(2, Math.floor(q.length / 4))).sort((a, b) => a.d - b.d).slice(0, 3);
    return {
      found: false, code: "STATION_NOT_FOUND",
      message: `No ${c.cfg.name} metro station called "${query}" in the ${c.cfg.operator_short} timetable.`,
      candidates: near.map((x) => x.s.name),
    };
  }

  private feedFacts(c: City) {
    return {
      operator: c.cfg.operator,
      source_detail: c.cfg.how_obtained,
      attribution: c.cfg.attribution,
      timetable_valid: { from: isoDate(c.feed.valid_from), to: isoDate(c.feed.valid_to) },
      feed_version: c.feed.feed_info.version,
    };
  }

  // ---------------- tools ----------------

  listCities(): Envelope {
    const loaded = [...this.cities.values()].map((c) => ({
      city: c.cfg.name, stations: this.stopsOf(c).length, lines: [...c.feed.routes.keys()].map((r) => c.cfg.line_names[r] ?? c.feed.routes.get(r)!.long_name),
      label_rule: `Timetable for dates ${isoDate(c.feed.valid_from)} to ${isoDate(c.feed.valid_to)}; Estimated (old pattern) for any other date. Never Live.`,
      ...this.feedFacts(c),
    }));
    return envelope({ loaded, not_yet: NOT_YET, other_cities: "Any city not listed: no verified metro data yet." }, "timetable",
      { level: "high", reasons: ["list of feeds loaded in this server"] }, SOURCE, null);
  }

  listStations(a: { city: string }): Envelope {
    const c = this.findCity(a.city);
    if ("missing" in c) return c.missing;
    const stations = this.stopsOf(c).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
    return envelope({ found: true, city: c.cfg.name, stations, ...this.feedFacts(c) }, "timetable",
      { level: "medium", reasons: ["official station list", "list may miss stations opened after the feed date"] }, c.cfg.source, isoDate(c.feed.valid_from));
  }

  findStation(a: { city: string; query: string }): Envelope {
    const c = this.findCity(a.city);
    if ("missing" in c) return c.missing;
    const r = this.resolve(c, a.query);
    if ("found" in r) return absent(r.code, r.message, { city: c.cfg.name, did_you_mean: r.candidates }, c.cfg.source);
    return envelope({ found: true, city: c.cfg.name, station: { id: r.stop.id, name: r.stop.name, lat: r.stop.lat, lon: r.stop.lon }, attribution: c.cfg.attribution }, "timetable",
      { level: "medium", reasons: ["official station list"] }, c.cfg.source, isoDate(c.feed.valid_from));
  }

  routeBetweenStations(a: { city: string; from: string; to: string; date?: string; depart_after?: string; count?: number }): Envelope {
    try {
      return this.routeImpl(a);
    } catch (e) {
      if (e instanceof BadInput) return badInput(e.message);
      throw e;
    }
  }

  private routeImpl(a: { city: string; from: string; to: string; date?: string; depart_after?: string; count?: number }): Envelope {
    const c = this.findCity(a.city);
    if ("missing" in c) return c.missing;
    const now = istNow(this.clock);
    const date = a.date ?? now.date;
    let compact: string;
    try { compact = compactDate(date); } catch (e) { throw new BadInput((e as Error).message); }
    let after = date === now.date ? now.sec : 0;
    if (a.depart_after !== undefined) {
      const m = /^(\d{2}):(\d{2})$/.exec(a.depart_after);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new BadInput(`depart_after must be HH:MM (24 h), got "${a.depart_after}"`);
      after = Number(m[1]) * 3600 + Number(m[2]) * 60;
    }
    const count = Math.min(Math.max(a.count ?? 3, 1), 6);

    const from = this.resolve(c, a.from);
    if ("found" in from) return absent(from.code, from.message, { city: c.cfg.name, which: "from", did_you_mean: from.candidates }, c.cfg.source);
    const to = this.resolve(c, a.to);
    if ("found" in to) return absent(to.code, to.message, { city: c.cfg.name, which: "to", did_you_mean: to.candidates }, c.cfg.source);
    if (from.stop.id === to.stop.id) throw new BadInput("From and to are the same station.");

    const origins = stationGroup(c.feed, from.stop.id);
    const targets = stationGroup(c.feed, to.stop.id);
    const journeys = route(c.feed, compact, origins, targets, after, count);
    const facts = this.feedFacts(c);
    if (!journeys.length) {
      const next = firstDeparture(c.feed, addDays(compact, 1), origins, targets);
      return absent("NO_SERVICE", `No more ${c.cfg.operator_short} trains from ${from.stop.name} to ${to.stop.name} after ${hhmm(after)} on ${date}.`, {
        city: c.cfg.name, from: from.stop.name, to: to.stop.name, date,
        first_train_next_day: next === null ? null : istIso(isoDate(addDays(compact, 1)), next),
        ...facts,
      }, c.cfg.source);
    }

    const options = journeys.map((j, i) => this.option(c, date, j, i + 1, from.stop, to.stop));
    const oldPattern = journeys.some((j) => j.any_old_pattern);
    const label: Label = oldPattern ? "estimated" : "timetable";
    let conf = confidenceFrom({ label, source_answered: true, official: c.cfg.official });
    conf = { ...conf, reasons: conf.reasons.map((r) => (r === "official source" ? `official ${c.cfg.operator_short} timetable (copy, unchanged)` : r)) };
    if (oldPattern) {
      conf = { level: "low", reasons: [...conf.reasons, `old timetable valid to ${facts.timetable_valid.to}; weekday pattern carried forward to ${date}`] };
    }
    conf.reasons.push("holidays and special timings are not in the timetable");
    const note = oldPattern
      ? `${c.cfg.operator_short}'s published timetable ends ${facts.timetable_valid.to}. Times for ${date} use that timetable's ${weekdayName(compact)} pattern and are Estimated. Check at the station.`
      : `Published ${c.cfg.operator_short} timetable. Not proof the train runs today.`;
    return envelope({ found: true, city: c.cfg.name, from: from.stop.name, to: to.stop.name, date, depart_after: hhmm(after), options, note, ...facts },
      label, conf, c.cfg.source, isoDate(c.feed.valid_from));
  }

  private option(c: City, date: string, j: Journey, n: number, from: Stop, to: Stop) {
    const name = (id: string) => c.feed.stops.get(id)?.name ?? id;
    const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
    const label: Label = j.any_old_pattern ? "estimated" : "timetable";
    const fz = c.feed.stops.get(rides[0].from_stop)?.zone;
    const tz = c.feed.stops.get(rides[rides.length - 1].to_stop)?.zone;
    const farePaise = fz && tz ? c.feed.fares.get(`${fz}|${tz}`) ?? null : null;
    const line = (rid: string) => c.cfg.line_names[rid] ?? c.feed.routes.get(rid)?.long_name ?? rid;
    const lines = [...new Set(rides.map((r) => line(r.route_id)))];
    return {
      option_id: `metro-${c.cfg.key}-${n}`,
      depart_at: istIso(date, j.dep),
      arrive_at: istIso(date, j.arr),
      duration_min: Math.round((j.arr - j.dep) / 60),
      changes: j.changes,
      label,
      legs: j.legs.map((l) => l.kind === "ride"
        ? { kind: "ride", line: line(l.route_id), board: name(l.from_stop), alight: name(l.to_stop), towards: l.towards, depart_at: istIso(date, l.dep), arrive_at: istIso(date, l.arr), stops: l.stops_travelled, label: l.from_old_pattern ? "estimated" : "timetable" }
        : { kind: "change", at: name(l.at_stop), to_platform_of: name(l.to_stop), allow_min: Math.round(l.min_sec / 60) }),
      fare: farePaise === null
        ? { paise: null, rupees: null, label: "unavailable", method: "no fare for this pair in the timetable" }
        : { paise: farePaise, rupees: paiseToRupees(farePaise), label: "estimated", method: `${c.cfg.operator_short} fare chart in the timetable feed (valid ${isoDate(c.feed.valid_from)}); single-journey ticket` },
      // Ready to pass to the Trip server's add_leg (give it a leg_key).
      trip_leg: {
        kind: "metro",
        from_name: `${from.name} (${c.cfg.name} Metro)`,
        to_name: `${to.name} (${c.cfg.name} Metro)`,
        depart_at: istIso(date, j.dep),
        arrive_at: istIso(date, j.arr),
        operator: c.cfg.operator_short,
        service_no: lines.join(" + "),
        source: c.cfg.source,
        label,
        ...(farePaise === null ? {} : { estimated_rupees: paiseToRupees(farePaise) }),
      },
    };
  }
}

function weekdayName(compact: string): string {
  const d = new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8))));
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
