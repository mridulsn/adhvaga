// Trip service: every rule, permission and money calculation lives here, in code.
// The MCP layer (server.ts) only translates tool calls into these functions.
import { randomUUID } from "node:crypto";
import type { Db, Tx } from "./db.ts";
import { ToolError, confidenceFrom, nowIso } from "./envelope.ts";
import type { Label } from "./envelope.ts";
import { LABELS } from "./envelope.ts";
import { findAffected } from "./graph.ts";
import { MoneyError, assertPaise, rupeesToPaise, sumPaise } from "./money.ts";
import { classify } from "./permissions.ts";
import { DEFAULT_MIN_GAP_MIN, checkRules, findCycle, ms } from "./rules.ts";
import type { LegKind, LegStatus, Link, PlanLeg, RuleFailure, TripRules } from "./types.ts";
import { LEG_KINDS, isTravel } from "./types.ts";

export type Role = "user" | "agent" | "test" | "public";

export interface Ctx {
  /** Browser session that owns the trip (no accounts in release 1). */
  session: string;
  role: Role;
  /** Test-only fault injection. */
  faults?: { propose_fail_after_legs?: number };
}

// ---------- helpers ----------

function need(cond: unknown, code: string, msg: string, details?: unknown): asserts cond {
  if (!cond) throw new ToolError(code, msg, details);
}

function requireWriter(ctx: Ctx) {
  need(ctx.role === "user" || ctx.role === "agent" || ctx.role === "test", "UNAUTHORISED", "This tool changes saved data and needs the secret pass.");
}

function requireUser(ctx: Ctx, what: string) {
  requireWriter(ctx);
  need(ctx.role === "user" || ctx.role === "test", "USER_ONLY", `Only you can ${what}. The assistant cannot do this.`);
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));

// Personal data is never stored (plan section 15).
const PII_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{10}\b/, "a 10-digit number (PNR or phone number)"],
  [/\b(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/, "a phone number"],
  [/\b(?:\d[ -]?){13,19}\b/, "a card number"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, "an email address"],
  [/\bpnr\b/i, "a PNR"],
];

export function assertNoPii(field: string, value: string | null | undefined) {
  if (!value) return;
  for (const [re, what] of PII_PATTERNS) {
    need(!re.test(value), "PII_NOT_ALLOWED", `${field} looks like it contains ${what}. Adhvaga never stores PNRs, names, phone numbers or card details.`);
  }
}

function parseMoney(v: string | number | undefined | null, name: string): number | null {
  if (v == null) return null;
  try {
    return rupeesToPaise(v);
  } catch (e) {
    if (e instanceof MoneyError) throw new ToolError("BAD_INPUT", `${name}: ${e.message}`);
    throw e;
  }
}

async function audit(tx: Tx, tripId: string | null, event: string, ctx: Ctx, nature: "fact" | "system_decision" | "ai_explanation", detail: object = {}) {
  await tx.query("INSERT INTO audit_log (trip_id, event, actor, nature, detail) VALUES ($1,$2,$3,$4,$5)", [tripId, event, ctx.role, nature, JSON.stringify(detail)]);
}

// ---------- input shapes ----------

export interface LegInput {
  leg_key: string;
  kind: LegKind;
  from_name: string;
  to_name: string;
  depart_at: string;
  arrive_at: string;
  operator?: string | null;
  service_no?: string | null;
  source: string;
  label: Label;
  min_gap_after_min?: number | null;
  estimated_rupees?: string | number | null;
  quoted_rupees?: string | number | null;
  quoted_source?: string | null;
  quoted_at?: string | null;
}

function toPlanLeg(i: LegInput): PlanLeg {
  need(/^[A-Za-z0-9._-]{1,24}$/.test(i.leg_key), "BAD_INPUT", "leg_key must be 1-24 letters, digits, dot, dash or underscore");
  need((LEG_KINDS as readonly string[]).includes(i.kind), "BAD_INPUT", `kind must be one of ${LEG_KINDS.join(", ")}`);
  need((LABELS as readonly string[]).includes(i.label), "BAD_INPUT", `label must be one of ${LABELS.join(", ")}`);
  need(i.from_name && i.to_name, "BAD_INPUT", "from_name and to_name are required");
  let dep: number, arr: number;
  try {
    dep = ms(i.depart_at);
    arr = ms(i.arrive_at);
  } catch {
    throw new ToolError("BAD_INPUT", "depart_at and arrive_at must be ISO date-times with offset, e.g. 2026-11-20T09:30:00+05:30");
  }
  need(arr > dep, "BAD_INPUT", `${i.leg_key}: arrive_at must be after depart_at`);
  need(i.min_gap_after_min == null || (Number.isInteger(i.min_gap_after_min) && i.min_gap_after_min >= 0 && i.min_gap_after_min <= 1440), "BAD_INPUT", "min_gap_after_min must be 0-1440");
  for (const f of ["from_name", "to_name", "operator", "service_no"] as const) assertNoPii(f, i[f] ?? null);
  const quoted = parseMoney(i.quoted_rupees, "quoted_rupees");
  need(quoted == null || (i.quoted_source && i.quoted_at), "BAD_INPUT", "a quoted price needs quoted_source and quoted_at");
  return {
    leg_key: i.leg_key,
    kind: i.kind,
    from_name: i.from_name,
    to_name: i.to_name,
    depart_at: new Date(dep).toISOString(),
    arrive_at: new Date(arr).toISOString(),
    operator: i.operator ?? null,
    service_no: i.service_no ?? null,
    source: i.source,
    label: i.label,
    min_gap_after_min: i.min_gap_after_min ?? null,
    estimated_paise: parseMoney(i.estimated_rupees, "estimated_rupees"),
    quoted_paise: quoted,
    quoted_source: i.quoted_source ?? null,
    quoted_at: i.quoted_at ? iso(i.quoted_at) : null,
  };
}

// ---------- the service ----------

export class TripService {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Run a write with a one-time key: same key returns the first answer and never repeats the change. */
  async write<R>(ctx: Ctx, tool: string, key: string | undefined, args: { trip_id?: string }, fn: (tx: Tx) => Promise<R>): Promise<R> {
    try {
      return await this.writeInner(ctx, tool, key, fn);
    } catch (e) {
      // The change was rolled back; record the refusal in the event log (outside the failed transaction).
      if (e instanceof ToolError && args.trip_id && e.code !== "NOT_FOUND") {
        await this.db.query(
          "INSERT INTO audit_log (trip_id, event, actor, nature, detail) SELECT id, 'write_rejected', $3, 'system_decision', $4 FROM trips WHERE id=$1 AND owner_session=$2",
          [args.trip_id, ctx.session, ctx.role, JSON.stringify({ tool, code: e.code, message: e.message, details: e.details ?? null })]);
      }
      throw e;
    }
  }

  private async writeInner<R>(ctx: Ctx, tool: string, key: string | undefined, fn: (tx: Tx) => Promise<R>): Promise<R> {
    requireWriter(ctx);
    need(typeof key === "string" && key.length >= 8 && key.length <= 100, "BAD_INPUT", "idempotency_key (8-100 chars, new for every change) is required");
    const k = `${ctx.session}:${key}`;
    const prev = await this.db.query<{ tool: string; response: R }>("SELECT tool, response FROM idempotency WHERE key=$1", [k]);
    if (prev.rows.length) {
      need(prev.rows[0].tool === tool, "BAD_INPUT", "idempotency_key was already used for a different tool");
      return prev.rows[0].response;
    }
    return this.db.transaction(async (tx) => {
      const r = await fn(tx);
      await tx.query("INSERT INTO idempotency (key, tool, response) VALUES ($1,$2,$3)", [k, tool, JSON.stringify(r ?? null)]);
      return r;
    });
  }

