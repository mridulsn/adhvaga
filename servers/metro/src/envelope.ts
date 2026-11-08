// One shared answer format for every tool (plan section 8).

export const LABELS = ["live", "timetable", "estimated", "simulated", "user_entered", "unavailable"] as const;
export type Label = (typeof LABELS)[number];
export type Status = "success" | "partial" | "unavailable" | "error";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface Envelope<T = unknown> {
  status: Status;
  source: string;
  label: Label;
  retrieved_at: string;
  data_as_of: string | null;
  confidence: { level: ConfidenceLevel; reasons: string[] };
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ok<T>(data: T, opts: Partial<Omit<Envelope<T>, "data" | "status">> = {}): Envelope<T> {
  return {
    status: "success",
    source: opts.source ?? "adhvaga-trip",
    label: opts.label ?? "user_entered",
    retrieved_at: opts.retrieved_at ?? nowIso(),
    data_as_of: opts.data_as_of ?? null,
    confidence: opts.confidence ?? { level: "high", reasons: ["saved trip data"] },
    data,
    error: null,
  };
}

export function fail(code: string, message: string, details?: unknown, status: Status = "error"): Envelope<null> {
  return {
    status,
    source: "adhvaga-trip",
    label: "unavailable",
    retrieved_at: nowIso(),
    data_as_of: null,
    confidence: { level: "low", reasons: [code] },
    data: null,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

/** Error thrown inside the service; converted to an envelope at the edge. */
export class ToolError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ---- Confidence from visible signals, never from the AI's opinion (plan section 10) ----
export interface Signals {
  label: Label;
  source_answered: boolean;
  official: boolean;
  age_minutes?: number | null;
  complete?: boolean;
  sources_agree?: boolean | null;
}

export function confidenceFrom(s: Signals): { level: ConfidenceLevel; reasons: string[] } {
  const reasons: string[] = [];
  if (!s.source_answered || s.label === "unavailable") return { level: "low", reasons: ["source did not answer"] };
  if (s.label === "simulated") return { level: "low", reasons: ["simulated data, demo only"] };
  let score = 0;
  if (s.official) { score += 2; reasons.push("official source"); } else reasons.push("third-party source");
  if (s.label === "live") {
    const age = s.age_minutes ?? Infinity;
    if (age <= 15) { score += 2; reasons.push(`checked ${Math.round(age)} min ago`); } else { reasons.push("live status is stale"); }
  } else if (s.label === "timetable") { score += 1; reasons.push("published timetable, not proof it runs today"); }
  else if (s.label === "estimated") { reasons.push("estimated by Adhvaga"); }
  else if (s.label === "user_entered") { score += 1; reasons.push("entered by you, not provider-checked"); }
  if (s.complete === false) { score -= 1; reasons.push("incomplete data"); }
  if (s.sources_agree === true) { score += 1; reasons.push("sources agree"); }
  if (s.sources_agree === false) { score -= 2; reasons.push("sources disagree"); }
  const level: ConfidenceLevel = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  return { level, reasons };
}
