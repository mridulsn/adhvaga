"""Scripted scenarios for the cases the Trip server can answer today.

scope = "full":      the whole case is exercised.
scope = "trip_part": only the Trip server's part runs (search, live data, the AI agent or the rule library
                     come in later phases); checks needing those are reported as skipped, not passed.
A case with no scenario is reported as "not yet" with the component it waits for.
"""
from __future__ import annotations

from typing import Awaitable, Callable

from .fixtures import GOLDEN_RULES, L1, L2, L2B, L3, StepFailed, Trial, leg, metro_alt, shift, t

SCENARIOS: dict[str, tuple[str, Callable[[Trial], Awaitable[None]]]] = {}


def scenario(case_id: str, scope: str = "full"):
    def wrap(fn):
        SCENARIOS[case_id] = (scope, fn)
        return fn
    return wrap


async def _cancel_and_replace(tr: Trial, book: bool = True):
    await tr.golden(book=book)
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.disrupt("L2", "cancelled")
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")
    await tr.propose(reason="L2 cancelled", replace=[{"leg_key": "L2", "with": [L2B]}])
    tr.obs["snap_after"] = await tr.snapshot(1)


async def _rank(tr: Trial, options: list[dict], replaces: list[str] | None = None, preference: str | None = None):
    args = {"trip_id": tr.trip, "options": options}
    if replaces:
        args["replaces"] = replaces
    if preference:
        args["preference"] = preference
    env = await tr.call("rank_options", args, role="agent")
    tr.obs["final"] = env
    d = env.get("data") or {}
    tr.obs["ranked"], tr.obs["demo"], tr.obs["dropped"] = d.get("ranked", []), d.get("demo_options", []), d.get("dropped", [])
    for o in tr.obs["ranked"] + tr.obs["demo"]:
        tr.obs["labels"] += o["labels"]
        tr.obs["confidences"].append(o["confidence"]["level"])


# ---------------- group 1 ----------------
@scenario("T01-12")
async def t01_12(tr):
    await tr.golden()


# ---------------- group 2 ----------------
@scenario("T02-01", "trip_part")
async def t02_01(tr):
    await _cancel_and_replace(tr)


@scenario("T02-04", "trip_part")
async def t02_04(tr):
    await tr.golden()
    await tr.disrupt("L2", delay_min=40)
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")
    await tr.ok("check_rules", {"trip_id": tr.trip}, role="agent")


@scenario("T02-05", "trip_part")
async def t02_05(tr):
    await tr.golden()
    await tr.disrupt("L2", "cancelled")
    bus = leg("B1", "bus", "Delhi ISBT", "Jaipur Sindhi Camp", t("06:30"), t("12:00"), "600", label="simulated", source="simulated", gap=60)
    await _rank(tr, [{"option_id": "sim-bus", "legs": [bus]}], replaces=["L2"])


@scenario("T02-06")
async def t02_06(tr):
    await tr.golden(auto_fix=True)
    await tr.disrupt("L1", "line_closed")
    env = await tr.propose(reason="Yellow line closed", replace=[{"leg_key": "L1", "with": [metro_alt(10)]}])
    if env["status"] == "success" and env["data"]["permission"] == "automatic":
        tr.obs["auto"] = await tr.ok("apply_auto_fix", {"trip_id": tr.trip, "approval_id": env["data"]["approval_id"]}, role="agent")


@scenario("T02-07")
async def t02_07(tr):
    await tr.golden(auto_fix=True)
    await tr.disrupt("L1", "line_closed")
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="Yellow line closed", replace=[{"leg_key": "L1", "with": [metro_alt(25, gap=10)]}])


