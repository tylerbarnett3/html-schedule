// Date helpers that work on 'YYYY-MM-DD' strings, so results never depend on the
// browser's time zone or daylight saving. Never use new Date('YYYY-MM-DD') (it parses
// as UTC midnight) or toISOString() on a local date (it can land on the previous day).

import { BUSINESS_TIME_ZONE, type DateRange, type ISODate } from "./types";

const DAY_MS = 86_400_000;

function utcFromParts(year: number, month: number, day: number): Date {
  // setUTCFullYear, unlike Date.UTC, doesn't map years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function utcDate(d: ISODate): Date {
  return utcFromParts(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10)));
}

function fromUtcDate(date: Date): ISODate {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True for a real calendar date between 1900 and 9999 in 'YYYY-MM-DD' form. */
export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && fromUtcDate(utcDate(value)) === value;
}

/** Days since 1970-01-01. */
export function toDayNumber(d: ISODate): number {
  return Math.round(utcDate(d).getTime() / DAY_MS);
}

export function fromDayNumber(n: number): ISODate {
  return fromUtcDate(new Date(n * DAY_MS));
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromDayNumber(toDayNumber(d) + n);
}

/** Negative when a is before b. Plain string comparison is valid for 'YYYY-MM-DD'. */
export function compareISODate(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(d: ISODate): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return utcDate(d).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** Today's date in the given time zone (the business's by default). */
export function todayInZone(timeZone: string = BUSINESS_TIME_ZONE, now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Formats a date with Intl options, e.g. { month: "short", day: "numeric" } -> 'Oct 5'. */
export function formatISODate(d: ISODate, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(utcDate(d));
}

// ---------------------------------------------------------------------------
// Display formatting. Names come from fixed en-US tables so the output never
// depends on the device's locale or time zone.

/** 'YYYY-MM', e.g. '2026-10'. */
export type MonthKey = string;

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function dateParts(d: ISODate): { year: number; month: number; day: number } {
  return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)) };
}

/** '8/1/26': month/day/two-digit year without leading zeros (past ranges in the hours editor). */
export function formatNumericDate(d: ISODate): string {
  const { year, month, day } = dateParts(d);
  return `${month}/${day}/${String(year % 100).padStart(2, "0")}`;
}

/** 'Oct 5' */
export function formatMonthDay(d: ISODate): string {
  const { month, day } = dateParts(d);
  return `${MONTH_SHORT[month - 1]} ${day}`;
}

/** 'Oct 5, 2026' */
export function formatShortDate(d: ISODate): string {
  return `${formatMonthDay(d)}, ${dateParts(d).year}`;
}

/** 'Mon, Oct 5' (selected-date chips, request lines, toasts). */
export function formatChipDate(d: ISODate): string {
  return `${WEEKDAY_SHORT[weekdayOf(d)]}, ${formatMonthDay(d)}`;
}

/** 'Sunday, October 11, 2026' */
export function formatLongDate(d: ISODate): string {
  const { year, month, day } = dateParts(d);
  return `${WEEKDAY_LONG[weekdayOf(d)]}, ${MONTH_LONG[month - 1]} ${day}, ${year}`;
}

// Postgres timestamptz as PostgREST sends it ('2026-09-29T14:03:12.123456+00:00'), or with a
// space instead of the T. The offset is required: without one the moment depends on the device.
const TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(?:(Z)|([+-]\d{2})(?::?(\d{2}))?)$/i;

/**
 * The business-day date of a timestamp: '2026-09-30T02:30:00+00:00' was still
 * Sep 29 in New York. Null for missing or unreadable values.
 */
export function timestampToBusinessDate(
  ts: string | null | undefined,
  timeZone: string = BUSINESS_TIME_ZONE,
): ISODate | null {
  const match = ts ? TIMESTAMP_PATTERN.exec(ts.trim()) : null;
  if (!match) return null;
  const [, date, time, fraction, utc, offsetHours, offsetMinutes = "00"] = match;
  // Date.parse rolls impossible dates over (Feb 30 becomes Mar 2).
  if (!isISODate(date)) return null;
  // Rebuilt in the one form every engine parses: milliseconds at most, and a '+HH:MM' offset.
  const millis = fraction ? `.${fraction.slice(0, 3)}` : "";
  const offset = utc ? "Z" : `${offsetHours}:${offsetMinutes}`;
  const ms = Date.parse(`${date}T${time}${millis}${offset}`);
  if (!Number.isFinite(ms)) return null;
  return todayInZone(timeZone, new Date(ms));
}

/** 'Oct 5, 2026, Oct 6, 2026' (the old page's list format); '' when empty. */
export function formatDateList(dates: readonly ISODate[]): string {
  return dates.map(formatShortDate).join(", ");
}

