// Parts of the day a time-off or availability request can cover.

import type { DayPeriod } from "./types";

/** In display and sort order. */
export const DAY_PERIODS: readonly DayPeriod[] = ["full-day", "morning", "evening"];

const PERIOD_LABELS = {
  "full-day": "Full Day",
  morning: "Morning",
  evening: "Evening",
} as const satisfies Record<DayPeriod, string>;

/** Labels for the period select in the request dialogs. */
export const PERIOD_OPTION_LABELS: Readonly<Record<DayPeriod, string>> = {
  "full-day": "Full Day",
  morning: "Morning (Open - 5pm)",
  evening: "Evening (5pm - Close)",
};

export function isDayPeriod(value: unknown): value is DayPeriod {
  return value === "full-day" || value === "morning" || value === "evening";
}

/** Anything unrecognized (including inherited keys like 'toString') becomes a full day. */
export function normalizePeriod(value: unknown): DayPeriod {
  return isDayPeriod(value) ? value : "full-day";
}

/** Morning and evening can share a day; a full day overlaps everything, as does the same part twice. */
export function periodsConflict(a: DayPeriod, b: DayPeriod): boolean {
  return a === "full-day" || b === "full-day" || a === b;
}

export function formatPeriod(p: DayPeriod): "Full Day" | "Morning" | "Evening" {
  return PERIOD_LABELS[normalizePeriod(p)];
}

export function periodSortValue(p: DayPeriod): 0 | 1 | 2 {
  const period = normalizePeriod(p);
  return period === "full-day" ? 0 : period === "morning" ? 1 : 2;
}
