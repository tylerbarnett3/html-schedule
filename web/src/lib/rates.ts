// Hourly pay rates (employee_rates). A rate period runs from start_date to end_date,
// both days included; a missing start or end means it has no limit on that side.

import { addDays, compareISODate, formatShortDate, isISODate } from "./dates";
import type { Tables } from "./supabase";
import type { DateRange, ISODate } from "./types";

export type EmployeeRate = Pick<Tables<"employee_rates">, "id" | "employee_id" | "rate" | "start_date" | "end_date">;
export interface RatePeriod {
  rate: number;
  start_date: ISODate | null;
  end_date: ISODate | null;
}
/** A rate to save; id is null for a new period. */
export type RateInput = RatePeriod & { id: string | null };

type Bounds = Pick<RatePeriod, "start_date" | "end_date">;

export function rateAppliesOn(r: Bounds, d: ISODate): boolean {
  return (
    (r.start_date === null || compareISODate(r.start_date, d) <= 0) &&
    (r.end_date === null || compareISODate(d, r.end_date) <= 0)
  );
}

/** Both ends count, so one period ending on the day another starts is an overlap. */
export function periodsOverlap(a: Bounds, b: Bounds): boolean {
  const aStartsInTime = a.start_date === null || b.end_date === null || compareISODate(a.start_date, b.end_date) <= 0;
  const bStartsInTime = b.start_date === null || a.end_date === null || compareISODate(b.start_date, a.end_date) <= 0;
  return aStartsInTime && bStartsInTime;
}

/** The first overlapping pair [i, j] with i < j, or null. */
export function findRateOverlap(rates: readonly Bounds[]): [number, number] | null {
  for (let i = 0; i < rates.length; i += 1) {
    for (let j = i + 1; j < rates.length; j += 1) {
      if (periodsOverlap(rates[i], rates[j])) return [i, j];
    }
  }
  return null;
}

/** The rate in effect on a date; null when no period covers it (the old page fell back to the first rate). */
export function rateForDate(rates: readonly RatePeriod[], d: ISODate): number | null {
  return rates.find((r) => rateAppliesOn(r, d))?.rate ?? null;
}

export function formatRate(rate: number): string {
  return `$${rate.toFixed(2)}/hr`;
}

/** The Employees drawer's rate line for the dates on screen (E3). */
export function rateSummary(rates: readonly RatePeriod[], range: DateRange): string {
  if (rates.length === 0) return "No rate set";
  const shown: Bounds = { start_date: range.start, end_date: range.end };
  const values = [...new Set(rates.filter((r) => periodsOverlap(r, shown)).map((r) => r.rate))];
  if (values.length === 0) return "No rate for these dates";
  if (values.length === 1) return formatRate(values[0]);
  return `$${Math.min(...values).toFixed(2)}-$${Math.max(...values).toFixed(2)}/hr`;
}

function compareBounds(a: Bounds, b: Bounds): number {
  if (a.start_date !== b.start_date) {
    if (a.start_date === null) return -1;
    if (b.start_date === null) return 1;
    return compareISODate(a.start_date, b.start_date);
  }
  if (a.end_date !== b.end_date) {
    if (a.end_date === null) return 1;
    if (b.end_date === null) return -1;
    return compareISODate(a.end_date, b.end_date);
  }
  return 0;
}

/** Earliest first: no start before any start date, then by end (no end last). */
export function sortRates<T extends Bounds>(rates: readonly T[]): T[] {
  return [...rates].sort(compareBounds);
}

/**
 * Rounds to whole cents the way Postgres rounds numeric(10,2): 12.345 becomes 12.35.
 * Scaling by 100 in floating point would give 1234.4999… and round down.
 */
export function roundToCents(n: number): number {
  const shifted = Number(`${n}e2`);
  if (!Number.isFinite(shifted)) return Math.round(n * 100) / 100;
  return Number(`${Math.round(shifted)}e-2`);
}

