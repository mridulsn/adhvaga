---
project: Adhvaga
type: registers (source, policy, cost)
created: 2026-11-07
session: 7130999c-ce97-4243-8747-e1bccc5b145a
resume: claude --resume 7130999c-ce97-4243-8747-e1bccc5b145a
---

# Adhvaga - Registers

**Summary.** Every provider Adhvaga will use, checked live on **7 Nov 2026**. Two surprises: the train API
(RailRadar) and the flight API (AviationStack) each allow only **100 free requests a month**, so Adhvaga must
cache answers and show "Unavailable (QUOTA)" when the allowance runs out. The Delhi Metro timetable is official
open data but was last updated in Aug 2023 and its download form needs his email and terms acceptance.

"Test call" column: a real call with his key is still pending for every provider (no keys yet). A source goes
live in Adhvaga only after its row is complete **and** its test call passes.

**Old timetable rule (8 Nov 2026, applies to every city).** A published timetable is labelled **Timetable** only for dates inside the feed's own calendar. For a date outside it (Kochi ends 31 Dec 2025; Delhi's feed is from Aug 2023), Adhvaga uses the same weekday pattern, labels it **Estimated**, says "old timetable valid to <date>, pattern carried forward", and confidence is low. Metro fares from a feed are always **Estimated** (method: operator fare chart, with its date).


---

## 1. Source register

