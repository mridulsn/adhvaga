// Knowledge service: word search over official passages, kept apart from "does it fit your booking".
// Rules: quote word for word with document, section, date and link; say "I could not find this rule" when the
// library does not cover the question; never decide alone that a rule applies; never use a replaced passage
// as the current rule.
import { ToolError, fail, nowIso, ok } from "./envelope.ts";
import type { ConfidenceLevel, Envelope } from "./envelope.ts";
import { NOT_IN_LIBRARY, loadLibrary } from "./library.ts";
import type { Doc, Library, Passage } from "./library.ts";

export const SERVER = "adhvaga-knowledge";
export const SOURCE = "official-documents";

const STOP = new Set(("a an the and or but if of to in on at by for from with about into over after before under is are was were be been being " +
  "do does did done have has had i me my we our you your it its this that these those what which who whom whose when where why how " +
  "can could should would will shall may might must get got am pm any all some there here than then so not no yes please tell " +
  "know want need im ive dont there their they them he she his her us also just only very more most less much many rule rules " +
  "say says said happen happens owe owed entitled").split(/\s+/));

// Everyday words -> words the official documents use.
const SYNONYMS: Record<string, string[]> = {
  late: ["delay"], delayed: ["delay"], delays: ["delay"], food: ["meal", "refreshment"], meal: ["meal"], snack: ["refreshment"],
  snacks: ["refreshment"], water: ["refreshment"], hotel: ["accommodation", "hotel"], stay: ["accommodation"],
  money: ["refund", "compensation"], cash: ["compensation", "cash"], overbooked: ["denied", "boarding"], offloaded: ["denied", "boarding"],
  waitlist: ["waitlisted"], wl: ["waitlisted"], waiting: ["waitlisted"], counter: ["counter", "prs"], online: ["e-ticket"],
  eticket: ["e-ticket"], irctc: ["e-ticket"], plane: ["flight"], flights: ["flight"], trains: ["train"], railway: ["train"],
  railways: ["train"], cancel: ["cancel"], cancelled: ["cancel"], cancellation: ["cancel"], canceled: ["cancel"],
  complain: ["complaint"], complaint: ["complaint"], grievance: ["complaint"],
};
// Names that the general rules cover (any airline in India is covered by the DGCA CAR).
const ENTITIES: Record<string, string> = {
  indigo: "airline", spicejet: "airline", akasa: "airline", vistara: "airline", airindia: "airline", alliance: "airline", airline: "airline",
  airlines: "airline", irctc: "e-ticket", ir: "train",
};
const LEGAL = /\b(sue|suing|lawsuit|lawyer|advocate|legal action|court case|file a case)\b/i;
const AIR = new Set(["flight", "airline", "airport", "boarding", "dgca", "plane", "block"]);
const RAIL = new Set(["train", "tdr", "rac", "waitlisted", "e-ticket", "counter", "prs", "tatkal", "chart", "clerkage", "irctc"]);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function words(s: string): string[] {
  const raw = s.toLowerCase().replace(/air india/g, "airindia").replace(/e-tickets?|e tickets?/g, "eticket").match(/[a-z][a-z0-9-]*/g) ?? [];
  return raw.filter((w) => w.length > 1 && !STOP.has(w));
}

/** Content words of a question, expanded with synonyms and entity names, then stemmed. */
export function queryTerms(q: string): { terms: Set<string>; original: string[] } {
  const original = words(q);
  const terms = new Set<string>();
  for (const w of original) {
    const exp = [...(SYNONYMS[w] ?? []), ...(ENTITIES[w] ? [ENTITIES[w]] : [])];
    for (const x of exp.length ? exp : [w]) terms.add(stem(x));
  }
  return { terms, original };
}

export interface Facts { [fact: string]: string | undefined }

export interface KnowledgeOptions { library?: Library; clock?: () => Date }