// A rate typed into a form: a number above 0 once rounded to cents, else null.
function parsePositiveRate(value: string): number | null {
  const text = value.trim();
  if (text === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const rounded = roundToCents(n);
  return rounded > 0 ? rounded : null;
}

// ---------------------------------------------------------------------------
// The rate editor in Edit Employee keeps the raw input values and checks them on save.

export interface RateDraft {
  key: string;
  id: string | null;
  rate: string;
  start: string;
  end: string;
}

export function toRateDrafts(rates: readonly EmployeeRate[], makeKey: () => string): RateDraft[] {
  return sortRates(rates).map((r) => ({
    key: makeKey(),
    id: r.id,
    rate: r.rate.toFixed(2),
    start: r.start_date ?? "",
    end: r.end_date ?? "",
  }));
}

export function emptyRateDraft(key: string): RateDraft {
  return { key, id: null, rate: "", start: "", end: "" };
}

function isBlankDraft(d: RateDraft): boolean {
  return d.rate.trim() === "" && d.start.trim() === "" && d.end.trim() === "";
}

/** Indexes are positions in the draft list, so they match the "Rate Period {n}" labels. */
export type RateError =
  | { kind: "invalid-rate"; index: number }
  | { kind: "invalid-date"; index: number }
  | { kind: "end-before-start"; index: number }
  | { kind: "overlap"; first: number; second: number };

// Blank means no limit; anything else must be a real date.
function parseDateValue(value: string): ISODate | null | undefined {
  const text = value.trim();
  if (text === "") return null;
  return isISODate(text) ? text : undefined;
}

/**
 * Checks the rate periods in the order the old page did (E2): untouched empty rows are
 * dropped; any other row needs a rate above 0; then no period may end before it starts;
 * then no two may overlap. Rates come back rounded to cents (E8).
 */
export function checkRateDrafts(
  drafts: readonly RateDraft[],
): { ok: true; rates: RateInput[] } | { ok: false; error: RateError } {
  const rows: { index: number; input: RateInput }[] = [];
  for (const [index, draft] of drafts.entries()) {
    if (isBlankDraft(draft)) continue;
    const rate = parsePositiveRate(draft.rate);
    if (rate === null) return { ok: false, error: { kind: "invalid-rate", index } };
    const start = parseDateValue(draft.start);
    const end = parseDateValue(draft.end);
    if (start === undefined || end === undefined) return { ok: false, error: { kind: "invalid-date", index } };
    rows.push({ index, input: { id: draft.id, rate, start_date: start, end_date: end } });
  }
  for (const { index, input } of rows) {
    if (input.start_date !== null && input.end_date !== null && compareISODate(input.end_date, input.start_date) < 0) {
      return { ok: false, error: { kind: "end-before-start", index } };
    }
  }
  const overlap = findRateOverlap(rows.map((row) => row.input));
  if (overlap) {
    return { ok: false, error: { kind: "overlap", first: rows[overlap[0]].index, second: rows[overlap[1]].index } };
  }
  return { ok: true, rates: rows.map((row) => row.input) };
}

export function rateErrorMessage(e: RateError): string {
  switch (e.kind) {
    case "invalid-rate":
      return `Hourly rate must be greater than 0 for Rate Period ${e.index + 1}.`;
    case "invalid-date":
      return `Enter a valid date for Rate Period ${e.index + 1}.`;
    case "end-before-start":
      return "End date must be after start date for all rate periods";
    case "overlap":
      return "Rate periods cannot overlap. Please adjust the dates.";
  }
}

/** Add Employee's optional single rate: blank means no rate. */
export function parseNewEmployeeRate(
  value: string,
): { ok: true; rate: number | null } | { ok: false; message: string } {
  if (value.trim() === "") return { ok: true, rate: null };
  const rate = parsePositiveRate(value);
  if (rate === null) return { ok: false, message: "Hourly rate must be greater than 0 or left empty" };
  return { ok: true, rate };
}

/** The separate writes a save needs when save_employee isn't available. */
export function diffRates(
  existing: readonly EmployeeRate[],
  next: readonly RateInput[],
): { toDelete: string[]; toUpdate: (RatePeriod & { id: string })[]; toInsert: RatePeriod[] } {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const keptIds = new Set(next.flatMap((r) => (r.id === null ? [] : [r.id])));
  const toUpdate: (RatePeriod & { id: string })[] = [];
  const toInsert: RatePeriod[] = [];
  for (const r of next) {
    const period: RatePeriod = { rate: r.rate, start_date: r.start_date, end_date: r.end_date };
    if (r.id === null) {
      toInsert.push(period);
      continue;
    }
    const old = byId.get(r.id);
    if (!old) continue;
    if (old.rate !== r.rate || old.start_date !== r.start_date || old.end_date !== r.end_date) {
      toUpdate.push({ id: r.id, ...period });
    }
  }
  return { toDelete: existing.filter((r) => !keptIds.has(r.id)).map((r) => r.id), toUpdate, toInsert };
}

/**
 * "New rate starting on…" (E9): the open-ended period now ends the day before `start`,
 * and a new open-ended period at the new rate starts on `start`.
 */
export function startNewRate(
  drafts: readonly RateDraft[],
  start: ISODate,
  rate: string,
  makeKey: () => string,
): { ok: true; drafts: RateDraft[] } | { ok: false; message: string } {
  const value = parsePositiveRate(rate);
  if (value === null) return { ok: false, message: "Enter an hourly rate greater than 0." };
  if (!isISODate(start)) return { ok: false, message: "Choose the date the new rate starts." };

  // The open-ended period that starts last is the one in effect from now on. A blank
  // start ("" sorts first) means it has always applied.
  let openIndex = -1;
  drafts.forEach((draft, index) => {
    if (isBlankDraft(draft) || draft.end.trim() !== "") return;
    if (openIndex === -1 || draft.start.trim() >= drafts[openIndex].start.trim()) openIndex = index;
  });

  const next = drafts.map((draft) => ({ ...draft }));
  if (openIndex !== -1) {
    const open = next[openIndex];
    const openStart = open.start.trim();
    if (isISODate(openStart) && compareISODate(start, openStart) <= 0) {
      return {
        ok: false,
        message: `The current rate starts on ${formatShortDate(openStart)}. Pick a later date for the new rate.`,
      };
    }
    open.end = addDays(start, -1);
  }

  const added: RateDraft = { key: makeKey(), id: null, rate: value.toFixed(2), start, end: "" };
  const clash = next.findIndex((draft) => {
    if (isBlankDraft(draft)) return false;
    const from = parseDateValue(draft.start);
    const to = parseDateValue(draft.end);
    if (from === undefined || to === undefined) return false;
    return periodsOverlap({ start_date: from, end_date: to }, { start_date: start, end_date: null });
  });
  if (clash !== -1) {
    return {
      ok: false,
      message: `The new rate would overlap Rate Period ${clash + 1}. Change that period's dates first.`,
    };
  }
  return { ok: true, drafts: [...next, added] };
}
