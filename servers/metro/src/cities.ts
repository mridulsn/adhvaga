// Which cities Adhvaga has verified metro data for, and the honest status of every other city.
// A city moves into LOADED only after its register row is complete (specs/02 Registers.md).

export interface LoadedCity {
  key: string;
  name: string;
  aliases: string[];
  operator: string;
  operator_short: string;
  feed_dir: string; // relative to the server folder
  source: string; // short id used in the envelope and on trip legs
  official: boolean;
  how_obtained: string;
  attribution: string;
  /** Spellings people use that differ from the feed's stop_name. Key and values are matched after normalising. */
  station_aliases: Record<string, string>;
  line_names: Record<string, string>; // route_id -> name people use
  /** When the timetable was published, if known (shown as data_as_of). Default: first date of its calendar. */
  published?: string;
  /**
   * Corrections for clear mistakes in a feed, applied when it is read. The files on disk stay unchanged, and every
   * answer says what was corrected (confidence reasons), so nothing is hidden.
   */
  feed_fixes?: {
    /** service_id -> days it runs, Monday first. Replaces that service's day flags in calendar.txt. */
    service_days?: Record<string, boolean[]>;
    /** Pairs of station ids that are one interchange in real life but separate stations in the feed. */
    station_links?: { a: string; b: string; walk_min: number }[];
    /** Shown in the confidence reasons of every route answer for this city. */
    reasons: string[];
  };
  /**
   * A newer official fare chart by distance, used instead of the feed's own fares. Distance is the track distance
   * travelled, from the feed's shape_dist_traveled (metres).
   */
  fare_chart?: { name: string; in_force_from: string; slabs: { up_to_km: number | null; rupees: number }[]; edge_km: number };
  /** Highest confidence any route answer here can have (e.g. "medium" for an old or corrected feed). */
  confidence_cap?: "medium" | "low";
}

