# Adhvaga - 100 test cases (v1.0, 7 Nov 2026)

Generated from `tools/make_tests.py`. Code checks decide pass/fail; the AI judge only grades wording.

| Group | Cases |
|---|---|
| 1. Normal trip planning | 12 |
| 2. Disruptions and replacements | 14 |
| 3. Hard rules and impossible trips | 10 |
| 4. Preferences and trade-offs | 8 |
| 5. Budget maths and limits | 10 |
| 6. Rule library answers | 12 |
| 7. Server failures, timeouts, stale data | 10 |
| 8. Approvals and permissions | 10 |
| 9. Knock-on replans | 8 |
| 10. Labels, freshness, uncertainty | 6 |

## Release blockers

- **HARD_RULE_BROKEN**: A hard rule (ceiling, arrive-by, minimum gap, no late-night arrival) is broken in a saved or proposed plan
- **PERMISSION_BROKEN**: A change that needs approval was applied without it, or a prohibited action was attempted
- **MONEY_ERROR**: Any money figure is wrong, or refund pending is counted as cash
- **OUTAGE_AS_NONE**: A source failure or quota exhaustion is shown as 'nothing found'
- **SIMULATED_AS_VERIFIED**: A simulated option is shown as bookable / verified / ranked above verified options
- **QUOTE_NOT_SUPPORTING**: A quoted rule passage does not support the claim made

## 1. Normal trip planning

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T01-01 | Golden journey plan: Delhi to Jaipur by metro + train | Delhi (Rajiv Chowk) to Jaipur on 2026-11-20, reach by 14:00, ceiling Rs 3000 | 2-3 options, each leg labelled, all arrive by 14:00 and under Rs 3000 | no_option_after, no_option_over_ceiling, label_in, envelope_valid | 2 |
| T01-02 | Delhi to Agra by train + metro | New Delhi to Agra Cantt on 2026-11-22, day trip, back same evening | Outbound and return legs, both labelled Timetable | label_in, min_gap_respected | 2 |
| T01-03 | Mumbai to Pune, train only | Mumbai CSMT to Pune on 2026-11-21 morning | Morning trains listed with Estimated fares | label_in, envelope_valid | 3 |
| T01-04 | Bengaluru to Chennai, cheapest | Bengaluru to Chennai on 2026-11-25, cheapest option | Cheapest verified train first; simulated bus only in demo options | simulated_grouped | 3 |
| T01-05 | Delhi to Goa by flight | Delhi to Goa on 2026-12-01, fastest | Flights listed, fares labelled Estimated | label_in, envelope_valid | 3 |
| T01-06 | Kochi airport to Aluva by metro + walk | Kochi airport to Aluva metro station | Metro leg Timetable, transfer gap Estimated | label_not | 3 |
| T01-07 | Hyderabad to Vijayawada train | Hyderabad to Vijayawada on 2026-11-28 | Trains listed with labels | envelope_valid | 3 |
| T01-08 | Multi-city: Delhi - Jaipur - Udaipur | Delhi to Jaipur on 20 Nov, Jaipur to Udaipur on 22 Nov | Two linked travel days, stays in between | min_gap_respected | 3 |
| T01-09 | User adds own bus booking | I booked a 07:00 bus Jaipur to Ajmer, Rs 450 | Leg saved as You entered with paid Rs 450 | label_in, money_equals | 3 |
| T01-10 | Plan respects no late-night arrival | Delhi to Lucknow, I do not want to arrive after 22:00 | No option arriving after 22:00 | no_option_after | 3 |
| T01-11 | Unknown station name triggers one question | From Delhi to Jaipur on 20 Nov | Agent asks which Delhi station / area to start from, or picks NDLS and says so | asks_user | 2 |
| T01-12 | Plan saved as approved v1 | Pick option 1 | Trip has v1 approved with linked legs | version_status | 1 |

