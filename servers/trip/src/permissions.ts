// Permission matrix (plan section 10). Decides: automatic, needs approval, or prohibited.
// Pure function over a base plan and a proposed plan. No AI involved.
import { ms } from "./rules.ts";
import type { Link, PlanLeg } from "./types.ts";
import { LOCAL_KINDS } from "./types.ts";

export type Permission = "automatic" | "needs_approval" | "prohibited";

export interface PermissionInput {
  base: { legs: PlanLeg[]; links: Link[]; cost_paise: number };
  proposed: { legs: PlanLeg[]; links: Link[]; cost_paise: number };
  auto_fix_local: boolean;
  booked: Set<string>;
  locked: Set<string>;
  target_paise: number | null;
  hard_ceiling_paise: number | null;
  rules_pass: boolean;
  relaxes_preference: boolean;
}

export interface PermissionResult {
  permission: Permission;
  reasons: string[];
  changed: string[];
  added: string[];
  removed: string[];
  cost_diff_paise: number;
  max_shift_min: number;
}

const PLAN_FIELDS: Array<keyof PlanLeg> = ["kind", "from_name", "to_name", "depart_at", "arrive_at", "operator", "service_no", "estimated_paise", "quoted_paise", "min_gap_after_min", "label", "source"];

export function legChanged(a: PlanLeg, b: PlanLeg): boolean {
  return PLAN_FIELDS.some((f) => {
    if (f === "depart_at" || f === "arrive_at") return ms(a[f]) !== ms(b[f]);
    return a[f] !== b[f];
  });
}

/** Latest arrival among predecessors, per leg. */
function readiness(legs: PlanLeg[], links: Link[]): Map<string, number> {
  const byKey = new Map(legs.map((l) => [l.leg_key, l]));
  const r = new Map<string, number>();
  for (const k of links) {
    const a = byKey.get(k.from_leg_key);
    if (!a) continue;
    const t = ms(a.arrive_at);
    r.set(k.to_leg_key, Math.max(r.get(k.to_leg_key) ?? -Infinity, t));
  }
  return r;
}

export function classify(i: PermissionInput): PermissionResult {
  const baseBy = new Map(i.base.legs.map((l) => [l.leg_key, l]));
  const propBy = new Map(i.proposed.legs.map((l) => [l.leg_key, l]));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, b] of propBy) {
    const a = baseBy.get(k);
    if (!a) added.push(k);
    else if (legChanged(a, b)) changed.push(k);
  }
  for (const k of baseBy.keys()) if (!propBy.has(k)) removed.push(k);

  const costDiff = i.proposed.cost_paise - i.base.cost_paise;

  // Shift at fixed points: unchanged legs whose predecessors now arrive at a different time.
  const rb = readiness(i.base.legs, i.base.links);
  const rp = readiness(i.proposed.legs, i.proposed.links);
  let maxShift = 0;
  const touchedKeys = new Set([...changed, ...added, ...removed]);
  for (const [k, tNew] of rp) {
    if (touchedKeys.has(k)) continue;
    const tOld = rb.get(k);
    if (tOld === undefined) continue;
    maxShift = Math.max(maxShift, Math.round((tNew - tOld) / 60000));
  }

  const reasons: string[] = [];
  if (i.hard_ceiling_paise != null && i.proposed.cost_paise > i.hard_ceiling_paise) {
    return { permission: "prohibited", reasons: ["OVER_CEILING"], changed, added, removed, cost_diff_paise: costDiff, max_shift_min: maxShift };
  }
  if (!i.rules_pass) reasons.push("RULES_FAIL");
  if (!i.auto_fix_local) reasons.push("AUTO_FIX_OFF");
  const allTouched = [...changed.map((k) => propBy.get(k) as PlanLeg), ...added.map((k) => propBy.get(k) as PlanLeg), ...removed.map((k) => baseBy.get(k) as PlanLeg)];
  if (allTouched.some((l) => !LOCAL_KINDS.includes(l.kind))) {
    if (allTouched.some((l) => l.kind === "stay" || l.kind === "activity")) reasons.push("MOVES_STAY_OR_ACTIVITY");
    else reasons.push("NOT_LOCAL_LEG");
  }
  const oldKeys = [...changed, ...removed];
  if (oldKeys.some((k) => i.booked.has(k))) reasons.push("CHANGES_BOOKED_LEG");
  if (oldKeys.some((k) => i.locked.has(k))) reasons.push("CHANGES_LOCKED_LEG");
  if (costDiff > 0) reasons.push("COSTS_MORE");
  if (i.target_paise != null && i.proposed.cost_paise > i.target_paise) reasons.push("ABOVE_TARGET");
  if (maxShift > 15) reasons.push("ARRIVAL_SHIFT_OVER_15_MIN");
  const newLegs = [...changed, ...added].map((k) => propBy.get(k) as PlanLeg);
  if (newLegs.some((l) => l.label !== "live" && l.label !== "timetable")) reasons.push("RELIES_ON_ESTIMATED_OR_WEAK_DATA");
  if (i.relaxes_preference) reasons.push("RELAXES_PREFERENCE");
  if (allTouched.length === 0) reasons.push("NO_CHANGE");

  return {
    permission: reasons.length === 0 ? "automatic" : "needs_approval",
    reasons,
    changed,
    added,
    removed,
    cost_diff_paise: costDiff,
    max_shift_min: maxShift,
  };
}
