// Phase 1 code checks, named after the Phase 0 test-case IDs (specs/adhvaga-tests-v1.json).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { L1, L2, L2b, L3, ctxFor, expectCode, golden, k, service, snapshot, t } from "./fixtures.ts";

const metroAlt = (delayMin: number, label: "timetable" | "estimated" = "timetable", rupees = "20") => ({
  leg_key: "L1x", kind: "metro" as const, from_name: "Rajiv Chowk", to_name: "New Delhi (via Kashmere Gate)",
  depart_at: t("05:10"), arrive_at: new Date(Date.parse(t("05:20")) + delayMin * 60000).toISOString(),
  operator: "DMRC", service_no: "Red + Yellow", source: "delhi-metro-gtfs", label, min_gap_after_min: 15, estimated_rupees: rupees,
});

describe("Group 1 - planning", () => {
  test("T01-12 plan saved as approved v1 with linked legs", async () => {
    const g = await golden();
    const trip = await g.svc.getTrip(g.ctx, { trip_id: g.trip });
    assert.equal(trip.current_version, 1);
    assert.equal(trip.versions[0].status, "approved");
    assert.deepEqual(trip.links.map((l) => `${l.from_leg_key}>${l.to_leg_key}`).sort(), ["L1>L2", "L2>L3"]);
  });
});

