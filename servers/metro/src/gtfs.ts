// Generic GTFS-static loader. Any city's feed folder (agency, stops, routes, trips, stop_times, calendar,
// calendar_dates, fare_attributes, fare_rules) is read into memory once. Nothing city-specific lives here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Row = Record<string, string>;

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, optional UTF-8 BOM. */
export function parseCsv(text: string): Row[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, (r[j] ?? "").trim()])));
}

/** "24:03:45" -> seconds after the service day's midnight. GTFS allows 24:00:00 and later. */
export function parseGtfsTime(s: string): number {
  const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`bad GTFS time "${s}"`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** "60.0" / "60" / "12.5" rupees -> integer paise, without floating point. */
export function rupeesToPaise(s: string): number {
  const m = /^(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s.trim());
  if (!m) throw new Error(`bad price "${s}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export interface Stop { id: string; name: string; lat: number; lon: number; parent: string | null; zone: string | null }
export interface Route { id: string; short_name: string; long_name: string; type: number }
export interface Trip { id: string; route_id: string; service_id: string; direction_id: string; headsign: string | null }
export interface StopTime { trip_id: string; seq: number; stop_id: string; arr: number; dep: number }
export interface Calendar { service_id: string; days: boolean[]; start: string; end: string } // days[0] = Monday
export interface CalendarDate { service_id: string; date: string; type: 1 | 2 } // 1 added, 2 removed

export interface Feed {
  dir: string;
  agency: { name: string; url: string; timezone: string; fare_url: string | null };
  feed_info: { version: string | null; start: string | null; end: string | null };
  stops: Map<string, Stop>;
  routes: Map<string, Route>;
  trips: Map<string, Trip>;
  stopTimes: Map<string, StopTime[]>; // by trip, in stop order
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  fares: Map<string, number>; // "originZone|destZone" -> paise
  /** First and last date any calendar or calendar_dates entry covers (YYYYMMDD). */
  valid_from: string;
  valid_to: string;
}

function read(dir: string, name: string, required: boolean): Row[] {
  const p = join(dir, name);
  if (!existsSync(p)) {
    if (required) throw new Error(`GTFS feed ${dir} is missing ${name}`);
    return [];
  }
  return parseCsv(readFileSync(p, "utf8"));
}

export function loadFeed(dir: string): Feed {
  const agencyRows = read(dir, "agency.txt", true);
  if (!agencyRows.length) throw new Error(`GTFS feed ${dir}: agency.txt is empty`);
  const a = agencyRows[0];
  const fi = read(dir, "feed_info.txt", false)[0];

  const stops = new Map<string, Stop>();
  for (const r of read(dir, "stops.txt", true)) {
    if (r.location_type && !["0", "1", ""].includes(r.location_type)) continue; // entrances, nodes: not boardable
    stops.set(r.stop_id, {
      id: r.stop_id, name: r.stop_name, lat: Number(r.stop_lat), lon: Number(r.stop_lon),
      parent: r.parent_station || null, zone: r.zone_id || null,
    });
  }
  const routes = new Map<string, Route>();
  for (const r of read(dir, "routes.txt", true)) {
    routes.set(r.route_id, { id: r.route_id, short_name: r.route_short_name ?? "", long_name: r.route_long_name ?? "", type: Number(r.route_type) });
  }
  const trips = new Map<string, Trip>();
  for (const r of read(dir, "trips.txt", true)) {
    trips.set(r.trip_id, { id: r.trip_id, route_id: r.route_id, service_id: r.service_id, direction_id: r.direction_id ?? "", headsign: r.trip_headsign || null });
  }
  const stopTimes = new Map<string, StopTime[]>();
  for (const r of read(dir, "stop_times.txt", true)) {
    if (!r.arrival_time && !r.departure_time) continue; // untimed stop: skipped rather than guessed
    const st: StopTime = {
      trip_id: r.trip_id, seq: Number(r.stop_sequence), stop_id: r.stop_id,
      arr: parseGtfsTime(r.arrival_time || r.departure_time), dep: parseGtfsTime(r.departure_time || r.arrival_time),
    };
    const list = stopTimes.get(st.trip_id);
    if (list) list.push(st); else stopTimes.set(st.trip_id, [st]);
  }
  for (const list of stopTimes.values()) list.sort((x, y) => x.seq - y.seq);

  const dayCols = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const calendars: Calendar[] = read(dir, "calendar.txt", false).map((r) => ({
    service_id: r.service_id, days: dayCols.map((d) => r[d] === "1"), start: r.start_date, end: r.end_date,
  }));
  const calendarDates: CalendarDate[] = read(dir, "calendar_dates.txt", false).map((r) => ({
    service_id: r.service_id, date: r.date, type: r.exception_type === "2" ? 2 : 1,
  }));
  if (!calendars.length && !calendarDates.length) throw new Error(`GTFS feed ${dir} has no calendar`);

  const fareById = new Map<string, number>();
  for (const r of read(dir, "fare_attributes.txt", false)) {
    if ((r.currency_type || "INR") !== "INR") continue;
    fareById.set(r.fare_id, rupeesToPaise(r.price));
  }
  const fares = new Map<string, number>();
  for (const r of read(dir, "fare_rules.txt", false)) {
    const p = fareById.get(r.fare_id);
    if (p !== undefined && r.origin_id && r.destination_id) fares.set(`${r.origin_id}|${r.destination_id}`, p);
  }

  const dates = [...calendars.flatMap((c) => [c.start, c.end]), ...calendarDates.filter((d) => d.type === 1).map((d) => d.date)].sort();
  return {
    dir,
    agency: { name: a.agency_name, url: a.agency_url, timezone: a.agency_timezone, fare_url: a.agency_fare_url || null },
    feed_info: { version: fi?.feed_version || null, start: fi?.feed_start_date || null, end: fi?.feed_end_date || null },
    stops, routes, trips, stopTimes, calendars, calendarDates, fares,
    valid_from: dates[0], valid_to: dates[dates.length - 1],
  };
}

// ---- dates ----

/** "2026-11-20" -> "20261120"; rejects impossible dates. */
export function compactDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`date must be YYYY-MM-DD, got "${iso}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1) throw new Error(`no such date "${iso}"`);
  return `${m[1]}${m[2]}${m[3]}`;
}

export function isoDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/** Monday = 0 ... Sunday = 6. */
export function weekday(compact: string): number {
  const d = new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8))));
  return (d.getUTCDay() + 6) % 7;
}

export function addDays(compact: string, n: number): string {
  const d = new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)) + n));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface ServiceDay {
  services: Set<string>;
  /** true when the date is inside the feed's own calendar (label Timetable); false = old pattern carried forward. */
  in_calendar: boolean;
}

/**
 * Which services run on a date. Inside the feed's dates: calendar + calendar_dates, as GTFS says.
 * Outside them: the weekday pattern of the calendar, ignoring its date range (the caller labels this Estimated).
 */
export function servicesOn(feed: Feed, compact: string): ServiceDay {
  const wd = weekday(compact);
  const inside = compact >= feed.valid_from && compact <= feed.valid_to;
  const services = new Set<string>();
  for (const c of feed.calendars) {
    if (c.days[wd] && (!inside || (compact >= c.start && compact <= c.end))) services.add(c.service_id);
  }
  if (inside) {
    for (const d of feed.calendarDates) {
      if (d.date !== compact) continue;
      if (d.type === 1) services.add(d.service_id); else services.delete(d.service_id);
    }
  }
  return { services, in_calendar: inside };
}