@scenario("T02-08")
async def t02_08(tr):
    await tr.golden(book=True)
    bk = (await tr.ok("get_trip", {"trip_id": tr.trip}, role="public"))["bookings"][0]
    tr.obs["budget_before_refund"] = await tr.ok("get_budget", {"trip_id": tr.trip}, role="public")
    await tr.disrupt("L2", "cancelled")
    await tr.ok("record_refund_pending", {"trip_id": tr.trip, "booking_id": bk["id"], "refund_rupees": "755"}, role="agent")
    await tr.propose(reason="L2 cancelled", replace=[{"leg_key": "L2", "with": [L2B]}])


@scenario("T02-10", "trip_part")
async def t02_10(tr):
    await tr.golden()
    await tr.disrupt("L1", "line_closed")
    await tr.disrupt("L2", delay_min=90)
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")


@scenario("T02-11")
async def t02_11(tr):
    await tr.golden()
    await tr.disrupt("L2", "cancelled")


@scenario("T02-12", "trip_part")
async def t02_12(tr):
    await _cancel_and_replace(tr)


@scenario("T02-13", "trip_part")
async def t02_13(tr):
    await tr.golden()
    await tr.disrupt("L2", "diverted")
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")


@scenario("T02-14")
async def t02_14(tr):
    await _cancel_and_replace(tr)
    p = tr.obs.get("proposal")
    if p:
        tr.obs["final"] = await tr.call("decide_approval", {"trip_id": tr.trip, "approval_id": p["approval_id"], "decision": "reject"})
    tr.obs["snap_after"] = await tr.snapshot(1)


# ---------------- group 3 ----------------
@scenario("T03-03")
async def t03_03(tr):
    a = leg("L1", "metro", "A", "B", t("10:40"), t("10:50"), "20", gap=30, source="delhi-metro-gtfs")
    b = leg("L2", "train", "B", "C", t("11:00"), t("15:00"), "500")
    tr.trip = (await tr.ok("create_trip", {"title": "Gap", "rules": {"default_min_gap_min": 30}}, role="agent"))["trip_id"]
    for lg in (a, b):
        await tr.ok("add_leg", {"trip_id": tr.trip, "leg": lg}, role="agent")
    await tr.ok("link_legs", {"trip_id": tr.trip, "from_leg_key": "L1", "to_leg_key": "L2"}, role="agent")
    tr.obs["final"] = await tr.call("approve_plan", {"trip_id": tr.trip})


@scenario("T03-04")
async def t03_04(tr):
    await tr.golden()
    late = {**L2B, "leg_key": "Lx", "depart_at": t("09:30"), "arrive_at": t("14:30")}
    await _rank(tr, [{"option_id": "ok", "legs": [L2B]}, {"option_id": "late", "legs": [late]}], replaces=["L2"])


@scenario("T03-05")
async def t03_05(tr):
    tr.trip = (await tr.ok("create_trip", {"title": "Night", "rules": {"no_arrival_after_local": "23:00"}}, role="agent"))["trip_id"]
    await _rank(tr, [{"option_id": "night", "legs": [{**L2, "depart_at": t("19:00"), "arrive_at": t("23:40")}]},
                     {"option_id": "day", "legs": [L2]}])


@scenario("T03-06")
async def t03_06(tr):
    await tr.golden(ceiling="2600", target="2600")
    await tr.propose(reason="upgrade", replace=[{"leg_key": "L2", "with": [{**L2B, "estimated_rupees": "1500"}]}])


@scenario("T03-07")
async def t03_07(tr):
    await tr.golden()
    tr.obs["final"] = await tr.call("set_budget", {"trip_id": tr.trip, "hard_ceiling_rupees": "9000"}, role="agent")


@scenario("T03-08")
async def t03_08(tr):
    tr.trip = (await tr.ok("create_trip", {"title": "Cycle"}, role="agent"))["trip_id"]
    for lg in (L1, L2, L3):
        await tr.ok("add_leg", {"trip_id": tr.trip, "leg": lg}, role="agent")
    await tr.ok("link_legs", {"trip_id": tr.trip, "from_leg_key": "L1", "to_leg_key": "L2"}, role="agent")
    await tr.ok("link_legs", {"trip_id": tr.trip, "from_leg_key": "L2", "to_leg_key": "L3"}, role="agent")
    tr.obs["final"] = await tr.call("link_legs", {"trip_id": tr.trip, "from_leg_key": "L3", "to_leg_key": "L1"}, role="agent")