describe("Group 2 - disruptions (code part)", () => {
  test("T02-01 / golden G7-G10: cancelled train -> proposed v2, v1 unchanged", async () => {
    const g = await golden({ book: true });
    const before = await snapshot(g, 1);
    await g.svc.injectTestDisruption(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", status: "cancelled" });
    const aff = await g.svc.findAffectedLegs(g.ctx, { trip_id: g.trip });
    assert.deepEqual(aff.broken, ["L2"]);
    assert.deepEqual(aff.kept_locked, ["L3"]);
    assert.deepEqual(aff.unaffected, ["L1"]);
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    assert.equal(p.permission, "needs_approval");
    assert.ok(p.reasons.includes("CHANGES_BOOKED_LEG"));
    assert.equal(await snapshot(g, 1), before);
    const trip = await g.svc.getTrip(g.ctx, { trip_id: g.trip });
    assert.equal(trip.current_version, 1);
    assert.equal(trip.versions.find((v) => v.number === 2)?.status, "proposed");
  });

  test("T02-06 metro closure, free alternative within 15 min, auto box ticked -> automatic, undo offered", async () => {
    const g = await golden({ autoFix: true });
    await g.svc.injectTestDisruption(g.ctx, k(), { trip_id: g.trip, leg_key: "L1", status: "line_closed" });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "Yellow line closed", replace: [{ leg_key: "L1", with: [metroAlt(10)] }] });
    assert.equal(p.permission, "automatic", JSON.stringify(p.reasons));
    const r = await g.svc.applyAutoFix(g.ctx, k(), { trip_id: g.trip, approval_id: p.approval_id });
    assert.equal(r.current_version, 2);
    assert.deepEqual(r.undo, { tool: "restore_version", version: 1 });
    const log = await g.svc.eventLog(g.ctx, { trip_id: g.trip });
    assert.ok(log.some((e) => e.event === "auto_fix_applied"));
  });

  test("T02-07 metro alternative adds 25 min -> needs approval", async () => {
    const g = await golden({ autoFix: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "Yellow line closed", replace: [{ leg_key: "L1", with: [{ ...metroAlt(25), min_gap_after_min: 10 }] }] });
    assert.equal(p.permission, "needs_approval");
    assert.ok(p.reasons.includes("ARRIVAL_SHIFT_OVER_15_MIN"), JSON.stringify(p.reasons));
    await expectCode(g.svc.applyAutoFix(g.ctx, k(), { trip_id: g.trip, approval_id: p.approval_id }), "NEEDS_APPROVAL");
  });

  test("T02-08 replacement costs Rs 150 more in fare; cash view keeps refund pending out", async () => {
    const g = await golden({ book: true });
    const b = (await g.svc.getTrip(g.ctx, { trip_id: g.trip })).bookings[0];
    await g.svc.recordRefundPending(g.ctx, k(), { trip_id: g.trip, booking_id: b.id, refund_rupees: "755" });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    assert.equal(p.fare_diff_paise, 15000);
    assert.equal(p.cost_diff_paise, 90500); // you still need to pay Rs 905 now; the Rs 755 refund is not cash yet
    assert.ok(p.reasons.includes("COSTS_MORE"));
    assert.ok(p.reasons.includes("ABOVE_TARGET"));
  });

  test("T02-10 two disruptions at once: L1 closed, L2 90 min late", async () => {
    const g = await golden();
    await g.svc.injectTestDisruption(g.ctx, k(), { trip_id: g.trip, leg_key: "L1", status: "line_closed" });
    await g.svc.injectTestDisruption(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", delay_min: 90 });
    const aff = await g.svc.findAffectedLegs(g.ctx, { trip_id: g.trip });
    assert.deepEqual(aff.broken, ["L1"]);
    assert.deepEqual(aff.at_risk, ["L2"]);
    assert.deepEqual(aff.kept_locked, ["L3"]);
  });

  test("T02-11 test disruption is labelled as a test, never Live", async () => {
    const g = await golden();
    const r = await g.svc.injectTestDisruption(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", status: "cancelled" });
    assert.equal(r.is_test, true);
    const log = await g.svc.eventLog(g.ctx, { trip_id: g.trip });
    const ev = log.find((e) => e.event === "test_disruption");
    assert.ok(ev);
    assert.equal((ev.detail as { label: string }).label, "simulated");
    await expectCode(g.svc.recordStatus(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", status: "cancelled", source: "x", label: "live", is_test: true }), "BAD_INPUT");
  });

  test("T02-12 replacement keeps the locked hotel exactly", async () => {
    const g = await golden({ book: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    const cmp = await g.svc.compareVersions(g.ctx, { trip_id: g.trip, a: 1, b: p.proposed_version });
    assert.ok(cmp.kept.includes("L3"));
    assert.ok(cmp.kept.includes("L1"));
    assert.deepEqual(cmp.removed, ["L2"]);
    assert.deepEqual(cmp.added, ["L2b"]);
  });

  test("T02-13 diverted train: L2 broken, locked hotel kept", async () => {
    const g = await golden();
    await g.svc.injectTestDisruption(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", status: "diverted" });
    const aff = await g.svc.findAffectedLegs(g.ctx, { trip_id: g.trip });
    assert.deepEqual(aff.broken, ["L2"]);
    assert.deepEqual(aff.kept_locked, ["L3"]);
  });

  test("T02-14 reject v2 keeps v1 byte-identical", async () => {
    const g = await golden({ book: true });
    const before = await snapshot(g, 1);
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    const r = await g.svc.decideApproval(g.ctx, k(), { trip_id: g.trip, approval_id: p.approval_id, decision: "reject" });
    assert.equal(r.decision, "reject");
    assert.equal(await snapshot(g, 1), before);
    const trip = await g.svc.getTrip(g.ctx, { trip_id: g.trip });
    assert.equal(trip.current_version, 1);
    assert.equal(trip.versions.find((v) => v.number === 2)?.status, "rejected");
  });

  test("Golden G12b approve: v2 current, v1 kept, audit written", async () => {
    const g = await golden({ book: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    const r = await g.svc.decideApproval(g.ctx, k(), { trip_id: g.trip, approval_id: p.approval_id, decision: "approve" });
    assert.ok("current_version" in r && r.current_version === 2);
    const trip = await g.svc.getTrip(g.ctx, { trip_id: g.trip });
    assert.equal(trip.versions.find((v) => v.number === 1)?.status, "superseded");
    const log = await g.svc.eventLog(g.ctx, { trip_id: g.trip });
    assert.ok(log.some((e) => e.event === "approval_decided"));
  });
});

describe("Group 3 - hard rules", () => {
  test("T03-03 gap below minimum is rejected with GAP_TOO_SHORT", async () => {
    const svc = await service();
    const ctx = ctxFor();
    const { trip_id } = await svc.createTrip(ctx, k(), { title: "Gap test", rules: { default_min_gap_min: 30 } });
    await svc.addLeg(ctx, k(), { trip_id, leg: { ...L1, arrive_at: t("10:50"), depart_at: t("10:40"), min_gap_after_min: 30 } });
    await svc.addLeg(ctx, k(), { trip_id, leg: { ...L2, depart_at: t("11:00"), arrive_at: t("15:00") } });
    await svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L1", to_leg_key: "L2" });
    await expectCode(svc.approvePlan(ctx, k(), { trip_id }), "RULES_FAIL");
    const log = await svc.eventLog(ctx, { trip_id });
    const rej = log.find((e) => e.event === "write_rejected");
    assert.ok(rej && JSON.stringify(rej.detail).includes("GAP_TOO_SHORT"));
  });

  test("T03-04 arrive-by deadline enforced in ranking", async () => {
    const g = await golden();
    const late = { ...L2b, leg_key: "Lx", depart_at: t("09:30"), arrive_at: t("14:30") };
    const r = await g.svc.rankOptions(g.ctx, { trip_id: g.trip, replaces: ["L2"], options: [{ option_id: "ok", legs: [L2b] }, { option_id: "late", legs: [late] }] });
    assert.deepEqual(r.ranked.map((x) => (x as { option_id: string }).option_id), ["ok"]);
    assert.ok(r.dropped.find((d) => d.option_id === "late")?.codes.includes("ARRIVES_LATE"));
    const log = await g.svc.eventLog(g.ctx, { trip_id: g.trip });
    assert.ok(log.some((e) => e.event === "option_dropped"));
  });

  test("T03-05 late-night arrivals dropped", async () => {
    const svc = await service();
    const ctx = ctxFor();
    const { trip_id } = await svc.createTrip(ctx, k(), { title: "Night", rules: { no_arrival_after_local: "23:00" } });
    const r = await svc.rankOptions(ctx, { trip_id, options: [
      { option_id: "night", legs: [{ ...L2, depart_at: t("19:00"), arrive_at: t("23:40") }] },
      { option_id: "early", legs: [{ ...L2, depart_at: t("00:30"), arrive_at: t("04:10") }] },
      { option_id: "day", legs: [L2] },
    ] });
    assert.deepEqual(r.ranked.map((x) => (x as { option_id: string }).option_id), ["day"]);
    assert.ok(r.dropped.every((d) => d.codes.includes("LATE_NIGHT")));
  });

  test("T03-06 proposal above ceiling is refused and nothing is saved", async () => {
    const g = await golden({ ceiling: "2600", target: "2600" });
    const pricey = { ...L2b, estimated_rupees: "1500" };
    await expectCode(g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "upgrade", replace: [{ leg_key: "L2", with: [pricey] }] }), "OVER_CEILING");
    const trip = await g.svc.getTrip(g.ctx, { trip_id: g.trip });
    assert.equal(trip.versions.length, 1);
  });

  test("T03-07 the assistant cannot raise the ceiling", async () => {
    const g = await golden();
    const agent = { ...g.ctx, role: "agent" as const };
    await expectCode(g.svc.setBudget(agent, k(), { trip_id: g.trip, hard_ceiling_rupees: "9000" }), "USER_ONLY");
    const b = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    assert.equal(b.hard_ceiling_paise, 400000);
  });

  test("T03-08 circular leg links refused", async () => {
    const svc = await service();
    const ctx = ctxFor();
    const { trip_id } = await svc.createTrip(ctx, k(), { title: "Cycle" });
    for (const leg of [L1, L2, L3]) await svc.addLeg(ctx, k(), { trip_id, leg });
    await svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L1", to_leg_key: "L2" });
    await svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L2", to_leg_key: "L3" });
    await expectCode(svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L3", to_leg_key: "L1" }), "CYCLE");
  });

  test("T03-09 leg that ends before it starts -> BAD_INPUT", async () => {
    const svc = await service();
    const ctx = ctxFor();
    const { trip_id } = await svc.createTrip(ctx, k(), { title: "Bad" });
    await expectCode(svc.addLeg(ctx, k(), { trip_id, leg: { ...L1, depart_at: t("10:00"), arrive_at: t("09:00") } }), "BAD_INPUT");
  });
});

describe("Group 5 - budget maths", () => {
  test("T05-01 six budget fields present, refund pending 0", async () => {
    const g = await golden();
    const b = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    for (const f of ["hard_ceiling_paise", "target_paise", "estimated_paise", "quoted_paise", "paid_paise", "refund_pending_paise"]) assert.ok(f in b, f);
    assert.equal(b.hard_ceiling_paise, 400000);
    assert.equal(b.target_paise, 300000);
    assert.equal(b.refund_pending_paise, 0);
    assert.equal(b.estimated_paise, 2000 + 75500 + 180000);
  });

  test("T05-02 refund pending is not counted as cash", async () => {
    const g = await golden({ book: true });
    const bk = (await g.svc.getTrip(g.ctx, { trip_id: g.trip })).bookings[0];
    const before = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    await g.svc.recordRefundPending(g.ctx, k(), { trip_id: g.trip, booking_id: bk.id, refund_rupees: "755" });
    const after = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    assert.equal(after.refund_pending_paise, 75500);
    assert.equal(after.paid_paise, 75500);
    assert.equal(after.headroom_to_ceiling_paise, before.headroom_to_ceiling_paise);
  });

  test("T05-03 refund marked received: pending 0, paid reduced by 755", async () => {
    const g = await golden({ book: true });
    const bk = (await g.svc.getTrip(g.ctx, { trip_id: g.trip })).bookings[0];
    await g.svc.recordRefundPending(g.ctx, k(), { trip_id: g.trip, booking_id: bk.id, refund_rupees: "755" });
    await g.svc.markRefundReceived(g.ctx, k(), { trip_id: g.trip, refund_rupees: "755" });
    const b = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    assert.equal(b.refund_pending_paise, 0);
    assert.equal(b.paid_paise, 0);
  });

  test("T05-04 fees and baggage counted: 4200 + 350 + 600 = 5150", async () => {
    const g = await golden({ ceiling: "20000", target: "20000" });
    await g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", operator: "Airline", travel_date: "2026-11-20", price_rupees: "4200", fees: [{ kind: "convenience fee", rupees: "350" }, { kind: "baggage", rupees: "600" }] });
    const b = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    assert.equal(b.paid_paise, 515000);
  });

  test("T05-05 paise maths has no rounding drift: 3 x 333.33 = 999.99", async () => {
    const g = await golden();
    for (const leg of ["L1", "L2", "L3"]) await g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: leg, operator: "X", travel_date: "2026-11-20", price_rupees: "333.33" });
    const b = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    assert.equal(b.paid_paise, 99999);
  });

  test("T05-06 cost diff of a proposal: unbooked L2 755 -> 905 = +150", async () => {
    const g = await golden();
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "swap", replace: [{ leg_key: "L2", with: [L2b] }] });
    assert.equal(p.cost_diff_paise, 15000);
    assert.equal(p.fare_diff_paise, 15000);
  });

  test("T05-07 negative amount rejected", async () => {
    const g = await golden();
    await expectCode(g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", operator: "IR", travel_date: "2026-11-20", price_rupees: "-50" }), "BAD_INPUT");
    await expectCode(g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", operator: "IR", travel_date: "2026-11-20", price_rupees: "10.555" }), "BAD_INPUT");
  });

  test("T05-09 estimated and paid kept separate", async () => {
    const g = await golden();
    await g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", operator: "IR", travel_date: "2026-11-20", price_rupees: "755" });
    const b = await g.svc.getBudget(g.ctx, { trip_id: g.trip });
    assert.equal(b.paid_paise, 75500);
    assert.equal(b.estimated_paise, 257500);
  });

  test("T05-10 duplicate booking write with same one-time key is saved once", async () => {
    const g = await golden();
    const key = k();
    const args = { trip_id: g.trip, leg_key: "L2", operator: "IR", travel_date: "2026-11-20", price_rupees: "755" };
    const a = await g.svc.recordBooking(g.ctx, key, args);
    const b = await g.svc.recordBooking(g.ctx, key, args);
    assert.deepEqual(a, b);
    assert.equal((await g.svc.getBudget(g.ctx, { trip_id: g.trip })).paid_paise, 75500);
  });
});

describe("Group 7 - failures (Trip server)", () => {
  test("T07-07 write retried with the same key after a lost response is saved once", async () => {
    const g = await golden();
    const key = k();
    const args = { trip_id: g.trip, leg_key: "L2", operator: "IR", travel_date: "2026-11-20", price_rupees: "755" };
    await g.svc.recordBooking(g.ctx, key, args); // response "lost"
    await g.svc.recordBooking(g.ctx, key, args); // client retries with the same key
    assert.equal((await g.svc.getBudget(g.ctx, { trip_id: g.trip })).paid_paise, 75500);
  });

  test("T07-10 database fails mid-save -> nothing saved (all-or-nothing)", async () => {
    const g = await golden();
    const before = await snapshot(g, 1);
    const faulty = { ...g.ctx, faults: { propose_fail_after_legs: 2 } };
    await assert.rejects(g.svc.proposeVersion(faulty, k(), { trip_id: g.trip, reason: "swap", replace: [{ leg_key: "L2", with: [L2b] }] }), /INJECTED_DB_FAULT/);
    const trip = await g.svc.getTrip(g.ctx, { trip_id: g.trip });
    assert.equal(trip.versions.length, 1);
    assert.equal(await snapshot(g, 1), before);
    assert.equal((await g.svc.listApprovals(g.ctx, { trip_id: g.trip })).length, 0);
  });
});

describe("Group 8 - approvals and permissions", () => {
  test("T08-01 paid change needs approval and is not applied", async () => {
    const g = await golden({ autoFix: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "swap", replace: [{ leg_key: "L1", with: [metroAlt(5, "timetable", "40")] }] });
    assert.equal(p.permission, "needs_approval");
    assert.ok(p.reasons.includes("COSTS_MORE"));
    assert.equal((await g.svc.getTrip(g.ctx, { trip_id: g.trip })).current_version, 1);
  });

  test("T08-02 free local fix still needs approval when the auto box is not ticked", async () => {
    const g = await golden({ autoFix: false });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "closure", replace: [{ leg_key: "L1", with: [metroAlt(5)] }] });
    assert.deepEqual(p.reasons, ["AUTO_FIX_OFF"]);
  });

  test("T08-03 auto fix blocked on a booked leg", async () => {
    const g = await golden({ autoFix: true });
    await g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: "L1", operator: "DMRC", travel_date: "2026-11-20", price_rupees: "20" });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "closure", replace: [{ leg_key: "L1", with: [{ ...metroAlt(5), estimated_rupees: "0" }] }] });
    assert.ok(p.reasons.includes("CHANGES_BOOKED_LEG"), JSON.stringify(p.reasons));
  });

  test("T08-04 auto fix blocked on a locked leg", async () => {
    const g = await golden({ autoFix: true });
    await g.svc.lockLeg(g.ctx, k(), { trip_id: g.trip, leg_key: "L1", locked: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "closure", replace: [{ leg_key: "L1", with: [metroAlt(5)] }] });
    assert.ok(p.reasons.includes("CHANGES_LOCKED_LEG"));
  });

  test("T08-05 auto fix blocked when the new leg relies on estimated data", async () => {
    const g = await golden({ autoFix: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "closure", replace: [{ leg_key: "L1", with: [metroAlt(5, "estimated")] }] });
    assert.ok(p.reasons.includes("RELIES_ON_ESTIMATED_OR_WEAK_DATA"));
  });

  test("T08-09 write without the secret pass is rejected", async () => {
    const g = await golden();
    const pub = { ...g.ctx, role: "public" as const };
    await expectCode(g.svc.recordBooking(pub, k(), { trip_id: g.trip, leg_key: "L2", operator: "IR", travel_date: "2026-11-20", price_rupees: "755" }), "UNAUTHORISED");
  });

  test("T08-09b the assistant cannot approve its own proposal", async () => {
    const g = await golden({ book: true });
    const agent = { ...g.ctx, role: "agent" as const };
    const p = await g.svc.proposeVersion(agent, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    await expectCode(g.svc.decideApproval(agent, k(), { trip_id: g.trip, approval_id: p.approval_id, decision: "approve" }), "USER_ONLY");
    assert.equal((await g.svc.getTrip(g.ctx, { trip_id: g.trip })).current_version, 1);
  });

  test("T08-10 approval decision is audited with proposal, decision, time, result", async () => {
    const g = await golden({ book: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    await g.svc.decideApproval(g.ctx, k(), { trip_id: g.trip, approval_id: p.approval_id, decision: "approve" });
    const log = await g.svc.eventLog(g.ctx, { trip_id: g.trip });
    const ev = log.find((e) => e.event === "approval_decided");
    assert.ok(ev && ev.at);
    const d = ev.detail as { approval_id: string; decision: string; result: string };
    assert.equal(d.approval_id, p.approval_id);
    assert.equal(d.decision, "approve");
    assert.match(d.result, /version 2/);
  });

  test("Another session cannot see or change the trip", async () => {
    const g = await golden();
    const other = ctxFor("user");
    await expectCode(g.svc.getTrip(other, { trip_id: g.trip }), "NOT_FOUND");
    await expectCode(g.svc.deleteTrip(other, k(), { trip_id: g.trip }), "NOT_FOUND");
  });
});

describe("Group 9 - knock-on replans (code part)", () => {
  test("T09-01 late train breaks the metro leg after it; locked hotel kept", async () => {
    const svc = await service();
    const ctx = ctxFor();
    const { trip_id } = await svc.createTrip(ctx, k(), { title: "Train then metro" });
    const train = { ...L2, leg_key: "L1", min_gap_after_min: 20 };
    const metro = { ...L1, leg_key: "L2", from_name: "Jaipur Railway Station", to_name: "Sindhi Camp", depart_at: t("11:00"), arrive_at: t("11:10"), min_gap_after_min: 30 };
    for (const leg of [train, metro, L3]) await svc.addLeg(ctx, k(), { trip_id, leg });
    await svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L1", to_leg_key: "L2" });
    await svc.linkLegs(ctx, k(), { trip_id, from_leg_key: "L2", to_leg_key: "L3" });
    await svc.approvePlan(ctx, k(), { trip_id });
    await svc.lockLeg(ctx, k(), { trip_id, leg_key: "L3", locked: true });
    await svc.injectTestDisruption(ctx, k(), { trip_id, leg_key: "L1", delay_min: 70 });
    const aff = await svc.findAffectedLegs(ctx, { trip_id });
    assert.deepEqual(aff.broken, ["L2"]);
    assert.deepEqual(aff.delayed, ["L1"]);
    assert.deepEqual(aff.kept_locked, ["L3"]);
  });

  test("T09-07 version history restorable: restore v1 after approving v2", async () => {
    const g = await golden({ book: true });
    const p = await g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "L2 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] });
    await g.svc.decideApproval(g.ctx, k(), { trip_id: g.trip, approval_id: p.approval_id, decision: "approve" });
    const r = await g.svc.restoreVersion(g.ctx, k(), { trip_id: g.trip, version: 1 });
    assert.equal(r.current_version, 3);
    const trip = await g.svc.getTrip(g.ctx, { trip_id: g.trip });
    assert.equal(trip.versions.find((v) => v.number === 2)?.status, "superseded");
    assert.equal(await snapshot(g, 3), await snapshot(g, 1));
  });

  test("T09-05 replan re-checks later gaps: replacement too late for the locked hotel is refused", async () => {
    const g = await golden();
    const tooLate = { ...L2b, depart_at: t("10:00"), arrive_at: t("14:20") };
    await expectCode(g.svc.proposeVersion(g.ctx, k(), { trip_id: g.trip, reason: "swap", replace: [{ leg_key: "L2", with: [tooLate] }] }), "RULES_FAIL");
  });
});

describe("Group 10 - labels and privacy", () => {
  test("T10-06 no PII stored: PNR / phone in fields is refused, no PII columns exist", async () => {
    const g = await golden();
    await expectCode(g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", operator: "IR PNR 4521234567", travel_date: "2026-11-20", price_rupees: "755" }), "PII_NOT_ALLOWED");
    await expectCode(g.svc.recordBooking(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", operator: "IR", service_no: "call 9876543210", travel_date: "2026-11-20", price_rupees: "755" }), "PII_NOT_ALLOWED");
    const cols = await g.svc.db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public'");
    const names = cols.rows.map((c) => c.column_name);
    for (const bad of ["pnr", "passenger_name", "phone", "card_number", "email"]) assert.ok(!names.includes(bad), bad);
  });

  test("Delete this trip removes everything", async () => {
    const g = await golden({ book: true });
    await g.svc.deleteTrip(g.ctx, k(), { trip_id: g.trip });
    for (const tbl of ["trips", "legs", "bookings", "approvals", "audit_log", "leg_status", "budgets"]) {
      const col = tbl === "trips" ? "id" : "trip_id";
      const r = await g.svc.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tbl} WHERE ${col}=$1`, [g.trip]);
      assert.equal(r.rows[0].n, 0, tbl);
    }
  });
});