export class KnowledgeService {
  private lib: Library;
  private docs: Map<string, Doc>;
  private index: Map<string, Map<string, number>>; // passage -> term -> weight
  private vocab: Set<string>;
  private df: Map<string, number>;
  constructor(opts: KnowledgeOptions = {}) {
    this.lib = opts.library ?? loadLibrary();
    this.docs = new Map(this.lib.documents.map((d) => [d.doc_id, d]));
    this.index = new Map();
    this.vocab = new Set();
    this.df = new Map();
    for (const p of this.lib.passages) {
      const tf = new Map<string, number>();
      const add = (t: string, w: number) => tf.set(t, (tf.get(t) ?? 0) + w);
      for (const w of words(p.text)) add(stem(w), 1);
      for (const w of words(p.heading)) add(stem(w), 2);
      for (const topic of p.topics) for (const w of words(topic)) add(stem(w), 3);
      // the document's own subject words count for every passage in it
      for (const w of words(this.docs.get(p.doc_id)!.title)) add(stem(w), 0.5);
      this.index.set(p.passage_id, tf);
      for (const t of tf.keys()) {
        this.vocab.add(t);
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
  }

  private wrap(fn: () => Envelope): Envelope {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ToolError) return { ...fail(e.code, e.message, e.details), source: SERVER };
      throw e;
    }
  }

  private docInfo(d: Doc) {
    return { doc_id: d.doc_id, title: d.title, authority: d.authority, link: d.link, version: d.version, effective: d.effective, published: d.published, fetched: d.fetched, caveat: d.caveat };
  }

  private envelope(data: unknown, level: ConfidenceLevel, reasons: string[], asOf: string | null = null): Envelope {
    return ok(data, { source: SOURCE, label: "timetable", data_as_of: asOf, retrieved_at: nowIso(), confidence: { level, reasons } });
  }

  /** "Does it fit your booking?" - kept apart from what the rule says. Unknown facts become questions. */
  fit(p: Passage, facts: Facts) {
    const reasons: string[] = [];
    const questions: string[] = [];
    let verdict: "seems_to_fit" | "does_not_fit" | "unknown" = "seems_to_fit";
    for (const c of p.conditions) {
      const v = facts[c.fact];
      if (v === undefined || v === "" || v === "unknown") {
        if (!questions.includes(c.ask)) questions.push(c.ask);
        if (verdict !== "does_not_fit") verdict = "unknown";
      } else if (c.fits.includes(v)) {
        reasons.push(`${c.fact} = ${v}: matches`);
      } else {
        reasons.push(`${c.fact} = ${v}: this passage is for ${c.fits.join(" / ")}`);
        verdict = "does_not_fit";
      }
    }
    if (!p.conditions.length) reasons.push("this passage has no booking conditions of its own");
    return { verdict, reasons, questions_to_ask: verdict === "does_not_fit" ? [] : questions };
  }