| Provider | Used for | Endpoint (checked) | Live / timetable | Free limit (checked 7 Nov 2026) | Sign-in | Known gaps | If it fails, user sees | Test call |
|---|---|---|---|---|---|---|---|---|
| **RailRadar** | Trains: search, live status, cancellations | `https://api.railradar.in/v1` - `/trains/between/{from}/{to}?date=&live=`, `/trains/{no}/live`, `/trains/exceptions`, `/lookup/search/stations` | Timetable (live=false) and Live (live=true, NTES-based) | **100 requests / month**, 10 / min. No overage charge; 429 when used up. Headers `X-RateLimit-Remaining-Month` | Key from railradar.in (his sign-in). `Authorization: Bearer <key>` | Independent, not IRCTC. Fare / seat endpoints are third-party, "not authoritative" | Train status "Unavailable (QUOTA)" or "(timeout)"; cached timetable still shown with its age | Pending key |
| IRCTC1 (RapidAPI) | Backup for trains | To verify in Phase 2 | - | To check | RapidAPI sign-up | Unofficial | as above | Not started |
| **AviationStack** | Flight status | `https://api.aviationstack.com/v1/flights` (to confirm on key) | Live status | **100 requests / month** (official pricing page). Paid starts $49.99/mo for 10,000 | Sign-up with email | Free plan may be HTTP-only and lack some filters - verify on key | "Flight status unavailable (QUOTA)" | Pending key |
| Flight fare table | Flight fares | Adhvaga's own table (route distance bands) | Estimated | n/a | none | Not real prices | Label Estimated with method | Write in Phase 3 |
| **Delhi Metro (DMRC) GTFS** | Metro routes, timetable | `https://otd.delhi.gov.in/data/staticDMRC/` (POST form) | Timetable | Free | Form: usage type, purpose, **email**, accept OTD terms | 262 stations, 36 routes, **last updated 10 Aug 2023** - newer stations missing | "No verified data for this station yet" | Needs his download |
| Delhi Metro (backup copy) | Same | Codeberg `eternaltyro/india-transit-data` (third-party) | Timetable | Free | none | Unofficial copy; licence to check | same | Not started |
| **Kochi Metro (KMRL) GTFS** | Kochi metro | Official zip `kochimetro.org/opendata/KMRLOpenData.zip` (via tinyurl.com/kmrlopendata) did NOT answer on 7 or 8 Nov. Copy used: Mobility Database mirror `files.mobilitydatabase.org/tld-1031/latest.zip` (mirror Last-Modified 3 Apr 2025, sha256 `26347766...b158`; KMRL-authored files dated 9 Aug 2024) | Timetable inside its dates, Estimated outside | Free | none | 25 stations Aluva - Tripunithura, 1 line, 450 trips. **Calendar valid 12 Aug 2024 - 31 Dec 2025 only, so every 2026 date is Estimated (old pattern).** No live data. Terms (KMRL ToU PDF, 2024 copy via Wayback): free, commercial OK, redistribution OK; must show "Contains data provided by Kochi Metro Rail Limited"; must not suggest KMRL endorsement; must not alter data to mislead | "No verified data for this station yet"; old-pattern times say so | **Loaded 8 Nov** (Metro server) |
| Bengaluru Metro (BMRCL) | Bengaluru metro | Unofficial GTFS on GitHub `Vonter/bmrcl-gtfs` (built from OSM + BMRCL timetable images) | Timetable (unofficial) | Free | none | No official feed found | labelled "unofficial timetable" | Phase 3 |
| Delhi buses (DTC GTFS) | City bus | `otd.delhi.gov.in` static + realtime | Timetable (+ Live via realtime key) | Free | Static: form; realtime: key | - | same | Phase 3 |
| Hyderabad Metro (HMRL) GTFS | Hyderabad metro | Official, listed active in Mobility Database (`mdb-2457`, Google Drive link from hmrl.co.in/open-data.html); no form | Timetable | Free | none | Licence at hmrl.co.in/open-data.html - to read | same | **Next city to load** (not started) |
| Other metros (Mumbai, Chennai, Kolkata, Pune, Ahmedabad, Lucknow, Jaipur, Nagpur, Kanpur, Agra, Bhopal, Indore, Navi Mumbai, Meerut) | Metro | Each checked one by one in Phase 3 | Timetable if open data, else station list + Estimated gaps | - | - | Never Live | "No verified data yet" until checked | Phase 3 |
| Intercity buses | Buses | None (no free API in India) | **Simulated** + You entered | n/a | none | Not bookable, never ranked above verified | Shown only in "demo options" | n/a |
| **Groq** | AI agent + wording judge | `https://api.groq.com/openai/v1` | n/a | About 1,000 requests/day and 100K tokens/day on Llama 3.3 70B; 14,400/day on Llama 3.1 8B (third-party copies of Groq's table, Aug-Sep 2026; confirm on his limits page) | Sign-up | Limits are per organisation, not per key | "AI busy, try in a minute"; rules still work | Pending key |
| **Neon Postgres** | The one database (+ pgvector) | Neon free project | n/a | 1 GB storage / project, 100 CU-hours / month, 5 GB transfer, scale-to-zero after 5 min, **no overage billing**, no card (official FAQ updated 1 Oct 2026) | Sign-up | Cold start after idle | Writes refused with clear message when full; reads continue | Pending sign-up |
| **Vercel Hobby** | 6 MCP servers | - | n/a | Free, non-commercial use (portfolio is fine) - confirm limits at sign-up | Sign-up | Function timeouts | Servers pause; sources show Unavailable | Pending |
| Embedding model | Meaning search (RAG) | Recommend a small open model run inside our own code (no key, no limit) - to choose in Phase 4 | n/a | Free | none | - | Falls back to word search | Phase 4 |

## 2. Policy register (Knowledge server, Phase 4)

Each document is stored with: title, issuing authority, official link, published / effective date, fetch date,
whole sections with headings, conditions and exceptions, and "replaced by" if superseded. Links are confirmed
from the official site when fetched in Phase 4; none are assumed now.

| Document | Authority | What it answers | Status |
|---|---|---|---|
| Railway Passengers (Cancellation of Ticket and Refund of Fare) Rules, latest amended version | Ministry of Railways / IRCTC | Cancellation charges, refunds, cancelled / late trains | To fetch, check current amendment |
| TDR filing rules (IRCTC e-tickets) | IRCTC | When a TDR is needed, deadlines | To fetch |
| DGCA Civil Aviation Requirement on facilities for passengers affected by denied boarding, cancellations and delays | DGCA | Flight cancellation / delay compensation and facilities | To fetch, check latest revision |
| DGCA Passenger Charter | DGCA / MoCA | Plain-language passenger rights | To fetch |
| Airline conditions of carriage (largest domestic airlines) | Each airline | Change / cancellation terms | To fetch, one per airline |
| Metro passenger rules per city (Delhi first) | Each metro | Ticket validity, refunds of cards / tokens, baggage | To fetch |

Rule: Adhvaga always keeps **"what the rule says"** apart from **"whether it seems to fit your booking"**, and
asks when the ticket type or booking channel is unknown. The old example "cancelled train = full refund, no TDR"
is removed.

## 3. Cost register

Rs 0 is the target, not a promise. No card and no paid plan without his OK.

| Service | Free allowance | Expected use (demo + tests) | When the free limit runs out | Card / auto-charge |
|---|---|---|---|---|
| RailRadar | 100 req / month | ~40-60 (register test, golden journey, demos; tests use recorded answers) | 429; Adhvaga shows Unavailable (QUOTA), cached timetable stays | No overage charges (official) |
| AviationStack | 100 req / month | ~20-40 | Same | Free plan, no card expected - confirm |
| Groq | ~1,000 req / day (70B) | 100-case eval run ~ 300-600 calls; run evals on the 8B model for wording-judge to save quota | "AI busy" | No card unless he upgrades |
| Neon | 1 GB, 100 CU-h / month | Small (trips, cache, documents) | Writes refused; no bill on Free | No card |
| Vercel Hobby | Hobby limits | 6 small functions | Paused | Expected no card - confirm |
| Embeddings | Local model | n/a | n/a | n/a |
| Emergent | His free credits | 4 rounds | Wait for credits; never re-send blindly | His credits |

## 4. Sources (checked 7 Nov 2026)

- RailRadar docs, rate limits, pricing: https://railradar.in/docs , https://railradar.in/docs/rate-limits , https://railradar.in/pricing
- AviationStack pricing: https://aviationstack.com/pricing
- Neon free plan FAQ: https://neon.com/faqs/free-plan-limits-and-quotas
- Groq limits (third-party copies; confirm on console): https://localaimaster.com/blog/groq-api-free-guide , https://openrouter.ai/blog/tutorials/free-llm-apis-compared/
- Delhi OTD portal: https://otd.delhi.gov.in/data/staticDMRC/ , https://otd.delhi.gov.in/documentation
- Kochi Metro open data: https://kochimetro.org/open-data
- Mobility Database catalogue (mirrors of official feeds): https://files.mobilitydatabase.org/feeds_v2.csv
- KMRL terms of use (2024 copy): http://web.archive.org/web/20240703051333/https://kochimetro.org/opendata/TermsOfUse.pdf
- Bengaluru unofficial GTFS: https://groups.google.com/g/datameet/c/h5uI8DMlgi4
- OSM list of GTFS feeds: https://wiki.openstreetmap.org/wiki/List_of_GTFS_feeds