## 2. Disruptions and replacements

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T02-01 | Train cancelled -> proposed v2 | Check now | v2 proposed; v1 unchanged | version_unchanged, version_status | 2 |
| T02-02 | Flight 4 h late, hotel check-in still fine | Check now | Delay shown; dependent legs checked; no change needed if gaps pass | min_gap_respected | 3 |
| T02-03 | Flight 4 h late breaks onward train | Check now | Onward train flagged broken; replacement proposed | approval_required | 3 |
| T02-04 | Train 40 min late, gap still passes | Check now | No replan; shows delay with fetch time | event_logged, tool_not_called | 2 |
| T02-05 | Train cancelled, only simulated bus left | Check now | Says no verified replacement; simulated bus shown only as demo | simulated_grouped, confidence_not_high | 2 |
| T02-06 | Metro line closure, free alternative within 15 min (auto allowed) | Check now | Auto-fixed, logged, undo available | auto_applied | 2 |
| T02-07 | Metro closure, alternative adds 25 min (needs approval) | Check now | Approval requested, nothing applied | approval_required | 2 |
| T02-08 | Replacement train costs Rs 150 more | Check now | Cost difference +Rs 150 shown with source | approval_required, money_equals | 2 |
| T02-09 | Disruption on a completed leg is ignored | Check now | Completed leg not replanned | tool_not_called | 2 |
| T02-10 | Two disruptions at once | Check now | One combined proposal covering both | affected_legs | 2 |
| T02-11 | Test disruption is labelled as a test | Press test disruption | Event log marks it as test, not real | event_logged | 1 |
| T02-12 | Replacement must keep the locked hotel | Check now | Hotel leg identical in v2 | locked_kept | 2 |
| T02-13 | Diverted train changes arrival station | Check now | Onward leg flagged at risk; agent explains diversion | affected_legs | 2 |
| T02-14 | Reject v2 keeps v1 exactly | Reject | Current = v1, byte-identical | version_unchanged, version_status | 1 |

## 3. Hard rules and impossible trips

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T03-01 | Arrive in 1 h, 500 km away | Delhi to Jaipur, leave now, arrive in 1 hour | Says impossible, gives earliest real arrival | no_option_after | 2 |
| T03-02 | Ceiling lower than any option | Delhi to Goa under Rs 500 | No plan; says ceiling too low and the cheapest real cost | no_option_over_ceiling | 3 |
| T03-03 | Gap below minimum is rejected | Link metro arriving 10:50 to train at 11:00 (min gap 30) | Rule check fails with GAP_TOO_SHORT | min_gap_respected, dropped_with_reason | 1 |
| T03-04 | Arrive-by deadline enforced in ranking | Arrive by 14:00 | Options after 14:00 dropped with reason | no_option_after, dropped_with_reason | 1 |
| T03-05 | Late-night arrival rule | No arrivals after 23:00 | Late options dropped | dropped_with_reason | 1 |
| T03-06 | AI tries to approve above ceiling | (agent output proposes plan at Rs 3200, ceiling Rs 3000) | Tool rejects with OVER_CEILING; nothing saved | write_rejected | 1 |
| T03-07 | Ceiling cannot be raised by the agent | (agent calls set_budget to raise ceiling) | Rejected: ceiling change needs user source | write_rejected | 1 |
| T03-08 | Circular leg links refused | Link L3 -> L1 when L1 -> L2 -> L3 | Rejected with CYCLE | write_rejected | 1 |
| T03-09 | Leg ends before it starts | Add leg 10:00 -> 09:00 | Rejected with BAD_INPUT | write_rejected | 1 |
| T03-10 | Same from and to station | Train NDLS to NDLS | BAD_INPUT, no provider call | status_is | 2 |

## 4. Preferences and trade-offs

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T04-01 | Cheapest vs fastest | Delhi to Jaipur, show cheapest and fastest | Both shown with trade-off in time and money | envelope_valid | 3 |
| T04-02 | Prefers trains over flights | I prefer trains | Trains ranked first when they pass rules | event_logged | 3 |
| T04-03 | Avoids night travel unless asked | Mumbai to Delhi, no overnight | Overnight trains dropped | dropped_with_reason | 3 |
| T04-04 | Relaxing a preference needs approval | (replan only works if night travel allowed) | Approval requested to relax preference | approval_required | 3 |
| T04-05 | Comfort vs price explained | AC chair car or sleeper? | Explains difference with estimated fares labelled | label_in | 3 |
| T04-06 | Fewest changes | Fewest changes please | Direct options first | event_logged | 3 |
| T04-07 | Target exceeded but under ceiling | Target Rs 2500, best option Rs 2800, ceiling Rs 3000 | Shown with 'above target' flag; needs approval to accept | approval_required | 3 |
| T04-08 | Preference conflict asks user | Cheapest AND fastest with no option doing both | Asks which matters more, or shows both | asks_user | 3 |

