---
project: Adhvaga
type: prd
version: 1.0 (for plan v2.1)
created: 2026-11-07
status: draft - waiting for his sign-off
session: 7130999c-ce97-4243-8747-e1bccc5b145a
resume: claude --resume 7130999c-ce97-4243-8747-e1bccc5b145a
---

# Adhvaga - Product Requirements (PRD)

**Summary.** Adhvaga is a website with an AI travel assistant for trips inside India. It plans across trains,
flights, buses and metro, keeps your bookings and budget in one place, checks the status of your legs when you
press "Check now", and when a leg breaks it **proposes** a new version of the trip. You approve or reject.
It never books, pays or cancels anything.

| Item | Decision |
|---|---|
| What it is | A website (opens from a link, nothing to install) |
| Who it is for | (1) a traveller planning an India trip; (2) a hiring manager looking at an agentic-AI portfolio |
| Built from | 6 MCP servers (TypeScript, Vercel free) + website (Emergent, Python backend) + Groq AI + one Postgres |
| Scope | India-wide; trains, flights, buses, metro in all cities as far as open data allows; every result labelled |
| First proof | Golden journey Delhi -> Jaipur, end to end, in Claude Code, before any website work |

---

## 1. Problem and goal

**Problem.** An India trip often mixes a metro ride, a train and a hotel. When one leg breaks (train cancelled,
flight late) the traveller has to work out by hand what else breaks, search again, check the money and the
refund rule. Existing apps do one mode each.

**Goal.** One place that knows how the legs depend on each other, finds what a disruption breaks, searches
replacements, checks hard rules in code, and shows a clear "old plan vs new plan" for the traveller to approve.

**Portfolio goal.** Show 10 skills in one working product: AI architecture, MCP, RAG, orchestration,
Python + TypeScript, APIs + databases, business rules, evals, human-in-the-loop, PRD + journeys.

## 2. Out of scope (on purpose)

- Booking, paying, cancelling real bookings, filing refund/TDR claims, storing cards. **No tool exists for these.**
- Accounts and sign-up in the first release (trips belong to the browser session).
- 24/7 background monitoring. Status is checked only when the user presses "Check now".
- Travel document wallet, traveller profile.
- Live bus data (no free intercity bus API in India; buses are Simulated or You entered).

## 3. Users and journeys

### Journey A - "Plan my trip" (traveller)
1. Opens the site, types: "Delhi to Jaipur on 20 Nov, reach by 2 pm, under Rs 3,000."
2. The agent asks one question if needed (e.g. starting point in Delhi).
3. Sees 2-3 options, each leg with its label (Live / Timetable / Estimated / Simulated / You entered / Unavailable),
   cost, time and the rules each option passes or fails.
4. Picks one. It becomes **v1 (approved)**. Records the train booking they made on IRCTC (number, date, price).
5. Sets the budget: hard ceiling Rs 3,000, target Rs 2,500.

**Success:** a saved v1 with linked legs, a budget, and no rule broken.

### Journey B - "Something broke" (traveller)
1. Presses "Check now". The train shows Cancelled (Live, fetched 09:12).
2. Adhvaga finds every later leg that depends on it, keeps locked legs (the hotel), searches replacements.
3. Code drops options that arrive after 2 pm or go over the ceiling, and says why in the event log.
4. A **proposed v2** appears in the Approvals inbox: Rs 150 more, changes a booked leg, so it needs approval.
5. User compares v1 and v2, approves. v2 becomes current; v1 stays in history. User books the replacement themselves.
6. If they reject, v1 is exactly as before.

**Success:** v2 proposed with reasons; nothing changed without approval; v1 untouched on reject.

### Journey C - "Show me how it works" (hiring manager)
1. Opens the Architecture page: website, agent, 6 MCP servers, one database.
2. Runs the demo trip with the "test disruption" button; watches the event log fill with real system events.
3. Opens the Evals page: latest run of the 100 cases, pass rate, release blockers, what changed since last run.
4. Opens "Data sources and health": each provider, its label, free limit and last check.
5. Optionally plugs the public read-only MCP links into Claude.

**Success:** they can see each of the 10 skills in under 5 minutes.

## 4. Golden journey script (Phase 2 milestone)

Run in Claude Code through the MCP servers only. Every step must pass before anything else is built.

| Step | Action | Server / tool | Must be true |
|---|---|---|---|
| G1 | Create trip "Delhi to Jaipur", date D, arrive-by 14:00, ceiling Rs 4,000, target Rs 3,000 (raised 7 Nov: with Rs 3,000 the honest replacement - Rs 755 already paid, refund not yet cash, plus Rs 905 new train - would breach the ceiling) | Trip: create_trip, set_budget, set_rules | Trip saved, 6 money fields present, refund pending = 0 |
| G2 | Metro leg: Rajiv Chowk -> New Delhi (Yellow line) | Metro: route_between_stations | Label Timetable or Estimated, never Live |
| G3 | Train leg: NDLS -> JP, departs after metro arrival + 30 min gap | Trains: search_trains | Timetable label; fares labelled Estimated |
| G4 | Hotel check-in in Jaipur 15:00, locked by user | Trip: add_leg (kind=stay), lock_leg | Lock saved |
| G5 | Link legs L1 -> L2 -> L3, minimum gaps set | Trip: link_legs | Rules check passes; v1 approved |
| G6 | Record booking for L2 (train no., date, Rs 755) | Trip: record_booking | Paid = 755, label You entered; no PNR field exists |
| G7 | Inject test disruption: L2 cancelled | Trip: inject_test_disruption | Event logged as test; L2 status cancelled |
| G8 | Find affected legs | Trip: find_affected_legs | broken = L2; kept_locked = L3 (downstream but locked, so kept); unaffected = L1 |
| G9 | Search replacements, check rules, rank | Trains + Buses + Trip: check_rules, rank_options | Options after 14:00 or over ceiling dropped with reason; simulated bus only in "demo options" |
| G10 | Propose v2 | Trip: propose_version | v1 unchanged; v2 status proposed; fare difference (+Rs 150) and cash difference (+Rs 905 while the Rs 755 refund is pending) both shown |
| G11 | Request approval (costs more, changes a booked leg) | Trip: request_approval | Approval required; no automatic apply |
| G12a | Reject | Trip: decide_approval | Current = v1, byte-identical to before |
| G12b | Approve (fresh run) | Trip: decide_approval | Current = v2; v1 kept in history; audit entry written |