  searchRules(a: { question: string; booking?: Facts; include_superseded?: boolean; limit?: number }): Envelope {
    return this.wrap(() => {
      const q = a.question.trim();
      if (!q) throw new ToolError("BAD_INPUT", "question is empty");
      const facts = a.booking ?? {};
      if (LEGAL.test(q)) {
        return this.envelope({
          found: false, code: "OUT_OF_SCOPE",
          message: "Adhvaga does not give legal advice. It can quote official travel rules, but whether to take legal action is a question for a lawyer or a consumer forum. For complaints, the official routes come first: the operator's own grievance channel; for flights, DGCA CAR Para 3.9 lists the airline, then Air Sewa, then statutory bodies.",
          passages: [],
        }, "high", ["question is outside the rule library's scope"]);
      }
      const { terms, original } = queryTerms(q);
      if (!terms.size) throw new ToolError("BAD_INPUT", "question has no searchable words");
      const unmatched = original.filter((w) => {
        const exp = [...(SYNONYMS[w] ?? []), ...(ENTITIES[w] ? [ENTITIES[w]] : [])];
        return !(exp.length ? exp : [w]).some((x) => this.vocab.has(stem(x)));
      });
      if (unmatched.length >= 2 || unmatched.length / original.length >= 0.4) {
        return this.envelope({
          found: false, code: "NO_MATCHING_RULE",
          message: `I could not find this rule. Adhvaga's library has nothing about: ${unmatched.join(", ")}.`,
          not_in_library_yet: NOT_IN_LIBRARY, passages: [],
        }, "high", ["searched every passage; these words appear in none of them"]);
      }
      const air = [...terms].some((t) => AIR.has(t));
      const rail = [...terms].some((t) => RAIL.has(t));
      const N = this.lib.passages.length;
      const scored = this.lib.passages
        .filter((p) => a.include_superseded || p.status === "current")
        .map((p) => {
          const tf = this.index.get(p.passage_id)!;
          let score = 0;
          for (const t of terms) {
            const f = tf.get(t);
            if (f) score += (f / (f + 1.2)) * Math.log(1 + N / (this.df.get(t) ?? 1));
          }
          const isAir = p.doc_id.startsWith("dgca");
          if ((air && !rail && !isAir) || (rail && !air && isAir)) score *= 0.2;
          const fit = this.fit(p, facts);
          if (fit.verdict === "does_not_fit") score *= 0.5;
          return { p, score, fit };
        })
        .filter((x) => x.score > 0.8)
        .sort((x, y) => y.score - x.score)
        .slice(0, a.limit ?? 3);
      if (!scored.length) {
        return this.envelope({ found: false, code: "NO_MATCHING_RULE", message: "I could not find this rule in Adhvaga's library.", not_in_library_yet: NOT_IN_LIBRARY, passages: [] },
          "high", ["searched every passage; nothing matched well enough"]);
      }
      const passages = scored.map(({ p, score, fit }) => {
        const d = this.docs.get(p.doc_id)!;
        return {
          what_the_rule_says: {
            passage_id: p.passage_id, quote: p.text, section: p.section, heading: p.heading,
            status: p.status, ...(p.replaced_by ? { replaced_by: p.replaced_by, warning: "This passage was REPLACED. Do not use it as the current rule." } : {}),
            document: this.docInfo(d),
          },
          does_it_fit_your_booking: { ...fit, note: "Adhvaga never decides alone that a rule applies to your ticket." },
          match_score: Math.round(score * 100) / 100,
        };
      });
      const top = scored[0];
      // The best passage must cover at least half of the question's own words (names like "IndiGo" excluded),
      // otherwise a general rule would be passed off as the answer to a specific question.
      const own = original.filter((w) => !ENTITIES[w]);
      const tfTop = this.index.get(top.p.passage_id)!;
      const missing = own.filter((w) => !(SYNONYMS[w] ?? [w]).some((x) => tfTop.has(stem(x))));
      if (own.length && missing.length / own.length > 0.5) {
        return this.envelope({
          found: false, code: "NO_MATCHING_RULE",
          message: `I could not find this rule. The closest passage (${top.p.section} of ${this.docs.get(top.p.doc_id)!.title.split(" - ")[0]}) does not cover: ${missing.join(", ")}.`,
          not_in_library_yet: NOT_IN_LIBRARY, passages: [],
        }, "high", ["closest passage does not cover the question"]);
      }
      const unknown = top.fit.verdict === "unknown";
      const level: ConfidenceLevel = top.score < 1.5 ? "low" : unknown || top.fit.verdict === "does_not_fit" ? "medium" : "high";
      const reasons = ["official document, quoted word for word", `document version: ${this.docs.get(top.p.doc_id)!.version}`];
      if (unknown) reasons.push("depends on facts about your booking that are not known yet");
      if (top.score < 1.5) reasons.push("weak word match");
      const asOf = this.docs.get(top.p.doc_id)!.effective;
      return this.envelope({
        found: true,
        questions_to_ask: unknown ? top.fit.questions_to_ask : [],
        passages,
      }, level, reasons, asOf);
    });
  }

  getPassage(a: { passage_id: string }): Envelope {
    return this.wrap(() => {
      const p = this.lib.passages.find((x) => x.passage_id === a.passage_id);
      if (!p) {
        return this.envelope({ found: false, code: "PASSAGE_NOT_FOUND", message: `No passage ${a.passage_id}.` }, "high", ["passage id not in the library"]);
      }
      const d = this.docs.get(p.doc_id)!;
      const current = p.replaced_by ? this.lib.passages.find((x) => x.passage_id === p.replaced_by) : null;
      return this.envelope({
        found: true, passage_id: p.passage_id, quote: p.text, section: p.section, heading: p.heading, status: p.status,
        conditions: p.conditions.map((c) => ({ fact: c.fact, applies_when: c.fits, question: c.ask })),
        ...(current ? { replaced_by: { passage_id: current.passage_id, quote: current.text, section: current.section } } : {}),
        document: this.docInfo(d),
      }, p.status === "current" ? "high" : "low", [p.status === "current" ? "official document, quoted word for word" : "replaced passage: history only"], d.effective);
    });
  }

  listDocuments(): Envelope {
    return this.envelope({
      documents: this.lib.documents.map((d) => ({ ...this.docInfo(d), passages: this.lib.passages.filter((p) => p.doc_id === d.doc_id).length, sha256: d.sha256 })),
      not_in_library_yet: NOT_IN_LIBRARY,
      search: "word search with everyday-word synonyms; meaning search (pgvector) comes with the hosted database",
    }, "high", ["list of documents held"]);
  }
}
