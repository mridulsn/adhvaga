"""Builds the Knowledge server's rule library from the official source files.

Every passage is cut from the official text itself (whitespace normalised only), so a quote can never say
more than the source. Each cut is asserted: if a source changes, the build fails instead of quoting wrongly.

Sources (raw copies in data/raw/knowledge, not in git; sha256 recorded in the library):
  - DGCA CAR Section 3, Series M, Part IV, Rev. 4 (PDF from dgca.gov.in)
  - Indian Railways "Revised Refund Rules w.e.f. 12.11.2015" (indianrail.gov.in)
  - IRCTC "Procedure for Cancellation of E-Tickets" (contents.irctc.co.in)

Run:  python tools/build_library.py
Out:  servers/knowledge/library/library.json
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "knowledge"
OUT = ROOT / "servers" / "knowledge" / "library" / "library.json"
FETCHED = "2026-11-09"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def norm(t: str) -> str:
    t = t.replace("\xa0", " ").replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
    t = t.replace("\u2013", "-").replace("\u2014", "-").replace("\u00bd", " 1/2").replace("\uf0b7", "-")
    return re.sub(r"\s+", " ", t).strip()


def html_text(p: Path) -> str:
    t = p.read_text(encoding="utf-8", errors="ignore")
    t = re.sub(r"(?s)<script.*?</script>|<style.*?</style>|<!--.*?-->", "", t)
    return norm(html.unescape(re.sub(r"<[^>]+>", " ", t)))


def cut(text: str, start: str, end: str, occurrence: int = 1) -> str:
    """Exact slice from the nth occurrence of `start` to the first `end` after it (inclusive)."""
    i = -1
    for _ in range(occurrence):
        i = text.find(start, i + 1)
        assert i >= 0, f"start not found (occurrence {occurrence}): {start[:60]}"
    j = text.find(end, i)
    assert j >= 0, f"end not found after start: {end[:60]}"
    return text[i:j + len(end)]


# ---------------------------------------------------------------- DGCA CAR
def dgca_sections(pdf: Path) -> dict[str, str]:
    raw = subprocess.check_output(["pdftotext", "-enc", "UTF-8", str(pdf), "-"], text=True, encoding="utf-8", errors="strict")
    text = norm(raw)
    # running page header + footer: "<page> Rev. 4, dated 25th Jan, 2023 CIVIL AVIATION REQUIREMENTS SERIES 'M' PART IV SECTION 3 6TH AUGUST, 2010"
    text = re.sub(r"\b\d{1,2} Rev\. 4, dated 25th Jan, 2023(?: CIVIL AVIATION REQUIREMENTS SERIES 'M' PART IV SECTION 3 6TH AUGUST, 2010)?", " ", text)
    text = re.sub(r"\s+", " ", text)
    assert "Rev. 4, dated" not in text and "6TH AUGUST, 2010 " not in text.split("EFFECTIVE", 1)[-1], "page header left in text"
    # split at paragraph numbers such as "3.3.2 " or "1.4 " that start a paragraph
    parts = re.split(r"(?=(?<![\d.])(?<!Para )(?<!Paras )(?:[1-3]\.\d{1,2}(?:\.\d)?)\s+[A-Z(])", text)
    out: dict[str, str] = {}
    for p in parts:
        m = re.match(r"([1-3]\.\d{1,2}(?:\.\d)?)\s+", p)
        if m and m.group(1) not in out:
            out[m.group(1)] = p.strip()
    return out


def build() -> dict:
    docs, passages = [], []

    # ---- DGCA ----
    pdf = RAW / "dgca-car-s3-m-iv-rev4.pdf"
    sec = dgca_sections(pdf)
    dgca = {
        "doc_id": "dgca-car-s3-m-iv",
        "title": "CAR Section 3, Series M, Part IV - Facilities to be provided to passengers by airlines due to denied boarding, cancellation of flights and delays in flights",
        "authority": "Directorate General of Civil Aviation (DGCA), Government of India",
        "link": "https://www.dgca.gov.in/digigov-portal/Upload?flag=iframeAttachView&attachId=we1PSlOuQhYdHcwKKrm7ew%3D%3D",
        "version": "Rev. 4, dated 25 Jan 2023", "effective": "2023-02-15", "published": "2023-01-25", "fetched": FETCHED,
        "sha256": sha(pdf), "status": "current", "replaced_by": None,
        "caveat": "Applies to flights operated by airlines in India (scheduled and non-scheduled). Refunds themselves follow CAR Section 3, Series M, Part II.",
    }
    docs.append(dgca)
    D = [
        ("1.4", "No compensation for force majeure", ["compensation", "force majeure", "extraordinary", "strike", "flood", "weather"], [{"fact": "cause", "fits": ["extraordinary"], "ask": "Was the cancellation or delay caused by something outside the airline's control (weather, ATC, strike, security)?"}]),
        ("1.5", "No compensation for ATC, weather, security", ["compensation", "atc", "air traffic control", "weather", "meteorological", "security"], [{"fact": "cause", "fits": ["extraordinary"], "ask": "Was the cancellation or delay caused by ATC, weather or security?"}]),
        ("3.2.2", "Denied boarding compensation", ["denied boarding", "overbooked", "offloaded", "compensation", "boarding"], [{"fact": "event", "fits": ["denied_boarding"], "ask": "Were you refused boarding on a confirmed ticket after reporting on time?"}]),
        ("3.3.1", "Cancellation: notice and alternate flight or refund", ["cancel", "cancelled", "cancellation", "flight", "refund", "alternate flight", "notice"], [{"fact": "event", "fits": ["flight_cancelled"], "ask": "Did the airline cancel the flight?"}, {"fact": "notice", "fits": ["2_weeks_or_more", "24h_to_2_weeks"], "ask": "How early did the airline tell you about the cancellation (2 weeks or more, between 24 hours and 2 weeks, or less than 24 hours)?"}]),
        ("3.3.2", "Cancellation: compensation when not informed in time", ["cancel", "cancelled", "cancellation", "flight", "compensation", "owed", "refund", "block time"], [{"fact": "event", "fits": ["flight_cancelled"], "ask": "Did the airline cancel the flight?"}, {"fact": "notice", "fits": ["under_24h"], "ask": "How early did the airline tell you about the cancellation (2 weeks or more, between 24 hours and 2 weeks, or less than 24 hours)?"}, {"fact": "cause", "fits": ["airline"], "ask": "Was the cause within the airline's control? (Weather, ATC, strikes and security are not.)"}]),
        ("3.3.3", "No compensation without contact details", ["contact", "email", "phone", "travel agent", "compensation"], [{"fact": "gave_contact_details", "fits": ["no"], "ask": "Did you give the airline (or your agent) your email or phone number when booking?"}]),
        ("3.3.4", "Cancellation: extraordinary circumstances", ["cancel", "cancellation", "extraordinary", "compensation"], [{"fact": "cause", "fits": ["extraordinary"], "ask": "Was the cancellation caused by something outside the airline's control?"}]),
        ("3.4.1", "Delay: meals and refreshments", ["delay", "delayed", "late", "food", "meal", "meals", "refreshments", "snacks", "water"], [{"fact": "event", "fits": ["flight_delayed"], "ask": "Is the flight delayed?"}, {"fact": "checked_in_on_time", "fits": ["yes"], "ask": "Did you check in on time?"}]),
        ("3.4.2", "Delay over 6 hours: alternate flight or full refund", ["delay", "delayed", "late", "6 hours", "refund", "alternate flight", "domestic"], [{"fact": "event", "fits": ["flight_delayed"], "ask": "Is the flight delayed?"}, {"fact": "domestic", "fits": ["yes"], "ask": "Is it a domestic flight?"}]),
        ("3.4.3", "Long delay: hotel", ["delay", "delayed", "hotel", "overnight", "accommodation", "24 hours", "night"], [{"fact": "event", "fits": ["flight_delayed"], "ask": "Is the flight delayed?"}]),
        ("3.4.4", "Delay: extraordinary circumstances", ["delay", "extraordinary", "facilities"], [{"fact": "cause", "fits": ["extraordinary"], "ask": "Was the delay caused by something outside the airline's control?"}]),
        ("3.5.1", "Involuntary downgrade refund", ["downgrade", "downgraded", "lower class", "class"], [{"fact": "event", "fits": ["downgraded"], "ask": "Were you moved to a lower class against your will?"}]),
        ("3.7.1", "How compensation is paid", ["compensation", "cash", "voucher", "bank transfer", "paid"], []),
        ("3.8.1", "Facilities: meals and hotel", ["meals", "food", "refreshments", "hotel", "accommodation", "facilities", "free"], []),
        ("3.9.1", "Complaints: airline first", ["complain", "complaint", "grievance", "redressal"], []),
        ("3.9.2", "Complaints: Air Sewa", ["complain", "complaint", "grievance", "air sewa"], []),
        ("3.9.3", "Complaints: statutory body or court", ["complain", "complaint", "court", "consumer", "legal"], []),
    ]
    for num, heading, topics, conds in D:
        assert num in sec, f"DGCA section {num} not found"
        passages.append({"passage_id": f"dgca-{num}", "doc_id": dgca["doc_id"], "section": f"Para {num}", "heading": heading,
                         "text": sec[num], "topics": topics, "conditions": conds, "status": "current", "replaced_by": None})

    # ---- Indian Railways refund rules page ----
    irp = RAW / "indianrail-refund-rules.html"
    ir = html_text(irp)
    ir_doc = {
        "doc_id": "ir-refund-rules-2015",
        "title": "Revised Refund Rules w.e.f. 12.11.2015 (Railway Passengers (Cancellation of Ticket and Refund of Fare) Rules, 2015 - summary of changes)",
        "authority": "Indian Railways (Ministry of Railways), indianrail.gov.in",
        "link": "https://www.indianrail.gov.in/refund_Rules.html",
        "version": "Rules effective 12 Nov 2015", "effective": "2015-11-12", "published": None, "fetched": FETCHED,
        "sha256": sha(irp), "status": "current", "replaced_by": None,
        "caveat": "This official page summarises the 2015 rules. Later amendments (for example GST on cancellation charges) are not in Adhvaga's library; check the IRCTC or Indian Railways site before relying on an amount.",
    }
    docs.append(ir_doc)
    R = [
        ("ir-2015-obj-iv", "Para 2(iv)", "Train cancelled: automatic refund on e-tickets",
         cut(ir, "(iv) Automatic refund", "No TDR filing is required in this case."), "current", None,
         ["cancel", "cancelled", "train", "refund", "full refund", "tdr", "automatic", "e-ticket"],
         [{"fact": "ticket_channel", "fits": ["e_ticket"], "ask": "Was the ticket booked online (e-ticket on IRCTC) or at a railway counter?"}, {"fact": "who_cancelled", "fits": ["railway"], "ask": "Did the railway cancel the train, or did you cancel your ticket?"}]),
        ("ir-2015-clerkage", "Table row 1 (revised)", "Clerkage on unreserved, RAC and waitlisted tickets",
         cut(ir, "Levy of clerkage per passenger", "other classes: Rs. 60", 2), "current", None,
         ["clerkage", "rac", "waitlisted", "waiting list", "unreserved", "cancel", "charge"],
         [{"fact": "ticket_status", "fits": ["rac", "waitlisted", "unreserved"], "ask": "Was the ticket confirmed, RAC, waitlisted or unreserved?"}]),
        ("ir-pre2015-clerkage", "Table row 1 (pre-revised)", "Clerkage before 12.11.2015 (replaced)",
         cut(ir, "Levy of clerkage per passenger", "other classes: Rs. 30"), "superseded", "ir-2015-clerkage",
         ["clerkage", "rac", "waitlisted", "unreserved", "cancel", "charge"], []),
        ("ir-2015-confirmed", "Table row 2 (revised)", "Cancellation charges on confirmed tickets",
         cut(ir, "Cancellation charge per passenger on confirmed", "No refund after the above prescribed time limit."), "current", None,
         ["cancel", "cancellation charge", "confirmed", "refund", "48 hours", "12 hours", "4 hours", "charge"],
         [{"fact": "ticket_status", "fits": ["confirmed"], "ask": "Was the ticket confirmed, RAC, waitlisted or unreserved?"}, {"fact": "who_cancelled", "fits": ["passenger"], "ask": "Did you cancel the ticket yourself, or did the railway cancel the train?"}]),
        ("ir-pre2015-confirmed", "Table row 2 (pre-revised)", "Cancellation charges before 12.11.2015 (replaced)",
         cut(ir, "Cancellaton charge per passenger confirmed", "No refund after the above prescribed time limit."), "superseded", "ir-2015-confirmed",
         ["cancel", "cancellation charge", "confirmed", "refund", "charge"], []),
        ("ir-2015-partial", "Table row 3 (revised)", "Partially confirmed tickets",
         cut(ir, "Partially confirmed: Upto half an hour", "departure of the train,"), "current", None,
         ["partially confirmed", "partial", "cancel", "refund"],
         [{"fact": "ticket_status", "fits": ["partially_confirmed"], "ask": "Were only some passengers on the ticket confirmed?"}]),
        ("ir-2015-racwl", "Table row 4 (revised)", "Refund on unused RAC / waitlisted tickets",
         cut(ir, "Refund on unused RAC/WL tickets: Upto half an hour", "No refund after the above prescribed time limit."), "current", None,
         ["rac", "waitlisted", "waiting list", "wl", "unused", "refund", "cancel"],
         [{"fact": "ticket_status", "fits": ["rac", "waitlisted"], "ask": "Was the ticket confirmed, RAC or waitlisted when the chart was made?"}]),
        ("ir-pre2015-racwl", "Table row 4 (pre-revised)", "RAC / waitlisted refund before 12.11.2015 (replaced)",
         cut(ir, "Refund on unused RAC/WL tickets: Upto 3 hours", "No refund after the above prescribed time limit."), "superseded", "ir-2015-racwl",
         ["rac", "waitlisted", "refund"], []),
        ("ir-2015-train-cancelled", "Table row 5 (revised)", "Train cancelled: e-tickets vs counter tickets",
         cut(ir, "In case of cancellation of trains for e tickets", "No change for counter PRS ticket.", 1), "current", None,
         ["cancel", "cancelled", "train", "refund", "tdr", "counter", "prs", "e-ticket", "automatic"],
         [{"fact": "who_cancelled", "fits": ["railway"], "ask": "Did the railway cancel the train, or did you cancel your ticket?"}, {"fact": "ticket_channel", "fits": ["e_ticket", "counter"], "ask": "Was the ticket booked online (e-ticket) or at a railway counter?"}]),
        ("ir-pre2015-train-cancelled", "Table row 5 (pre-revised)", "Train cancelled before 01.07.2015 (replaced)",
         cut(ir, "In case of cancellation of trains for e-tickets: Before", "No change for counter PRS ticket."), "superseded", "ir-2015-train-cancelled",
         ["cancel", "train", "tdr", "e-ticket"], []),
    ]
    for pid, section, heading, text, status, repl, topics, conds in R:
        passages.append({"passage_id": pid, "doc_id": ir_doc["doc_id"], "section": section, "heading": heading, "text": text,
                         "topics": topics, "conditions": conds, "status": status, "replaced_by": repl})

    # ---- IRCTC e-ticket cancellation page ----
    icp = RAW / "irctc-eticket-cancel.html"
    ic = html_text(icp)
    ic_doc = {
        "doc_id": "irctc-eticket-cancel",
        "title": "Procedure for Cancellation of E-Tickets (IRCTC)",
        "authority": "IRCTC (Indian Railway Catering and Tourism Corporation)",
        "link": "https://contents.irctc.co.in/en/eticketCancel.html",
        "version": "Page is undated", "effective": None, "published": None, "fetched": FETCHED,
        "sha256": sha(icp), "status": "current", "replaced_by": None,
        "caveat": "The page carries no date. Amounts match the 2015 rules; check irctc.co.in before relying on them.",
    }
    docs.append(ic_doc)
    C = [
        ("irctc-before-chart", "Before chart preparation", "E-ticket cancellation charges before the chart",
         cut(ic, "If a confirmed ticket is cancelled more than 48 hrs", "subject to the minimum cancellation charges."),
         ["cancel", "cancellation charge", "confirmed", "e-ticket", "48 hours", "12 hours", "4 hours", "refund"],
         [{"fact": "ticket_channel", "fits": ["e_ticket"], "ask": "Was the ticket booked online (e-ticket) or at a railway counter?"}, {"fact": "ticket_status", "fits": ["confirmed"], "ask": "Was the ticket confirmed?"}]),
        ("irctc-tdr-deadlines", "After chart preparation (TDR)", "TDR deadlines after the chart",
         cut(ic, "For Normal User:- E-ticket cannot be cancelled after chart preparation.", "upto thirty minutes before the scheduled departure of the train."),
         ["tdr", "file tdr", "deadline", "chart", "after chart", "refund", "rac", "confirmed", "when"],
         [{"fact": "ticket_channel", "fits": ["e_ticket"], "ask": "Was the ticket booked online (e-ticket) or at a railway counter?"}]),
        ("irctc-tatkal", "Tatkal e-tickets", "Tatkal: no refund on confirmed tickets",
         cut(ic, "No refund will be granted on cancellation of confirmed Tatkal tickets.", "Partial cancellation of Tatkal e-tickets is allowed ."),
         ["tatkal", "cancel", "refund"],
         [{"fact": "ticket_status", "fits": ["tatkal"], "ask": "Was it a Tatkal ticket?"}]),
        ("irctc-train-cancelled", "Trains cancelled", "Train marked CANCELLED: full refund within three days",
         cut(ic, 'If the train is marked as "CANCELLED" in PRS', "such cancellations can be done by the customer through Internet."),
         ["cancel", "cancelled", "train", "full refund", "refund", "three days", "breaches", "floods"],
         [{"fact": "who_cancelled", "fits": ["railway"], "ask": "Did the railway cancel the train, or did you cancel your ticket?"}]),
    ]
    for pid, section, heading, text, topics, conds in C:
        passages.append({"passage_id": pid, "doc_id": ic_doc["doc_id"], "section": section, "heading": heading, "text": text,
                         "topics": topics, "conditions": conds, "status": "current", "replaced_by": None})

    for p in passages:
        assert p["text"] and p["text"].isascii(), f"{p['passage_id']} empty or non-ASCII"
    return {"built": FETCHED, "documents": docs, "passages": passages}


if __name__ == "__main__":
    lib = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(lib, indent=1, ensure_ascii=True) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(lib['documents'])} documents, {len(lib['passages'])} passages -> {OUT}")