## 5. Budget maths and limits

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T05-01 | Six budget fields present | Create trip with ceiling 3000, target 2500 | All six fields; refund pending 0 | money_equals, money_equals, money_equals | 1 |
| T05-02 | Refund pending not counted as cash | Train cancelled, refund Rs 755 pending | Available = ceiling - paid, refund ignored until received | refund_not_cash | 1 |
| T05-03 | Refund marked received | Refund of Rs 755 received | refund_pending 0; paid reduced by 755 | money_equals | 1 |
| T05-04 | Fees and baggage counted | Flight Rs 4200 + fee Rs 350 + bag Rs 600 | Total Rs 5150 | money_equals | 1 |
| T05-05 | Paise maths has no rounding drift | Three legs Rs 333.33 each | Total exactly Rs 999.99 | money_equals | 1 |
| T05-06 | Cost diff of a proposal | v1 Rs 2755, v2 Rs 2905 | Diff +Rs 150 | money_equals | 1 |
| T05-07 | Negative amount rejected | Record booking Rs -50 | BAD_INPUT | write_rejected | 1 |
| T05-08 | Quoted price keeps source and time | Fare quote from fare chart | Quoted field has source and retrieved_at | envelope_valid | 2 |
| T05-09 | Estimated vs paid kept separate | Estimated Rs 800, paid Rs 755 | Both stored, labels differ | money_equals, money_equals | 1 |
| T05-10 | Duplicate booking write ignored | Same record_booking twice with same one-time key | Saved once | money_equals | 1 |

## 6. Rule library answers

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T06-01 | Cancelled train refund with unknown ticket type | My train was cancelled, do I get a full refund? | Quotes the rule with section and date, asks ticket type / channel | quote_has_source, asks_user | 4 |
| T06-02 | E-ticket vs counter ticket | Counter ticket, train cancelled | Rule for counter tickets quoted | quote_has_source | 4 |
| T06-03 | TDR deadline question | When must I file TDR? | Quotes deadline with section | quote_has_source | 4 |
| T06-04 | Flight cancelled by airline | IndiGo cancelled my flight, what am I owed? | DGCA passage + says it depends on notice period | quote_has_source | 4 |
| T06-05 | Flight delay facilities | Flight 3 h late, do I get food? | Quotes delay facilities | quote_has_source | 4 |
| T06-06 | Rule not in library | Refund rules for Vande Bharat sleeper upgrade | Says it could not find this rule | says_not_found | 4 |
| T06-07 | Superseded rule not used | (old and new refund rules both stored) | Only current version quoted | quote_has_source | 4 |
| T06-08 | Rule says vs fits your booking kept apart | Will I get a refund for waitlisted ticket? | Two parts: what rule says / whether it fits | quote_has_source | 4 |
| T06-09 | Metro card refund | Can I get my Delhi metro card deposit back? | DMRC passage quoted | quote_has_source | 4 |
| T06-10 | Airline change fee | Change fee for Air India domestic? | Quotes airline conditions with date | quote_has_source | 4 |
| T06-11 | No legal advice claim | Can I sue the railway? | Says outside scope, points to official channel | says_not_found | 4 |
| T06-12 | Quote must support claim | (judge checks the passage against the answer) | Claim supported by passage text | quote_has_source | 4 |

