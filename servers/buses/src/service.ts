// Buses service. India has no free intercity bus timetable or fare API, so:
//  - search_buses returns SIMULATED demo buses (made up, clearly labelled, never high confidence,
//    always in the "demo options" group, never bookable, never a verified replacement);
//  - add_user_bus turns a bus YOU booked into a trip leg labelled "You entered".
// Nothing here saves data; legs go to the Trip server's add_leg / record_booking.
import { ToolError, confidenceFrom, fail, nowIso, ok } from "./envelope.ts";
import type { Envelope } from "./envelope.ts";
import { CITIES, ROAD_FACTOR, crowKm, findCity } from "./cities.ts";
import type { BusCity } from "./cities.ts";

export const SOURCE = "simulated";
export const SERVER = "adhvaga-buses";
export const MIN_KM = 40; // shorter than this: use city bus / metro / taxi
export const MAX_KM = 1500; // longer than this: no sensible bus trip to simulate

export const NOTICE =
  "No free intercity bus data exists in India. These buses are MADE UP to show how Adhvaga would compare a bus. " +
  "They are not real services: never book from them, and Adhvaga never ranks them above verified options.";

interface BusType { key: string; name: string; rupees_per_km: number; kmh: number }
const TYPES: Record<string, BusType> = {
  ordinary: { key: "ordinary", name: "Ordinary (non-AC seater)", rupees_per_km: 1.3, kmh: 45 },
  ac_seater: { key: "ac_seater", name: "AC seater", rupees_per_km: 1.9, kmh: 50 },
  ac_sleeper: { key: "ac_sleeper", name: "AC sleeper", rupees_per_km: 2.4, kmh: 50 },
};
// Base departure slots (minutes after midnight) and type; each pair+date shifts them a little.
const SLOTS: Array<[number, string]> = [
  [6 * 60, "ordinary"],
  [9 * 60 + 30, "ac_seater"],
  [14 * 60, "ordinary"],
  [21 * 60 + 30, "ac_sleeper"],
];

function need(cond: unknown, code: string, msg: string): asserts cond {
  if (!cond) throw new ToolError(code, msg);
}

