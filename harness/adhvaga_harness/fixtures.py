"""Trial = one test case run: its own browser session, its tool calls and the observations the checks read.

Fixtures build trips through MCP tool calls only (the same way the agent will).
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .client import TripClient

DAY = "2026-11-20"


def t(hhmm: str, day: str = DAY) -> str:
    return f"{day}T{hhmm}:00+05:30"


def shift(iso: str, minutes: int) -> str:
    d = datetime.fromisoformat(iso) + timedelta(minutes=minutes)
    return d.isoformat()


def leg(key: str, kind: str, frm: str, to: str, dep: str, arr: str, rupees: str, label: str = "timetable",
        source: str = "railradar", gap: int | None = None, op: str | None = None, no: str | None = None) -> dict:
    d: dict[str, Any] = {"leg_key": key, "kind": kind, "from_name": frm, "to_name": to, "depart_at": dep, "arrive_at": arr,
                         "source": source, "label": label, "estimated_rupees": rupees}
    if gap is not None:
        d["min_gap_after_min"] = gap
    if op:
        d["operator"] = op
    if no:
        d["service_no"] = no
    return d


L1 = leg("L1", "metro", "Rajiv Chowk", "New Delhi", t("05:10"), t("05:20"), "20", source="delhi-metro-gtfs", gap=30, op="DMRC", no="Yellow Line")
L2 = leg("L2", "train", "New Delhi (NDLS)", "Jaipur (JP)", t("06:10"), t("10:35"), "755", gap=60, op="Indian Railways", no="12015")
L3 = leg("L3", "stay", "Jaipur hotel", "Jaipur hotel", t("15:00"), t("11:00", "2026-11-21"), "1800", label="user_entered", source="user")
L2B = leg("L2b", "train", "New Delhi (NDLS)", "Jaipur (JP)", t("07:00"), t("11:40"), "905", gap=60, op="Indian Railways", no="12958")
GOLDEN_RULES = {"arrive_by": {"at": t("14:00")}, "no_arrival_after_local": "23:00", "default_min_gap_min": 30}


def metro_alt(delay_min: int, label: str = "timetable", rupees: str = "20", gap: int = 15) -> dict:
    return leg("L1x", "metro", "Rajiv Chowk", "New Delhi (via Kashmere Gate)", t("05:10"), shift(t("05:20"), delay_min),
               rupees, label=label, source="delhi-metro-gtfs", gap=gap, op="DMRC", no="Red + Yellow")


class StepFailed(Exception):
    """A setup step failed - the case cannot be judged (reported as an error, not a pass)."""


class Trial:
    def __init__(self, client: TripClient, case: dict):
        self.c = client
        self.case = case
        self.session = f"test-{case['id']}-{uuid.uuid4().hex[:8]}"
        self.trip: str | None = None
        self.obs: dict[str, Any] = {"envelopes": [], "calls": [], "labels": [], "confidences": [], "date": DAY,
                                    "fixtures": (case.get("setup") or {}).get("fixtures", [])}

    # ---- calls ----
    async def call(self, tool: str, args: dict, role: str = "user", faults: dict | None = None, expect_ok: bool = False) -> dict:
        env = await self.c.call(tool, args, role=role, session=self.session, faults=faults)
        self.obs["envelopes"].append(env)
        self.obs["calls"].append(tool)
        if expect_ok and env.get("status") != "success":
            raise StepFailed(f"setup step {tool} failed: {env.get('error')}")
        return env

    async def ok(self, tool: str, args: dict, role: str = "user") -> Any:
        return (await self.call(tool, args, role=role, expect_ok=True))["data"]

    # ---- fixtures ----
    async def build(self, legs: list[dict], links: list[tuple[str, str]], rules: dict | None = None,
                    ceiling: str | None = "4000", target: str | None = "3000", lock: tuple[str, ...] = (), title: str = "Test trip") -> str:
        args: dict[str, Any] = {"title": title, "trip_end_date": "2026-11-21", "rules": rules or {"default_min_gap_min": 30}}
        if ceiling:
            args["hard_ceiling_rupees"] = ceiling
        if target:
            args["target_rupees"] = target
        self.trip = (await self.ok("create_trip", args, role="agent"))["trip_id"]
        for lg in legs:
            await self.ok("add_leg", {"trip_id": self.trip, "leg": lg}, role="agent")
        for a, b in links:
            await self.ok("link_legs", {"trip_id": self.trip, "from_leg_key": a, "to_leg_key": b}, role="agent")
        await self.ok("approve_plan", {"trip_id": self.trip})
        for k in lock:
            await self.ok("lock_leg", {"trip_id": self.trip, "leg_key": k, "locked": True})
        return self.trip

    async def golden(self, book: bool = False, lock: bool = True, auto_fix: bool = False, ceiling: str = "4000", target: str = "3000") -> str:
        await self.build([L1, L2, L3], [("L1", "L2"), ("L2", "L3")], GOLDEN_RULES, ceiling, target, ("L3",) if lock else (), "Delhi to Jaipur")
        if book:
            await self.book("L2", "755", op="Indian Railways", no="12015")
        if auto_fix:
            await self.ok("set_auto_fix", {"trip_id": self.trip, "enabled": True})
        return self.trip

    async def book(self, leg_key: str, rupees: str, op: str = "Operator", no: str | None = None, fees: list | None = None) -> dict:
        args: dict[str, Any] = {"trip_id": self.trip, "leg_key": leg_key, "operator": op, "travel_date": DAY, "price_rupees": rupees}
        if no:
            args["service_no"] = no
        if fees:
            args["fees"] = fees
        return await self.ok("record_booking", args, role="agent")

    async def disrupt(self, leg_key: str, status: str | None = None, delay_min: int | None = None) -> None:
        args: dict[str, Any] = {"trip_id": self.trip, "leg_key": leg_key}
        if status:
            args["status"] = status
        if delay_min:
            args["delay_min"] = delay_min
        await self.ok("inject_test_disruption", args, role="agent")

    async def propose(self, role: str = "agent", **changes) -> dict:
        env = await self.call("propose_version", {"trip_id": self.trip, "reason": changes.pop("reason", "test"), **changes}, role=role)
        self.obs["final"] = env
        if env["status"] == "success":
            self.obs["proposal"] = env["data"]
        return env

    # ---- metro server ----
    async def metro(self, tool: str, args: dict) -> dict:
        """Call a Metro tool; record its labels, confidence and (for absent answers) the lookup result."""
        env = await self.call(tool, args, role="public")
        d = env.get("data") or {}
        self.obs["lookup"] = env
        self.obs["final"] = env
        for o in d.get("options", []):
            self.obs["labels"].append(o["label"])
            self.obs["confidences"].append(env["confidence"]["level"])
        return env

    # ---- buses server ----
    async def buses(self, tool: str, args: dict) -> dict:
        """Call a Buses tool; record the label and confidence of every demo bus it returns."""
        env = await self.call(tool, args, role="public")
        d = env.get("data") or {}
        self.obs["lookup"] = env
        self.obs["final"] = env
        for o in d.get("demo_options", []):
            self.obs["labels"].append(o["trip_leg"]["label"])
            self.obs["confidences"].append(env["confidence"]["level"])
        return env

    # ---- knowledge server ----
    async def rules(self, tool: str, args: dict) -> dict:
        """Call a Knowledge tool; keep its answer for the library checks (quote_has_source, says_not_found)."""
        env = await self.call(tool, args, role="public")
        self.obs["rule"] = env
        self.obs["lookup"] = env
        self.obs["final"] = env
        return env

    # ---- observations ----
    async def snapshot(self, version: int = 1) -> str:
        d = await self.ok("get_trip", {"trip_id": self.trip, "version": version}, role="public")
        keep = ["leg_key", "kind", "from_name", "to_name", "depart_at", "arrive_at", "operator", "service_no", "source", "label",
                "min_gap_after_min", "estimated_paise", "quoted_paise"]
        return json.dumps({"legs": [{k: lg[k] for k in keep} for lg in d["legs"]], "links": d["links"]}, sort_keys=True)

    async def observe(self) -> None:
        """Collect the end state every check may read."""
        if not self.trip:
            return
        trip = await self.call("get_trip", {"trip_id": self.trip}, role="public")
        if trip["status"] == "success":
            d = trip["data"]
            self.obs["trip"] = d
            self.obs["current_version"] = d["current_version"]
            self.obs["versions"] = {v["number"]: v["status"] for v in d["versions"]}
        self.obs["budget"] = (await self.call("get_budget", {"trip_id": self.trip}, role="public")).get("data")
        self.obs["events"] = (await self.call("get_event_log", {"trip_id": self.trip}, role="user")).get("data") or []
        self.obs["rules_check"] = (await self.call("check_rules", {"trip_id": self.trip}, role="public")).get("data")