@scenario("T03-09")
async def t03_09(tr):
    tr.trip = (await tr.ok("create_trip", {"title": "Bad"}, role="agent"))["trip_id"]
    tr.obs["final"] = await tr.call("add_leg", {"trip_id": tr.trip, "leg": {**L1, "depart_at": t("10:00"), "arrive_at": t("09:00")}}, role="agent")


# ---------------- group 4 ----------------
@scenario("T04-01", "trip_part")
async def t04_01(tr):
    await tr.golden()
    fast = {**L2B, "leg_key": "Lf", "depart_at": t("06:00"), "arrive_at": t("09:30"), "estimated_rupees": "1200"}
    await _rank(tr, [{"option_id": "cheap", "legs": [{**L2B, "estimated_rupees": "500"}]}, {"option_id": "fast", "legs": [fast]}], replaces=["L2"], preference="fastest")


@scenario("T04-03", "trip_part")
async def t04_03(tr):
    rules = {"default_min_gap_min": 30, "preferences": {"avoid_overnight": True}}
    tr.trip = (await tr.ok("create_trip", {"title": "No overnight", "rules": rules}, role="agent"))["trip_id"]
    night = leg("N1", "train", "Mumbai Central", "New Delhi", t("17:00"), t("08:35", "2026-11-21"), "2900")
    day = leg("D1", "train", "Mumbai Central", "New Delhi", t("06:00"), t("21:30"), "2100")
    await _rank(tr, [{"option_id": "rajdhani-night", "legs": [night], "overnight": True}, {"option_id": "day", "legs": [day]}])


@scenario("T04-04")
async def t04_04(tr):
    await tr.golden(auto_fix=True)
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="only works with night travel", relaxes_preference=True, replace=[{"leg_key": "L1", "with": [metro_alt(5)]}])


@scenario("T04-07")
async def t04_07(tr):
    await tr.golden(target="2600")
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="better train", replace=[{"leg_key": "L2", "with": [{**L2B, "estimated_rupees": "980"}]}])


# ---------------- group 5 ----------------
@scenario("T05-01")
async def t05_01(tr):
    # Spec input: ceiling Rs 3000, target Rs 2500.
    await tr.golden(ceiling="3000", target="2500")


@scenario("T05-02")
async def t05_02(tr):
    await tr.golden(book=True)
    bk = (await tr.ok("get_trip", {"trip_id": tr.trip}, role="public"))["bookings"][0]
    tr.obs["budget_before_refund"] = await tr.ok("get_budget", {"trip_id": tr.trip}, role="public")
    await tr.ok("record_refund_pending", {"trip_id": tr.trip, "booking_id": bk["id"], "refund_rupees": "755"}, role="agent")


@scenario("T05-03")
async def t05_03(tr):
    await t05_02(tr)
    await tr.ok("mark_refund_received", {"trip_id": tr.trip, "refund_rupees": "755"})


@scenario("T05-04")
async def t05_04(tr):
    await tr.golden(ceiling="20000", target="20000")
    await tr.book("L2", "4200", fees=[{"kind": "convenience fee", "rupees": "350"}, {"kind": "baggage", "rupees": "600"}])


@scenario("T05-05")
async def t05_05(tr):
    await tr.golden()
    for k in ("L1", "L2", "L3"):
        await tr.book(k, "333.33")


@scenario("T05-06")
async def t05_06(tr):
    await tr.golden()
    await tr.propose(reason="swap", replace=[{"leg_key": "L2", "with": [L2B]}])


@scenario("T05-07")
async def t05_07(tr):
    await tr.golden()
    tr.obs["final"] = await tr.call("record_booking", {"trip_id": tr.trip, "leg_key": "L2", "operator": "IR", "travel_date": "2026-11-20", "price_rupees": "-50"}, role="agent")


