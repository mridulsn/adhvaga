// Cases added after the Phase 1 review.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expectCode, golden, k } from "./fixtures.ts";

describe("Review additions", () => {
  test("T09-04 locked hotel whose own connection fails is reported as kept_locked, not unaffected", async () => {
    const g = await golden();
    await g.svc.injectTestDisruption(g.ctx, k(), { trip_id: g.trip, leg_key: "L2", delay_min: 250 });
    const aff = await g.svc.findAffectedLegs(g.ctx, { trip_id: g.trip });
    assert.deepEqual(aff.kept_locked, ["L3"]);
    assert.deepEqual(aff.delayed, ["L2"]);
    assert.ok(!aff.unaffected.includes("L3"));
    assert.match(aff.reasons.L3, /locked/);
  });

  test("Agent's refused attempt to approve or raise the ceiling is written to the event log", async () => {
    const g = await golden();
    const agent = { ...g.ctx, role: "agent" as const };
    await expectCode(g.svc.setBudget(agent, k(), { trip_id: g.trip, hard_ceiling_rupees: "9000" }), "USER_ONLY");
    const log = await g.svc.eventLog(g.ctx, { trip_id: g.trip });
    const ev = log.find((e) => e.event === "write_rejected" && (e.detail as { code: string }).code === "USER_ONLY");
    assert.ok(ev, "refusal should be logged");
    assert.equal(ev.actor, "agent");
  });
});
