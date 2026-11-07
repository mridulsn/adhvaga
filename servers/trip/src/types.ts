import type { Label } from "./envelope.ts";

export const TRAVEL_KINDS = ["metro", "train", "flight", "bus", "city_bus", "walk", "taxi"] as const;
export const FIXED_KINDS = ["stay", "activity"] as const;
export const LEG_KINDS = [...TRAVEL_KINDS, ...FIXED_KINDS] as const;
export type LegKind = (typeof LEG_KINDS)[number];
export const LOCAL_KINDS: readonly LegKind[] = ["metro", "city_bus", "walk"];

/** A leg as it exists inside one version (pure plan data, immutable once saved). */
export interface PlanLeg {
  leg_key: string;
  kind: LegKind;
  from_name: string;
  to_name: string;
  depart_at: string; // ISO with offset; for stay/activity = start
  arrive_at: string; // ISO with offset; for stay/activity = end
  operator: string | null;
  service_no: string | null;
  source: string;
  label: Label;
  min_gap_after_min: number | null;
  estimated_paise: number | null;
  quoted_paise: number | null;
  quoted_source: string | null;
  quoted_at: string | null;
}

export interface Link {
  from_leg_key: string;
  to_leg_key: string;
}

/** Observed status of a leg (trip level, by leg_key). Not part of the plan. */
export interface LegStatus {
  leg_key: string;
  status: "scheduled" | "delayed" | "cancelled" | "diverted" | "line_closed" | "completed" | "unknown";
  delay_min: number;
  checked_at: string;
  source: string;
  label: Label;
  is_test: boolean;
}

export interface TripRules {
  arrive_by?: { at: string; leg_key?: string } | null;
  /** Local (IST) clock time after which no travel leg may arrive, e.g. "23:00". Window runs to 05:00. */
  no_arrival_after_local?: string | null;
  default_min_gap_min?: number;
  /** Preferences the agent may only relax with approval. */
  preferences?: { avoid_overnight?: boolean; prefer_modes?: LegKind[] };
}

export interface RuleFailure {
  code: "GAP_TOO_SHORT" | "ARRIVES_LATE" | "LATE_NIGHT" | "OVER_CEILING" | "CYCLE" | "BAD_TIMES" | "UNKNOWN_LEG";
  leg_keys: string[];
  detail: string;
}

export function isTravel(kind: LegKind): boolean {
  return (TRAVEL_KINDS as readonly string[]).includes(kind);
}