export const LOADED: LoadedCity[] = [
  {
    key: "kochi",
    name: "Kochi",
    aliases: ["kochi", "cochin", "ernakulam", "kochimetro", "kmrl"],
    operator: "Kochi Metro Rail Limited (KMRL)",
    operator_short: "KMRL",
    feed_dir: "feeds/kochi",
    source: "kmrl-gtfs",
    official: true,
    how_obtained: "Official KMRL open-data timetable, copy from the Mobility Database mirror (kochimetro.org did not answer on 7-8 Nov 2026). Unchanged.",
    attribution: "Contains data provided by Kochi Metro Rail Limited.",
    station_aliases: {
      petta: "PETT", pettah: "PETT", cusat: "CCUV", cochinuniversity: "CCUV", edappally: "EDAP", edappalli: "EDAP",
      jawaharlalnehrustadium: "JLSD", kaloorstadium: "JLSD", thrippunithura: "TPHT", tripunithuraterminal: "TPHT",
      maharajascollege: "MACE", maharajas: "MACE", mgroad: "MGRD", ernakulamsouth: "ERSH", vyttilahub: "VYTA",
      kalamasserry: "KLMT", sndjunction: "SNJN", snjunction: "SNJN",
    },
    line_names: { R1: "Kochi Metro Line 1 (Aluva - Tripunithura)" },
  },
  {
    key: "hyderabad",
    name: "Hyderabad",
    aliases: ["hyderabad", "secunderabad", "hyd", "hmrl", "hyderabadmetro", "ltmetro"],
    operator: "Hyderabad Metro Rail Ltd. (HMRL), run by L&T Metro Rail (Hyderabad) Ltd.",
    operator_short: "HMRL",
    feed_dir: "feeds/hyderabad",
    source: "hmrl-gtfs",
    official: true,
    how_obtained: "Official HMRL open-data timetable (published Apr 2025), copy from the Mobility Database mirror. The official download now sits behind a Google form. Unchanged.",
    attribution: "Contains data provided by Hyderabad Metro Rail Ltd.",
    published: "2025-04-08",
    station_aliases: {
      hitech: "HTC", hitechcity: "HTC", hiteccity: "HTC", jntu: "JNT", lbnagar: "LBN", lbn: "LBN",
      mgbs: "MGB", mgbusstation: "MGB", imlibun: "MGB", jbs: "JBS", jubileebusstation: "JBS", srnagar: "SRN",
      lakdikapul: "LKP", lakdikapool: "LKP", kphb: "KPH", rtcxroads: "RTC", rtccrossroads: "RTC", dsnr: "DSN",
      dilsukhnagar: "DSN", secbadeast: "SEC_E", secunderabadeast: "SEC_E", secbadwest: "SCR",
      jubileehillscheckpost: "JCP", osmaniamedicalcollege: "OMC",
    },
    line_names: { RED: "Red Line (Miyapur - LB Nagar)", BLUE: "Blue Line (Nagole - Raidurg)", GREEN: "Green Line (JBS Parade Ground - MGBS)" },
    feed_fixes: {
      // calendar.txt marks the weekday service WK as running all 7 days, but the feed also has full separate
      // Saturday (SA) and Sunday (SU) services. Read as published, weekends would get both (about 25 trains an
      // hour, first train 04:39). WK is taken as Monday to Friday.
      service_days: { WK: [true, true, true, true, true, false, false] },
      // JBS Parade Ground (Green Line end) and Parade Ground (Blue Line) are separate stations in the feed with no
      // link, but they are one interchange, about 150 m apart. Without this, Blue to Green would go via Ameerpet.
      station_links: [{ a: "JBS", b: "PRG", walk_min: 6 }],
      reasons: [
        "HMRL feed says the weekday timetable also runs at weekends; Adhvaga uses its separate Saturday and Sunday timetables on those days",
        "timetable published Apr 2025; HMRL says changes may not be reflected",
      ],
    },
    fare_chart: {
      name: "HMRL revised fare chart, press release 23 May 2025",
      in_force_from: "2025-05-24",
      slabs: [
        { up_to_km: 2, rupees: 11 }, { up_to_km: 4, rupees: 17 }, { up_to_km: 6, rupees: 28 }, { up_to_km: 9, rupees: 37 },
        { up_to_km: 12, rupees: 47 }, { up_to_km: 15, rupees: 51 }, { up_to_km: 18, rupees: 56 }, { up_to_km: 21, rupees: 61 },
        { up_to_km: 24, rupees: 65 }, { up_to_km: null, rupees: 69 },
      ],
      // Track distance in the feed is within about 0.4 km of HMRL's own fare distance (checked on all 3,418 pairs).
      edge_km: 0.4,
    },
    confidence_cap: "medium",
  },
];

export interface CityStatus { name: string; status: "feed_pending" | "unofficial_only" | "not_checked"; message: string }

/** Cities with a metro that Adhvaga knows about but has no verified data for yet. Messages are shown to users. */
export const NOT_YET: CityStatus[] = [
  { name: "Delhi", status: "feed_pending", message: "Delhi Metro's official timetable (DMRC open data, last updated Aug 2023) needs a manual download through a sign-up form. Not loaded yet." },
  { name: "Bengaluru", status: "unofficial_only", message: "Only an unofficial Bengaluru Metro timetable is available. Not loaded yet." },
  ...["Mumbai", "Navi Mumbai", "Chennai", "Kolkata", "Pune", "Ahmedabad", "Lucknow", "Jaipur", "Nagpur", "Kanpur", "Agra", "Bhopal", "Indore", "Meerut"].map(
    (name): CityStatus => ({ name, status: "not_checked", message: `${name} metro data has not been checked yet.` }),
  ),
];

export const CITY_ALIASES: Record<string, string> = { bangalore: "Bengaluru", newdelhi: "Delhi", bombay: "Mumbai", madras: "Chennai", calcutta: "Kolkata" };

export function norm(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/\b(metro|station|stn)\b/g, "").replace(/[^a-z0-9]/g, "");
}
