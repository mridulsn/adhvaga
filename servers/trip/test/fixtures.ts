// Shared fixtures: the golden journey Delhi -> Jaipur (plan section 14, PRD section 4).
import { randomUUID } from "node:crypto";
import { openPglite } from "../src/db.ts";
import type { Ctx, LegInput } from "../src/service.ts";
import { TripService } from "../src/service.ts";

let shared: TripService | null = null;
export async function service(): Promise<TripService> {
  if (!shared) shared = new TripService(await openPglite());
  return shared;
}

export const k = () => randomUUID();
export function ctxFor(role: Ctx["role"] = "user", session = randomUUID()): Ctx {
  return { session, role };
}

const D = "2026-11-20";
export const t = (hhmm: string, day = D) => `${day}T${hhmm}:00+05:30`;

export const L1: LegInput = {
  leg_key: "L1", kind: "metro", from_name: "Rajiv Chowk", to_name: "New Delhi", depart_at: t("05:10"), arrive_at: t("05:20"),
  operator: "DMRC", service_no: "Yellow Line", source: "delhi-metro-gtfs", label: "timetable", min_gap_after_min: 30, estimated_rupees: "20",
};
export const L2: LegInput = {
  leg_key: "L2", kind: "train", from_name: "New Delhi (NDLS)", to_name: "Jaipur (JP)", depart_at: t("06:10"), arrive_at: t("10:35"),
  operator: "Indian Railways", service_no: "12015", source: "railradar", label: "timetable", min_gap_after_min: 60, estimated_rupees: "755",
};
export const L3: LegInput = {
  leg_key: "L3", kind: "stay", from_name: "Jaipur hotel", to_name: "Jaipur hotel", depart_at: t("15:00"), arrive_at: t("11:00", "2026-11-21"),
  operator: null, service_no: null, source: "user", label: "user_entered", estimated_rupees: "1800",
};
/** Replacement train after L2 is cancelled: Rs 150 more than the booked fare. */
export const L2b: LegInput = {
  leg_key: "L2b", kind: "train", from_name: "New Delhi (NDLS)", to_name: "Jaipur (JP)", depart_at: t("07:00"), arrive_at: t("11:40"),
  operator: "Indian Railways", service_no: "12958", source: "railradar", label: "timetable", min_gap_after_min: 60, estimated_rupees: "905",
};

export interface Golden {
  svc: TripService;
  ctx: Ctx;
  trip: string;
}

/** Creates the golden trip and approves v1. Options: book L2, lock L3, auto-fix on. */
export async function golden(opts: { book?: boolean; lock?: boolean; autoFix?: boolean; ceiling?: string; target?: string } = {}): Promise<Golden> {
  const svc = await service();
  const ctx = ctxFor("user");
  const { trip_id } = await svc.createTrip(ctx, k(), {
    title: "Delhi to Jaipur", trip_end_date: "2026-11-21",
    rules: { arrive_by: { at: t("14:00") }, no_arrival_after_local: "23:00", default_min_gap_min: 30 },
    hard_ceiling_rupees: opts.ceiling ?? "4000", target_rupees: opts.target ?? "3000",
  });
  for (const leg of [L1, L2, L3]) await svc.addLeg(ctx, k(), { trip_id, leg });
  await svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L1", to_leg_key: "L2" });
  await svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L2", to_leg_key: "L3" });
  await svc.approvePlan(ctx, k(), { trip_id });
  if (opts.lock ?? true) await svc.lockLeg(ctx, k(), { trip_id, leg_key: "L3", locked: true });
  if (opts.book) await svc.recordBooking(ctx, k(), { trip_id, leg_key: "L2", operator: "Indian Railways", service_no: "12015", travel_date: D, price_rupees: "755" });
  if (opts.autoFix) await svc.setAutoFix(ctx, k(), { trip_id, enabled: true });
  return { svc, ctx, trip: trip_id };
}

export async function snapshot(g: Golden, version: number): Promise<string> {
  const v = await g.svc.version(g.svc.db, g.trip, version);
  return JSON.stringify({ legs: v.legs, links: v.links });
}

export async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c === code) return;
    throw new Error(`expected error ${code}, got ${c}: ${(e as Error).message}`);
  }
  throw new Error(`expected error ${code}, but the call succeeded`);
}
