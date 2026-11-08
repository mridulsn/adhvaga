// Earliest-arrival routing over a GTFS feed (Connection Scan Algorithm). Generic: works for one line
// (Kochi) or many lines with changes (Delhi), with a minimum change time between trains.
import type { Feed } from "./gtfs.ts";
import { addDays, servicesOn } from "./gtfs.ts";

export const MIN_CHANGE_SEC = 5 * 60; // getting off one train and onto another, incl. walking to the other platform

interface Conn { trip: string; from: string; to: string; dep: number; arr: number; fromIdx: number; dayOffset: number; estimated: boolean }

export interface RideLeg {
  kind: "ride";
  trip_id: string;
  route_id: string;
  from_stop: string;
  to_stop: string;
  dep: number; // seconds after midnight of the query date (may exceed 86400)
  arr: number;
  stops_travelled: number;
  towards: string; // last stop name of that train
  from_old_pattern: boolean; // its service day is outside the feed's calendar
}
export interface ChangeLeg { kind: "change"; at_stop: string; to_stop: string; min_sec: number }
export interface Journey { legs: (RideLeg | ChangeLeg)[]; dep: number; arr: number; changes: number; any_old_pattern: boolean; all_old_pattern: boolean }

/** Stop ids that belong to the same station: the stop, its parent and the parent's other children. */
export function stationGroup(feed: Feed, stopId: string): Set<string> {
  const s = feed.stops.get(stopId);
  const root = s?.parent ?? stopId;
  const out = new Set<string>([stopId, root]);
  for (const x of feed.stops.values()) if (x.parent === root) out.add(x.id);
  return out;
}

function connectionsFor(feed: Feed, date: string): Conn[] {
  const out: Conn[] = [];
  // Yesterday's trips that run past midnight count too (GTFS times like 24:30:00).
  for (const [offsetDays, day] of [[-1, addDays(date, -1)], [0, date]] as const) {
    const sd = servicesOn(feed, day);
    for (const trip of feed.trips.values()) {
      if (!sd.services.has(trip.service_id)) continue;
      const sts = feed.stopTimes.get(trip.id);
      if (!sts || sts.length < 2) continue;
      const shift = offsetDays * 86400;
      if (sts[sts.length - 1].arr + shift < 0) continue;
      for (let i = 0; i + 1 < sts.length; i++) {
        out.push({ trip: trip.id, from: sts[i].stop_id, to: sts[i + 1].stop_id, dep: sts[i].dep + shift, arr: sts[i + 1].arr + shift, fromIdx: i, dayOffset: offsetDays, estimated: !sd.in_calendar });
      }
    }
  }
  out.sort((x, y) => x.dep - y.dep || x.arr - y.arr);
  return out;
}

type Ptr = { kind: "ride"; enter: Conn; exit: Conn } | { kind: "change"; from: string };

function scan(feed: Feed, conns: Conn[], origins: Set<string>, targets: Set<string>, t0: number): Journey | null {
  const arrival = new Map<string, number>(); // when you are standing at the stop
  const board = new Map<string, number>(); // earliest time you can board a NEW train there
  const ptr = new Map<string, Ptr>();
  const tripEnter = new Map<string, Conn>();
  for (const o of origins) { arrival.set(o, t0); board.set(o, t0); }
  const best = () => Math.min(...[...targets].map((t) => arrival.get(t) ?? Infinity));

  for (const c of conns) {
    if (c.dep < t0) continue;
    if (c.dep > best()) break;
    let enter = tripEnter.get(c.trip);
    if (!enter && (board.get(c.from) ?? Infinity) <= c.dep) {
      enter = c;
      tripEnter.set(c.trip, c);
    }
    if (!enter) continue;
    if (c.arr < (arrival.get(c.to) ?? Infinity)) {
      arrival.set(c.to, c.arr);
      ptr.set(c.to, { kind: "ride", enter, exit: c });
      const canBoard = c.arr + MIN_CHANGE_SEC;
      for (const sib of stationGroup(feed, c.to)) {
        if (sib !== c.to && canBoard < (arrival.get(sib) ?? Infinity) && !origins.has(sib)) {
          arrival.set(sib, canBoard);
          ptr.set(sib, { kind: "change", from: c.to });
        }
        if (canBoard < (board.get(sib) ?? Infinity)) board.set(sib, canBoard);
      }
    }
  }
  const end = [...targets].filter((t) => arrival.has(t)).sort((a, b) => arrival.get(a)! - arrival.get(b)!)[0];
  if (!end) return null;

  const legs: (RideLeg | ChangeLeg)[] = [];
  let at = end;
  for (let guard = 0; !origins.has(at) || legs.length === 0; guard++) {
    if (guard > 200) throw new Error("route reconstruction did not end");
    const p = ptr.get(at);
    if (!p) break;
    if (p.kind === "change") {
      legs.unshift({ kind: "change", at_stop: p.from, to_stop: at, min_sec: MIN_CHANGE_SEC });
      at = p.from;
      continue;
    }
    const trip = feed.trips.get(p.enter.trip)!;
    const sts = feed.stopTimes.get(trip.id)!;
    legs.unshift({
      kind: "ride", trip_id: trip.id, route_id: trip.route_id, from_stop: p.enter.from, to_stop: p.exit.to,
      dep: p.enter.dep, arr: p.exit.arr, stops_travelled: p.exit.fromIdx - p.enter.fromIdx + 1,
      towards: trip.headsign ?? feed.stops.get(sts[sts.length - 1].stop_id)?.name ?? sts[sts.length - 1].stop_id,
      from_old_pattern: p.enter.estimated,
    });
    at = p.enter.from;
    if (origins.has(at)) break;
  }
  // A change leg between two rides at the same station can appear where consecutive rides share a stop; that is a
  // same-platform change and still needs the minimum change time, which the scan already enforced.
  const rides = legs.filter((l): l is RideLeg => l.kind === "ride");
  if (!rides.length) return null;
  return {
    legs, dep: rides[0].dep, arr: rides[rides.length - 1].arr, changes: rides.length - 1,
    any_old_pattern: rides.some((r) => r.from_old_pattern), all_old_pattern: rides.every((r) => r.from_old_pattern),
  };
}

/** Up to `count` journeys, each the earliest arrival for successively later departures. */
export function route(feed: Feed, date: string, origins: Set<string>, targets: Set<string>, afterSec: number, count: number): Journey[] {
  const conns = connectionsFor(feed, date);
  const out: Journey[] = [];
  let t0 = afterSec;
  while (out.length < count) {
    const j = scan(feed, conns, origins, targets, t0);
    if (!j) break;
    if (!out.some((x) => x.dep === j.dep && x.arr === j.arr)) out.push(j);
    t0 = j.dep + 1;
  }
  return out;
}

/** First departure of the day from any origin stop (for "no more trains today, first train tomorrow at ..."). */
export function firstDeparture(feed: Feed, date: string, origins: Set<string>, targets: Set<string>): number | null {
  const j = scan(feed, connectionsFor(feed, date), origins, targets, 0);
  return j ? j.dep : null;
}
