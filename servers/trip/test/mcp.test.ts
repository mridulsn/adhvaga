// The MCP layer: tool list, envelope, secret pass, and prohibited actions having no tool.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import type { Ctx } from "../src/service.ts";
import { L1, L2, L2b, L3, k, service, t } from "./fixtures.ts";

async function connect(role: Ctx["role"], session: string) {
  const svc = await service();
  const server = buildServer(svc, () => ({ session, role }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as Array<{ text: string }>)[0].text);
  };
  return { client, call };
}

const ENVELOPE_KEYS = ["status", "source", "label", "retrieved_at", "data_as_of", "confidence", "data", "error"];

describe("MCP layer", () => {
  test("T08-06/07/08 no tool exists to book, pay, cancel a real booking, file a claim or store a card", async () => {
    const { client } = await connect("user", "s-tools");
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.length >= 25, String(names.length));
    for (const banned of [/^book/, /pay/, /purchase/, /buy/, /cancel_(real_)?booking/, /claim/, /card/, /tdr/]) {
      assert.ok(!names.some((n) => banned.test(n)), `found a tool matching ${banned}`);
    }
  });

  test("Every answer uses the envelope, including errors", async () => {
    const { call, client } = await connect("user", "s-env");
    const good = await call("create_trip", { idempotency_key: k(), title: "Env test" });
    const bad = await call("get_trip", { trip_id: "nope" });
    // Wrong VALUES are checked by our code and come back as a BAD_INPUT envelope.
    const badInput = await call("add_leg", { idempotency_key: k(), trip_id: good.data.trip_id, leg: { ...L1, depart_at: t("10:00"), arrive_at: t("09:00") } });
    for (const e of [good, bad, badInput]) assert.deepEqual(Object.keys(e).sort(), [...ENVELOPE_KEYS].sort());
    assert.equal(good.status, "success");
    assert.equal(bad.error.code, "NOT_FOUND");
    assert.equal(badInput.error.code, "BAD_INPUT");
    // A wrong SHAPE is refused by the MCP library before our code runs (isError, nothing saved).
    const r = await client.callTool({ name: "add_leg", arguments: { idempotency_key: k(), trip_id: good.data.trip_id, leg: { leg_key: "L1" } } });
    assert.equal(r.isError, true);
  });

  test("T08-09 write tools refuse callers without the secret pass; reads still work", async () => {
    const session = "s-pass";
    const user = await connect("user", session);
    const pub = await connect("public", session);
    const trip = (await user.call("create_trip", { idempotency_key: k(), title: "Pass test" })).data.trip_id;
    const w = await pub.call("add_leg", { idempotency_key: k(), trip_id: trip, leg: L1 });
    assert.equal(w.error.code, "UNAUTHORISED");
    const r = await pub.call("get_trip", { trip_id: trip });
    assert.equal(r.status, "success");
  });

  test("Golden journey G1-G12a through MCP calls only", async () => {
    const session = "s-golden";
    const u = await connect("user", session);
    const agent = await connect("agent", session);
    const trip = (await agent.call("create_trip", {
      idempotency_key: k(), title: "Delhi to Jaipur", hard_ceiling_rupees: "4000", target_rupees: "3000",
      rules: { arrive_by: { at: t("14:00") }, no_arrival_after_local: "23:00", default_min_gap_min: 30 },
    })).data.trip_id;
    for (const leg of [L1, L2, L3]) assert.equal((await agent.call("add_leg", { idempotency_key: k(), trip_id: trip, leg })).status, "success");
    await agent.call("link_legs", { idempotency_key: k(), trip_id: trip, from_leg_key: "L1", to_leg_key: "L2" });
    await agent.call("link_legs", { idempotency_key: k(), trip_id: trip, from_leg_key: "L2", to_leg_key: "L3" });
    assert.equal((await agent.call("approve_plan", { idempotency_key: k(), trip_id: trip })).error.code, "USER_ONLY");
    assert.equal((await u.call("approve_plan", { idempotency_key: k(), trip_id: trip })).data.current_version, 1);
    await u.call("lock_leg", { idempotency_key: k(), trip_id: trip, leg_key: "L3", locked: true });
    const bk = await agent.call("record_booking", { idempotency_key: k(), trip_id: trip, leg_key: "L2", operator: "Indian Railways", service_no: "12015", travel_date: "2026-11-20", price_rupees: "755" });
    assert.equal(bk.data.label, "user_entered");
    await agent.call("inject_test_disruption", { idempotency_key: k(), trip_id: trip, leg_key: "L2", status: "cancelled" });
    const aff = (await agent.call("find_affected_legs", { trip_id: trip })).data;
    assert.deepEqual([aff.broken, aff.kept_locked, aff.unaffected], [["L2"], ["L3"], ["L1"]]);
    const p = (await agent.call("propose_version", { idempotency_key: k(), trip_id: trip, reason: "12015 cancelled", replace: [{ leg_key: "L2", with: [L2b] }] })).data;
    assert.equal(p.permission, "needs_approval");
    const inbox = (await u.call("list_approvals", { trip_id: trip, status: "pending" })).data;
    assert.equal(inbox.length, 1);
    const before = JSON.stringify((await u.call("get_trip", { trip_id: trip, version: 1 })).data.legs.map((l: { leg_key: string; depart_at: string }) => [l.leg_key, l.depart_at]));
    await u.call("decide_approval", { idempotency_key: k(), trip_id: trip, approval_id: p.approval_id, decision: "reject" });
    const after = JSON.stringify((await u.call("get_trip", { trip_id: trip, version: 1 })).data.legs.map((l: { leg_key: string; depart_at: string }) => [l.leg_key, l.depart_at]));
    assert.equal(after, before);
    assert.equal((await u.call("get_trip", { trip_id: trip })).data.current_version, 1);
  });
});