  // ----- loading -----

  async trip(tx: Tx, ctx: Ctx, tripId: string) {
    const r = await tx.query<{ id: string; owner_session: string; title: string; auto_fix_local: boolean; rules: TripRules; current_version: number | null; trip_end_date: unknown }>(
      "SELECT * FROM trips WHERE id=$1", [tripId]);
    const t = r.rows[0];
    need(t && t.owner_session === ctx.session, "NOT_FOUND", "No such trip in this session.");
    return t;
  }

  async version(tx: Tx, tripId: string, n: number) {
    const v = await tx.query<{ number: number; status: string; parent: number | null; reason: string | null; created_by: string; created_at: unknown }>(
      "SELECT * FROM versions WHERE trip_id=$1 AND number=$2", [tripId, n]);
    need(v.rows[0], "NOT_FOUND", `Version ${n} does not exist.`);
    const legs = await tx.query<Record<string, unknown>>("SELECT * FROM legs WHERE trip_id=$1 AND version=$2 ORDER BY depart_at, leg_key", [tripId, n]);
    const links = await tx.query<{ from_leg: string; to_leg: string }>("SELECT from_leg, to_leg FROM leg_links WHERE trip_id=$1 AND version=$2 ORDER BY from_leg, to_leg", [tripId, n]);
    return {
      ...v.rows[0],
      created_at: iso(v.rows[0].created_at),
      legs: legs.rows.map(rowToLeg),
      links: links.rows.map((l) => ({ from_leg_key: l.from_leg, to_leg_key: l.to_leg })),
    };
  }

  async observations(tx: Tx, tripId: string) {
    const locks = await tx.query<{ leg_key: string }>("SELECT leg_key FROM leg_locks WHERE trip_id=$1", [tripId]);
    const st = await tx.query<Record<string, unknown>>("SELECT * FROM leg_status WHERE trip_id=$1", [tripId]);
    const bk = await tx.query<Record<string, unknown>>("SELECT * FROM bookings WHERE trip_id=$1 ORDER BY recorded_at", [tripId]);
    const bu = await tx.query<Record<string, unknown>>("SELECT * FROM budgets WHERE trip_id=$1", [tripId]);
    return {
      locked: new Set(locks.rows.map((r) => r.leg_key)),
      statuses: st.rows.map((s): LegStatus => ({
        leg_key: String(s.leg_key), status: s.status as LegStatus["status"], delay_min: Number(s.delay_min),
        checked_at: iso(s.checked_at), source: String(s.source), label: s.label as Label, is_test: Boolean(s.is_test),
      })),
      bookings: bk.rows.map((b) => ({
        id: String(b.id), leg_key: String(b.leg_key), operator: String(b.operator), service_no: (b.service_no as string) ?? null,
        travel_date: iso(b.travel_date).slice(0, 10), price_paise: Number(b.price_paise), fees: b.fees, fees_paise: Number(b.fees_paise), state: String(b.state),
      })),
      budget: bu.rows[0]
        ? {
            hard_ceiling_paise: num(bu.rows[0].hard_ceiling_paise), target_paise: num(bu.rows[0].target_paise),
            refund_pending_paise: Number(bu.rows[0].refund_pending_paise), refund_received_paise: Number(bu.rows[0].refund_received_paise),
          }
        : { hard_ceiling_paise: null, target_paise: null, refund_pending_paise: 0, refund_received_paise: 0 },
    };
  }

  /** Net money actually spent: all bookings (incl. cancelled ones awaiting refund) minus refunds received. */
  paidNet(obs: Awaited<ReturnType<TripService["observations"]>>): number {
    return sumPaise(obs.bookings.map((b) => b.price_paise + b.fees_paise)) - obs.budget.refund_received_paise;
  }

  /** Committed cost of a plan. Refund pending is NEVER counted as cash. */
  costOf(legs: PlanLeg[], obs: Awaited<ReturnType<TripService["observations"]>>): number {
    const hasBooking = new Set(obs.bookings.map((b) => b.leg_key));
    const unbooked = legs.filter((l) => !hasBooking.has(l.leg_key)).map((l) => l.quoted_paise ?? l.estimated_paise ?? 0);
    return this.paidNet(obs) + sumPaise(unbooked);
  }

  bookedKeys(obs: Awaited<ReturnType<TripService["observations"]>>): Set<string> {
    return new Set(obs.bookings.map((b) => b.leg_key));
  }

