"""Runs the 100 Adhvaga test cases against the MCP servers and applies the release rules."""
from __future__ import annotations

import asyncio
import json
import subprocess
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from .checks import BLOCKER_OF, evaluate
from .client import ROOT, all_servers
from .fixtures import StepFailed, Trial
from .scenarios import SCENARIOS

SPEC = ROOT / "specs" / "adhvaga-tests-v1.json"
RESULTS = ROOT / "harness" / "results"

WAITS_FOR = {2: "Trains + Metro servers (Phase 2)", 3: "Flights, Buses, more metro cities (Phase 3)",
             4: "Knowledge server / rule library (Phase 4)", "5b": "website agent loop (Phase 5b)"}
AGENT_ONLY = {"T01-11", "T04-02", "T04-05", "T04-06", "T04-08", "T06-11"}


def _git_version() -> str:
    try:
        return subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


async def run_case(client, case: dict) -> dict:
    base = {"id": case["id"], "group": case["group"], "title": case["title"], "phase": case["phase"]}
    if case["id"] not in SCENARIOS:
        why = "the AI agent (Phase 5b)" if case["id"] in AGENT_ONLY else WAITS_FOR.get(case["phase"], f"phase {case['phase']}")
        return {**base, "result": "not_yet", "waits_for": why, "checks": []}
    scope, fn = SCENARIOS[case["id"]]
    tr = Trial(client, case)
    t0 = time.perf_counter()
    try:
        await fn(tr)
        await tr.observe()
    except StepFailed as e:
        return {**base, "result": "error", "scope": scope, "error": str(e), "checks": [], "ms": round((time.perf_counter() - t0) * 1000)}
    except Exception as e:
        return {**base, "result": "error", "scope": scope, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-800:], "checks": []}
    checks = []
    for ck in case["checks"]:
        res, detail = evaluate(ck, tr.obs)
        checks.append({"check": ck["check"], "result": res, "detail": detail})
    failed = [c for c in checks if c["result"] == "fail"]
    skipped = [c for c in checks if c["result"] == "skip"]
    blockers = sorted({BLOCKER_OF[c["check"]] for c in failed if BLOCKER_OF.get(c["check"]) in case["never"]})
    if failed:
        result = "fail"
    elif skipped and len(skipped) == len(checks):
        result = "not_yet"
    elif skipped or scope != "full":
        result = "partial"
    else:
        result = "pass"
    out = {**base, "result": result, "scope": scope, "checks": checks, "blockers": blockers, "ms": round((time.perf_counter() - t0) * 1000)}
    if result == "not_yet":
        out["waits_for"] = "; ".join(sorted({c["detail"] for c in skipped}))
    return out


async def run_all(only: list[str] | None = None) -> dict:
    spec = json.loads(SPEC.read_text(encoding="ascii"))
    cases = [c for c in spec["cases"] if not only or c["id"] in only]
    started = datetime.now(timezone.utc).isoformat()
    results = []
    async with all_servers() as client:
        for c in cases:
            results.append(await run_case(client, c))
    return summarise(spec, results, started)


def summarise(spec: dict, results: list[dict], started: str) -> dict:
    count = lambda r: sum(1 for x in results if x["result"] == r)  # noqa: E731
    groups = {}
    for x in results:
        g = groups.setdefault(x["group"], {"total": 0, "pass": 0, "partial": 0, "fail": 0, "error": 0, "not_yet": 0})
        g["total"] += 1
        g[x["result"]] += 1
    blockers = sorted({b for x in results for b in x.get("blockers", [])})
    previous = None
    latest = RESULTS / "latest.json"
    if latest.exists():
        try:
            prev = json.loads(latest.read_text(encoding="utf-8"))
            previous = {"app_version": prev.get("app_version"), "started": prev.get("started"),
                        "groups": {int(k): v for k, v in prev.get("groups", {}).items()}}
        except Exception:
            previous = None
    worse = []
    if previous:
        for g, v in groups.items():
            pg = previous["groups"].get(g)
            if pg and (v["pass"] + v["partial"]) < (pg["pass"] + pg["partial"]):
                worse.append(g)
    full = count("pass")
    rules = spec["release_rules"]
    if blockers:
        gate = "BLOCKED"
    elif full >= rules["min_pass"] and not worse and count("fail") + count("error") == 0:
        gate = "READY"
    else:
        gate = "NOT READY"
    return {
        "started": started, "app_version": _git_version(), "spec_version": spec["version"], "model": None,
        "settings": {"trip_server": "stdio test mode, in-memory database", "metro_server": "stdio, bundled timetables (Kochi, Hyderabad)", "buses_server": "stdio, simulated demo buses"},
        "totals": {"cases": len(results), "pass": full, "partial": count("partial"), "fail": count("fail"),
                   "error": count("error"), "not_yet": count("not_yet")},
        "groups": groups, "blockers": blockers, "groups_worse_than_last_run": worse,
        "gate": gate, "gate_rule": f"0 blockers, >= {rules['min_pass']} full passes, no group worse than last run",
        "previous": previous, "results": results,
    }


def save(summary: dict) -> Path:
    RESULTS.mkdir(parents=True, exist_ok=True)
    p = RESULTS / "latest.json"
    p.write_text(json.dumps(summary, indent=1), encoding="utf-8")
    return p


def main(argv: list[str]) -> int:
    only = [a for a in argv if a.startswith("T")] or None
    summary = asyncio.run(run_all(only))
    if not only:
        save(summary)
    t = summary["totals"]
    print(f"Adhvaga tests  app {summary['app_version']}  gate: {summary['gate']}")
    print(f"  pass {t['pass']}  partial {t['partial']}  fail {t['fail']}  error {t['error']}  not yet {t['not_yet']}  (of {t['cases']})")
    if summary["blockers"]:
        print("  RELEASE BLOCKERS:", ", ".join(summary["blockers"]))
    for x in summary["results"]:
        if x["result"] in ("fail", "error"):
            print(f"  {x['result'].upper():5} {x['id']} {x['title']}")
            if x.get("error"):
                print(f"        {x['error']}")
            for c in x["checks"]:
                if c["result"] == "fail":
                    print(f"        {c['check']}: {c['detail']}")
    return 1 if summary["blockers"] or t["fail"] or t["error"] else 0