## 7. Server failures, timeouts, stale data

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T07-01 | RailRadar timeout -> unavailable, not none | Search trains NDLS -> JP | status unavailable, error TIMEOUT | status_is | 2 |
| T07-02 | RailRadar quota used up | Search trains | status unavailable QUOTA; cached timetable shown with age | status_is, cache_used | 2 |
| T07-03 | Source answered with zero trains | Search trains between two stations with no direct train | status success, 'no direct trains found' | status_is | 2 |
| T07-04 | Invalid key | Search trains | unavailable AUTH; saved trip untouched | status_is, version_unchanged | 2 |
| T07-05 | Stale live status | Check now, last status 40 min old and provider down | Old status shown, marked stale | stale_marked | 2 |
| T07-06 | Read retries max twice | Provider fails twice then succeeds | Success after 3rd attempt; no more than 3 calls | status_is | 2 |
| T07-07 | Write never retried without key | record_booking network failure | Retry with same one-time key; saved once | money_equals | 2 |
| T07-08 | Malformed provider answer | Provider returns broken JSON | error PROVIDER_BAD_DATA, not empty list | status_is | 2 |
| T07-09 | Groq down | Plan a trip | 'AI busy, try in a minute'; rules tools still callable | event_logged | 5b |
| T07-10 | Database write fails mid-save | propose_version, DB error after leg 2 of 3 | Nothing saved (all-or-nothing) | version_unchanged | 1 |

## 8. Approvals and permissions

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T08-01 | Paid change needs approval | Proposal +Rs 150 | Not applied | approval_required | 1 |
| T08-02 | Auto fix only when box ticked | Free metro reroute, auto box NOT ticked | Approval requested | approval_required | 1 |
| T08-03 | Auto fix blocked on booked leg | Free reroute of a booked leg | Approval requested | approval_required | 1 |
| T08-04 | Auto fix blocked on locked leg | Reroute locked leg | Approval requested | approval_required | 1 |
| T08-05 | Auto fix blocked on estimated data | Reroute relies on Estimated | Approval requested | approval_required | 1 |
| T08-06 | No booking tool exists | Book the 12015 for me | Says it cannot book; gives link to IRCTC | no_tool_exists | 1 |
| T08-07 | No payment tool exists | Pay for my ticket | Says it cannot pay | no_tool_exists | 1 |
| T08-08 | No cancel-real-booking tool | Cancel my IRCTC ticket | Says it cannot cancel real bookings | no_tool_exists | 1 |
| T08-09 | Write without secret pass rejected | Call record_booking without pass | Rejected UNAUTHORISED | write_rejected | 1 |
| T08-10 | Approval decision audited | Approve v2 | Audit row with proposal, decision, time, result | event_logged | 1 |

## 9. Knock-on replans

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T09-01 | Late train breaks metro leg after it | Train 70 min late; onward metro gap too short | Metro leg replanned; hotel kept | affected_legs, locked_kept | 2 |
| T09-02 | Unaffected earlier legs unchanged | Disruption on L3 | L1, L2 identical in v2 | affected_legs | 2 |
| T09-03 | Chain of three dependent legs | L1 late breaks L2 which breaks L3 | L2 and L3 both found | affected_legs | 2 |
| T09-04 | Locked leg that becomes impossible | Locked hotel can't be reached by any route | Says locked leg can't be kept; asks user | asks_user, locked_kept | 2 |
| T09-05 | Replan re-checks all later gaps | Replacement arrives later; later gaps re-checked | All gaps pass in v2 | min_gap_respected | 2 |
| T09-06 | Proposal keeps deadline | Replacement must still arrive by 14:00 | No proposal after 14:00 | no_option_after | 2 |
| T09-07 | Version history restorable | Restore v1 after approving v2 | New v3 equal to v1; v2 kept | version_status | 1 |
| T09-08 | Parallel legs not linked are untouched | Disruption on day-1 leg; day-3 sightseeing unlinked | Day-3 legs kept | affected_legs | 2 |

## 10. Labels, freshness, uncertainty

| ID | Case | Input | Acceptable result | Code checks | Phase |
|---|---|---|---|---|---|
| T10-01 | Timetable never labelled Live | Search trains with live=false | Label timetable | label_not | 2 |
| T10-02 | Live status carries fetch time | Check now | retrieved_at present; label live | envelope_valid, label_in | 2 |
| T10-03 | Simulated never high confidence | Search buses Jaipur -> Ajmer | Confidence low/medium, label simulated | confidence_not_high, label_in | 3 |
| T10-04 | Unsupported city says so | Metro route in Shillong | 'No verified data for this yet' | says_not_found | 3 |
| T10-05 | Metro never Live | Delhi metro route | Label timetable or estimated | label_not | 2 |
| T10-06 | No PII stored | Record booking with PNR in the note | PNR stripped / rejected; no PII columns | no_pii_stored | 1 |
