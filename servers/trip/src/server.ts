// Adhvaga Trip MCP server. Thin layer: validates tool input, maps the caller to a role, wraps answers in the envelope.
// Prohibited actions (book, pay, cancel a real booking, file a claim, store card details) have NO tool here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openPglite } from "./db.ts";
import { ToolError, fail, ok } from "./envelope.ts";
import type { Envelope } from "./envelope.ts";
import type { Ctx } from "./service.ts";
import { TripService } from "./service.ts";
import { LEG_KINDS } from "./types.ts";

const money = z.union([z.string(), z.number()]).describe('Rupees, e.g. "755" or "333.33"');
const key = z.string().min(8).max(100).describe("New one-time key for this change (prevents duplicates on retry)");
const tripId = z.string().describe("Trip id");
const label = z.enum(["live", "timetable", "estimated", "simulated", "user_entered", "unavailable"]);
const leg = z.object({
  leg_key: z.string().describe("Stable leg id, e.g. L1"),
  kind: z.enum(LEG_KINDS),
  from_name: z.string(),
  to_name: z.string(),
  depart_at: z.string().describe("ISO date-time with offset; start for stay/activity"),
  arrive_at: z.string().describe("ISO date-time with offset; end for stay/activity"),
  operator: z.string().nullish(),
  service_no: z.string().nullish(),
  source: z.string(),
  label,
  min_gap_after_min: z.number().int().nullish(),
  estimated_rupees: money.nullish(),
  quoted_rupees: money.nullish(),
  quoted_source: z.string().nullish(),
  quoted_at: z.string().nullish(),
});
const rules = z.object({
  arrive_by: z.object({ at: z.string(), leg_key: z.string().optional() }).nullish(),
  no_arrival_after_local: z.string().nullish(),
  default_min_gap_min: z.number().int().optional(),
  preferences: z.object({ avoid_overnight: z.boolean().optional(), prefer_modes: z.array(z.enum(LEG_KINDS)).optional() }).optional(),
});

type Handler = (ctx: Ctx, args: any) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ToolDef {
  name: string;
  kind: "read" | "write";
  description: string;
  shape: z.ZodRawShape;
  run: Handler;
}