  async saveVersionRows(tx: Tx, ctx: Ctx, tripId: string, n: number, legs: PlanLeg[], links: Link[]) {
    let i = 0;
    for (const l of legs) {
      await tx.query(
        `INSERT INTO legs (trip_id, version, leg_key, kind, from_name, to_name, depart_at, arrive_at, operator, service_no, source, label,
          min_gap_after_min, estimated_paise, quoted_paise, quoted_source, quoted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [tripId, n, l.leg_key, l.kind, l.from_name, l.to_name, l.depart_at, l.arrive_at, l.operator, l.service_no, l.source, l.label,
          l.min_gap_after_min, l.estimated_paise, l.quoted_paise, l.quoted_source, l.quoted_at]);
      i++;
      if (ctx.faults?.propose_fail_after_legs === i) throw new Error("INJECTED_DB_FAULT");
    }
    for (const k of links) {
      await tx.query("INSERT INTO leg_links (trip_id, version, from_leg, to_leg) VALUES ($1,$2,$3,$4)", [tripId, n, k.from_leg_key, k.to_leg_key]);
    }
  }

  async nextVersionNumber(tx: Tx, tripId: string): Promise<number> {
    const r = await tx.query<{ n: number | null }>("SELECT max(number) AS n FROM versions WHERE trip_id=$1", [tripId]);
    return Number(r.rows[0].n ?? 0) + 1;
  }

  // ================= tools =================

  async createTrip(ctx: Ctx, key: string, a: { title: string; trip_end_date?: string; rules?: TripRules; hard_ceiling_rupees?: string | number; target_rupees?: string | number }) {
    return this.write(ctx, "create_trip", key, {}, async (tx) => {
      need(a.title && a.title.length <= 120, "BAD_INPUT", "title is required (max 120 chars)");
      assertNoPii("title", a.title);
      const rules = validateRules(a.rules ?? {});
      const ceiling = parseMoney(a.hard_ceiling_rupees, "hard_ceiling_rupees");
      const target = parseMoney(a.target_rupees, "target_rupees");
      need(ceiling == null || target == null || target <= ceiling, "BAD_INPUT", "target cannot be above the hard ceiling");
      const id = randomUUID();
      await tx.query("INSERT INTO trips (id, owner_session, title, trip_end_date, rules) VALUES ($1,$2,$3,$4,$5)", [id, ctx.session, a.title, a.trip_end_date ?? null, JSON.stringify(rules)]);
      await tx.query("INSERT INTO budgets (trip_id, hard_ceiling_paise, target_paise) VALUES ($1,$2,$3)", [id, ceiling, target]);
      await tx.query("INSERT INTO versions (trip_id, number, status, created_by, reason) VALUES ($1,1,'draft',$2,'first plan')", [id, ctx.role]);
      await audit(tx, id, "trip_created", ctx, "fact", { rules, hard_ceiling_paise: ceiling, target_paise: target });
      return { trip_id: id, draft_version: 1 };
    });
  }

  async setBudget(ctx: Ctx, key: string, a: { trip_id: string; hard_ceiling_rupees?: string | number; target_rupees?: string | number }) {
    return this.write(ctx, "set_budget", key, a, async (tx) => {
      requireUser(ctx, "change the budget");
      await this.trip(tx, ctx, a.trip_id);
      const obs = await this.observations(tx, a.trip_id);
      const ceiling = a.hard_ceiling_rupees !== undefined ? parseMoney(a.hard_ceiling_rupees, "hard_ceiling_rupees") : obs.budget.hard_ceiling_paise;
      const target = a.target_rupees !== undefined ? parseMoney(a.target_rupees, "target_rupees") : obs.budget.target_paise;
      need(ceiling == null || target == null || target <= ceiling, "BAD_INPUT", "target cannot be above the hard ceiling");
      await tx.query("UPDATE budgets SET hard_ceiling_paise=$2, target_paise=$3 WHERE trip_id=$1", [a.trip_id, ceiling, target]);
      await audit(tx, a.trip_id, "budget_set", ctx, "fact", { hard_ceiling_paise: ceiling, target_paise: target });
      return { hard_ceiling_paise: ceiling, target_paise: target };
    });
  }

  async setRules(ctx: Ctx, key: string, a: { trip_id: string; rules: TripRules }) {
    return this.write(ctx, "set_rules", key, a, async (tx) => {
      const t = await this.trip(tx, ctx, a.trip_id);
      need(t.current_version == null || ctx.role !== "agent", "USER_ONLY", "Once a plan is approved, only you can change the trip rules.");
      const rules = validateRules(a.rules);
      await tx.query("UPDATE trips SET rules=$2 WHERE id=$1", [a.trip_id, JSON.stringify(rules)]);
      await audit(tx, a.trip_id, "rules_set", ctx, "fact", { rules });
      return { rules };
    });
  }

  async setAutoFix(ctx: Ctx, key: string, a: { trip_id: string; enabled: boolean }) {
    return this.write(ctx, "set_auto_fix", key, a, async (tx) => {
      requireUser(ctx, "let Adhvaga fix local legs by itself");
      await this.trip(tx, ctx, a.trip_id);
      await tx.query("UPDATE trips SET auto_fix_local=$2 WHERE id=$1", [a.trip_id, !!a.enabled]);
      await audit(tx, a.trip_id, "auto_fix_set", ctx, "fact", { enabled: !!a.enabled });
      return { auto_fix_local: !!a.enabled };
    });
  }

  private async draft(tx: Tx, ctx: Ctx, tripId: string) {
    await this.trip(tx, ctx, tripId);
    const r = await tx.query<{ number: number }>("SELECT number FROM versions WHERE trip_id=$1 AND status='draft' ORDER BY number DESC LIMIT 1", [tripId]);
    need(r.rows[0], "NOT_DRAFT", "The plan is already approved. Changes go through propose_version.");
    return Number(r.rows[0].number);
  }

  async addLeg(ctx: Ctx, key: string, a: { trip_id: string; leg: LegInput }) {
    return this.write(ctx, "add_leg", key, a, async (tx) => {
      const n = await this.draft(tx, ctx, a.trip_id);
      const leg = toPlanLeg(a.leg);
      const dup = await tx.query("SELECT 1 FROM legs WHERE trip_id=$1 AND version=$2 AND leg_key=$3", [a.trip_id, n, leg.leg_key]);
      need(!dup.rows.length, "BAD_INPUT", `leg_key ${leg.leg_key} already exists`);
      await this.saveVersionRows(tx, ctx, a.trip_id, n, [leg], []);
      await audit(tx, a.trip_id, "leg_added", ctx, "fact", { leg_key: leg.leg_key, kind: leg.kind, label: leg.label });
      return { version: n, leg };
    });
  }

  async linkLegs(ctx: Ctx, key: string, a: { trip_id: string; from_leg_key: string; to_leg_key: string }) {
    return this.write(ctx, "link_legs", key, a, async (tx) => {
      const n = await this.draft(tx, ctx, a.trip_id);
      const v = await this.version(tx, a.trip_id, n);
      const keys = v.legs.map((l) => l.leg_key);
      need(keys.includes(a.from_leg_key) && keys.includes(a.to_leg_key), "UNKNOWN_LEG", "Both legs must exist in the draft.");
      need(a.from_leg_key !== a.to_leg_key, "CYCLE", "A leg cannot depend on itself.");
      const links = [...v.links, { from_leg_key: a.from_leg_key, to_leg_key: a.to_leg_key }];
      const cyc = findCycle(keys, links);
      need(!cyc, "CYCLE", `That link would make a circle: ${cyc?.join(" -> ")}`);
      await tx.query("INSERT INTO leg_links (trip_id, version, from_leg, to_leg) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [a.trip_id, n, a.from_leg_key, a.to_leg_key]);
      await audit(tx, a.trip_id, "legs_linked", ctx, "fact", { from: a.from_leg_key, to: a.to_leg_key });
      return { version: n, links };
    });
  }

  async removeLeg(ctx: Ctx, key: string, a: { trip_id: string; leg_key: string }) {
    return this.write(ctx, "remove_leg", key, a, async (tx) => {
      const n = await this.draft(tx, ctx, a.trip_id);
      await tx.query("DELETE FROM leg_links WHERE trip_id=$1 AND version=$2 AND (from_leg=$3 OR to_leg=$3)", [a.trip_id, n, a.leg_key]);
      const r = await tx.query("DELETE FROM legs WHERE trip_id=$1 AND version=$2 AND leg_key=$3 RETURNING leg_key", [a.trip_id, n, a.leg_key]);
      need(r.rows.length, "UNKNOWN_LEG", "No such leg in the draft.");
      await audit(tx, a.trip_id, "leg_removed", ctx, "fact", { leg_key: a.leg_key });
      return { version: n, removed: a.leg_key };
    });
  }

  /** You pick the plan: the draft becomes the approved v1. Hard rules must pass. */
  async approvePlan(ctx: Ctx, key: string, a: { trip_id: string }) {
    return this.write(ctx, "approve_plan", key, a, async (tx) => {
      requireUser(ctx, "approve the plan");
      const t = await this.trip(tx, ctx, a.trip_id);
      const n = await this.draft(tx, ctx, a.trip_id);
      const v = await this.version(tx, a.trip_id, n);
      need(v.legs.length > 0, "BAD_INPUT", "The draft has no legs.");
      const obs = await this.observations(tx, a.trip_id);
      const cost = this.costOf(v.legs, obs);
      const failures = checkRules(v.legs, v.links, { rules: t.rules, cost_paise: cost, hard_ceiling_paise: obs.budget.hard_ceiling_paise });
      if (failures.length) {
        await audit(tx, a.trip_id, "rule_checked", ctx, "system_decision", { version: n, passed: false, failures });
        throw new ToolError(failures.some((f) => f.code === "OVER_CEILING") ? "OVER_CEILING" : "RULES_FAIL", "The plan breaks a hard rule, so it cannot be approved.", failures);
      }
      if (t.current_version != null) await tx.query("UPDATE versions SET status='superseded' WHERE trip_id=$1 AND number=$2", [a.trip_id, t.current_version]);
      await tx.query("UPDATE versions SET status='approved' WHERE trip_id=$1 AND number=$2", [a.trip_id, n]);
      await tx.query("UPDATE trips SET current_version=$2 WHERE id=$1", [a.trip_id, n]);
      await audit(tx, a.trip_id, "version_created", ctx, "system_decision", { version: n, status: "approved", cost_paise: cost });
      return { current_version: n, cost_paise: cost };
    });
  }

  async lockLeg(ctx: Ctx, key: string, a: { trip_id: string; leg_key: string; locked: boolean }) {
    return this.write(ctx, "lock_leg", key, a, async (tx) => {
      requireUser(ctx, "lock or unlock a leg");
      await this.trip(tx, ctx, a.trip_id);
      if (a.locked) await tx.query("INSERT INTO leg_locks (trip_id, leg_key) VALUES ($1,$2) ON CONFLICT DO NOTHING", [a.trip_id, a.leg_key]);
      else await tx.query("DELETE FROM leg_locks WHERE trip_id=$1 AND leg_key=$2", [a.trip_id, a.leg_key]);
      await audit(tx, a.trip_id, a.locked ? "leg_locked" : "leg_unlocked", ctx, "fact", { leg_key: a.leg_key });
      return { leg_key: a.leg_key, locked: a.locked };
    });
  }

  /** Record a booking YOU made on the real site. Adhvaga never books. No PNR field exists. */
  async recordBooking(ctx: Ctx, key: string, a: { trip_id: string; leg_key: string; operator: string; service_no?: string; travel_date: string; price_rupees: string | number; fees?: Array<{ kind: string; rupees: string | number }> }) {
    return this.write(ctx, "record_booking", key, a, async (tx) => {
      const t = await this.trip(tx, ctx, a.trip_id);
      need(t.current_version != null, "NOT_APPROVED", "Approve the plan before recording bookings.");
      const v = await this.version(tx, a.trip_id, t.current_version);
      need(v.legs.some((l) => l.leg_key === a.leg_key), "UNKNOWN_LEG", `Leg ${a.leg_key} is not in the current plan.`);
      for (const f of ["operator", "service_no"] as const) assertNoPii(f, a[f] ?? null);
      need(/^\d{4}-\d{2}-\d{2}$/.test(a.travel_date), "BAD_INPUT", "travel_date must be YYYY-MM-DD");
      const price = parseMoney(a.price_rupees, "price_rupees") as number;
      need(price != null, "BAD_INPUT", "price_rupees is required");
      const fees = (a.fees ?? []).map((f) => {
        need(f.kind && f.kind.length <= 40, "BAD_INPUT", "each fee needs a kind");
        assertNoPii("fee kind", f.kind);
        return { kind: f.kind, paise: parseMoney(f.rupees, `fee ${f.kind}`) as number };
      });
      const feesPaise = sumPaise(fees.map((f) => f.paise));
      const id = randomUUID();
      await tx.query("INSERT INTO bookings (id, trip_id, leg_key, operator, service_no, travel_date, price_paise, fees, fees_paise) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [id, a.trip_id, a.leg_key, a.operator, a.service_no ?? null, a.travel_date, assertPaise(price), JSON.stringify(fees), feesPaise]);
      await audit(tx, a.trip_id, "booking_recorded", ctx, "fact", { leg_key: a.leg_key, price_paise: price, fees_paise: feesPaise, label: "user_entered" });
      return { booking_id: id, leg_key: a.leg_key, paid_paise: price + feesPaise, label: "user_entered" as const };
    });
  }

  /** The operator cancelled or you cancelled on the real site; record the refund you expect. Not counted as cash. */
  async recordRefundPending(ctx: Ctx, key: string, a: { trip_id: string; booking_id: string; refund_rupees: string | number }) {
    return this.write(ctx, "record_refund_pending", key, a, async (tx) => {
      await this.trip(tx, ctx, a.trip_id);
      const amt = parseMoney(a.refund_rupees, "refund_rupees") as number;
      const b = await tx.query<{ price_paise: number; fees_paise: number; state: string }>("SELECT price_paise, fees_paise, state FROM bookings WHERE id=$1 AND trip_id=$2", [a.booking_id, a.trip_id]);
      need(b.rows[0], "NOT_FOUND", "No such booking.");
      need(amt <= Number(b.rows[0].price_paise) + Number(b.rows[0].fees_paise), "BAD_INPUT", "Refund cannot be more than what was paid for this booking.");
      await tx.query("UPDATE bookings SET state='cancelled' WHERE id=$1", [a.booking_id]);
      await tx.query("UPDATE budgets SET refund_pending_paise = refund_pending_paise + $2 WHERE trip_id=$1", [a.trip_id, amt]);
      await audit(tx, a.trip_id, "refund_pending_recorded", ctx, "fact", { booking_id: a.booking_id, refund_paise: amt });
      return { refund_pending_added_paise: amt };
    });
  }

  async markRefundReceived(ctx: Ctx, key: string, a: { trip_id: string; refund_rupees: string | number }) {
    return this.write(ctx, "mark_refund_received", key, a, async (tx) => {
      requireUser(ctx, "mark a refund as received");
      await this.trip(tx, ctx, a.trip_id);
      const amt = parseMoney(a.refund_rupees, "refund_rupees") as number;
      const obs = await this.observations(tx, a.trip_id);
      need(amt <= obs.budget.refund_pending_paise, "BAD_INPUT", "That is more than the refund pending.");
      await tx.query("UPDATE budgets SET refund_pending_paise = refund_pending_paise - $2, refund_received_paise = refund_received_paise + $2 WHERE trip_id=$1", [a.trip_id, amt]);
      await audit(tx, a.trip_id, "refund_received", ctx, "fact", { refund_paise: amt });
      return { refund_received_paise: amt };
    });
  }

  async getBudget(ctx: Ctx, a: { trip_id: string }) {
    const t = await this.trip(this.db, ctx, a.trip_id);
    const obs = await this.observations(this.db, a.trip_id);
    const legs = t.current_version != null ? (await this.version(this.db, a.trip_id, t.current_version)).legs : [];
    const cost = this.costOf(legs, obs);
    const ceiling = obs.budget.hard_ceiling_paise;
    return {
      hard_ceiling_paise: ceiling,
      target_paise: obs.budget.target_paise,
      estimated_paise: sumPaise(legs.map((l) => l.estimated_paise)),
      quoted_paise: sumPaise(legs.map((l) => l.quoted_paise)),
      paid_paise: this.paidNet(obs),
      refund_pending_paise: obs.budget.refund_pending_paise,
      committed_cost_paise: cost,
      headroom_to_ceiling_paise: ceiling == null ? null : ceiling - cost,
      note: "Refund pending is not counted as cash until you mark it received.",
    };
  }

  async getTrip(ctx: Ctx, a: { trip_id: string; version?: number }) {
    const t = await this.trip(this.db, ctx, a.trip_id);
    const versions = await this.db.query<{ number: number; status: string }>("SELECT number, status, parent, reason, created_by FROM versions WHERE trip_id=$1 ORDER BY number", [a.trip_id]);
    const n = a.version ?? t.current_version ?? Number(versions.rows[versions.rows.length - 1].number);
    const v = await this.version(this.db, a.trip_id, n);
    const obs = await this.observations(this.db, a.trip_id);
    const booked = this.bookedKeys(obs);
    const statusBy = new Map(obs.statuses.map((s) => [s.leg_key, s]));
    return {
      trip_id: t.id, title: t.title, rules: t.rules, auto_fix_local: t.auto_fix_local, current_version: t.current_version,
      versions: versions.rows,
      shown_version: n,
      legs: v.legs.map((l) => {
        const s = statusBy.get(l.leg_key);
        return {
          ...l,
          locked: obs.locked.has(l.leg_key),
          booking_state: obs.bookings.find((b) => b.leg_key === l.leg_key)?.state ?? (booked.has(l.leg_key) ? "booked" : "unbooked"),
          status: s ? { ...s, stale: s.label === "live" && Date.now() - ms(s.checked_at) > 15 * 60000 } : null,
        };
      }),
      links: v.links,
      bookings: obs.bookings,
    };
  }

  async checkRulesTool(ctx: Ctx, a: { trip_id: string; version?: number }) {
    const t = await this.trip(this.db, ctx, a.trip_id);
    const n = a.version ?? t.current_version ?? 1;
    const v = await this.version(this.db, a.trip_id, n);
    const obs = await this.observations(this.db, a.trip_id);
    const cost = this.costOf(v.legs, obs);
    const failures = checkRules(v.legs, v.links, { rules: t.rules, cost_paise: cost, hard_ceiling_paise: obs.budget.hard_ceiling_paise });
    if (ctx.role !== "public") await audit(this.db, a.trip_id, "rule_checked", ctx, "system_decision", { version: n, passed: failures.length === 0, failures });
    return { version: n, passed: failures.length === 0, failures, cost_paise: cost };
  }

  /**
   * Rank candidate options found by search tools. Code drops options that break hard rules or preferences,
   * puts simulated options in a separate demo group, and sorts the rest.
   */
  async rankOptions(ctx: Ctx, a: { trip_id: string; replaces?: string[]; preference?: "cheapest" | "fastest" | "fewest_changes"; options: Array<{ option_id: string; legs: LegInput[]; overnight?: boolean; official?: boolean; age_minutes?: number }> }) {
    const t = await this.trip(this.db, ctx, a.trip_id);
    const obs = await this.observations(this.db, a.trip_id);
    const base = t.current_version != null ? await this.version(this.db, a.trip_id, t.current_version) : { legs: [] as PlanLeg[], links: [] as Link[] };
    const replaces = new Set(a.replaces ?? []);
    const kept: PlanLeg[] = base.legs.filter((l) => !replaces.has(l.leg_key));
    const baseKeys = new Set(base.legs.map((l) => l.leg_key));
    // Work out the slot: predecessors of the replaced legs feed the first new leg; successors follow the last.
    const preds = base.links.filter((k) => replaces.has(k.to_leg_key) && !replaces.has(k.from_leg_key)).map((k) => k.from_leg_key);
    const succs = base.links.filter((k) => replaces.has(k.from_leg_key) && !replaces.has(k.to_leg_key)).map((k) => k.to_leg_key);
    const keptLinks = base.links.filter((k) => !replaces.has(k.from_leg_key) && !replaces.has(k.to_leg_key));

    const verified: unknown[] = [];
    const demo: unknown[] = [];
    const dropped: Array<{ option_id: string; codes: string[]; failures: RuleFailure[] }> = [];
    for (const o of a.options) {
      let legs: PlanLeg[];
      try {
        legs = o.legs.map(toPlanLeg);
      } catch (e) {
        dropped.push({ option_id: o.option_id, codes: ["BAD_INPUT"], failures: [{ code: "BAD_TIMES", leg_keys: [], detail: (e as Error).message }] });
        continue;
      }
      if (legs.some((l) => baseKeys.has(l.leg_key) && !replaces.has(l.leg_key))) {
        dropped.push({ option_id: o.option_id, codes: ["BAD_INPUT"], failures: [{ code: "UNKNOWN_LEG", leg_keys: [], detail: "option reuses a leg_key of a kept leg" }] });
        continue;
      }
      const chain: Link[] = [];
      for (let i = 0; i + 1 < legs.length; i++) chain.push({ from_leg_key: legs[i].leg_key, to_leg_key: legs[i + 1].leg_key });
      const links = [...keptLinks, ...chain,
        ...preds.map((p) => ({ from_leg_key: p, to_leg_key: legs[0].leg_key })),
        ...succs.map((s) => ({ from_leg_key: legs[legs.length - 1].leg_key, to_leg_key: s }))];
      const all = [...kept, ...legs];
      const cost = this.costOf(all, obs);
      const failures = checkRules(all, links, { rules: t.rules, cost_paise: cost, hard_ceiling_paise: obs.budget.hard_ceiling_paise });
      const codes = [...new Set(failures.map((f) => f.code as string))];
      if (t.rules.preferences?.avoid_overnight && o.overnight) codes.push("PREFERENCE");
      if (codes.length) {
        dropped.push({ option_id: o.option_id, codes, failures });
        continue;
      }
      const weakest = legs.map((l) => l.label).includes("simulated") ? "simulated" : legs.map((l) => l.label).includes("estimated") ? "estimated" : legs[0].label;
      const conf = confidenceFrom({ label: weakest as Label, source_answered: true, official: o.official ?? false, age_minutes: o.age_minutes ?? null });
      const entry = {
        option_id: o.option_id,
        cost_paise: cost,
        added_cost_paise: sumPaise(legs.map((l) => l.quoted_paise ?? l.estimated_paise ?? 0)),
        arrives_at: legs[legs.length - 1].arrive_at,
        duration_min: Math.round((ms(legs[legs.length - 1].arrive_at) - ms(legs[0].depart_at)) / 60000),
        changes: legs.filter((l) => isTravel(l.kind)).length - 1,
        above_target: obs.budget.target_paise != null && cost > obs.budget.target_paise,
        labels: legs.map((l) => l.label),
        confidence: conf,
        prefers_mode: (t.rules.preferences?.prefer_modes ?? []).some((m) => legs.some((l) => l.kind === m)),
      };
      (weakest === "simulated" ? demo : verified).push(entry);
    }
    type E = { cost_paise: number; duration_min: number; changes: number; prefers_mode: boolean; option_id: string };
    const pref = a.preference ?? "cheapest";
    const cmp = (x: E, y: E) =>
      Number(y.prefers_mode) - Number(x.prefers_mode) ||
      (pref === "fastest" ? x.duration_min - y.duration_min : pref === "fewest_changes" ? x.changes - y.changes : x.cost_paise - y.cost_paise) ||
      x.cost_paise - y.cost_paise || x.duration_min - y.duration_min || x.option_id.localeCompare(y.option_id);
    (verified as E[]).sort(cmp);
    (demo as E[]).sort(cmp);
    if (ctx.role !== "public") {
      for (const d of dropped) await audit(this.db, a.trip_id, "option_dropped", ctx, "system_decision", d);
      if (t.rules.preferences?.prefer_modes?.length || a.preference) await audit(this.db, a.trip_id, "preference_applied", ctx, "system_decision", { preference: pref, prefer_modes: t.rules.preferences?.prefer_modes ?? [] });
    }
    return { ranked: verified, demo_options: demo, dropped, note: demo.length ? "Demo options are simulated and are not bookable." : undefined };
  }

  /**
   * Propose a new version. The approved plan is never edited. Hard rules must pass.
   * Code classifies the change with the permission matrix; anything not automatic waits in the Approvals inbox.
   */
  async proposeVersion(ctx: Ctx, key: string, a: {
    trip_id: string; reason: string; relaxes_preference?: boolean;
    replace?: Array<{ leg_key: string; with: LegInput[] }>; update?: Array<{ leg_key: string; leg: LegInput }>; remove?: string[];
  }) {
    return this.write(ctx, "propose_version", key, a, async (tx) => {
      const t = await this.trip(tx, ctx, a.trip_id);
      need(t.current_version != null, "NOT_APPROVED", "There is no approved plan to change yet.");
      need(a.reason && a.reason.length <= 300, "BAD_INPUT", "reason is required");
      const base = await this.version(tx, a.trip_id, t.current_version);
      let legs = base.legs.map((l) => ({ ...l }));
      let links = base.links.map((l) => ({ ...l }));
      const has = (k: string) => legs.some((l) => l.leg_key === k);

      for (const u of a.update ?? []) {
        need(has(u.leg_key) && u.leg.leg_key === u.leg_key, "UNKNOWN_LEG", `Cannot update ${u.leg_key}`);
        legs = legs.map((l) => (l.leg_key === u.leg_key ? toPlanLeg(u.leg) : l));
      }
      for (const r of a.replace ?? []) {
        need(has(r.leg_key), "UNKNOWN_LEG", `Cannot replace ${r.leg_key}: not in the plan`);
        need(r.with.length > 0, "BAD_INPUT", "replace needs at least one new leg");
        const fresh = r.with.map(toPlanLeg);
        for (const f of fresh) need(!has(f.leg_key) || f.leg_key === r.leg_key, "BAD_INPUT", `leg_key ${f.leg_key} already used`);
        const preds = links.filter((k) => k.to_leg_key === r.leg_key).map((k) => k.from_leg_key);
        const succs = links.filter((k) => k.from_leg_key === r.leg_key).map((k) => k.to_leg_key);
        links = links.filter((k) => k.to_leg_key !== r.leg_key && k.from_leg_key !== r.leg_key);
        legs = legs.filter((l) => l.leg_key !== r.leg_key).concat(fresh);
        for (const p of preds) links.push({ from_leg_key: p, to_leg_key: fresh[0].leg_key });
        for (let i = 0; i + 1 < fresh.length; i++) links.push({ from_leg_key: fresh[i].leg_key, to_leg_key: fresh[i + 1].leg_key });
        for (const s of succs) links.push({ from_leg_key: fresh[fresh.length - 1].leg_key, to_leg_key: s });
      }
      for (const k of a.remove ?? []) {
        need(has(k), "UNKNOWN_LEG", `Cannot remove ${k}`);
        const preds = links.filter((x) => x.to_leg_key === k).map((x) => x.from_leg_key);
        const succs = links.filter((x) => x.from_leg_key === k).map((x) => x.to_leg_key);
        links = links.filter((x) => x.to_leg_key !== k && x.from_leg_key !== k);
        for (const p of preds) for (const s of succs) links.push({ from_leg_key: p, to_leg_key: s });
        legs = legs.filter((l) => l.leg_key !== k);
      }

      const obs = await this.observations(tx, a.trip_id);
      const baseCost = this.costOf(base.legs, obs);
      const cost = this.costOf(legs, obs);
      const failures = checkRules(legs, links, { rules: t.rules, cost_paise: cost, hard_ceiling_paise: obs.budget.hard_ceiling_paise });
      if (failures.length) {
        await audit(tx, a.trip_id, "proposal_rejected_by_rules", ctx, "system_decision", { failures });
        const code = failures.some((f) => f.code === "OVER_CEILING") ? "OVER_CEILING" : "RULES_FAIL";
        throw new ToolError(code, "This proposal breaks a hard rule, so it was not saved.", failures);
      }
      const perm = classify({
        base: { legs: base.legs, links: base.links, cost_paise: baseCost },
        proposed: { legs, links, cost_paise: cost },
        auto_fix_local: t.auto_fix_local, booked: this.bookedKeys(obs), locked: obs.locked,
        target_paise: obs.budget.target_paise, hard_ceiling_paise: obs.budget.hard_ceiling_paise,
        rules_pass: true, relaxes_preference: !!a.relaxes_preference,
      });
      need(perm.permission !== "prohibited", "OVER_CEILING", "This would go over your hard ceiling.");
      need(!perm.reasons.includes("NO_CHANGE"), "BAD_INPUT", "The proposal changes nothing.");

      const removedPaise = sumPaise([...perm.changed, ...perm.removed].map((k) => base.legs.find((l) => l.leg_key === k)).map((l) => {
        if (!l) return 0;
        const b = obs.bookings.filter((x) => x.leg_key === l.leg_key);
        return b.length ? sumPaise(b.map((x) => x.price_paise + x.fees_paise)) : l.quoted_paise ?? l.estimated_paise ?? 0;
      }));
      const addedPaise = sumPaise([...perm.changed, ...perm.added].map((k) => legs.find((l) => l.leg_key === k)).map((l) => (l ? l.quoted_paise ?? l.estimated_paise ?? 0 : 0)));

      const n = await this.nextVersionNumber(tx, a.trip_id);
      await tx.query("INSERT INTO versions (trip_id, number, status, parent, reason, created_by) VALUES ($1,$2,'proposed',$3,$4,$5)", [a.trip_id, n, base.number, a.reason, ctx.role]);
      await this.saveVersionRows(tx, ctx, a.trip_id, n, legs, links);
      const approvalId = randomUUID();
      const summary = {
        changed: perm.changed, added: perm.added, removed: perm.removed,
        kept: legs.filter((l) => !perm.changed.includes(l.leg_key) && !perm.added.includes(l.leg_key)).map((l) => l.leg_key),
        base_cost_paise: baseCost, proposed_cost_paise: cost,
        fare_diff_paise: addedPaise - removedPaise,
        max_arrival_shift_min: perm.max_shift_min,
        if_rejected: `Version ${base.number} stays exactly as it is.`,
        labels: [...new Set(legs.filter((l) => perm.changed.includes(l.leg_key) || perm.added.includes(l.leg_key)).map((l) => l.label))],
      };
      await tx.query("INSERT INTO approvals (id, trip_id, base_version, proposed_version, status, reasons, cost_diff_paise, summary) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7)",
        [approvalId, a.trip_id, base.number, n, JSON.stringify(perm.reasons), perm.cost_diff_paise, JSON.stringify(summary)]);
      await audit(tx, a.trip_id, "version_created", ctx, "system_decision", { version: n, status: "proposed", parent: base.number, permission: perm.permission, reasons: perm.reasons });
      if (perm.permission === "needs_approval") await audit(tx, a.trip_id, "approval_requested", ctx, "system_decision", { approval_id: approvalId, version: n, reasons: perm.reasons });
      return { proposed_version: n, base_version: base.number, approval_id: approvalId, permission: perm.permission, reasons: perm.reasons, cost_diff_paise: perm.cost_diff_paise, ...summary };
    });
  }

  private async applyVersion(tx: Tx, ctx: Ctx, tripId: string, approvalId: string, how: "approved" | "auto") {
    const ap = await tx.query<{ base_version: number; proposed_version: number; status: string }>("SELECT * FROM approvals WHERE id=$1 AND trip_id=$2 FOR UPDATE", [approvalId, tripId]);
    const row = ap.rows[0];
    need(row, "NOT_FOUND", "No such approval.");
    need(row.status === "pending", "ALREADY_DECIDED", `This proposal was already ${row.status}.`);
    const t = await this.trip(tx, ctx, tripId);
    if (t.current_version !== Number(row.base_version)) {
      await tx.query("UPDATE approvals SET status='expired', decided_at=now(), result='plan changed since proposal' WHERE id=$1", [approvalId]);
      await tx.query("UPDATE versions SET status='rejected' WHERE trip_id=$1 AND number=$2", [tripId, row.proposed_version]);
      return { stale: true as const };
    }
    // Re-check hard rules against today's budget and rules before applying.
    const v = await this.version(tx, tripId, Number(row.proposed_version));
    const obs = await this.observations(tx, tripId);
    const cost = this.costOf(v.legs, obs);
    const failures = checkRules(v.legs, v.links, { rules: t.rules, cost_paise: cost, hard_ceiling_paise: obs.budget.hard_ceiling_paise });
    need(!failures.length, failures.some((f) => f.code === "OVER_CEILING") ? "OVER_CEILING" : "RULES_FAIL", "The proposal no longer passes the hard rules.", failures);
    await tx.query("UPDATE versions SET status='superseded' WHERE trip_id=$1 AND number=$2", [tripId, row.base_version]);
    await tx.query("UPDATE versions SET status='approved' WHERE trip_id=$1 AND number=$2", [tripId, row.proposed_version]);
    await tx.query("UPDATE trips SET current_version=$2 WHERE id=$1", [tripId, row.proposed_version]);
    await tx.query("UPDATE approvals SET status='approved', decided_at=now(), result=$2 WHERE id=$1", [approvalId, how === "auto" ? "applied automatically" : "approved by you"]);
    return { stale: false as const, current_version: Number(row.proposed_version), previous_version: Number(row.base_version), cost_paise: cost };
  }

  /** Only you can approve or reject. Rejecting leaves the approved plan untouched. */
  async decideApproval(ctx: Ctx, key: string, a: { trip_id: string; approval_id: string; decision: "approve" | "reject" }) {
    need(a.decision === "approve" || a.decision === "reject", "BAD_INPUT", "decision must be approve or reject");
    return this.write(ctx, "decide_approval", key, a, async (tx) => {
      requireUser(ctx, "approve or reject a change");
      await this.trip(tx, ctx, a.trip_id);
      if (a.decision === "reject") {
        const ap = await tx.query<{ proposed_version: number; status: string }>("SELECT proposed_version, status FROM approvals WHERE id=$1 AND trip_id=$2", [a.approval_id, a.trip_id]);
        need(ap.rows[0], "NOT_FOUND", "No such approval.");
        need(ap.rows[0].status === "pending", "ALREADY_DECIDED", `This proposal was already ${ap.rows[0].status}.`);
        await tx.query("UPDATE approvals SET status='rejected', decided_at=now(), result='rejected by you' WHERE id=$1", [a.approval_id]);
        await tx.query("UPDATE versions SET status='rejected' WHERE trip_id=$1 AND number=$2", [a.trip_id, ap.rows[0].proposed_version]);
        await audit(tx, a.trip_id, "approval_decided", ctx, "fact", { approval_id: a.approval_id, decision: "reject", result: "plan unchanged" });
        return { decision: "reject", result: "Your approved plan is unchanged." };
      }
      const r = await this.applyVersion(tx, ctx, a.trip_id, a.approval_id, "approved");
      if (r.stale) {
        await audit(tx, a.trip_id, "approval_decided", ctx, "fact", { approval_id: a.approval_id, decision: "approve", result: "expired: plan changed since" });
        return { decision: "approve", result: "This proposal is out of date because the plan changed since. Nothing was applied." };
      }
      await audit(tx, a.trip_id, "approval_decided", ctx, "fact", { approval_id: a.approval_id, decision: "approve", result: `version ${r.current_version} is now current` });
      return { decision: "approve", ...r, result: `Version ${r.current_version} is now your plan. Version ${r.previous_version} is kept in history.` };
    });
  }

  /** Apply a proposal ONLY if code re-confirms it is automatic under the permission matrix. */
  async applyAutoFix(ctx: Ctx, key: string, a: { trip_id: string; approval_id: string }) {
    return this.write(ctx, "apply_auto_fix", key, a, async (tx) => {
      const t = await this.trip(tx, ctx, a.trip_id);
      const ap = await tx.query<{ base_version: number; proposed_version: number; status: string }>("SELECT * FROM approvals WHERE id=$1 AND trip_id=$2", [a.approval_id, a.trip_id]);
      need(ap.rows[0], "NOT_FOUND", "No such proposal.");
      const base = await this.version(tx, a.trip_id, Number(ap.rows[0].base_version));
      const prop = await this.version(tx, a.trip_id, Number(ap.rows[0].proposed_version));
      const obs = await this.observations(tx, a.trip_id);
      const perm = classify({
        base: { legs: base.legs, links: base.links, cost_paise: this.costOf(base.legs, obs) },
        proposed: { legs: prop.legs, links: prop.links, cost_paise: this.costOf(prop.legs, obs) },
        auto_fix_local: t.auto_fix_local, booked: this.bookedKeys(obs), locked: obs.locked,
        target_paise: obs.budget.target_paise, hard_ceiling_paise: obs.budget.hard_ceiling_paise, rules_pass: true, relaxes_preference: false,
      });
      need(perm.permission === "automatic", "NEEDS_APPROVAL", "This change needs your approval; it cannot be applied automatically.", perm.reasons);
      const r = await this.applyVersion(tx, ctx, a.trip_id, a.approval_id, "auto");
      need(!r.stale, "STALE_PROPOSAL", "The plan changed since this proposal.");
      await audit(tx, a.trip_id, "auto_fix_applied", ctx, "system_decision", { approval_id: a.approval_id, version: r.current_version, undo: `restore_version ${r.previous_version}` });
      return { ...r, undo: { tool: "restore_version", version: r.previous_version } };
    });
  }

  /** Make an old version current again, as a new version. History is never deleted. */
  async restoreVersion(ctx: Ctx, key: string, a: { trip_id: string; version: number }) {
    return this.write(ctx, "restore_version", key, a, async (tx) => {
      requireUser(ctx, "restore an older version");
      const t = await this.trip(tx, ctx, a.trip_id);
      need(t.current_version != null, "NOT_APPROVED", "No approved plan yet.");
      const old = await this.version(tx, a.trip_id, a.version);
      need(old.status !== "draft", "BAD_INPUT", "Cannot restore a draft.");
      const obs = await this.observations(tx, a.trip_id);
      const cost = this.costOf(old.legs, obs);
      const failures = checkRules(old.legs, old.links, { rules: t.rules, cost_paise: cost, hard_ceiling_paise: obs.budget.hard_ceiling_paise });
      need(!failures.length, failures.some((f) => f.code === "OVER_CEILING") ? "OVER_CEILING" : "RULES_FAIL", "That version breaks a hard rule today.", failures);
      const n = await this.nextVersionNumber(tx, a.trip_id);
      await tx.query("INSERT INTO versions (trip_id, number, status, parent, reason, created_by) VALUES ($1,$2,'approved',$3,$4,$5)", [a.trip_id, n, a.version, `restored from version ${a.version}`, ctx.role]);
      await this.saveVersionRows(tx, ctx, a.trip_id, n, old.legs, old.links);
      await tx.query("UPDATE versions SET status='superseded' WHERE trip_id=$1 AND number=$2", [a.trip_id, t.current_version]);
      await tx.query("UPDATE trips SET current_version=$2 WHERE id=$1", [a.trip_id, n]);
      await audit(tx, a.trip_id, "version_created", ctx, "fact", { version: n, status: "approved", restored_from: a.version });
      return { current_version: n, restored_from: a.version };
    });
  }

  /** Record a leg's status. Real checks come from provider servers; tests use is_test=true. */
  async recordStatus(ctx: Ctx, key: string, a: { trip_id: string; leg_key: string; status: LegStatus["status"]; delay_min?: number; source: string; label: Label; checked_at?: string; is_test?: boolean }) {
    return this.write(ctx, a.is_test ? "inject_test_disruption" : "record_status", key, a, async (tx) => {
      const t = await this.trip(tx, ctx, a.trip_id);
      need(t.current_version != null, "NOT_APPROVED", "No approved plan yet.");
      const v = await this.version(tx, a.trip_id, t.current_version);
      need(v.legs.some((l) => l.leg_key === a.leg_key), "UNKNOWN_LEG", `Leg ${a.leg_key} is not in the current plan.`);
      const allowed = ["scheduled", "delayed", "cancelled", "diverted", "line_closed", "completed", "unknown"];
      need(allowed.includes(a.status), "BAD_INPUT", `status must be one of ${allowed.join(", ")}`);
      const delay = a.delay_min ?? 0;
      need(Number.isInteger(delay) && delay >= 0 && delay <= 2880, "BAD_INPUT", "delay_min must be 0-2880");
      need(!(a.label === "live" && a.is_test), "BAD_INPUT", "A test disruption can never be labelled Live.");
      const checked = a.checked_at ? iso(a.checked_at) : nowIso();
      await tx.query(
        `INSERT INTO leg_status (trip_id, leg_key, status, delay_min, checked_at, source, label, is_test) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (trip_id, leg_key) DO UPDATE SET status=EXCLUDED.status, delay_min=EXCLUDED.delay_min, checked_at=EXCLUDED.checked_at,
           source=EXCLUDED.source, label=EXCLUDED.label, is_test=EXCLUDED.is_test`,
        [a.trip_id, a.leg_key, a.status, delay, checked, a.source, a.label, !!a.is_test]);
      await audit(tx, a.trip_id, a.is_test ? "test_disruption" : "status_recorded", ctx, "fact", { leg_key: a.leg_key, status: a.status, delay_min: delay, label: a.label, source: a.source, is_test: !!a.is_test });
      return { leg_key: a.leg_key, status: a.status, delay_min: delay, checked_at: checked, is_test: !!a.is_test };
    });
  }

  async injectTestDisruption(ctx: Ctx, key: string, a: { trip_id: string; leg_key: string; status?: LegStatus["status"]; delay_min?: number }) {
    return this.recordStatus(ctx, key, { trip_id: a.trip_id, leg_key: a.leg_key, status: a.status ?? (a.delay_min ? "delayed" : "cancelled"), delay_min: a.delay_min, source: "test-disruption", label: "simulated", is_test: true });
  }

  async findAffectedLegs(ctx: Ctx, a: { trip_id: string }) {
    const t = await this.trip(this.db, ctx, a.trip_id);
    need(t.current_version != null, "NOT_APPROVED", "No approved plan yet.");
    const v = await this.version(this.db, a.trip_id, t.current_version);
    const obs = await this.observations(this.db, a.trip_id);
    const r = findAffected(v.legs, v.links, obs.statuses, obs.locked, t.rules.default_min_gap_min ?? DEFAULT_MIN_GAP_MIN);
    if (ctx.role !== "public") await audit(this.db, a.trip_id, "affected_legs_found", ctx, "system_decision", r);
    return { version: v.number, ...r };
  }

  async compareVersions(ctx: Ctx, a: { trip_id: string; a: number; b: number }) {
    await this.trip(this.db, ctx, a.trip_id);
    const va = await this.version(this.db, a.trip_id, a.a);
    const vb = await this.version(this.db, a.trip_id, a.b);
    const obs = await this.observations(this.db, a.trip_id);
    const ka = new Map(va.legs.map((l) => [l.leg_key, l]));
    const kb = new Map(vb.legs.map((l) => [l.leg_key, l]));
    const changed: string[] = [], kept: string[] = [], onlyA: string[] = [], onlyB: string[] = [];
    for (const [k, l] of ka) {
      const m = kb.get(k);
      if (!m) onlyA.push(k);
      else if (JSON.stringify(l) === JSON.stringify(m)) kept.push(k);
      else changed.push(k);
    }
    for (const k of kb.keys()) if (!ka.has(k)) onlyB.push(k);
    const lastArr = (ls: PlanLeg[]) => ls.filter((l) => isTravel(l.kind)).map((l) => l.arrive_at).sort().pop() ?? null;
    return {
      a: { version: va.number, status: va.status, cost_paise: this.costOf(va.legs, obs), last_arrival: lastArr(va.legs), legs: va.legs },
      b: { version: vb.number, status: vb.status, cost_paise: this.costOf(vb.legs, obs), last_arrival: lastArr(vb.legs), legs: vb.legs },
      kept, changed, removed: onlyA, added: onlyB,
    };
  }

  async listApprovals(ctx: Ctx, a: { trip_id: string; status?: string }) {
    await this.trip(this.db, ctx, a.trip_id);
    const r = await this.db.query<Record<string, unknown>>(
      "SELECT id, base_version, proposed_version, status, reasons, cost_diff_paise, summary, created_at, decided_at, result FROM approvals WHERE trip_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at",
      [a.trip_id, a.status ?? null]);
    return r.rows.map((x) => ({ ...x, cost_diff_paise: Number(x.cost_diff_paise), created_at: iso(x.created_at), decided_at: x.decided_at ? iso(x.decided_at) : null }));
  }

  async eventLog(ctx: Ctx, a: { trip_id: string; after_id?: number }) {
    await this.trip(this.db, ctx, a.trip_id);
    const r = await this.db.query<Record<string, unknown>>("SELECT id, at, event, actor, nature, detail FROM audit_log WHERE trip_id=$1 AND id > $2 ORDER BY id", [a.trip_id, a.after_id ?? 0]);
    return r.rows.map((x) => ({ id: Number(x.id), at: iso(x.at), event: String(x.event), actor: String(x.actor), nature: String(x.nature), detail: x.detail as Record<string, unknown> }));
  }

  async deleteTrip(ctx: Ctx, key: string, a: { trip_id: string }) {
    return this.write(ctx, "delete_trip", key, a, async (tx) => {
      requireUser(ctx, "delete a trip");
      await this.trip(tx, ctx, a.trip_id);
      await tx.query("DELETE FROM audit_log WHERE trip_id=$1", [a.trip_id]);
      await tx.query("DELETE FROM trips WHERE id=$1", [a.trip_id]);
      await audit(tx, null, "trip_deleted", ctx, "fact", {});
      return { deleted: true };
    });
  }

  /** Auto-delete trips 30 days after they end (plan section 15). */
  async purgeExpired(): Promise<number> {
    const r = await this.db.query<{ id: string }>("DELETE FROM trips WHERE trip_end_date IS NOT NULL AND trip_end_date < (now() - interval '30 days')::date RETURNING id");
    return r.rows.length;
  }
}

function rowToLeg(r: Record<string, unknown>): PlanLeg {
  return {
    leg_key: String(r.leg_key), kind: r.kind as LegKind, from_name: String(r.from_name), to_name: String(r.to_name),
    depart_at: iso(r.depart_at), arrive_at: iso(r.arrive_at), operator: (r.operator as string) ?? null, service_no: (r.service_no as string) ?? null,
    source: String(r.source), label: r.label as Label, min_gap_after_min: num(r.min_gap_after_min),
    estimated_paise: num(r.estimated_paise), quoted_paise: num(r.quoted_paise), quoted_source: (r.quoted_source as string) ?? null,
    quoted_at: r.quoted_at ? iso(r.quoted_at) : null,
  };
}

export function validateRules(r: TripRules): TripRules {
  const out: TripRules = {};
  if (r.arrive_by) {
    try { ms(r.arrive_by.at); } catch { throw new ToolError("BAD_INPUT", "arrive_by.at must be an ISO date-time"); }
    out.arrive_by = { at: new Date(ms(r.arrive_by.at)).toISOString(), ...(r.arrive_by.leg_key ? { leg_key: r.arrive_by.leg_key } : {}) };
  }
  if (r.no_arrival_after_local) {
    need(/^([01]\d|2[0-3]):[0-5]\d$/.test(r.no_arrival_after_local), "BAD_INPUT", "no_arrival_after_local must be HH:MM");
    out.no_arrival_after_local = r.no_arrival_after_local;
  }
  if (r.default_min_gap_min != null) {
    need(Number.isInteger(r.default_min_gap_min) && r.default_min_gap_min >= 0 && r.default_min_gap_min <= 600, "BAD_INPUT", "default_min_gap_min must be 0-600");
    out.default_min_gap_min = r.default_min_gap_min;
  }
  if (r.preferences) {
    out.preferences = {};
    if (r.preferences.avoid_overnight != null) out.preferences.avoid_overnight = !!r.preferences.avoid_overnight;
    if (r.preferences.prefer_modes) {
      for (const m of r.preferences.prefer_modes) need((LEG_KINDS as readonly string[]).includes(m), "BAD_INPUT", `unknown mode ${m}`);
      out.preferences.prefer_modes = r.preferences.prefer_modes;
    }
  }
  return out;
}
