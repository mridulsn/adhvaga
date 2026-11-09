// The rule library: official passages cut word for word from the source documents by tools/build_library.py.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Condition { fact: string; fits: string[]; ask: string }
export interface Doc {
  doc_id: string; title: string; authority: string; link: string; version: string;
  effective: string | null; published: string | null; fetched: string; sha256: string;
  status: "current" | "superseded"; replaced_by: string | null; caveat: string;
}
export interface Passage {
  passage_id: string; doc_id: string; section: string; heading: string; text: string;
  topics: string[]; conditions: Condition[]; status: "current" | "superseded"; replaced_by: string | null;
}
export interface Library { built: string; documents: Doc[]; passages: Passage[] }

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIBRARY_FILE = join(HERE, "..", "library", "library.json");

export function loadLibrary(file = LIBRARY_FILE): Library {
  const lib = JSON.parse(readFileSync(file, "utf8")) as Library;
  const ids = new Set(lib.documents.map((d) => d.doc_id));
  const pids = new Set(lib.passages.map((p) => p.passage_id));
  for (const p of lib.passages) {
    if (!ids.has(p.doc_id)) throw new Error(`passage ${p.passage_id}: unknown document ${p.doc_id}`);
    if (p.replaced_by && !pids.has(p.replaced_by)) throw new Error(`passage ${p.passage_id}: replaced_by ${p.replaced_by} missing`);
    if (!p.text.trim()) throw new Error(`passage ${p.passage_id} is empty`);
  }
  return lib;
}

/** Things travellers ask about that are NOT in the library yet (said plainly, never guessed). */
export const NOT_IN_LIBRARY = [
  "Airline conditions of carriage (change and cancellation fees of each airline)",
  "Metro passenger rules (smart card deposits, token refunds) for any city",
  "DGCA CAR Section 3, Series M, Part II (how airline refunds are processed)",
  "Indian Railways rules after the 2015 summary (for example GST on cancellation charges)",
];