export function toolDefs(svc: TripService): ToolDef[] {
  const w = (name: string, description: string, shape: z.ZodRawShape, run: Handler): ToolDef => ({ name, kind: "write", description, shape: { idempotency_key: key, ...shape }, run });
  const r = (name: string, description: string, shape: z.ZodRawShape, run: Handler): ToolDef => ({ name, kind: "read", description, shape, run });
  return [
    w("create_trip", "Create a trip with its rules and budget. Starts a draft plan (version 1).",
      { title: z.string(), trip_end_date: z.string().optional(), rules: rules.optional(), hard_ceiling_rupees: money.optional(), target_rupees: money.optional() },
      (c, a) => svc.createTrip(c, a.idempotency_key, a)),
    w("set_budget", "USER ONLY. Change the hard ceiling or target.", { trip_id: tripId, hard_ceiling_rupees: money.optional(), target_rupees: money.optional() },
      (c, a) => svc.setBudget(c, a.idempotency_key, a)),
    w("set_rules", "Set trip rules (arrive-by, no late-night arrival, minimum gaps, preferences). After approval: user only.", { trip_id: tripId, rules },
      (c, a) => svc.setRules(c, a.idempotency_key, a)),
    w("set_auto_fix", "USER ONLY. Allow Adhvaga to fix free local legs by itself.", { trip_id: tripId, enabled: z.boolean() },
      (c, a) => svc.setAutoFix(c, a.idempotency_key, a)),
    w("add_leg", "Add a leg to the draft plan.", { trip_id: tripId, leg }, (c, a) => svc.addLeg(c, a.idempotency_key, a)),
    w("link_legs", "Say that one leg depends on another (draft only). Circles are refused.", { trip_id: tripId, from_leg_key: z.string(), to_leg_key: z.string() },
      (c, a) => svc.linkLegs(c, a.idempotency_key, a)),
    w("remove_leg", "Remove a leg from the draft plan.", { trip_id: tripId, leg_key: z.string() }, (c, a) => svc.removeLeg(c, a.idempotency_key, a)),
    w("approve_plan", "USER ONLY. Make the draft the approved plan. Hard rules must pass.", { trip_id: tripId }, (c, a) => svc.approvePlan(c, a.idempotency_key, a)),
    w("lock_leg", "USER ONLY. Lock or unlock a leg so the system keeps it.", { trip_id: tripId, leg_key: z.string(), locked: z.boolean() },
      (c, a) => svc.lockLeg(c, a.idempotency_key, a)),
    w("record_booking", "Record a booking YOU made on the real site (operator, number, date, price). Adhvaga never books. Do not include PNR, names or phone numbers.",
      { trip_id: tripId, leg_key: z.string(), operator: z.string(), service_no: z.string().optional(), travel_date: z.string(), price_rupees: money, fees: z.array(z.object({ kind: z.string(), rupees: money })).optional() },
      (c, a) => svc.recordBooking(c, a.idempotency_key, a)),
    w("record_refund_pending", "Record a refund you expect for a booking. It is never counted as cash until received.", { trip_id: tripId, booking_id: z.string(), refund_rupees: money },
      (c, a) => svc.recordRefundPending(c, a.idempotency_key, a)),
    w("mark_refund_received", "USER ONLY. Mark refund money as received.", { trip_id: tripId, refund_rupees: money }, (c, a) => svc.markRefundReceived(c, a.idempotency_key, a)),
    w("propose_version", "Propose a new version of the approved plan (replace / update / remove legs). The approved plan is never edited. Returns permission: automatic or needs_approval.",
      { trip_id: tripId, reason: z.string(), relaxes_preference: z.boolean().optional(), replace: z.array(z.object({ leg_key: z.string(), with: z.array(leg) })).optional(), update: z.array(z.object({ leg_key: z.string(), leg })).optional(), remove: z.array(z.string()).optional() },
      (c, a) => svc.proposeVersion(c, a.idempotency_key, a)),
    w("decide_approval", "USER ONLY. Approve or reject a proposed version.", { trip_id: tripId, approval_id: z.string(), decision: z.enum(["approve", "reject"]) },
      (c, a) => svc.decideApproval(c, a.idempotency_key, a)),
    w("apply_auto_fix", "Apply a proposal only if code confirms it is automatic under the permission matrix. Returns an undo.", { trip_id: tripId, approval_id: z.string() },
      (c, a) => svc.applyAutoFix(c, a.idempotency_key, a)),
    w("restore_version", "USER ONLY. Make an older version current again (saved as a new version).", { trip_id: tripId, version: z.number().int() },
      (c, a) => svc.restoreVersion(c, a.idempotency_key, a)),
    w("record_status", "Record a leg status from a provider check (Check now).",
      { trip_id: tripId, leg_key: z.string(), status: z.enum(["scheduled", "delayed", "cancelled", "diverted", "line_closed", "completed", "unknown"]), delay_min: z.number().int().optional(), source: z.string(), label, checked_at: z.string().optional() },
      (c, a) => svc.recordStatus(c, a.idempotency_key, { ...a, is_test: false })),
    w("inject_test_disruption", "Demo/test only: mark a leg cancelled, closed or late. Always labelled as a test.",
      { trip_id: tripId, leg_key: z.string(), status: z.enum(["delayed", "cancelled", "diverted", "line_closed"]).optional(), delay_min: z.number().int().optional() },
      (c, a) => svc.injectTestDisruption(c, a.idempotency_key, a)),
    w("delete_trip", "USER ONLY. Delete this trip and everything saved about it.", { trip_id: tripId }, (c, a) => svc.deleteTrip(c, a.idempotency_key, a)),

    r("get_trip", "Get a trip: legs with label, status and fetch time, lock and booking state; links; versions.", { trip_id: tripId, version: z.number().int().optional() }, (c, a) => svc.getTrip(c, a)),
    r("get_budget", "The six budget fields plus committed cost and headroom. Refund pending is not cash.", { trip_id: tripId }, (c, a) => svc.getBudget(c, a)),
    r("check_rules", "Check a version against the hard rules.", { trip_id: tripId, version: z.number().int().optional() }, (c, a) => svc.checkRulesTool(c, a)),
    r("rank_options", "Rank candidate options from search tools. Code drops rule-breaking options with reasons; simulated options go to demo_options.",
      { trip_id: tripId, replaces: z.array(z.string()).optional(), preference: z.enum(["cheapest", "fastest", "fewest_changes"]).optional(), options: z.array(z.object({ option_id: z.string(), legs: z.array(leg), overnight: z.boolean().optional(), official: z.boolean().optional(), age_minutes: z.number().optional() })) },
      (c, a) => svc.rankOptions(c, a)),
    r("find_affected_legs", "After a disruption: which legs are broken, delayed, at risk, locked-and-kept, unaffected.", { trip_id: tripId }, (c, a) => svc.findAffectedLegs(c, a)),
    r("compare_versions", "Compare two versions: kept, changed, removed, added legs; cost and last arrival.", { trip_id: tripId, a: z.number().int(), b: z.number().int() }, (c, a) => svc.compareVersions(c, a)),
    r("list_approvals", "Approvals inbox.", { trip_id: tripId, status: z.enum(["pending", "approved", "rejected", "expired"]).optional() }, (c, a) => svc.listApprovals(c, a)),
    r("get_event_log", "Event log of real system events (facts, system decisions). No private AI thinking.", { trip_id: tripId, after_id: z.number().int().optional() }, (c, a) => svc.eventLog(c, a)),
  ];
}

export async function runTool(def: ToolDef, ctx: Ctx, args: unknown): Promise<Envelope> {
  const parsed = z.object(def.shape).safeParse(args);
  if (!parsed.success) return fail("BAD_INPUT", "Input does not match the tool schema.", parsed.error.issues);
  try {
    return ok(await def.run(ctx, parsed.data));
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.message, e.details);
    return fail("INTERNAL", "The trip server hit an error. Nothing was saved.");
  }
}

export function buildServer(svc: TripService, ctxFor: () => Ctx): McpServer {
  const server = new McpServer({ name: "adhvaga-trip", version: "0.1.0" });
  for (const def of toolDefs(svc)) {
    server.registerTool(def.name, {
      description: `[${def.kind === "write" ? "CHANGES SAVED DATA - needs the secret pass" : "read"}] ${def.description}`,
      inputSchema: def.shape,
      annotations: { readOnlyHint: def.kind === "read", idempotentHint: true, openWorldHint: false },
    }, async (args: unknown) => {
      const env = await runTool(def, ctxFor(), args);
      return { content: [{ type: "text" as const, text: JSON.stringify(env, null, 1) }], isError: env.status === "error" };
    });
  }
  return server;
}

/** Local stdio mode for Claude Code. Role comes from the environment; default is read-only. */
async function main() {
  const svc = new TripService(await openPglite(process.env.ADHVAGA_PGLITE_DIR || undefined));
  const role = (process.env.ADHVAGA_STDIO_ROLE ?? "public") as Ctx["role"];
  if (!["public", "agent", "user"].includes(role)) throw new Error("ADHVAGA_STDIO_ROLE must be public, agent or user");
  const session = process.env.ADHVAGA_SESSION ?? "local-claude-code";
  const server = buildServer(svc, () => ({ session, role }));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() as string)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
