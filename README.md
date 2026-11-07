# Adhvaga

India travel command centre: plans trips across trains, flights, buses and metro, tracks bookings and
budget, and proposes a new version of the trip when a leg breaks. You approve; it never books or pays.

Plan: `Claude Vault/Projects/Adhvaga/Adhvaga - Plan.md` (v2.1). Phase 0 specs: `specs/`.

## Status (7 Nov 2026)

| Phase | State |
|---|---|
| 0. PRD, registers, 100 test specs | Done (`specs/`) |
| 1. Trip server + database | Done locally: 27 MCP tools, 49 tests passing (PGlite stands in for Neon) |
| Test runner (Python) | Done: runs the 100 spec cases over MCP. Latest: 37 pass, 18 pass (trip part), 0 fail, 45 not built yet, 0 blockers |
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

## Test runner (`harness/`)

Python, official MCP SDK. Starts the Trip server in TEST MODE (in-memory database; each call picks its
role and session through `_meta` - never enabled on a hosted server) and runs every case in
`specs/adhvaga-tests-v1.json`. Code checks decide pass/fail; a failed check raises a release blocker only if
the case lists that blocker. Cases needing later parts are shown as "not built yet", never as passes.

    cd harness
    python -m venv .venv && .venv\Scripts\pip install mcp
    .venv\Scripts\python run_tests.py              # all 100, saves results/latest.json
    .venv\Scripts\python run_tests.py T02-01       # selected cases
    .venv\Scripts\python -m adhvaga_harness.report  # results/latest.html

Release gate: 0 blockers, at least 90 full passes, no group worse than the last run.
