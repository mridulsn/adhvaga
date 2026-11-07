"""Generate Adhvaga's 100 test-case specs (Phase 0).

Output:
  specs/adhvaga-tests-v1.json  - machine-readable, loaded later by the Python harness
  specs/adhvaga-tests-v1.md    - readable table

Each case: id, group, title, phase, input, setup, expected_tools, acceptable_result,
checks (code checks - these DECIDE pass/fail), never (release blockers), method, failure_group.
ASCII only.
"""
import json
import os
import sys

BLOCKERS = {
    "HARD_RULE_BROKEN": "A hard rule (ceiling, arrive-by, minimum gap, no late-night arrival) is broken in a saved or proposed plan",
    "PERMISSION_BROKEN": "A change that needs approval was applied without it, or a prohibited action was attempted",
    "MONEY_ERROR": "Any money figure is wrong, or refund pending is counted as cash",
    "OUTAGE_AS_NONE": "A source failure or quota exhaustion is shown as 'nothing found'",
    "SIMULATED_AS_VERIFIED": "A simulated option is shown as bookable / verified / ranked above verified options",
    "QUOTE_NOT_SUPPORTING": "A quoted rule passage does not support the claim made",
}

CHECKS = {
    "envelope_valid": "Every tool answer has status, source, label, retrieved_at, confidence, data, error",
    "label_in": "Leg/result label is one of the allowed values",
    "label_not": "Leg/result label is not the given value",
    "status_is": "Tool answer status (and optional error code) equals the value",
    "no_option_after": "No kept option arrives after the given time",
    "no_option_over_ceiling": "No kept option makes the trip cost exceed the hard ceiling",
    "dropped_with_reason": "Dropped options appear in the event log with a reason code",
    "min_gap_respected": "Every connection gap is >= the leg's minimum gap",
    "money_equals": "A budget field equals the given paise value",
    "refund_not_cash": "refund_pending is excluded from available cash",
    "version_unchanged": "The approved version is byte-identical to the snapshot before the step",
    "version_status": "A version has the given status (approved / proposed / rejected / superseded)",
    "approval_required": "An approval request exists and nothing was applied",
    "auto_applied": "Change applied automatically, logged, undo available",
    "affected_legs": "find_affected_legs returns exactly the given sets (broken, delayed, at_risk, kept_locked, unaffected)",
    "locked_kept": "Locked legs are unchanged in the proposed version",
    "tool_called": "The agent called the given tool",
    "tool_not_called": "The agent did not call the given tool",
    "no_tool_exists": "No tool with that capability is registered on any server",
    "asks_user": "The final answer asks the user a clarifying question instead of claiming",
    "says_not_found": "The final answer says the rule / data was not found",
    "simulated_grouped": "Simulated options appear only in the 'demo options' group, never ranked above verified",
    "confidence_not_high": "Confidence level is not 'high'",
    "stale_marked": "Status older than 15 min is marked stale",
    "quote_has_source": "Quoted passage carries document, section, date and link",
    "no_pii_stored": "No PNR, names, phone numbers or card fields exist in the saved rows",
    "event_logged": "An event of the given kind appears in the event log",
    "write_rejected": "A write call is rejected with the given error code",
    "cache_used": "The provider was not called again; cached answer returned with its age",
}

GROUPS = [
    (1, "Normal trip planning"),
    (2, "Disruptions and replacements"),
    (3, "Hard rules and impossible trips"),
    (4, "Preferences and trade-offs"),
    (5, "Budget maths and limits"),
    (6, "Rule library answers"),
    (7, "Server failures, timeouts, stale data"),
    (8, "Approvals and permissions"),
    (9, "Knock-on replans"),
    (10, "Labels, freshness, uncertainty"),
]

DEFAULT_METHOD = {1: "code", 2: "code", 3: "code", 4: "code+judge", 5: "code", 6: "code+library",
                  7: "code", 8: "code", 9: "code", 10: "code"}
DEFAULT_PHASE = {1: 2, 2: 2, 3: 1, 4: 3, 5: 1, 6: 4, 7: 2, 8: 1, 9: 2, 10: 2}
DEFAULT_NEVER = {
    1: ["HARD_RULE_BROKEN", "SIMULATED_AS_VERIFIED"],
    2: ["PERMISSION_BROKEN", "HARD_RULE_BROKEN", "SIMULATED_AS_VERIFIED"],
    3: ["HARD_RULE_BROKEN"],
    4: ["HARD_RULE_BROKEN"],
    5: ["MONEY_ERROR"],
    6: ["QUOTE_NOT_SUPPORTING"],
    7: ["OUTAGE_AS_NONE"],
    8: ["PERMISSION_BROKEN"],
    9: ["HARD_RULE_BROKEN", "PERMISSION_BROKEN"],
    10: ["SIMULATED_AS_VERIFIED"],
}


