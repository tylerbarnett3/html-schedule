// Rules for the time-off and availability request dialogs: which dates can be picked,
// the busy-day warning, and the messages shown after submitting.

import { addDays, addMonths, compareISODate, formatDateList, monthOf, nextMonth, type MonthKey } from "./dates";
import { periodsConflict } from "./periods";
import type { Availability, DayPeriod, ISODate, RequestResult, TimeOff } from "./types";

/** Requests can be made from today through this many days ahead. */
export const MAX_DAYS_AHEAD = 365;
/** The picker can page this many months past the current one. */
export const MAX_MONTHS_AHEAD = 12;
/** A day with this many time-off requests already gets a warning before submitting. */
export const HIGH_VOLUME_THRESHOLD = 3;

/**
 * True when the date is closed or I already have time off there covering an overlapping
 * part of the day. Any of my rows counts, including pending requests and days off my
 * manager assigned.
 */
export function hasTimeOffConflict(
  d: ISODate,
  period: DayPeriod,
  myTimeOff: ReadonlyArray<Pick<TimeOff, "off_date" | "period">>,
  closed: ReadonlySet<ISODate>,
): boolean {
  return closed.has(d) || myTimeOff.some((t) => t.off_date === d && periodsConflict(t.period, period));
}

/** True when the date is closed or I already marked availability overlapping that part of the day. */
export function hasAvailabilityConflict(
  d: ISODate,
  period: DayPeriod,
  myAvailability: ReadonlyArray<Pick<Availability, "available_date" | "period">>,
  closed: ReadonlySet<ISODate>,
): boolean {
  return (
    closed.has(d) || myAvailability.some((a) => a.available_date === d && periodsConflict(a.period, period))
  );
}

/** First and last dates that can be requested. */
export function pickerBounds(today: ISODate): { min: ISODate; max: ISODate } {
  return { min: today, max: addDays(today, MAX_DAYS_AHEAD) };
}

export function isPickerDateDisabled(
  d: ISODate,
  today: ISODate,
  closed: ReadonlySet<ISODate>,
  hasConflict: boolean,
): boolean {
  const { min, max } = pickerBounds(today);
  return (
    hasConflict || closed.has(d) || compareISODate(d, min) < 0 || compareISODate(d, max) > 0
  );
}

/** The picker never shows months before the current one. */
export function canGoPrevMonth(m: MonthKey, today: ISODate): boolean {
  return m > monthOf(today);
}

export function canGoNextMonth(m: MonthKey, today: ISODate): boolean {
  return nextMonth(m) <= addMonths(monthOf(today), MAX_MONTHS_AHEAD);
}

/** Adds or removes the date; the result is sorted. */
export function toggleDate(selected: readonly ISODate[], d: ISODate): ISODate[] {
  const next = selected.includes(d) ? selected.filter((s) => s !== d) : [...selected, d];
  return next.sort(compareISODate);
}

/**
 * Selected dates that already have HIGH_VOLUME_THRESHOLD or more pending or approved
 * time-off requests from anyone. Days off a manager assigned aren't requests and don't
 * count. Rows are counted, so one person's morning and evening requests count twice.
 */
export function highVolumeDates(
  selected: readonly ISODate[],
  rows: ReadonlyArray<Pick<TimeOff, "off_date" | "status" | "source">>,
  threshold: number = HIGH_VOLUME_THRESHOLD,
): ISODate[] {
  const counts = new Map<ISODate, number>();
  for (const row of rows) {
    if (row.source !== "request" || (row.status !== "pending" && row.status !== "approved")) continue;
    counts.set(row.off_date, (counts.get(row.off_date) ?? 0) + 1);
  }
  return selected.filter((d) => (counts.get(d) ?? 0) >= threshold);
}

/** The old page's confirm text for busy days, or null when there are none. */
export function highVolumeWarning(dates: readonly ISODate[]): string | null {
  if (dates.length === 0) return null;
  const list = formatDateList(dates);
  if (dates.length === 1) {
    return `Warning: ${list} already has 3 or more time-off requests. Your request may not be approved due to high volume.\n\nDo you want to submit anyway?`;
  }
  return `Warning: The following dates already have 3 or more time-off requests:\n${list}\n\nYour requests for these days may not be approved due to high volume.\n\nDo you want to submit anyway?`;
}

/**
 * What to tell the employee after submitting. The dialog closes when anything was
 * submitted and stays open (with its selections) when nothing was. Null means no
 * message (nothing was sent at all).
 */
export function requestResultMessage(
  kind: "time-off" | "availability",
  result: RequestResult,
): { text: string; closeDialog: boolean } | null {
  const submitted = result.submitted.length > 0;
  const skipped = [...result.skipped].sort(compareISODate);
  const list = formatDateList(skipped);

  if (kind === "time-off") {
    if (submitted && skipped.length > 0) {
      return {
        text: `Time-off request submitted. Skipped dates that are closed or already had a pending or approved request: ${list}`,
        closeDialog: true,
      };
    }
    if (submitted) {
      return { text: "Time-off request submitted! Your manager will review it shortly.", closeDialog: true };
    }
    if (skipped.length > 0) {
      return {
        text: `No new requests were submitted. These dates are closed or already had pending or approved requests: ${list}`,
        closeDialog: false,
      };
    }
    return null;
  }

  if (submitted) {
    return {
      text:
        skipped.length > 0
          ? `Availability submitted. Skipped dates that were closed or already had overlapping availability: ${list}`
          : "Availability submitted!",
      closeDialog: true,
    };
  }
  return {
    text:
      skipped.length > 0
        ? `No new availability was submitted. These dates were closed or already had overlapping availability: ${list}`
        : "No availability was submitted.",
    closeDialog: false,
  };
}
