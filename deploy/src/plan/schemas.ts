// /api/plan request and response shapes. Zod is the gate; the JSON Schemas below are only hints for the model
// (Groq structured outputs). Hard invariants run in code after parsing: a model answer that breaks one is invalid.
import { z } from "zod";

export const CATEGORIES = [
  "mountains",
  "beaches",
  "rivers-lakes",
  "forests-wildlife",
  "heritage",
  "temples-spiritual",
  "museums",
  "markets-shopping",
  "food-cafes",
  "walks-nature",
  "adventure-outdoor",
  "nightlife",
] as const;

const short = (max: number) => z.string().trim().min(1).max(max);

export const PlanRequest = z
  .object({
    op: z.enum(["city-profile", "inspiration-draft"]),
    city: z
      .object({
        name: short(60),
        state: short(60),
        lat: z.number().min(6).max(38),
        lng: z.number().min(68).max(98),
      })
      .strict(),
    days: z.number().int().min(1).max(14).optional(),
    interests: z.array(short(40)).max(8).optional(),
  })
  .strict()
  .refine((r) => r.op !== "inspiration-draft" || r.days !== undefined, { message: "days is required for inspiration-draft", path: ["days"] });
export type PlanRequest = z.infer<typeof PlanRequest>;

export const CityProfile = z
  .object({
    categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length),
    summary: z.string().trim().min(1).max(400),
    cautions: z.array(z.string().trim().min(1).max(200)).max(5),
  })
  .strict();
export type CityProfile = z.infer<typeof CityProfile>;

export const InspirationDraft = z
  .object({
    days: z
      .array(
        z
          .object({
            theme: z.string().trim().min(1).max(80),
            ideas: z.array(z.string().trim().min(1).max(100)).min(1).max(5),
          })
          .strict(),
      )
      .min(1)
      .max(14),
    researchChecklist: z.array(z.string().trim().min(1).max(160)).max(10),
  })
  .strict();
export type InspirationDraft = z.infer<typeof InspirationDraft>;

// ---- JSON Schemas for structured outputs (strict mode: every property required, no extras) ----
export const CITY_PROFILE_JSON_SCHEMA = {
  type: "object",
  properties: {
    categories: { type: "array", items: { type: "string", enum: [...CATEGORIES] } },
    summary: { type: "string" },
    cautions: { type: "array", items: { type: "string" } },
  },
  required: ["categories", "summary", "cautions"],
  additionalProperties: false,
};

export const INSPIRATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: { theme: { type: "string" }, ideas: { type: "array", items: { type: "string" } } },
        required: ["theme", "ideas"],
        additionalProperties: false,
      },
    },
    researchChecklist: { type: "array", items: { type: "string" } },
  },
  required: ["days", "researchChecklist"],
  additionalProperties: false,
};

// ---- Hard invariants (after zod) ----
const CLOCK_TIME = /\b\d{1,2}[:.]\d{2}\b/;
const MONEY = /\u20B9|\bRs\.?\s*\d|\bINR\s*\d|\brupees?\b/i;
const PROPERTY = /hotel|resort|homestay/i;

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === "object") for (const v of Object.values(x)) strings(v, out);
  return out;
}

/** Returns the parsed answer, or null with a reason when the model output is not acceptable. */
export function validateCityProfile(raw: unknown): { ok: true; value: CityProfile } | { ok: false; reason: string } {
  const p = CityProfile.safeParse(raw);
  if (!p.success) return { ok: false, reason: "schema" };
  const all = strings(p.data);
  if (all.some((s) => CLOCK_TIME.test(s))) return { ok: false, reason: "clock_time" };
  if (all.some((s) => MONEY.test(s))) return { ok: false, reason: "price" };
  return { ok: true, value: { ...p.data, categories: [...new Set(p.data.categories)] } };
}

export function validateInspiration(raw: unknown, days: number): { ok: true; value: InspirationDraft } | { ok: false; reason: string } {
  const p = InspirationDraft.safeParse(raw);
  if (!p.success) return { ok: false, reason: "schema" };
  if (p.data.days.length !== days) return { ok: false, reason: "day_count" };
  const all = strings(p.data);
  if (all.some((s) => CLOCK_TIME.test(s))) return { ok: false, reason: "clock_time" };
  if (all.some((s) => MONEY.test(s))) return { ok: false, reason: "price" };
  if (p.data.days.some((d) => PROPERTY.test(d.theme) || d.ideas.some((i) => PROPERTY.test(i)))) return { ok: false, reason: "property_name" };
  return { ok: true, value: p.data };
}
