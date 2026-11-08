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
];

export interface CityStatus { name: string; status: "feed_pending" | "next_to_load" | "unofficial_only" | "not_checked"; message: string }

/** Cities with a metro that Adhvaga knows about but has no verified data for yet. Messages are shown to users. */
export const NOT_YET: CityStatus[] = [
  { name: "Delhi", status: "feed_pending", message: "Delhi Metro's official timetable (DMRC open data, last updated Aug 2023) needs a manual download through a sign-up form. Not loaded yet." },
  { name: "Hyderabad", status: "next_to_load", message: "An official Hyderabad Metro timetable exists (HMRL open data). Not loaded yet." },
  { name: "Bengaluru", status: "unofficial_only", message: "Only an unofficial Bengaluru Metro timetable is available. Not loaded yet." },
  ...["Mumbai", "Navi Mumbai", "Chennai", "Kolkata", "Pune", "Ahmedabad", "Lucknow", "Jaipur", "Nagpur", "Kanpur", "Agra", "Bhopal", "Indore", "Meerut"].map(
    (name): CityStatus => ({ name, status: "not_checked", message: `${name} metro data has not been checked yet.` }),
  ),
];

export const CITY_ALIASES: Record<string, string> = { bangalore: "Bengaluru", newdelhi: "Delhi", secunderabad: "Hyderabad", bombay: "Mumbai", madras: "Chennai", calcutta: "Kolkata" };

export function norm(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/\b(metro|station|stn)\b/g, "").replace(/[^a-z0-9]/g, "");
}