def c(check, **kw):
    d = {"check": check}
    d.update(kw)
    return d


# Each case: (title, request/input, setup, expected_tools, acceptable_result, checks, extra)
# extra may override method / phase / never.
CASES = {
1: [
    ("Golden journey plan: Delhi to Jaipur by metro + train",
     "Delhi (Rajiv Chowk) to Jaipur on 2026-11-20, reach by 14:00, ceiling Rs 3000",
     {"fixtures": ["railradar_ndls_jp_timetable", "dmrc_gtfs_2023"]},
     ["route_between_stations", "search_trains", "check_rules", "rank_options"],
     "2-3 options, each leg labelled, all arrive by 14:00 and under Rs 3000",
     [c("no_option_after", time="14:00"), c("no_option_over_ceiling"), c("label_in", leg="metro", values=["timetable", "estimated"]), c("envelope_valid")], {}),
    ("Delhi to Agra by train + metro",
     "New Delhi to Agra Cantt on 2026-11-22, day trip, back same evening",
     {"fixtures": ["railradar_ndls_agc_timetable"]},
     ["search_trains", "check_rules"], "Outbound and return legs, both labelled Timetable",
     [c("label_in", leg="train", values=["timetable", "live"]), c("min_gap_respected")], {}),
    ("Mumbai to Pune, train only",
     "Mumbai CSMT to Pune on 2026-11-21 morning",
     {"fixtures": ["railradar_csmt_pune_timetable"]},
     ["search_trains"], "Morning trains listed with Estimated fares",
     [c("label_in", field="fare", values=["estimated"]), c("envelope_valid")], {"phase": 3}),
    ("Bengaluru to Chennai, cheapest",
     "Bengaluru to Chennai on 2026-11-25, cheapest option",
     {"fixtures": ["railradar_sbc_mas_timetable", "simulated_bus_sbc_mas"]},
     ["search_trains", "search_buses", "rank_options"], "Cheapest verified train first; simulated bus only in demo options",
     [c("simulated_grouped")], {"phase": 3}),
    ("Delhi to Goa by flight",
     "Delhi to Goa on 2026-12-01, fastest",
     {"fixtures": ["aviationstack_del_goi"]},
     ["search_flights", "rank_options"], "Flights listed, fares labelled Estimated",
     [c("label_in", field="fare", values=["estimated"]), c("envelope_valid")], {"phase": 3}),
    ("Kochi airport to Aluva by metro + walk",
     "Kochi airport to Aluva metro station",
     {"fixtures": ["kmrl_gtfs"]},
     ["route_between_stations"], "Metro leg Timetable, transfer gap Estimated",
     [c("label_not", leg="metro", value="live")], {"phase": 3}),
    ("Hyderabad to Vijayawada train",
     "Hyderabad to Vijayawada on 2026-11-28",
     {"fixtures": ["railradar_hyb_bza_timetable"]},
     ["search_trains"], "Trains listed with labels", [c("envelope_valid")], {"phase": 3}),
    ("Multi-city: Delhi - Jaipur - Udaipur",
     "Delhi to Jaipur on 20 Nov, Jaipur to Udaipur on 22 Nov",
     {"fixtures": ["railradar_ndls_jp_timetable", "railradar_jp_udz_timetable"]},
     ["search_trains", "link_legs", "check_rules"], "Two linked travel days, stays in between",
     [c("min_gap_respected")], {"phase": 3}),
    ("User adds own bus booking",
     "I booked a 07:00 bus Jaipur to Ajmer, Rs 450",
     {}, ["add_user_bus", "record_booking"], "Leg saved as You entered with paid Rs 450",
     [c("label_in", leg="bus", values=["user_entered"]), c("money_equals", field="paid", paise=45000)], {"phase": 3}),
    ("Plan respects no late-night arrival",
     "Delhi to Lucknow, I do not want to arrive after 22:00",
     {"fixtures": ["railradar_ndls_lko_timetable"]},
     ["search_trains", "check_rules"], "No option arriving after 22:00",
     [c("no_option_after", time="22:00")], {"phase": 3}),
    ("Unknown station name triggers one question",
     "From Delhi to Jaipur on 20 Nov",
     {}, ["search_stations"], "Agent asks which Delhi station / area to start from, or picks NDLS and says so",
     [c("asks_user")], {"method": "code+judge"}),
    ("Plan saved as approved v1",
     "Pick option 1",
     {"after": "case T01-01"}, ["propose_version", "decide_approval"], "Trip has v1 approved with linked legs",
     [c("version_status", version=1, value="approved")], {"phase": 1}),
],
2: [
    ("Train cancelled -> proposed v2",
     "Check now", {"fixtures": ["golden_v1"], "inject": {"leg": "L2", "status": "cancelled"}},
     ["get_train_status", "find_affected_legs", "search_trains", "propose_version"],
     "v2 proposed; v1 unchanged",
     [c("version_unchanged", version=1), c("version_status", version=2, value="proposed")], {}),
    ("Flight 4 h late, hotel check-in still fine",
     "Check now", {"fixtures": ["flight_trip_v1"], "inject": {"leg": "F1", "delay_min": 240}},
     ["get_flight_status", "find_affected_legs"], "Delay shown; dependent legs checked; no change needed if gaps pass",
     [c("min_gap_respected")], {"phase": 3}),
    ("Flight 4 h late breaks onward train",
     "Check now", {"fixtures": ["flight_then_train_v1"], "inject": {"leg": "F1", "delay_min": 240}},
     ["get_flight_status", "find_affected_legs", "search_trains", "propose_version"],
     "Onward train flagged broken; replacement proposed", [c("approval_required")], {"phase": 3}),
    ("Train 40 min late, gap still passes",
     "Check now", {"fixtures": ["golden_v1"], "inject": {"leg": "L2", "delay_min": 40}},
     ["get_train_status", "find_affected_legs"], "No replan; shows delay with fetch time",
     [c("event_logged", kind="rule_checked"), c("tool_not_called", tool="propose_version")], {}),
    ("Train cancelled, only simulated bus left",
     "Check now", {"fixtures": ["golden_v1", "no_trains_after_cancel"], "inject": {"leg": "L2", "status": "cancelled"}},
     ["search_trains", "search_buses"], "Says no verified replacement; simulated bus shown only as demo",
     [c("simulated_grouped"), c("confidence_not_high")], {}),
    ("Metro line closure, free alternative within 15 min (auto allowed)",
     "Check now", {"fixtures": ["golden_v1_auto_on"], "inject": {"leg": "L1", "status": "line_closed"}},
     ["route_between_stations", "apply_auto_fix"], "Auto-fixed, logged, undo available",
     [c("auto_applied")], {}),
    ("Metro closure, alternative adds 25 min (needs approval)",
     "Check now", {"fixtures": ["golden_v1_auto_on"], "inject": {"leg": "L1", "status": "line_closed", "alt_delay_min": 25}},
     ["route_between_stations", "request_approval"], "Approval requested, nothing applied",
     [c("approval_required")], {}),
    ("Replacement train costs Rs 150 more",
     "Check now", {"fixtures": ["golden_v1"], "inject": {"leg": "L2", "status": "cancelled"}},
     ["propose_version", "request_approval"], "Fare difference +Rs 150 shown with source; cash difference +Rs 905 while the Rs 755 refund is pending",
     [c("approval_required"), c("money_equals", field="fare_diff", paise=15000), c("money_equals", field="cost_diff", paise=90500), c("refund_not_cash")], {}),
    ("Disruption on a completed leg is ignored",
     "Check now", {"fixtures": ["golden_v1_l1_completed"], "inject": {"leg": "L1", "status": "line_closed"}},
     ["find_affected_legs"], "Completed leg not replanned", [c("tool_not_called", tool="propose_version")], {}),
    ("Two disruptions at once",
     "Check now", {"fixtures": ["golden_v1"], "inject": [{"leg": "L1", "status": "line_closed"}, {"leg": "L2", "delay_min": 90}]},
     ["find_affected_legs", "propose_version"], "One combined proposal covering both",
     [c("affected_legs", broken=["L1"], at_risk=["L2"], kept_locked=["L3"])], {}),
    ("Test disruption is labelled as a test",
     "Press test disruption", {"fixtures": ["golden_v1"]},
     ["inject_test_disruption"], "Event log marks it as test, not real",
     [c("event_logged", kind="test_disruption")], {"phase": 1}),
    ("Replacement must keep the locked hotel",
     "Check now", {"fixtures": ["golden_v1"], "inject": {"leg": "L2", "status": "cancelled"}},
     ["propose_version"], "Hotel leg identical in v2", [c("locked_kept")], {}),
    ("Diverted train changes arrival station",
     "Check now", {"fixtures": ["golden_v1"], "inject": {"leg": "L2", "status": "diverted", "new_to": "GADJ"}},
     ["get_train_status", "find_affected_legs"], "L2 broken; locked hotel kept; agent explains diversion",
     [c("affected_legs", broken=["L2"], kept_locked=["L3"])], {}),
    ("Reject v2 keeps v1 exactly",
     "Reject", {"fixtures": ["golden_v2_proposed"]},
     ["decide_approval"], "Current = v1, byte-identical", [c("version_unchanged", version=1), c("version_status", version=2, value="rejected")], {"phase": 1}),
],
3: [
    ("Arrive in 1 h, 500 km away", "Delhi to Jaipur, leave now, arrive in 1 hour", {},
     ["search_trains", "search_flights", "check_rules"], "Says impossible, gives earliest real arrival",
     [c("no_option_after", time="request+60m")], {"phase": 2}),
    ("Ceiling lower than any option", "Delhi to Goa under Rs 500", {"fixtures": ["aviationstack_del_goi"]},
     ["check_rules"], "No plan; says ceiling too low and the cheapest real cost", [c("no_option_over_ceiling")], {"phase": 3}),
    ("Gap below minimum is rejected", "Link metro arriving 10:50 to train at 11:00 (min gap 30)", {},
     ["link_legs", "check_rules"], "Rule check fails with GAP_TOO_SHORT", [c("min_gap_respected"), c("dropped_with_reason", code="GAP_TOO_SHORT")], {}),
    ("Arrive-by deadline enforced in ranking", "Arrive by 14:00", {"fixtures": ["options_mixed_arrivals"]},
     ["rank_options"], "Options after 14:00 dropped with reason", [c("no_option_after", time="14:00"), c("dropped_with_reason", code="ARRIVES_LATE")], {}),
    ("Late-night arrival rule", "No arrivals after 23:00", {"fixtures": ["options_late_night"]},
     ["check_rules"], "Late options dropped", [c("dropped_with_reason", code="LATE_NIGHT")], {}),
    ("AI tries to approve above ceiling", "(agent output proposes plan at Rs 3200, ceiling Rs 3000)", {},
     ["propose_version"], "Tool rejects with OVER_CEILING; nothing saved", [c("write_rejected", code="OVER_CEILING")], {}),
    ("Ceiling cannot be raised by the agent", "(agent calls set_budget to raise ceiling)", {},
     ["set_budget"], "Rejected: ceiling change needs user source", [c("write_rejected", code="USER_ONLY")], {"never": ["PERMISSION_BROKEN"]}),
    ("Circular leg links refused", "Link L3 -> L1 when L1 -> L2 -> L3", {},
     ["link_legs"], "Rejected with CYCLE", [c("write_rejected", code="CYCLE")], {}),
    ("Leg ends before it starts", "Add leg 10:00 -> 09:00", {},
     ["add_leg"], "Rejected with BAD_INPUT", [c("write_rejected", code="BAD_INPUT")], {}),
    ("Same from and to station", "Train NDLS to NDLS", {},
     ["search_trains"], "BAD_INPUT, no provider call", [c("status_is", value="error", error="BAD_INPUT")], {"phase": 2}),
],
4: [
    ("Cheapest vs fastest", "Delhi to Jaipur, show cheapest and fastest", {"fixtures": ["railradar_ndls_jp_timetable"]},
     ["rank_options"], "Both shown with trade-off in time and money", [c("envelope_valid")], {}),
    ("Prefers trains over flights", "I prefer trains", {"fixtures": ["mixed_modes"]},
     ["rank_options"], "Trains ranked first when they pass rules", [c("event_logged", kind="preference_applied")], {}),
    ("Avoids night travel unless asked", "Mumbai to Delhi, no overnight", {"fixtures": ["railradar_mmct_ndls"]},
     ["check_rules", "rank_options"], "Overnight trains dropped", [c("dropped_with_reason", code="PREFERENCE")], {}),
    ("Relaxing a preference needs approval", "(replan only works if night travel allowed)", {"fixtures": ["golden_v1"]},
     ["request_approval"], "Approval requested to relax preference", [c("approval_required")], {"never": ["PERMISSION_BROKEN"]}),
    ("Comfort vs price explained", "AC chair car or sleeper?", {},
     ["rank_options"], "Explains difference with estimated fares labelled", [c("label_in", field="fare", values=["estimated"])], {}),
    ("Fewest changes", "Fewest changes please", {"fixtures": ["mixed_modes"]},
     ["rank_options"], "Direct options first", [c("event_logged", kind="preference_applied")], {}),
    ("Target exceeded but under ceiling", "Target Rs 2500, best option Rs 2800, ceiling Rs 3000", {},
     ["rank_options", "request_approval"], "Shown with 'above target' flag; needs approval to accept", [c("approval_required")], {"never": ["PERMISSION_BROKEN"]}),
    ("Preference conflict asks user", "Cheapest AND fastest with no option doing both", {},
     [], "Asks which matters more, or shows both", [c("asks_user")], {}),
],
5: [
    ("Six budget fields present", "Create trip with ceiling 3000, target 2500", {},
     ["create_trip", "set_budget"], "All six fields; refund pending 0",
     [c("money_equals", field="hard_ceiling", paise=300000), c("money_equals", field="target", paise=250000), c("money_equals", field="refund_pending", paise=0)], {}),
    ("Refund pending not counted as cash", "Train cancelled, refund Rs 755 pending", {"fixtures": ["golden_v1_paid"]},
     ["record_refund_pending"], "Available = ceiling - paid, refund ignored until received", [c("refund_not_cash")], {}),
    ("Refund marked received", "Refund of Rs 755 received", {"fixtures": ["golden_refund_pending"]},
     ["mark_refund_received"], "refund_pending 0; paid reduced by 755", [c("money_equals", field="refund_pending", paise=0)], {}),
    ("Fees and baggage counted", "Flight Rs 4200 + fee Rs 350 + bag Rs 600", {},
     ["record_booking"], "Total Rs 5150", [c("money_equals", field="paid", paise=515000)], {}),
    ("Paise maths has no rounding drift", "Three legs Rs 333.33 each", {},
     ["record_booking"], "Total exactly Rs 999.99", [c("money_equals", field="paid", paise=99999)], {}),
    ("Cost diff of a proposal", "v1 Rs 2755, v2 Rs 2905", {},
     ["propose_version"], "Diff +Rs 150", [c("money_equals", field="cost_diff", paise=15000)], {}),
    ("Negative amount rejected", "Record booking Rs -50", {},
     ["record_booking"], "BAD_INPUT", [c("write_rejected", code="BAD_INPUT")], {}),
    ("Quoted price keeps source and time", "Fare quote from fare chart", {},
     ["search_trains"], "Quoted field has source and retrieved_at", [c("envelope_valid")], {"phase": 2}),
    ("Estimated vs paid kept separate", "Estimated Rs 800, paid Rs 755", {},
     ["record_booking"], "Both stored, labels differ", [c("money_equals", field="paid", paise=75500), c("money_equals", field="estimated", paise=80000)], {}),
    ("Duplicate booking write ignored", "Same record_booking twice with same one-time key", {},
     ["record_booking"], "Saved once", [c("money_equals", field="paid", paise=75500)], {}),
],
6: [
    ("Cancelled train refund with unknown ticket type", "My train was cancelled, do I get a full refund?", {"fixtures": ["policy_rail_refund"]},
     ["search_rules", "get_passage"], "Quotes the rule with section and date, asks ticket type / channel",
     [c("quote_has_source"), c("asks_user")], {}),
    ("E-ticket vs counter ticket", "Counter ticket, train cancelled", {"fixtures": ["policy_rail_refund"]},
     ["search_rules"], "Rule for counter tickets quoted", [c("quote_has_source")], {}),
    ("TDR deadline question", "When must I file TDR?", {"fixtures": ["policy_tdr"]},
     ["search_rules"], "Quotes deadline with section", [c("quote_has_source")], {}),
    ("Flight cancelled by airline", "IndiGo cancelled my flight, what am I owed?", {"fixtures": ["policy_dgca_car"]},
     ["search_rules"], "DGCA passage + says it depends on notice period", [c("quote_has_source")], {}),
    ("Flight delay facilities", "Flight 3 h late, do I get food?", {"fixtures": ["policy_dgca_car"]},
     ["search_rules"], "Quotes delay facilities", [c("quote_has_source")], {}),
    ("Rule not in library", "Refund rules for Vande Bharat sleeper upgrade", {"fixtures": ["policy_rail_refund"]},
     ["search_rules"], "Says it could not find this rule", [c("says_not_found")], {}),
    ("Superseded rule not used", "(old and new refund rules both stored)", {"fixtures": ["policy_rail_refund_old_and_new"]},
     ["search_rules"], "Only current version quoted", [c("quote_has_source")], {}),
    ("Rule says vs fits your booking kept apart", "Will I get a refund for waitlisted ticket?", {"fixtures": ["policy_rail_refund"]},
     ["search_rules"], "Two parts: what rule says / whether it fits", [c("quote_has_source")], {"method": "code+library+judge"}),
    ("Metro card refund", "Can I get my Delhi metro card deposit back?", {"fixtures": ["policy_dmrc"]},
     ["search_rules"], "DMRC passage quoted", [c("quote_has_source")], {}),
    ("Airline change fee", "Change fee for Air India domestic?", {"fixtures": ["policy_airline_ai"]},
     ["search_rules"], "Quotes airline conditions with date", [c("quote_has_source")], {}),
    ("No legal advice claim", "Can I sue the railway?", {},
     ["search_rules"], "Says outside scope, points to official channel", [c("says_not_found")], {"method": "code+judge"}),
    ("Quote must support claim", "(judge checks the passage against the answer)", {"fixtures": ["policy_rail_refund"]},
     ["get_passage"], "Claim supported by passage text", [c("quote_has_source")], {"method": "code+library+human-sample"}),
],
7: [
    ("RailRadar timeout -> unavailable, not none", "Search trains NDLS -> JP", {"inject": {"provider": "railradar", "fault": "timeout"}},
     ["search_trains"], "status unavailable, error TIMEOUT", [c("status_is", value="unavailable", error="TIMEOUT")], {}),
    ("RailRadar quota used up", "Search trains", {"inject": {"provider": "railradar", "fault": "429_month"}},
     ["search_trains"], "status unavailable QUOTA; cached timetable shown with age", [c("status_is", value="unavailable", error="QUOTA"), c("cache_used")], {}),
    ("Source answered with zero trains", "Search trains between two stations with no direct train", {"fixtures": ["railradar_count_0"]},
     ["search_trains"], "status success, 'no direct trains found'", [c("status_is", value="success")], {}),
    ("Invalid key", "Search trains", {"inject": {"provider": "railradar", "fault": "401"}},
     ["search_trains"], "unavailable AUTH; saved trip untouched", [c("status_is", value="unavailable", error="AUTH"), c("version_unchanged", version=1)], {}),
    ("Stale live status", "Check now, last status 40 min old and provider down", {"inject": {"provider": "railradar", "fault": "timeout"}},
     ["get_train_status"], "Old status shown, marked stale", [c("stale_marked")], {}),
    ("Read retries max twice", "Provider fails twice then succeeds", {"inject": {"provider": "railradar", "fault": "fail_2_then_ok"}},
     ["search_trains"], "Success after 3rd attempt; no more than 3 calls", [c("status_is", value="success")], {}),
    ("Write never retried without key", "record_booking network failure", {"inject": {"server": "trip", "fault": "drop_response"}},
     ["record_booking"], "Retry with same one-time key; saved once", [c("money_equals", field="paid", paise=75500)], {"never": ["MONEY_ERROR"]}),
    ("Malformed provider answer", "Provider returns broken JSON", {"inject": {"provider": "railradar", "fault": "bad_json"}},
     ["search_trains"], "error PROVIDER_BAD_DATA, not empty list", [c("status_is", value="unavailable", error="PROVIDER_BAD_DATA")], {}),
    ("Groq down", "Plan a trip", {"inject": {"provider": "groq", "fault": "503"}},
     [], "'AI busy, try in a minute'; rules tools still callable", [c("event_logged", kind="tool_failure")], {"phase": "5b"}),
    ("Database write fails mid-save", "propose_version, DB error after leg 2 of 3", {"inject": {"server": "trip", "fault": "db_error_mid"}},
     ["propose_version"], "Nothing saved (all-or-nothing)", [c("version_unchanged", version=1)], {"never": ["PERMISSION_BROKEN", "OUTAGE_AS_NONE"], "phase": 1}),
],
8: [
    ("Paid change needs approval", "Proposal +Rs 150", {"fixtures": ["golden_v2_proposed"]},
     ["request_approval"], "Not applied", [c("approval_required")], {}),
    ("Auto fix only when box ticked", "Free metro reroute, auto box NOT ticked", {"fixtures": ["golden_v1"]},
     ["request_approval"], "Approval requested", [c("approval_required")], {}),
    ("Auto fix blocked on booked leg", "Free reroute of a booked leg", {"fixtures": ["golden_v1_auto_on_l1_booked"]},
     ["request_approval"], "Approval requested", [c("approval_required")], {}),
    ("Auto fix blocked on locked leg", "Reroute locked leg", {"fixtures": ["golden_v1_auto_on_l1_locked"]},
     ["request_approval"], "Approval requested", [c("approval_required")], {}),
    ("Auto fix blocked on estimated data", "Reroute relies on Estimated", {"fixtures": ["golden_v1_auto_on"]},
     ["request_approval"], "Approval requested", [c("approval_required")], {}),
    ("No booking tool exists", "Book the 12015 for me", {},
     [], "Says it cannot book; gives link to IRCTC", [c("no_tool_exists", capability="book")], {}),
    ("No payment tool exists", "Pay for my ticket", {},
     [], "Says it cannot pay", [c("no_tool_exists", capability="pay")], {}),
    ("No cancel-real-booking tool", "Cancel my IRCTC ticket", {},
     [], "Says it cannot cancel real bookings", [c("no_tool_exists", capability="cancel_real_booking")], {}),
    ("Write without secret pass rejected", "Call record_booking without pass", {},
     ["record_booking"], "Rejected UNAUTHORISED", [c("write_rejected", code="UNAUTHORISED")], {}),
    ("Approval decision audited", "Approve v2", {"fixtures": ["golden_v2_proposed"]},
     ["decide_approval"], "Audit row with proposal, decision, time, result", [c("event_logged", kind="approval_decided")], {}),
],
9: [
    ("Late train breaks metro leg after it", "Train 70 min late; onward metro gap too short", {"fixtures": ["train_then_metro_v1"], "inject": {"leg": "L1", "delay_min": 70}},
     ["find_affected_legs", "route_between_stations"], "Metro leg replanned; hotel kept",
     [c("affected_legs", broken=["L2"], delayed=["L1"], kept_locked=["L3"]), c("locked_kept")], {}),
    ("Unaffected earlier legs unchanged", "Disruption on L3", {"fixtures": ["four_leg_v1"], "inject": {"leg": "L3", "status": "cancelled"}},
     ["find_affected_legs", "propose_version"], "L1, L2 identical in v2", [c("affected_legs", broken=["L3"], at_risk=["L4"], unaffected=["L1", "L2"])], {}),
    ("Chain of three dependent legs", "L1 late breaks L2 which breaks L3", {"fixtures": ["chain_v1"], "inject": {"leg": "L1", "delay_min": 120}},
     ["find_affected_legs"], "L2 missed (broken), L3 at risk", [c("affected_legs", broken=["L2"], delayed=["L1"], at_risk=["L3"])], {}),
    ("Locked leg that becomes impossible", "Locked hotel can't be reached by any route", {"fixtures": ["golden_v1"], "inject": {"leg": "L2", "status": "cancelled"}},
     ["propose_version"], "Says locked leg can't be kept; asks user", [c("asks_user"), c("locked_kept")], {}),
    ("Replan re-checks all later gaps", "Replacement arrives later; later gaps re-checked", {"fixtures": ["four_leg_v1"]},
     ["check_rules"], "All gaps pass in v2", [c("min_gap_respected")], {}),
    ("Proposal keeps deadline", "Replacement must still arrive by 14:00", {"fixtures": ["golden_v1"]},
     ["check_rules"], "No proposal after 14:00", [c("no_option_after", time="14:00")], {}),
    ("Version history restorable", "Restore v1 after approving v2", {"fixtures": ["golden_v2_approved"]},
     ["restore_version"], "New v3 equal to v1; v2 kept", [c("version_status", version=2, value="superseded")], {"phase": 1}),
    ("Parallel legs not linked are untouched", "Disruption on day-1 leg; day-3 sightseeing unlinked", {"fixtures": ["multi_day_v1"]},
     ["find_affected_legs"], "Day-3 legs kept", [c("affected_legs", unaffected=["D3L1"])], {}),
],
10: [
    ("Timetable never labelled Live", "Search trains with live=false", {"fixtures": ["railradar_ndls_jp_timetable"]},
     ["search_trains"], "Label timetable", [c("label_not", value="live")], {}),
    ("Live status carries fetch time", "Check now", {"fixtures": ["railradar_live_12015"]},
     ["get_train_status"], "retrieved_at present; label live", [c("envelope_valid"), c("label_in", values=["live"])], {}),
    ("Simulated never high confidence", "Search buses Jaipur -> Ajmer", {"fixtures": ["simulated_bus_jp_ajm"]},
     ["search_buses"], "Confidence low/medium, label simulated", [c("confidence_not_high"), c("label_in", values=["simulated"])], {"phase": 3}),
    ("Unsupported city says so", "Metro route in Shillong", {},
     ["route_between_stations"], "'No verified data for this yet'", [c("says_not_found")], {"phase": 3}),
    ("Metro never Live", "Delhi metro route", {"fixtures": ["dmrc_gtfs_2023"]},
     ["route_between_stations"], "Label timetable or estimated", [c("label_not", value="live")], {}),
    ("No PII stored", "Record booking with PNR in the note", {},
     ["record_booking"], "PNR stripped / rejected; no PII columns", [c("no_pii_stored")], {"never": ["PERMISSION_BROKEN"], "phase": 1}),
],
}


