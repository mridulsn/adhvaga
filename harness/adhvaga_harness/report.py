"""Easy-read HTML report of results/latest.json (summary first, tables, plain words)."""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path

from .runner import WAITS_FOR

GROUP_NAMES = {1: "Normal planning", 2: "Disruptions", 3: "Hard rules", 4: "Preferences", 5: "Budget maths",
               6: "Rule library", 7: "Failures, stale data", 8: "Approvals, permissions", 9: "Knock-on replans", 10: "Labels, freshness"}
WORD = {"pass": "Pass", "partial": "Pass (trip part)", "fail": "FAIL", "error": "ERROR", "not_yet": "Not built yet"}
CSS = """body{font-family:Segoe UI,Arial,sans-serif;color:#1d2433;margin:30px 38px;line-height:1.5;font-size:13px}
h1{font-size:24px;margin:0 0 4px;color:#123a6b}.sub{color:#5a6475;margin-bottom:16px}
h2{font-size:16px;color:#123a6b;border-bottom:2px solid #dbe4f0;padding-bottom:4px;margin-top:24px}
.box{background:#eef4fb;border-left:5px solid #2f6db5;padding:11px 15px;border-radius:6px;margin:10px 0}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d5dce6;padding:5px 7px;text-align:left;vertical-align:top}
th{background:#f1f5fa}.stats{display:flex;gap:10px;margin:12px 0}.stat{flex:1;background:#f6f8fb;border:1px solid #dbe4f0;border-radius:8px;padding:9px;text-align:center}
.stat b{display:block;font-size:22px;color:#123a6b}.pass{color:#1b7a3a;font-weight:600}.partial{color:#2f6db5;font-weight:600}
.fail,.error{color:#b3261e;font-weight:700}.not_yet{color:#7a8291}"""


def _note(x: dict) -> str:
    if x.get("waits_for") or x.get("error"):
        return x.get("waits_for") or x.get("error")
    other = "; ".join(c["check"] + ": " + c["detail"] for c in x["checks"] if c["result"] != "pass")
    if x["result"] == "partial":
        rest = WAITS_FOR.get(x["phase"], "later phases")
        return "trip server part passes; the rest needs " + rest + (" (" + other + ")" if other else "")
    return other or "all code checks pass"


def build(summary: dict) -> str:
    t = summary["totals"]
    e = html.escape
    rows_g = "".join(
        f"<tr><td>{g}. {GROUP_NAMES.get(int(g), '')}</td><td>{v['total']}</td><td class=pass>{v['pass']}</td><td class=partial>{v['partial']}</td>"
        f"<td class=fail>{v['fail'] + v['error']}</td><td class=not_yet>{v['not_yet']}</td></tr>"
        for g, v in sorted(summary["groups"].items(), key=lambda kv: int(kv[0])))
    rows_c = "".join(
        f"<tr><td>{x['id']}</td><td>{e(x['title'])}</td><td class={x['result']}>{WORD[x['result']]}</td>"
        f"<td>{e(_note(x))}</td></tr>"
        for x in summary["results"])
    gate_line = {"READY": "Ready to release.", "NOT READY": "Not ready yet - normal at this stage: most remaining cases wait for servers not built yet.",
                 "BLOCKED": "BLOCKED by a release blocker: " + ", ".join(summary["blockers"])}[summary["gate"]]
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Adhvaga test run</title><style>{CSS}</style></head><body>
<h1>Adhvaga - test run</h1><div class="sub">{e(summary['started'][:16].replace('T', ' '))} UTC &middot; code version {e(summary['app_version'])} &middot; 100 cases from the Phase 0 spec</div>
<div class="box"><b>In one line:</b> {t['pass'] + t['partial']} cases run today and every code check passes ({t['fail']} failures, {len(summary['blockers'])} release blockers).
{t['not_yet']} cases wait for parts not built yet (train / metro / flight servers, rule library, the AI agent). Release gate: <b>{e(summary['gate'])}</b> - {e(gate_line)}</div>
<div class="stats"><div class="stat"><b>{t['pass']}</b>pass</div><div class="stat"><b>{t['partial']}</b>pass (trip part)</div>
<div class="stat"><b>{t['fail'] + t['error']}</b>fail</div><div class="stat"><b>{t['not_yet']}</b>not built yet</div></div>
<h2>What the words mean</h2><table><tr><th>Result</th><th>Meaning</th></tr>
<tr><td class=pass>Pass</td><td>The whole case ran and every code check passed</td></tr>
<tr><td class=partial>Pass (trip part)</td><td>The trip server's part passed; the rest needs search, live data or the AI agent (later phases)</td></tr>
<tr><td class=fail>FAIL</td><td>A code check failed</td></tr><tr><td class=not_yet>Not built yet</td><td>Waits for a server or the agent; shown, never counted as a pass</td></tr></table>
<h2>By group</h2><table><tr><th>Group</th><th>Cases</th><th>Pass</th><th>Trip part</th><th>Fail</th><th>Not yet</th></tr>{rows_g}</table>
<p>Release rule: {e(summary['gate_rule'])}.</p>
<h2>Every case</h2><table><tr><th>ID</th><th>Case</th><th>Result</th><th>Notes</th></tr>{rows_c}</table></body></html>"""


def main() -> int:
    root = Path(__file__).resolve().parents[1] / "results"
    summary = json.loads((root / "latest.json").read_text(encoding="utf-8"))
    out = root / "latest.html"
    out.write_text(build(summary), encoding="ascii", errors="xmlcharrefreplace")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