/** Calendar header: '5 Oct' on desktop, 'Monday, Oct 5' on mobile. */
export function formatDayLabel(d: ISODate, variant: "desktop" | "mobile"): string {
  if (variant === "mobile") return `${WEEKDAY_LONG[weekdayOf(d)]}, ${formatMonthDay(d)}`;
  const { month, day } = dateParts(d);
  return `${day} ${MONTH_SHORT[month - 1]}`;
}

/** Seven short weekday names, starting on the weekday of `start` (as the old grid did). */
export function weekdayHeaders(start: ISODate): string[] {
  const first = weekdayOf(start);
  return Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(first + i) % 7]);
}

// ---------------------------------------------------------------------------
// Months (date picker)

export function monthOf(d: ISODate): MonthKey {
  return d.slice(0, 7);
}

export function addMonths(m: MonthKey, n: number): MonthKey {
  const index = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function prevMonth(m: MonthKey): MonthKey {
  return addMonths(m, -1);
}

export function nextMonth(m: MonthKey): MonthKey {
  return addMonths(m, 1);
}

/** 'October 2026' */
export function formatMonthLabel(m: MonthKey): string {
  return `${MONTH_LONG[Number(m.slice(5, 7)) - 1]} ${Number(m.slice(0, 4))}`;
}

/** Every date of the month, plus how many blank cells precede the 1st in a Sunday-first grid. */
export function monthGrid(m: MonthKey): { leadingBlanks: number; days: ISODate[] } {
  const first = `${m}-01`;
  const count = toDayNumber(`${nextMonth(m)}-01`) - toDayNumber(first);
  return {
    leadingBlanks: weekdayOf(first),
    days: Array.from({ length: count }, (_, i) => addDays(first, i)),
  };
}

// ---------------------------------------------------------------------------
// Calendar range

/** The default window is 35 days starting today. */
export const DEFAULT_RANGE_DAYS = 35;
/** Longest range the calendar will show, so a mistyped year can't build thousands of cells. */
export const MAX_RANGE_DAYS = 180;
// Chromium fires change events for partial years (0002, 0020, 0202) while typing.
const MIN_EDIT_YEAR = 2000;

/** Number of days in an inclusive range; 0 or less when end is before start. */
export function daysInclusive(r: DateRange): number {
  return toDayNumber(r.end) - toDayNumber(r.start) + 1;
}

/** start..end inclusive; empty when end is before start. */
export function rangeDates(r: DateRange): ISODate[] {
  const first = toDayNumber(r.start);
  const last = toDayNumber(r.end);
  const dates: ISODate[] = [];
  for (let n = first; n <= last; n += 1) dates.push(fromDayNumber(n));
  return dates;
}

export function defaultRange(today: ISODate): DateRange {
  return { start: today, end: addDays(today, DEFAULT_RANGE_DAYS - 1) };
}

/** Moves the whole range back or forward by its own length. */
export function shiftRange(r: DateRange, direction: 1 | -1): DateRange {
  const step = daysInclusive(r) * direction;
  return { start: addDays(r.start, step), end: addDays(r.end, step) };
}

/**
 * Applies a value typed into the Start or End input. Returns null for values that aren't
 * a finished date yet (so the input isn't snapped back while the user types). Moving
 * start past end, or end before start, drags the other end along to keep the current
 * length. Ranges longer than MAX_RANGE_DAYS are cut short at the end.
 */
export function applyRangeEdit(
  field: "start" | "end",
  value: string,
  current: DateRange,
): { range: DateRange; capped: boolean } | null {
  if (!isISODate(value) || Number(value.slice(0, 4)) < MIN_EDIT_YEAR) return null;
  const length = Math.min(Math.max(daysInclusive(current), 1), MAX_RANGE_DAYS);
  let start: ISODate;
  let end: ISODate;
  if (field === "start") {
    start = value;
    end = compareISODate(value, current.end) > 0 ? addDays(value, length - 1) : current.end;
  } else {
    end = value;
    start = compareISODate(value, current.start) < 0 ? addDays(value, 1 - length) : current.start;
  }
  const capped = daysInclusive({ start, end }) > MAX_RANGE_DAYS;
  if (capped) end = addDays(start, MAX_RANGE_DAYS - 1);
  if (start === current.start && end === current.end) return { range: current, capped };
  return { range: { start, end }, capped };
}

/** Period heading: { text: 'Sep 28 - Nov 1', days: 35 }. */
export function formatRangeLabel(r: DateRange): { text: string; days: number } {
  return { text: `${formatMonthDay(r.start)} - ${formatMonthDay(r.end)}`, days: daysInclusive(r) };
}