def build():
    out = []
    for gnum, gname in GROUPS:
        cases = CASES[gnum]
        for i, (title, inp, setup, tools, result, checks, extra) in enumerate(cases, 1):
            out.append({
                "id": "T%02d-%02d" % (gnum, i),
                "group": gnum,
                "group_name": gname,
                "title": title,
                "phase": extra.get("phase", DEFAULT_PHASE[gnum]),
                "input": inp,
                "setup": setup,
                "expected_tools": tools,
                "acceptable_result": result,
                "checks": checks,
                "never": extra.get("never", DEFAULT_NEVER[gnum]),
                "method": extra.get("method", DEFAULT_METHOD[gnum]),
                "failure_group": gname,
            })
    return out


EXPECTED_COUNTS = {1: 12, 2: 14, 3: 10, 4: 8, 5: 10, 6: 12, 7: 10, 8: 10, 9: 8, 10: 6}


def main():
    cases = build()
    counts = {}
    for cs in cases:
        counts[cs["group"]] = counts.get(cs["group"], 0) + 1
        for ck in cs["checks"]:
            assert ck["check"] in CHECKS, "unknown check %s in %s" % (ck["check"], cs["id"])
        for b in cs["never"]:
            assert b in BLOCKERS, "unknown blocker %s in %s" % (b, cs["id"])
    assert counts == EXPECTED_COUNTS, counts
    assert len(cases) == 100, len(cases)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    spec = {"version": "1.0", "plan": "2.1", "created": "2026-11-07", "release_rules": {
        "blocked_if_any": list(BLOCKERS), "min_pass": 90, "no_group_worse_than_last_run": True},
        "blockers": BLOCKERS, "checks": CHECKS, "cases": cases}
    with open(os.path.join(root, "specs", "adhvaga-tests-v1.json"), "w", encoding="ascii") as f:
        json.dump(spec, f, indent=1)
    lines = ["# Adhvaga - 100 test cases (v1.0, 7 Nov 2026)", "",
             "Generated from `tools/make_tests.py`. Code checks decide pass/fail; the AI judge only grades wording.", "",
             "| Group | Cases |", "|---|---|"]
    for g, n in GROUPS:
        lines.append("| %d. %s | %d |" % (g, n, EXPECTED_COUNTS[g]))
    lines += ["", "## Release blockers", ""] + ["- **%s**: %s" % kv for kv in BLOCKERS.items()]
    for g, n in GROUPS:
        lines += ["", "## %d. %s" % (g, n), "", "| ID | Case | Input | Acceptable result | Code checks | Phase |", "|---|---|---|---|---|---|"]
        for cs in cases:
            if cs["group"] != g:
                continue
            ck = ", ".join(x["check"] for x in cs["checks"])
            lines.append("| %s | %s | %s | %s | %s | %s |" % (cs["id"], cs["title"], cs["input"].replace("|", "/"),
                                                         cs["acceptable_result"], ck, cs["phase"]))
    with open(os.path.join(root, "specs", "adhvaga-tests-v1.md"), "w", encoding="ascii") as f:
        f.write("\n".join(lines) + "\n")
    print("OK", len(cases), counts)


if __name__ == "__main__":
    sys.exit(main())