@scenario("T05-09")
async def t05_09(tr):
    # Spec input: one leg estimated Rs 800, paid Rs 755.
    await tr.build([{**L2, "estimated_rupees": "800"}], [], ceiling="3000", target="3000")
    await tr.book("L2", "755")


@scenario("T05-10")
async def t05_10(tr):
    await tr.golden()
    args = {"idempotency_key": "dup-key-0001", "trip_id": tr.trip, "leg_key": "L2", "operator": "IR", "travel_date": "2026-11-20", "price_rupees": "755"}
    await tr.call("record_booking", dict(args), role="agent")
    await tr.call("record_booking", dict(args), role="agent")


# ---------------- group 7 ----------------
@scenario("T07-05", "trip_part")
async def t07_05(tr):
    await tr.golden()
    await tr.ok("record_status", {"trip_id": tr.trip, "leg_key": "L2", "status": "delayed", "delay_min": 20, "source": "railradar", "label": "live", "checked_at": "2026-11-07T08:00:00+05:30"}, role="agent")


@scenario("T07-07", "trip_part")
async def t07_07(tr):
    await tr.golden()
    args = {"idempotency_key": "retry-key-0001", "trip_id": tr.trip, "leg_key": "L2", "operator": "IR", "travel_date": "2026-11-20", "price_rupees": "755"}
    await tr.call("record_booking", dict(args), role="agent")  # response "lost"
    await tr.call("record_booking", dict(args), role="agent")  # retried with the same key


@scenario("T07-10")
async def t07_10(tr):
    await tr.golden()
    tr.obs["snap_before"] = await tr.snapshot(1)
    env = await tr.call("propose_version", {"trip_id": tr.trip, "reason": "swap", "replace": [{"leg_key": "L2", "with": [L2B]}]},
                        role="agent", faults={"propose_fail_after_legs": 2})
    tr.obs["final"] = env
    tr.obs["snap_after"] = await tr.snapshot(1)


# ---------------- group 8 ----------------
@scenario("T08-01")
async def t08_01(tr):
    await tr.golden(auto_fix=True)
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="dearer route", replace=[{"leg_key": "L1", "with": [metro_alt(5, rupees="40")]}])


@scenario("T08-02")
async def t08_02(tr):
    await tr.golden(auto_fix=False)
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="closure", replace=[{"leg_key": "L1", "with": [metro_alt(5)]}])


@scenario("T08-03")
async def t08_03(tr):
    await tr.golden(auto_fix=True)
    await tr.book("L1", "20", op="DMRC")
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="closure", replace=[{"leg_key": "L1", "with": [metro_alt(5, rupees="0")]}])


@scenario("T08-04")
async def t08_04(tr):
    await tr.golden(auto_fix=True)
    await tr.ok("lock_leg", {"trip_id": tr.trip, "leg_key": "L1", "locked": True})
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="closure", replace=[{"leg_key": "L1", "with": [metro_alt(5)]}])


@scenario("T08-05")
async def t08_05(tr):
    await tr.golden(auto_fix=True)
    tr.obs["snap_before"] = await tr.snapshot(1)
    await tr.propose(reason="closure", replace=[{"leg_key": "L1", "with": [metro_alt(5, label="estimated")]}])


for _cid in ("T08-06", "T08-07", "T08-08"):
    @scenario(_cid)
    async def _no_tool(tr):
        tr.obs["tools"] = list(tr.c.tool_names)


@scenario("T08-09")
async def t08_09(tr):
    await tr.golden()
    tr.obs["final"] = await tr.call("record_booking", {"trip_id": tr.trip, "leg_key": "L2", "operator": "IR", "travel_date": "2026-11-20", "price_rupees": "755"}, role="public")


@scenario("T08-10")
async def t08_10(tr):
    await _cancel_and_replace(tr)
    p = tr.obs.get("proposal")
    if p:
        await tr.call("decide_approval", {"trip_id": tr.trip, "approval_id": p["approval_id"], "decision": "approve"})


