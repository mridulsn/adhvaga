// Hard rules, enforced in code only. Pure functions: no database, no AI.
import type { Link, PlanLeg, RuleFailure, TripRules } from "./types.ts";
import { isTravel } from "./types.ts";

export const DEFAULT_MIN_GAP_MIN = 30;
const IST_OFFSET_MIN = 330;

export function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Bad time: ${iso}`);
  return t;
}

export function minutesBetween(a: string, b: string): number {
  return Math.round((ms(b) - ms(a)) / 60000);
}

/** Minutes since local (IST) midnight. */
export function istClockMinutes(iso: string): number {
  const m = Math.floor(ms(iso) / 60000) + IST_OFFSET_MIN;
  return ((m % 1440) + 1440) % 1440;
}

function hhmm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Bad clock time ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Returns a leg key in a cycle, or null. */
export function findCycle(legKeys: string[], links: Link[]): string[] | null {
  const out = new Map<string, string[]>();
  for (const k of legKeys) out.set(k, []);
  for (const l of links) out.get(l.from_leg_key)?.push(l.to_leg_key);
  const state = new Map<string, number>(); // 1 = visiting, 2 = done
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    state.set(k, 1);
    stack.push(k);
    for (const n of out.get(k) ?? []) {
      if (state.get(n) === 1) return stack.slice(stack.indexOf(n)).concat(n);
      if (!state.get(n)) {
        const c = visit(n);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(k, 2);
    return null;
  };
  for (const k of legKeys) {
    if (!state.get(k)) {
      const c = visit(k);
      if (c) return c;
    }
  }
  return null;
}

export interface RuleContext {
  rules: TripRules;
  /** Total committed cost of this plan in paise, and the hard ceiling. */
  cost_paise?: number;
  hard_ceiling_paise?: number | null;
  /** Optional delays (minutes) to apply when checking, keyed by leg_key. */
  delays?: Record<string, number>;
}

export function effectiveTimes(leg: PlanLeg, delays?: Record<string, number>): { dep: number; arr: number } {
  const d = (delays?.[leg.leg_key] ?? 0) * 60000;
  return { dep: ms(leg.depart_at) + d, arr: ms(leg.arrive_at) + d };
}

export function checkRules(legs: PlanLeg[], links: Link[], ctx: RuleContext): RuleFailure[] {
  const f: RuleFailure[] = [];
  const byKey = new Map(legs.map((l) => [l.leg_key, l]));
  const defGap = ctx.rules.default_min_gap_min ?? DEFAULT_MIN_GAP_MIN;

  for (const l of legs) {
    if (ms(l.arrive_at) <= ms(l.depart_at)) f.push({ code: "BAD_TIMES", leg_keys: [l.leg_key], detail: `${l.leg_key} ends before it starts` });
  }
  for (const k of links) {
    if (!byKey.has(k.from_leg_key) || !byKey.has(k.to_leg_key)) {
      f.push({ code: "UNKNOWN_LEG", leg_keys: [k.from_leg_key, k.to_leg_key], detail: "link refers to a leg that is not in this version" });
    }
  }
  const cyc = findCycle(legs.map((l) => l.leg_key), links);
  if (cyc) f.push({ code: "CYCLE", leg_keys: cyc, detail: `legs link in a circle: ${cyc.join(" -> ")}` });

  for (const k of links) {
    const a = byKey.get(k.from_leg_key);
    const b = byKey.get(k.to_leg_key);
    if (!a || !b) continue;
    const need = a.min_gap_after_min ?? defGap;
    const gap = Math.round((effectiveTimes(b, ctx.delays).dep - effectiveTimes(a, ctx.delays).arr) / 60000);
    if (gap < need) {
      f.push({ code: "GAP_TOO_SHORT", leg_keys: [a.leg_key, b.leg_key], detail: `${gap} min between ${a.leg_key} and ${b.leg_key}, need ${need}` });
    }
  }

  const ab = ctx.rules.arrive_by;
  if (ab) {
    const travel = legs.filter((l) => isTravel(l.kind));
    const target = ab.leg_key ? byKey.get(ab.leg_key) : travel.sort((x, y) => ms(y.arrive_at) - ms(x.arrive_at))[0];
    if (target && effectiveTimes(target, ctx.delays).arr > ms(ab.at)) {
      f.push({ code: "ARRIVES_LATE", leg_keys: [target.leg_key], detail: `${target.leg_key} arrives after ${ab.at}` });
    }
  }

  if (ctx.rules.no_arrival_after_local) {
    const limit = hhmm(ctx.rules.no_arrival_after_local);
    const morning = 5 * 60;
    for (const l of legs) {
      if (!isTravel(l.kind)) continue;
      const t = istClockMinutes(new Date(effectiveTimes(l, ctx.delays).arr).toISOString());
      if (t > limit || t < morning) {
        f.push({ code: "LATE_NIGHT", leg_keys: [l.leg_key], detail: `${l.leg_key} arrives at night (after ${ctx.rules.no_arrival_after_local})` });
      }
    }
  }

  if (ctx.hard_ceiling_paise != null && ctx.cost_paise != null && ctx.cost_paise > ctx.hard_ceiling_paise) {
    f.push({ code: "OVER_CEILING", leg_keys: [], detail: `plan costs ${ctx.cost_paise} paise, hard ceiling ${ctx.hard_ceiling_paise}` });
  }
  return f;
}