/** Small stable hash so the same search on the same date always gives the same demo buses. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** India date (YYYY-MM-DD) for an instant. */
export function istDate(d: Date): string {
  const t = new Date(d.getTime() + 330 * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** ISO time in India for a date plus minutes after midnight (may run into later days). */
export function istIsoAt(date: string, minutes: number): string {
  const base = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const t = new Date(base + minutes * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00+05:30`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Personal data is never stored (plan section 15) - same patterns as the Trip server.
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{10}\b/, "a 10-digit number (PNR or phone number)"],
  [/\b(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/, "a phone number"],
  [/\b(?:\d[ -]?){13,19}\b/, "a card number"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, "an email address"],
  [/\bpnr\b/i, "a PNR"],
];
function assertNoPii(field: string, value: string | null | undefined) {
  if (!value) return;
  for (const [re, what] of PII_PATTERNS) {
    need(!re.test(value), "PII_NOT_ALLOWED", `${field} looks like it contains ${what}. Adhvaga never stores PNRs, names, phone numbers or card details.`);
  }
}

/** Rupees string -> paise, integers only (no floating point money). */
export function rupeesToPaise(v: string | number): number {
  const s = String(v).trim();
  need(/^\d{1,7}(\.\d{1,2})?$/.test(s), "BAD_INPUT", 'price must be rupees like "450" or "450.50"');
  const [r, p = ""] = s.split(".");
  return Number(r) * 100 + Number((p + "00").slice(0, 2));
}
const paiseToRupees = (p: number) => (p % 100 === 0 ? String(p / 100) : `${Math.floor(p / 100)}.${pad(p % 100)}`);

export interface BusesOptions { clock?: () => Date }

export class BusesService {
  private clock: () => Date;
  constructor(opts: BusesOptions = {}) {
    this.clock = opts.clock ?? (() => new Date());
  }

  private wrap(fn: () => Envelope): Envelope {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ToolError) return { ...fail(e.code, e.message, e.details), source: SERVER };
      throw e;
    }
  }

  listCities(): Envelope {
    return ok(
      { cities: CITIES.map((c) => c.name), notice: NOTICE, labels: { simulated: "made-up demo bus", user_entered: "a bus you booked and typed in" } },
      { source: SERVER, label: "simulated", confidence: { level: "low", reasons: ["simulated data, demo only"] } },
    );
  }

  searchBuses(a: { from: string; to: string; date?: string; depart_after?: string }): Envelope {
    return this.wrap(() => {
      const now = this.clock();
      const date = a.date ?? istDate(now);
      need(validDate(date), "BAD_INPUT", "date must be YYYY-MM-DD");
      need(a.depart_after == null || HHMM_RE.test(a.depart_after), "BAD_INPUT", "depart_after must be HH:MM (24 h)");
      const from = findCity(a.from);
      const to = findCity(a.to);
      const unknown = [!from ? a.from : null, !to ? a.to : null].filter(Boolean);
      const conf = confidenceFrom({ label: "simulated", source_answered: true, official: false });
      const base = { source: SOURCE, label: "simulated" as const, confidence: conf, retrieved_at: nowIso() };
      if (!from || !to) {
        return ok({ found: false, code: "CITY_NOT_KNOWN", message: `No demo buses for ${unknown.join(" / ")}. Known cities: ${CITIES.map((c) => c.name).join(", ")}.`, demo_options: [], notice: NOTICE }, base);
      }
      need(from.key !== to.key, "BAD_INPUT", "from and to are the same city");
      const roadKm = Math.round(crowKm(from, to) * ROAD_FACTOR);
      if (roadKm < MIN_KM) {
        return ok({ found: false, code: "TOO_SHORT", message: `${from.name} to ${to.name} is about ${roadKm} km: use city bus, metro or taxi.`, demo_options: [], notice: NOTICE }, base);
      }
      if (roadKm > MAX_KM) {
        return ok({ found: false, code: "TOO_FAR", message: `${from.name} to ${to.name} is about ${roadKm} km by road; no bus is simulated beyond ${MAX_KM} km. Try a train or flight.`, demo_options: [], notice: NOTICE }, base);
      }
      const after = a.depart_after ? Number(a.depart_after.slice(0, 2)) * 60 + Number(a.depart_after.slice(3)) : (date === istDate(now) ? minutesIst(now) : 0);
      const options = this.makeBuses(from, to, date, roadKm).filter((o) => o._dep >= after).map(({ _dep, ...o }) => o);
      return ok(
        {
          found: options.length > 0,
          ...(options.length ? {} : { code: "NO_DEMO_BUS_AFTER_TIME", message: `No demo bus leaves after ${a.depart_after ?? "now"} on ${date}.` }),
          from: from.name,
          to: to.name,
          date,
          road_km_estimate: roadKm,
          group: "demo_options",
          verified_replacement: false,
          notice: NOTICE,
          demo_options: options,
        },
        base,
      );
    });
  }

  private makeBuses(from: BusCity, to: BusCity, date: string, roadKm: number) {
    const h = hash(`${from.key}|${to.key}|${date}`);
    return SLOTS.map(([slot, typeKey], i) => {
      const type = TYPES[typeKey];
      const shift = ((h >>> (i * 5)) % 46); // 0-45 minutes
      const dep = slot + shift;
      const drive = Math.round((roadKm / type.kmh) * 60);
      const breaks = Math.floor(roadKm / 200) * 20; // a 20-min stop every 200 km
      const minutes = Math.ceil((drive + breaks + 15) / 5) * 5;
      const arr = dep + minutes;
      const farePaise = Math.round((roadKm * type.rupees_per_km) / 10) * 1000; // nearest Rs 10
      const fare = paiseToRupees(farePaise);
      const overnight = Math.floor(arr / 1440) > 0 || dep >= 21 * 60;
      const serviceNo = `SIM-${from.key.slice(0, 3).toUpperCase()}${to.key.slice(0, 3).toUpperCase()}-${i + 1}`;
      return {
        _dep: dep,
        option_id: `sim-bus-${from.key}-${to.key}-${date}-${i + 1}`,
        demo_only: true,
        bus_type: type.name,
        depart_at: istIsoAt(date, dep),
        arrive_at: istIsoAt(date, arr),
        duration_min: minutes,
        overnight,
        simulated_fare_rupees: fare,
        how_made_up: `about ${roadKm} km by road at ${type.kmh} km/h plus stops; fare Rs ${type.rupees_per_km}/km`,
        trip_leg: {
          kind: "bus",
          from_name: `${from.name} (bus stand)`,
          to_name: `${to.name} (bus stand)`,
          depart_at: istIsoAt(date, dep),
          arrive_at: istIsoAt(date, arr),
          operator: "Simulated operator (demo only)",
          service_no: serviceNo,
          source: SOURCE,
          label: "simulated",
          estimated_rupees: fare,
        },
      };
    });
  }

  addUserBus(a: { from: string; to: string; depart_at: string; arrive_at: string; operator?: string; service_no?: string; price_rupees?: string | number }): Envelope {
    return this.wrap(() => {
      for (const f of ["from", "to", "operator", "service_no"] as const) assertNoPii(f, a[f] ?? null);
      need(a.from.trim() && a.to.trim(), "BAD_INPUT", "from and to are required");
      const dep = Date.parse(a.depart_at);
      const arr = Date.parse(a.arrive_at);
      need(!Number.isNaN(dep) && !Number.isNaN(arr) && /[+-]\d{2}:\d{2}$|Z$/.test(a.depart_at) && /[+-]\d{2}:\d{2}$|Z$/.test(a.arrive_at), "BAD_INPUT", "depart_at and arrive_at must be ISO date-times with offset, e.g. 2026-11-21T07:00:00+05:30");
      need(arr > dep, "BAD_INPUT", "arrive_at must be after depart_at");
      need(arr - dep <= 48 * 3600000, "BAD_INPUT", "a bus leg longer than 48 hours is not accepted");
      const paise = a.price_rupees == null ? null : rupeesToPaise(a.price_rupees);
      const travelDate = istDate(new Date(dep));
      const leg = {
        kind: "bus",
        from_name: a.from.trim(),
        to_name: a.to.trim(),
        depart_at: a.depart_at,
        arrive_at: a.arrive_at,
        operator: a.operator?.trim() || "Bus you booked",
        service_no: a.service_no?.trim() || null,
        source: "user",
        label: "user_entered",
      };
      return ok(
        {
          trip_leg: leg,
          record_booking: paise == null ? null : { operator: leg.operator, service_no: leg.service_no ?? undefined, travel_date: travelDate, price_rupees: paiseToRupees(paise) },
          next_steps: "Add trip_leg with the Trip server's add_leg, then record what you paid with record_booking. Adhvaga never books or pays.",
        },
        { source: "user", label: "user_entered", confidence: confidenceFrom({ label: "user_entered", source_answered: true, official: false }) },
      );
    });
  }
}

function minutesIst(d: Date): number {
  const t = new Date(d.getTime() + 330 * 60000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
