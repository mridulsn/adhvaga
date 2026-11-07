// Leg dependency graph: which later legs does a disruption break?
import { DEFAULT_MIN_GAP_MIN, effectiveTimes } from "./rules.ts";
import type { LegStatus, Link, PlanLeg } from "./types.ts";

export interface AffectedResult {
  /** Legs that cannot happen as planned: cancelled / diverted / line closed, or a missed connection. */
  broken: string[];
  /** Legs running late but whose onward connections still pass. */
  delayed: string[];
  /** Unlocked legs downstream of a broken leg: they need to be re-planned or re-checked. */
  at_risk: string[];
  /** Locked legs downstream of a broken leg: kept exactly; the replan must reach them. */
  kept_locked: string[];
  /** Everything else, untouched. */
  unaffected: string[];
  reasons: Record<string, string>;
}

const BREAKING = new Set(["cancelled", "diverted", "line_closed"]);

export function findAffected(
  legs: PlanLeg[],
  links: Link[],
  statuses: LegStatus[],
  locked: Set<string>,
  defaultGap = DEFAULT_MIN_GAP_MIN,
): AffectedResult {
  const byKey = new Map(legs.map((l) => [l.leg_key, l]));
  const st = new Map(statuses.map((s) => [s.leg_key, s]));
  const out = new Map<string, string[]>();
  for (const l of legs) out.set(l.leg_key, []);
  for (const k of links) out.get(k.from_leg_key)?.push(k.to_leg_key);

  const delays: Record<string, number> = {};
  for (const s of statuses) if (s.delay_min > 0) delays[s.leg_key] = s.delay_min;

  const broken = new Set<string>();
  const delayed = new Set<string>();
  const lockedConflicts = new Set<string>();
  const reasons: Record<string, string> = {};

  for (const l of legs) {
    const s = st.get(l.leg_key);
    if (s?.status === "completed") continue;
    if (s && BREAKING.has(s.status)) {
      broken.add(l.leg_key);
      reasons[l.leg_key] = `status ${s.status}${s.is_test ? " (test)" : ""}`;
    }
  }
  // Missed connections caused by delays.
  for (const k of links) {
    const a = byKey.get(k.from_leg_key);
    const b = byKey.get(k.to_leg_key);
    if (!a || !b || broken.has(a.leg_key)) continue;
    if (st.get(b.leg_key)?.status === "completed") continue;
    const da = delays[a.leg_key] ?? 0;
    if (da <= 0) continue;
    const gap = Math.round((effectiveTimes(b, delays).dep - effectiveTimes(a, delays).arr) / 60000);
    const need = a.min_gap_after_min ?? defaultGap;
    if (gap < need) {
      if (locked.has(b.leg_key)) {
        // A locked leg is kept; report the conflict instead of marking it broken.
        reasons[b.leg_key] = `connection from late ${a.leg_key} now ${gap} min (need ${need}); leg is locked, so kept - the replan must reach it or ask you`;
        lockedConflicts.add(b.leg_key);
      } else {
        broken.add(b.leg_key);
        reasons[b.leg_key] = `missed connection: ${a.leg_key} is ${da} min late, gap now ${gap} min (need ${need})`;
      }
      delayed.add(a.leg_key);
    } else {
      delayed.add(a.leg_key);
    }
  }
  for (const k of Object.keys(delays)) if (!broken.has(k) && byKey.has(k)) delayed.add(k);

  // Walk downstream of broken legs.
  const atRisk = new Set<string>();
  const keptLocked = new Set<string>(lockedConflicts);
  const queue = [...broken, ...lockedConflicts];
  const seen = new Set(queue);
  while (queue.length) {
    const k = queue.shift() as string;
    for (const n of out.get(k) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (st.get(n)?.status === "completed") continue;
      if (broken.has(n)) continue;
      if (locked.has(n)) {
        keptLocked.add(n);
        reasons[n] ??= `downstream of ${k}; locked, so kept`;
      } else {
        atRisk.add(n);
        reasons[n] ??= `depends on ${k}`;
      }
      queue.push(n);
    }
  }
  for (const k of broken) delayed.delete(k);
  const touched = new Set([...broken, ...delayed, ...atRisk, ...keptLocked]);
  const unaffected = legs.map((l) => l.leg_key).filter((k) => !touched.has(k));
  const sort = (s: Set<string>) => [...s].sort();
  return { broken: sort(broken), delayed: sort(delayed), at_risk: sort(atRisk), kept_locked: sort(keptLocked), unaffected: unaffected.sort(), reasons };
}