## 5. Who does what (code vs AI vs library vs user)

| Work | Done by | Never done by |
|---|---|---|
| Input checks, money maths, hard rules, permissions, versions, leg links, saving | **Code** (Trip server) | AI |
| Understand request, pick tools and order, recover from failures, explain trade-offs, draft proposals | **AI agent** (Groq) | - |
| Find official rule passages with source, section, date, conditions | **Library** (Knowledge server, RAG) | Deciding alone a rule fits the ticket |
| Approve / reject changes, answer unknowns, book and pay on real sites | **You** | - |

Malformed AI output is rejected, retried once, then shown as an error. The AI cannot save anything except
through tools, and every tool checks rules in code.

## 6. Permission matrix

| Category | Exact conditions |
|---|---|
| Automatic | ALL true: user ticked "let Adhvaga fix local legs"; leg is metro / city bus / walk; unbooked; not locked; extra cost Rs 0; arrival at the next fixed point moves <= 15 min; every later gap and deadline passes; new option is Live or Timetable. Logged, one-tap undo |
| Needs approval | Anything else not prohibited: extra cost > Rs 0; above target (under ceiling); changes a booked leg; moves a stay/activity time; relaxes a preference; relies on Estimated or low-confidence data; arrival moves > 15 min |
| Prohibited | Pay, book, cancel real bookings, file claims, enter/store card details, exceed hard ceiling, claim something was done when only suggested. **No tool exists** |

## 7. Budget model (six fields)

| Field | Meaning | Rule in code |
|---|---|---|
| hard_ceiling | Most you will ever spend | No approved version may exceed it, even with approval. Only the user changes it |
| target | What you would like to spend | Above target needs approval |
| estimated | Adhvaga's forecast, with method | Label Estimated |
| quoted | Price a source returned | Stored with source and time |
| paid | What you say you paid | Label You entered |
| refund_pending | Money you may get back | **Never counted as cash** until marked received |

All money is stored as **integer paise** (no floating point). Trip cost = paid legs + quoted/estimated unpaid
legs + fees + local transfers. Cost differences are shown with where each number came from.

## 8. Data labels and the answer envelope

Six labels: **Live** (with fetch time), **Timetable** (not proof it runs today), **Estimated** (method shown),
**Simulated** (never bookable), **You entered**, **Unavailable** (source failed - different from "none found").

Every tool returns: `status` (success / partial / unavailable / error), `source`, `label`, `retrieved_at`,
`data_as_of`, `confidence` {level, reasons}, `data`, `error`. Live status older than 15 min is marked stale.
8 s timeout; reads retry at most twice with backoff; writes need a one-time key and never retry blindly.

## 9. Quota protection (new, from the 7 Nov source check)

RailRadar and AviationStack free plans each allow only **100 requests a month**. So:
- Every provider answer is cached in Postgres with its fetch time. Timetable answers are reused for 24 h;
  live status for 15 min.
- A request counter per provider; at 80% used the Data sources page shows a warning; at 100% tools return
  `unavailable` + `QUOTA` and the timetable copy is still shown (labelled Timetable, with its age).
- Tests never call real providers; they use recorded answers (fixtures). Only the register test calls use real keys.

## 10. Non-functional requirements

| Area | Requirement |
|---|---|
| Privacy | No PNR, names, phone numbers, card details or documents stored. Auto-delete 30 days after trip end. "Delete this trip" button |
| Security | Write tools need the secret pass; read tools public and rate-limited; keys only in Vercel/Emergent secrets |
| Reliability | Degraded mode: a down provider shows Unavailable, the rest works; saves are all-or-nothing |
| Honesty | Never claims nationwide live coverage; unsupported city/route says "no verified data yet" |
| Cost | Rs 0 target; no card or paid plan without his OK |
| Audit | Every approval, version change and automatic fix logged with time and reason |

## 11. Success measures (release)

1. Golden journey passes end to end in Claude Code.
2. At least 90 of 100 test cases pass, with **zero** release blockers.
3. Breaking a key gives "unavailable", not "none", and the saved trip is untouched.
4. No paid change applied without approval; nothing above the hard ceiling.
5. Rejecting a proposal leaves the approved plan exactly as before.
6. No key in the browser or GitHub; write tools refuse calls without the pass; "Delete this trip" works.

## 12. Open items for him

| # | Item | Why only he can do it |
|---|---|---|
| 1 | Sign off this PRD (or change it) | His product |
| 2 | RailRadar free key | Sign-in with his account |
| 3 | AviationStack free key | Sign-up with his email |
| 4 | Groq free key | Sign-up with his account |
| 5 | Neon free project | Sign-up with his account |
| 6 | Delhi Metro data download (OTD portal) | Form asks for an email and acceptance of their terms |
| 7 | Vercel + Emergent go | His accounts, his credits |
