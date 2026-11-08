# Adhvaga

India travel command centre: plans trips across trains, flights, buses and metro, tracks bookings and
budget, and proposes a new version of the trip when a leg breaks. You approve; it never books or pays.

Plan: `Claude Vault/Projects/Adhvaga/Adhvaga - Plan.md` (v2.1). Phase 0 specs: `specs/`.

## Status (8 Nov 2026)

| Phase | State |
|---|---|
| 0. PRD, registers, 100 test specs | Done (`specs/`) |
| 1. Trip server + database | Done locally: 27 MCP tools, 49 tests passing (PGlite stands in for Neon) |
| Metro server (Kochi, Hyderabad) | Done locally: 4 read-only MCP tools, real KMRL and HMRL timetables, 29 tests passing |
| Test runner (Python) | Done: runs the 100 spec cases over MCP (Trip + Metro). Latest: 38 pass, 21 partial, 0 fail, 41 not built yet, 0 blockers |
| 2. Golden journey with real Trains + Metro servers | Needs RailRadar key + Delhi Metro download |

## Trip server (`servers/trip`)

TypeScript run directly by Node 24 (no build step). Postgres via PGlite locally.

    cd servers/trip
    npm install
    npm test            # 49 tests, named after the spec IDs (T01-12, T03-06, ...)
    npm run typecheck

Run as an MCP server for Claude Code (stdio):

    ADHVAGA_STDIO_ROLE=user ADHVAGA_PGLITE_DIR=../../data/pglite node src/server.ts

Roles: `public` (read only, default), `agent` (can propose, cannot approve or change the budget ceiling),
`user` (can approve). Over HTTP (Phase 5) the role will come from the secret pass.

Key design points:
- Money is integer paise. Refund pending is never counted as cash.
- Versions are immutable. A replan saves a proposed version; rejecting leaves the approved one byte-identical.
- Status, locks and bookings are stored per leg_key outside the versions.
- Every write needs a one-time key; a retry with the same key returns the first answer.
- Book / pay / cancel-real-booking / claim / card tools do not exist.
- No PNR, names, phone numbers or card details are stored; such text is refused.

## Metro server (`servers/metro`)

Read-only. A generic GTFS loader plus one folder per city under `feeds/`. Loaded: **Kochi** (KMRL, 25 stations, 1 line)
and **Hyderabad** (HMRL, 57 stations, 3 lines). Contains data provided by Kochi Metro Rail Limited. Contains data
provided by Hyderabad Metro Rail Ltd. (Each `feeds/<city>/SOURCE.md` says where the copy came from.)

    cd servers/metro
    npm install
    npm test            # 29 tests
    node src/server.ts  # stdio MCP server

Tools: `list_cities`, `list_stations`, `find_station`, `route_between_stations` (returns a `trip_leg` ready for the
Trip server's `add_leg`).

Label rule (all cities): **Timetable** only for dates inside the feed's own calendar; any other date uses the same
weekday pattern and is **Estimated** with low confidence and the reason. Kochi's timetable ends 31 Dec 2025, so every
2026 answer is Estimated. Fares are always Estimated. Never Live. A city or station with no verified data is an
answer (`status success`, `found false`, code `NO_VERIFIED_DATA` / `STATION_NOT_FOUND` / `NO_SERVICE`), never a
failure. Changes between lines need at least 5 minutes.

Feed mistakes are corrected in memory only, never in the files, and each answer lists the correction
(`feed_fixes` in `src/cities.ts`). Hyderabad has two: the weekday timetable is marked as running every day
(taken as Monday to Friday), and the Parade Ground interchange is two unlinked stations (linked, 6 min walk).
Hyderabad fares use HMRL's May 2025 chart by track distance; near a zone edge the other possible fare is given too.

## Test runner (`harness/`)

Python, official MCP SDK. Starts the Metro server and the Trip server in TEST MODE (in-memory database; each call picks its
role and session through `_meta` - never enabled on a hosted server) and runs every case in
`specs/adhvaga-tests-v1.json`. Code checks decide pass/fail; a failed check raises a release blocker only if
the case lists that blocker. Cases needing later parts are shown as "not built yet", never as passes.

    cd harness
    python -m venv .venv && .venv\Scripts\pip install mcp
    .venv\Scripts\python run_tests.py              # all 100, saves results/latest.json
    .venv\Scripts\python run_tests.py T02-01       # selected cases
    .venv\Scripts\python -m adhvaga_harness.report  # results/latest.html

Release gate: 0 blockers, at least 90 full passes, no group worse than the last run.