# ---------------- group 9 ----------------
@scenario("T09-01", "trip_part")
async def t09_01(tr):
    train = {**L2, "leg_key": "L1", "min_gap_after_min": 20}
    metro = {**L1, "leg_key": "L2", "from_name": "Jaipur Railway Station", "to_name": "Sindhi Camp", "depart_at": t("11:00"), "arrive_at": t("11:10")}
    await tr.build([train, metro, L3], [("L1", "L2"), ("L2", "L3")], lock=("L3",))
    await tr.disrupt("L1", delay_min=70)
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")
    tr.obs["locked_keys"] = ["L3"]


FOUR = [
    leg("L1", "metro", "Home", "NDLS", t("05:00"), t("05:30"), "30", source="delhi-metro-gtfs", gap=30),
    leg("L2", "train", "NDLS", "JP", t("06:10"), t("10:35"), "755", gap=60),
    leg("L3", "train", "JP", "Ajmer", t("12:00"), t("14:00"), "200", gap=30),
    leg("L4", "stay", "Ajmer hotel", "Ajmer hotel", t("16:00"), t("10:00", "2026-11-21"), "1500", label="user_entered", source="user"),
]


@scenario("T09-02", "trip_part")
async def t09_02(tr):
    await tr.build(FOUR, [("L1", "L2"), ("L2", "L3"), ("L3", "L4")])
    await tr.disrupt("L3", "cancelled")
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")


@scenario("T09-03", "trip_part")
async def t09_03(tr):
    await tr.build(FOUR[:3], [("L1", "L2"), ("L2", "L3")])
    # L1 120 min late misses L2; L3 depends on L2.
    await tr.disrupt("L1", delay_min=120)
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")


@scenario("T09-04", "trip_part")
async def t09_04(tr):
    await _cancel_and_replace(tr)
    tr.obs["locked_keys"] = ["L3"]


@scenario("T09-05", "trip_part")
async def t09_05(tr):
    await tr.build(FOUR, [("L1", "L2"), ("L2", "L3"), ("L3", "L4")])
    too_late = leg("L3b", "train", "JP", "Ajmer", t("14:30"), t("16:10"), "220", gap=30)
    await tr.propose(reason="L3 cancelled", replace=[{"leg_key": "L3", "with": [too_late]}])


@scenario("T09-06", "trip_part")
async def t09_06(tr):
    await tr.golden()
    late = {**L2B, "leg_key": "Lz", "depart_at": t("10:00"), "arrive_at": t("14:20")}
    await _rank(tr, [{"option_id": "ok", "legs": [L2B]}, {"option_id": "late", "legs": [late]}], replaces=["L2"])


@scenario("T09-07")
async def t09_07(tr):
    await _cancel_and_replace(tr)
    p = tr.obs.get("proposal")
    if p:
        await tr.ok("decide_approval", {"trip_id": tr.trip, "approval_id": p["approval_id"], "decision": "approve"})
        tr.obs["final"] = await tr.call("restore_version", {"trip_id": tr.trip, "version": 1})


@scenario("T09-08", "trip_part")
async def t09_08(tr):
    d3 = leg("D3L1", "activity", "Amber Fort", "Amber Fort", t("10:00", "2026-11-22"), t("13:00", "2026-11-22"), "500", label="user_entered", source="user")
    await tr.build([L1, L2, L3, d3], [("L1", "L2"), ("L2", "L3")], GOLDEN_RULES, ceiling="5000", target="5000")
    await tr.disrupt("L1", "line_closed")
    tr.obs["affected"] = await tr.ok("find_affected_legs", {"trip_id": tr.trip}, role="agent")


