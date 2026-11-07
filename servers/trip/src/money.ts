// Money is always integer paise. Never floating point.

export class MoneyError extends Error {
  code = "BAD_INPUT";
}

const RUPEES_RE = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

/** Parse a rupee amount given as a string ("333.33") or an integer number of rupees. */
export function rupeesToPaise(input: string | number): number {
  const s = typeof input === "number" ? String(input) : input.trim();
  const m = RUPEES_RE.exec(s);
  if (!m) throw new MoneyError(`Amount must be a non-negative rupee value with at most 2 decimals, got "${s}"`);
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  return whole * 100 + frac;
}

export function assertPaise(p: number, name = "amount"): number {
  if (!Number.isSafeInteger(p) || p < 0) throw new MoneyError(`${name} must be a non-negative integer number of paise`);
  return p;
}

export function sumPaise(values: Array<number | null | undefined>): number {
  let t = 0;
  for (const v of values) if (v != null) t += v;
  return t;
}

export function formatRupees(paise: number): string {
  const neg = paise < 0;
  const a = Math.abs(paise);
  const r = Math.floor(a / 100);
  const p = a % 100;
  return `${neg ? "-" : ""}Rs ${r.toLocaleString("en-IN")}${p ? "." + String(p).padStart(2, "0") : ""}`;
}
