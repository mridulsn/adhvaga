# Adhvaga

India travel command centre: plans trips across trains, flights, buses and metro, tracks bookings and
budget, and proposes a new version of the trip when a leg breaks. You approve; it never books or pays.

Plan: `Claude Vault/Projects/Adhvaga/Adhvaga - Plan.md` (v2.1). Phase 0 specs: `specs/`.

## Status (7 Nov 2026)

| Phase | State |
|---|---|
| 0. PRD, registers, 100 test specs | Done (`specs/`) |
| 1. Trip server + database | Done locally: 27 MCP tools, 49 tests passing (PGlite stands in for Neon) |
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
