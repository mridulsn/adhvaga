# Adhvaga

An AI travel command centre for trips inside India. It plans across trains, flights, buses and metro, keeps the
bookings and the budget in one place, and when a leg breaks (train cancelled, flight late) it works out what else
breaks and **proposes** a new version of the trip. You approve or reject. It never books, pays or cancels anything.

The AI chooses which tools to call; **code enforces the rules** (budget ceiling, arrive-by time, connection gaps,
permissions). Every answer says how far it can be trusted: Live, Timetable, Estimated, Simulated, You entered or
Unavailable.

Made with AI (Claude Code), from a written PRD and 100 test cases that came first.

## Status (9 Nov 2026)

| Part | State |
|---|---|
| Phase 0: PRD, registers, 100 test specs | Done (`specs/`) |
| Trip server (plan, versions, budget, rules, approvals) | Done locally: 27 MCP tools, 49 tests (PGlite stands in for Postgres) |
| Metro server (Kochi, Hyderabad) | Done, **live**: 4 read-only tools, official timetables, 29 tests |
| Buses server (simulated intercity buses + buses you booked) | Done, **live**: 3 read-only tools, 13 tests |
| Knowledge server (official rules, RAG) | Done, **live**: 3 read-only tools, 3 official documents, 16 tests |
| Test runner (Python) | Done: 100 spec cases over MCP. Latest: **49 pass, 22 partial, 0 fail, 29 not built yet, 0 release blockers** |
| Trains server | Waiting for a RailRadar key |
| Flights server | Later (AviationStack key) |
| Hosted Postgres, website and AI agent | Next |

Live read-only MCP servers: **https://adhvaga-mcp.vercel.app** (`/api/metro`, `/api/buses`, `/api/knowledge`).

## How it fits together

```
You -> website -> AI agent (Groq) -> MCP servers -> one Postgres
                                     |- Trip       plan, legs, links, versions, budget, rules, approvals, event log
                                     |- Metro      official metro timetables (GTFS)
                                     |- Buses      simulated intercity buses, buses you booked
                                     |- Knowledge  official rules quoted word for word
                                     |- Trains     (next)   |- Flights (later)
```

All servers share one answer format (the envelope): `status`, `source`, `label`, `retrieved_at`, `data_as_of`,
`confidence {level, reasons}`, `data`, `error`. A source that is down answers `unavailable`, never "none found".

## Servers

Each server is TypeScript run directly by Node 24 (no build step):

    cd servers/<name>
    npm install
    npm test
    npm run typecheck
    node src/server.ts        # stdio MCP server (for Claude Code or any MCP client)

### Trip (`servers/trip`)

Roles: `public` (read only, default), `agent` (can propose, cannot approve or change the budget ceiling), `user`
(can approve). Run for Claude Code: `ADHVAGA_STDIO_ROLE=user ADHVAGA_PGLITE_DIR=../../data/pglite node src/server.ts`.

- Money is integer paise. Refund pending is never counted as cash.
- Versions are immutable. A replan saves a proposed version; rejecting leaves the approved one byte-identical.
- Every write needs a one-time key; a retry with the same key returns the first answer.
- Book / pay / cancel-real-booking / claim / card tools do not exist.
- No PNR, names, phone numbers or card details are stored; such text is refused.

### Metro (`servers/metro`)

A generic GTFS loader plus one folder per city under `feeds/`: **Kochi** (KMRL, 25 stations) and **Hyderabad**
(HMRL, 57 stations, 3 lines). Contains data provided by Kochi Metro Rail Limited. Contains data provided by
Hyderabad Metro Rail Ltd. Each `feeds/<city>/SOURCE.md` says where the copy came from and its terms.

**Timetable** only for dates inside the feed's own calendar; other dates are **Estimated** with the reason. Fares are
always Estimated. Never Live. Feed mistakes are corrected in memory, never in the files, and each answer lists them.

### Buses (`servers/buses`)

India has no free intercity bus data, so `search_buses` returns **made-up demo buses**: always labelled Simulated,
low confidence, in a separate `demo_options` group, never a verified replacement. They are repeatable (same
search and date, same buses) so tests and evals are stable. `add_user_bus` turns a bus you booked into a leg
labelled You entered.

### Knowledge (`servers/knowledge`)

The rule library is cut **word for word** from official sources by `tools/build_library.py`, which fails if a
source changes instead of quoting wrongly:

| Document | Authority | Version |
|---|---|---|
| CAR Section 3, Series M, Part IV (denied boarding, cancellations, delays) | DGCA | Rev. 4, 25 Jan 2023, effective 15 Feb 2023 |
| Revised Refund Rules w.e.f. 12.11.2015 | Indian Railways (indianrail.gov.in) | 2015 (old and new rows kept; old marked replaced) |
| Procedure for Cancellation of E-Tickets | IRCTC | page undated |

`search_rules` keeps **what the rule says** apart from **whether it fits your booking**, asks when that depends on
facts it does not know (ticket type, who cancelled, notice given), never uses a replaced passage as the current
rule, says "I could not find this rule" when nothing covers the question, and does not give legal advice.
Word search with an everyday-word synonym list today; meaning search (pgvector) comes with the hosted database.

## Test runner (`harness/`)

Python, official MCP SDK. Starts every server, runs the 100 cases in `specs/adhvaga-tests-v1.json`, and decides
pass/fail with code checks. A failed check raises a release blocker only if the case lists that blocker. Cases
needing later parts are reported as "not built yet", never as passes.

    cd harness
    python -m venv .venv && .venv\Scripts\pip install mcp
    .venv\Scripts\python run_tests.py              # all 100, saves results/latest.json
    .venv\Scripts\python run_tests.py T06-01       # selected cases
    .venv\Scripts\python -m adhvaga_harness.report  # results/latest.html

Release gate: 0 blockers, at least 90 full passes, no group worse than the last run.

## Hosting (`deploy/`)

`npm run bundle` bundles the read-only servers into Vercel functions (`api/metro.js`, `api/buses.js`,
`api/knowledge.js`): stateless Streamable HTTP, open CORS, a per-instance rate limit, data under `api/_data`
(never served). `npm run local` serves the same handlers on 127.0.0.1:8790.

## Data and attribution

- Contains data provided by Kochi Metro Rail Limited. Contains data provided by Hyderabad Metro Rail Ltd.
  Adhvaga is not endorsed by either.
- Rule passages are quoted from DGCA, Indian Railways and IRCTC public pages, with links, versions and fetch dates.
- Intercity buses are simulated and labelled as such.