# ---------------- group 10 ----------------
@scenario("T10-02", "trip_part")
async def t10_02(tr):
    await tr.golden()
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    env = await tr.call("record_status", {"trip_id": tr.trip, "leg_key": "L2", "status": "delayed", "delay_min": 12, "source": "railradar", "label": "live", "checked_at": now}, role="agent")
    tr.obs["final"] = env
    tr.obs["labels"] = ["live"]


@scenario("T10-06")
async def t10_06(tr):
    await tr.golden()
    refusals = []
    for op, no in (("IR PNR 4521234567", None), ("IR", "call 9876543210"), ("Card 4111 1111 1111 1111", None)):
        args = {"trip_id": tr.trip, "leg_key": "L2", "operator": op, "travel_date": "2026-11-20", "price_rupees": "755"}
        if no:
            args["service_no"] = no
        refusals.append(await tr.call("record_booking", args, role="agent"))
    tr.obs["pii_refusals"] = refusals


# ---------------- metro server (Kochi and Hyderabad loaded 8 Nov 2026) ----------------
@scenario("T01-06", "metro_part")
async def t01_06(tr):
    # The airport is not on the metro: the server must say so, not guess. The airport -> Aluva road leg is
    # outside the Metro server, so only the metro part is judged here (reported as partial).
    air = await tr.metro("find_station", {"city": "Kochi", "query": "Kochi airport"})
    if (air.get("data") or {}).get("found") is not False:
        raise StepFailed("Kochi airport was matched to a metro station")
    env = await tr.metro("route_between_stations", {"city": "Kochi", "from": "Aluva", "to": "MG Road", "date": tr.obs["date"], "depart_after": "08:00"})
    if env["status"] != "success" or not env["data"].get("found"):
        raise StepFailed(f"no Kochi metro route: {env.get('error') or env.get('data')}")
    # The metro answer's trip_leg must go straight into the Trip server (cross-server seam).
    metro_leg = {"leg_key": "L1", **env["data"]["options"][0]["trip_leg"]}
    await tr.build([metro_leg], [], title="Kochi metro leg")


@scenario("T10-04")
async def t10_04(tr):
    await tr.metro("route_between_stations", {"city": "Shillong", "from": "Police Bazar", "to": "Laitumkhrah"})


@scenario("T10-05", "metro_part")
async def t10_05(tr):
    # The case names Delhi, whose feed is not loaded yet (needs the DMRC form). The rule is the same for every
    # city, so it is checked on both loaded cities, inside and outside their timetable dates, plus Delhi's answer.
    asks = [
        {"city": "Kochi", "from": "Aluva", "to": "MG Road", "date": "2025-03-10", "depart_after": "08:00"},
        {"city": "Kochi", "from": "Aluva", "to": "MG Road", "date": tr.obs["date"], "depart_after": "08:00"},
        {"city": "Hyderabad", "from": "Miyapur", "to": "Raidurg", "date": tr.obs["date"], "depart_after": "08:00"},
        {"city": "Hyderabad", "from": "Nagole", "to": "MGBS", "date": "2026-11-14", "depart_after": "08:00"},
    ]
    for a in asks:
        env = await tr.metro("route_between_stations", a)
        if env["status"] != "success" or not env["data"].get("found"):
            raise StepFailed(f"no metro route for {a['city']}: {env.get('error') or env.get('data')}")
        tr.obs["labels"].append(env["label"])
    delhi = await tr.metro("route_between_stations", {"city": "Delhi", "from": "Rajiv Chowk", "to": "New Delhi"})
    if (delhi.get("data") or {}).get("code") != "NO_VERIFIED_DATA":
        raise StepFailed("Delhi metro answered without a loaded feed")
    tr.obs["labels"].append(delhi["label"])


@scenario("T03-10", "metro_part")
async def t03_10(tr):
    # Same from and to station must be refused as BAD_INPUT before any timetable is searched. The case is about
    # trains (NDLS to NDLS); trains come in Phase 2, so the same rule is checked on the Metro server.
    await tr.metro("route_between_stations", {"city": "Hyderabad", "from": "Ameerpet", "to": "Ameerpet"})
