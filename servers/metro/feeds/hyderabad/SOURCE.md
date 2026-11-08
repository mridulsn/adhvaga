# Hyderabad Metro (HMRL) GTFS - where this copy came from

Contains data provided by Hyderabad Metro Rail Ltd.

| Item | Value |
|---|---|
| Publisher | Hyderabad Metro Rail Ltd. (HMRL), official open data (feed_info: Open Data Telangana) |
| Official page | https://hmrl.co.in/open-data/ (the old address `open-data.html` now gives "page not found") |
| Official download on 8 Nov 2026 | "Click here to download the GTFS files" opens a **Google form**. The older Google Drive link (in the Mobility Database catalogue) asks for a Google sign-in |
| Copy used | Mobility Database mirror, feed `mdb-2457`: https://files.mobilitydatabase.org/mdb-2457/latest.zip |
| Mirror stored | 15 Apr 2025 (storage generation 1744749529160757) |
| Zip sha256 | ed801427b35ac0760092d13eccf65d71cd299910c2ab80e1de54cf21f33727f1 |
| Files inside dated | 8 Apr 2025 |
| feed_info | valid 2025-04-05 to 2030-01-01 |
| Contents | 3 lines (Red, Blue, Green), 57 stations, 117 platforms, 531 entrances, 2,828 trips, 61,829 stop times |
| Downloaded | 8 Nov 2026 |
| Changes made to the files | None. Files are byte-for-byte as in the zip |

## Terms (HMRL open-data page, read 8 Nov 2026)

- Free and non-exclusive; commercial and non-commercial use; use, adapt, reproduce, store, display, copy,
  transmit and redistribute allowed.
- Every use must show: **"Contains data provided by Hyderabad Metro Rail Ltd."**
- Must not suggest that Adhvaga is endorsed by HMRL.
- Must not modify the data to make it inaccurate, false or misleading.
- Data is "as is"; HMRL does not guarantee updates and gives no notice of changes.
- HMRL logos and symbols are not part of the data (do not use them).

## Two mistakes in the feed, and what Adhvaga does about them

The files are not changed. The server corrects these in memory (`src/cities.ts`, `feed_fixes`) and every route
answer lists both corrections in its confidence reasons.

1. **Weekday timetable marked as running every day.** `calendar.txt` has `WK` = all 7 days, but `SA` (Saturday)
   and `SU` (Sunday) are complete timetables of their own. Read as published, a Saturday would get both: about
   25 trains an hour and a first train at 04:39. Adhvaga treats `WK` as Monday to Friday.
2. **Parade Ground interchange split in two.** The Green Line ends at "JBS Parade Ground" (`JBS`) and the Blue Line
   stops at "Parade Ground" (`PRG`). They are one interchange, about 150 m apart, but the feed has no link
   between them. Adhvaga links them with a 6-minute walk. Without this, Blue to Green trips go the long way via Ameerpet.

## Fares

The feed's fare table is the old chart (Rs 10 - 60). HMRL raised fares from 17 May 2025 and cut the rise by 10%
from 24 May 2025 (press release L&TMRHL/CCD/PR/189/23-05-2025, Rs 11 - 69, by distance zone):
https://ltmetro.com/wp-content/uploads/2025/05/Hyderabad-Metro-Rail-Revised-Fare-Chart-Final.pdf
(sha256 be81481098626bedf7eabb3b3470bb446bef330e59341fa712fa849c4014e0ad).

Adhvaga uses that newer chart, with the distance taken from the feed's track distances (`shape_dist_traveled`).
Check of the method: applying the *old* chart to those distances gives the feed's own old fare for 3,348 of
3,418 station pairs (98%), and all 70 others are within 0.4 km of a zone edge. So answers within 0.4 km of an
edge also give the other possible fare (`could_be_rupees`). Fares are always labelled **Estimated**.

## How Adhvaga uses it

- Dates inside 2025-04-05 to 2030-01-01: label **Timetable**, confidence at most **medium** (old feed, corrections above).
- Never **Live**: HMRL publishes no live feed.
