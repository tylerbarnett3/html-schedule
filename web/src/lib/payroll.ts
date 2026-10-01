// Payroll review ("actualizing"): what each scheduled shift really was, plus work that was
// never on the schedule. Pure functions only; the page keeps an edit overlay on top of
// buildPristineRows(saved data) and saves the difference with planActualsSave.

import type { Database } from "./database.types";
import {
  addDays,
  compareISODate,
  formatISODate,
  formatMonthDay,
  formatShortDate,
  isISODate,
  timestampToBusinessDate,
  WEEKDAY_SHORT,
  weekdayOf,
} from "./dates";
import { rateForDate, type EmployeeRate, type RatePeriod } from "./rates";
import type { Tables } from "./supabase";
import { absoluteShiftInterval, formatTime12Hour, shiftDurationMinutes, timeToMinutes } from "./time";
import type { DateRange, Employee, ISODate, PgTime, Shift } from "./types";

export type ActualStatus = Database["public"]["Enums"]["actual_status"];
export type ShiftActual = Pick<
  Tables<"shift_actuals">,
  "id" | "shift_id" | "employee_id" | "work_date" | "start_time" | "end_time" | "status" | "note" | "actualized_at"
>;
/** 'HH:MM' as <input type="time"> gives it; '' while the input is cleared. */
export type ClockTime = string;

export const PAY_PERIOD_DAYS = 14;
export const NUDGE_MINUTES = 15;
export const NOTE_MAX_LENGTH = 160;

const DAY_MINUTES = 24 * 60;
// Chromium reports partial years (0002, 0020, 0202) while a date is being typed.
const MIN_START_YEAR = 2000;

// ---------------------------------------------------------------------------
// Time

function clockFromMinutes(minutes: number): ClockTime {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

/** Moves a time by `delta` minutes, wrapping around midnight; null when there's no time. */
export function nudgeClock(t: ClockTime | null, delta: number): ClockTime | null {
  const minutes = timeToMinutes(t);
  if (minutes === null) return null;
  return clockFromMinutes((((minutes + delta) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES);
}

/** Same time of day, compared as minutes ('12:00:00' equals '12:00'); two blanks are equal. */
export function sameClock(a: PgTime | null, b: PgTime | null): boolean {
  return timeToMinutes(a) === timeToMinutes(b);
}

/** Minutes worked, 0 when a time is missing (payroll adds these up). */
function minutesWorked(start: PgTime | null, end: PgTime | null): number {
  return shiftDurationMinutes(start, end) ?? 0;
}

// ---------------------------------------------------------------------------
// Formatting

/** '8 hr', '16.3 hr' */
export function formatActualHours(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`;
}

/** Hours with up to two decimals for the payroll output: 20 min -> '0.33', 60 -> '1'. */
export function formatPayrollDecimalHours(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

/** A length of time: '6h 15m', '6h', '15m' (a zero part is left out; nothing at all is '0m'). */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** '+15 min', '−1 hr 30 min' (U+2212 minus), 'No time difference'. */
export function formatActualDifference(minutes: number): string {
  if (minutes === 0) return "No time difference";
  const sign = minutes > 0 ? "+" : "−";
  const absolute = Math.abs(minutes);
  if (absolute < 60) return `${sign}${absolute} min`;
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return `${sign}${hours} hr${rest ? ` ${rest} min` : ""}`;
}

const STATUS_LABELS: Record<ActualStatus, string> = {
  confirmed: "As scheduled",
  adjusted: "Adjusted",
  "not-worked": "Vacated",
  unscheduled: "Unscheduled",
};

export function actualStatusLabel(status: ActualStatus | null): string {
  return status ? STATUS_LABELS[status] : "Needs review";
}

// ---------------------------------------------------------------------------
// Pay period: a rolling 14 days (U1)

export function payPeriodFrom(start: ISODate): DateRange {
  return { start, end: addDays(start, PAY_PERIOD_DAYS - 1) };
}

/** The 14 complete days ending yesterday, with yesterday selected. */
export function defaultPayPeriod(today: ISODate): { period: DateRange; selected: ISODate } {
  const period = payPeriodFrom(addDays(today, -PAY_PERIOD_DAYS));
  return { period, selected: period.end };
}

export function stepPayPeriod(p: DateRange, direction: 1 | -1): DateRange {
  return payPeriodFrom(addDays(p.start, direction * PAY_PERIOD_DAYS));
}

/** A finished start date typed into the Start input, or null to ignore it. */
export function parsePeriodStartInput(value: string): ISODate | null {
  return isISODate(value) && Number(value.slice(0, 4)) >= MIN_START_YEAR ? value : null;
}

export function isFutureWorkDate(d: ISODate, today: ISODate): boolean {
  return compareISODate(d, today) > 0;
}

/**
 * The period and day named by ?start=&day= (P2). Missing or unreadable values fall back
 * to the defaults; a day outside the period falls back to the period's last day.
 */
export function payPeriodFromParams(
  params: { start: string | null; day: string | null },
  today: ISODate,
): { period: DateRange; selected: ISODate } {
  const start = params.start === null ? null : parsePeriodStartInput(params.start);
  const period = start ? payPeriodFrom(start) : defaultPayPeriod(today).period;
  const day = params.day;
  const inPeriod =
    day !== null && isISODate(day) && compareISODate(day, period.start) >= 0 && compareISODate(day, period.end) <= 0;
  return { period, selected: inPeriod ? day : period.end };
}

// ---------------------------------------------------------------------------
// Draft rows

export interface ScheduledRow {
  kind: "scheduled";
  key: string;
  shift: Shift;
  saved: ShiftActual | null;
  status: Exclude<ActualStatus, "unscheduled"> | null;
  /** Who worked; null for "No employee" (always null while vacated). */
  employeeId: string | null;
  start: ClockTime | null;
  end: ClockTime | null;
  note: string;
}

/** Work that isn't tied to a shift on the schedule. */
export interface ActualOnlyRow {
  kind: "actual-only";
  key: string;
  /** The shift_actuals id it is (or will be) saved under. */
  id: string;
  saved: ShiftActual | null;
  /**
   * A saved confirmed / adjusted / vacated record whose shift was deleted from the schedule
   * (P3). It keeps its status until edited; edits save it as unscheduled.
   */
  orphan: boolean;
  /** The values it was added or last saved with: its heading, and its place in the list. */
  origin: { employeeId: string; start: ClockTime; end: ClockTime };
  date: ISODate;
  status: ActualStatus;
  employeeId: string | null;
  start: ClockTime | null;
  end: ClockTime | null;
  note: string;
}

export type DraftRow = ScheduledRow | ActualOnlyRow;

export const rowDate = (r: DraftRow): ISODate => (r.kind === "scheduled" ? r.shift.shift_date : r.date);

export const shiftRowKey = (shiftId: string): string => `shift:${shiftId}`;
export const actualRowKey = (actualId: string): string => `actual:${actualId}`;

/** The draft values a saved record stands for. A vacated record shows "No employee" (P8). */
function savedValues(saved: ShiftActual): Pick<DraftRow, "employeeId" | "start" | "end" | "note"> {
  const vacated = saved.status === "not-worked";
  return {
    employeeId: vacated ? null : saved.employee_id,
    start: vacated ? null : toClockOrNull(saved.start_time),
    end: vacated ? null : toClockOrNull(saved.end_time),
    note: saved.note,
  };
}

function toClockOrNull(t: PgTime | null): ClockTime | null {
  const minutes = timeToMinutes(t);
  return minutes === null ? null : clockFromMinutes(minutes % DAY_MINUTES);
}

function scheduledValues(shift: Shift): { employeeId: string; start: ClockTime | null; end: ClockTime | null } {
  return {
    employeeId: shift.employee_id,
    start: toClockOrNull(shift.start_time),
    end: toClockOrNull(shift.end_time),
  };
}

function inPeriod(d: ISODate, period: DateRange): boolean {
  return compareISODate(d, period.start) >= 0 && compareISODate(d, period.end) <= 0;
}

function scheduledRow(shift: Shift, saved: ShiftActual | null): ScheduledRow {
  const base = { kind: "scheduled" as const, key: shiftRowKey(shift.id), shift, saved };
  if (!saved) return { ...base, status: null, ...scheduledValues(shift), note: "" };
  // A shift's record is never unscheduled (the database forbids it); read it as adjusted.
  const status = saved.status === "unscheduled" ? "adjusted" : saved.status;
  return { ...base, status, ...savedValues(saved) };
}

function actualOnlyRow(saved: ShiftActual): ActualOnlyRow {
  const values = savedValues(saved);
  return {
    kind: "actual-only",
    key: actualRowKey(saved.id),
    id: saved.id,
    saved,
    orphan: saved.status !== "unscheduled",
    origin: {
      employeeId: saved.employee_id,
      start: toClockOrNull(saved.start_time) ?? "",
      end: toClockOrNull(saved.end_time) ?? "",
    },
    date: saved.work_date,
    status: saved.status,
    ...values,
  };
}

/** The saved state of a pay period: one row per shift, plus records with no shift. Sorted. */
export function buildPristineRows(input: {
  period: DateRange;
  shifts: readonly Shift[];
  actuals: readonly ShiftActual[];
}): DraftRow[] {
  const byShift = new Map<string, ShiftActual>();
  for (const actual of input.actuals) if (actual.shift_id) byShift.set(actual.shift_id, actual);
  const rows: DraftRow[] = [];
  for (const shift of input.shifts) {
    if (inPeriod(shift.shift_date, input.period)) rows.push(scheduledRow(shift, byShift.get(shift.id) ?? null));
  }
  for (const actual of input.actuals) {
    if (actual.shift_id === null && inPeriod(actual.work_date, input.period)) rows.push(actualOnlyRow(actual));
  }
  return rows.sort(compareDraftRows);
}

function sortTimes(row: DraftRow): { start: number; end: number } {
  // Actual-only rows sort on the values they were added with, so they don't jump while edited.
  const start = row.kind === "scheduled" ? row.shift.start_time : row.origin.start;
  const end = row.kind === "scheduled" ? row.shift.end_time : row.origin.end;
  return { start: timeToMinutes(start) ?? Infinity, end: timeToMinutes(end) ?? Infinity };
}

/** Date, scheduled start, end, scheduled rows before actual-only ones, then key. */
export function compareDraftRows(a: DraftRow, b: DraftRow): number {
  const byDate = compareISODate(rowDate(a), rowDate(b));
  if (byDate !== 0) return byDate;
  const ta = sortTimes(a);
  const tb = sortTimes(b);
  if (ta.start !== tb.start) return ta.start < tb.start ? -1 : 1;
  if (ta.end !== tb.end) return ta.end < tb.end ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "scheduled" ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function matchesSavedValues(row: DraftRow, saved: ShiftActual): boolean {
  const values = savedValues(saved);
  return (
    row.employeeId === values.employeeId &&
    sameClock(row.start, values.start) &&
    sameClock(row.end, values.end) &&
    row.note.trim() === values.note.trim()
  );
}

/**
 * The status a row's values stand for. A shift is "As scheduled" when the scheduled employee
 * worked the scheduled times (compared as minutes), otherwise adjusted. Work off the
 * schedule is unscheduled, except an untouched orphan, which keeps its saved status.
 */
export function deriveActualStatus(row: DraftRow): ActualStatus {
  if (row.kind === "actual-only") {
    return row.orphan && row.saved && matchesSavedValues(row, row.saved) ? row.saved.status : "unscheduled";
  }
  return scheduledStatus(row);
}

function scheduledStatus(row: ScheduledRow): Exclude<ActualStatus, "unscheduled"> {
  if (row.status === "not-worked") return "not-worked";
  const scheduled = scheduledValues(row.shift);
  const matches =
    row.employeeId === scheduled.employeeId &&
    sameClock(row.start, scheduled.start) &&
    sameClock(row.end, scheduled.end);
  return matches ? "confirmed" : "adjusted";
}

export type RowAction =
  | { type: "confirm" }
  | { type: "vacate" }
  | { type: "set-employee"; employeeId: string | null }
  | { type: "set-time"; field: "start" | "end"; value: ClockTime }
  | { type: "nudge"; field: "start" | "end"; delta: number }
  | { type: "set-note"; note: string }
  /** Fills in the hours the employee logged for the shift (hour_logs). */
  | { type: "use-logged"; employeeId: string; start: ClockTime; end: ClockTime };

/** Future rows, and vacated ones, can't be edited field by field. */
function valuesLocked(row: DraftRow, today: ISODate): boolean {
  return isFutureWorkDate(rowDate(row), today) || row.status === "not-worked";
}

function withValues(row: DraftRow, values: Partial<Pick<DraftRow, "employeeId" | "start" | "end" | "note">>): DraftRow {
  if (row.kind === "scheduled") {
    const next: ScheduledRow = { ...row, ...values };
    return { ...next, status: scheduledStatus(next) };
  }
  const next: ActualOnlyRow = { ...row, ...values };
  return { ...next, status: deriveActualStatus(next) };
}

/** The row after one edit. Returns `row` itself when the action changes nothing. */
export function applyRowAction(row: DraftRow, action: RowAction, today: ISODate): DraftRow {
  if (isFutureWorkDate(rowDate(row), today)) return row;
  switch (action.type) {
    case "confirm": {
      if (row.kind !== "scheduled") return row;
      if (row.status === "confirmed") return { ...row, status: null };
      return { ...row, ...scheduledValues(row.shift), status: "confirmed" };
    }
    case "vacate": {
      if (row.kind !== "scheduled") return row;
      // Un-vacating puts the schedule back, so a later edit doesn't start from blanks.
      if (row.status === "not-worked") return { ...row, ...scheduledValues(row.shift), status: null };
      return { ...row, employeeId: null, start: null, end: null, status: "not-worked" };
    }
    case "set-employee": {
      if (valuesLocked(row, today) || row.employeeId === action.employeeId) return row;
      return withValues(row, { employeeId: action.employeeId });
    }
    case "set-time": {
      if (valuesLocked(row, today)) return row;
      const current = row[action.field];
      if ((current ?? "") === action.value || (current && sameClock(current, action.value))) return row;
      return withValues(row, action.field === "start" ? { start: action.value } : { end: action.value });
    }
    case "nudge": {
      if (valuesLocked(row, today)) return row;
      const moved = nudgeClock(row[action.field], action.delta);
      if (moved === null) return row;
      return withValues(row, action.field === "start" ? { start: moved } : { end: moved });
    }
    case "set-note": {
      // Notes never change the outcome, so there's nothing to note until there is one (P5).
      if (row.status === null || row.note === action.note) return row;
      if (row.kind === "actual-only") {
        // A vacated orphan has no times, so it can't be saved as unscheduled work.
        if (row.status === "not-worked") return row;
        return withValues(row, { note: action.note });
      }
      return { ...row, note: action.note };
    }
    case "use-logged": {
      if (row.kind !== "scheduled") return row;
      const reviewed = row.status !== null && row.status !== "not-worked";
      if (
        reviewed &&
        row.employeeId === action.employeeId &&
        sameClock(row.start, action.start) &&
        sameClock(row.end, action.end)
      ) {
        return row;
      }
      // Logged hours mean the shift was worked, so this also undoes Vacated.
      const worked: ScheduledRow = row.status === "not-worked" ? { ...row, status: null } : row;
      return withValues(worked, { employeeId: action.employeeId, start: action.start, end: action.end });
    }
  }
}

/** True when "Use logged hours" would change the row (see the use-logged action). */
export function canUseLoggedHours(
  row: DraftRow,
  logged: { employeeId: string; start: ClockTime; end: ClockTime },
  today: ISODate,
): boolean {
  return applyRowAction(row, { type: "use-logged", ...logged }, today) !== row;
}

/** Same values in the draft (times compared as minutes). */
export function rowsEqual(a: DraftRow, b: DraftRow): boolean {
  return (
    a.kind === b.kind &&
    a.key === b.key &&
    a.status === b.status &&
    a.employeeId === b.employeeId &&
    sameClock(a.start, b.start) &&
    sameClock(a.end, b.end) &&
    a.note === b.note
  );
}

/**
 * Reset puts a row back to its last-saved state, and removes a row that was added but
 * never saved (P6). Nothing to reset on future rows or untouched rows.
 */
export function canResetRow(row: DraftRow, pristine: DraftRow | undefined, today: ISODate): boolean {
  if (isFutureWorkDate(rowDate(row), today)) return false;
  if (!pristine) return row.kind === "actual-only" && row.saved === null;
  return !rowsEqual(row, pristine);
}

export function newActualOnlyRow(input: {
  id: string;
  employeeId: string;
  date: ISODate;
  start: ClockTime;
  end: ClockTime;
  note: string;
}): ActualOnlyRow {
  return {
    kind: "actual-only",
    key: actualRowKey(input.id),
    id: input.id,
    saved: null,
    orphan: false,
    origin: { employeeId: input.employeeId, start: input.start, end: input.end },
    date: input.date,
    status: "unscheduled",
    employeeId: input.employeeId,
    start: input.start,
    end: input.end,
    note: input.note.trim(),
  };
}

/** Why "Add to actuals" can't add this work yet, or null when it can. */
export function addWorkError(
  input: { employeeId: string | null; date: string; start: string; end: string },
  period: DateRange,
  today: ISODate,
): { title: string; message: string } | null {
  const start = timeToMinutes(input.start);
  const end = timeToMinutes(input.end);
  if (!input.employeeId || !isISODate(input.date) || start === null || end === null) {
    return { title: "Missing shift details", message: "Choose an employee, date, start time, and end time." };
  }
  if (!inPeriod(input.date, period)) {
    return { title: "Date outside this pay period", message: "Choose a date shown in the current pay period." };
  }
  if (isFutureWorkDate(input.date, today)) {
    return { title: "Date has not happened yet", message: "Work can only be added for today or an earlier date." };
  }
  if (start === end) return { title: "Invalid times", message: "Start and end can't be the same time." };
  return null;
}

// ---------------------------------------------------------------------------
// Row display

export function rowStatusLabel(row: DraftRow, today: ISODate): string {
  if (row.status === null && isFutureWorkDate(rowDate(row), today)) return "Upcoming";
  return actualStatusLabel(row.status);
}

/** The line under the status: how the actual differs from the schedule. */
export function rowDifferenceText(row: DraftRow, today: ISODate): string {
  if (row.status === null) {
    return isFutureWorkDate(rowDate(row), today) ? "Available after this date begins." : "";
  }
  if (row.status === "not-worked") return "0 actual hours recorded.";
  if (row.kind === "actual-only") return row.status === "unscheduled" ? "Added to actual hours only." : "";
  const details: string[] = [];
  if (row.employeeId !== row.shift.employee_id) details.push("Different employee");
  const actual = minutesWorked(row.start, row.end);
  const scheduled = minutesWorked(row.shift.start_time, row.shift.end_time);
  details.push(formatActualDifference(actual - scheduled));
  return details.join(" · ");
}

/** 'Scheduled · 9:00 AM – 5:00 PM (8h)' (middle dot, en dash). */
export function scheduledLine(row: DraftRow): string {
  if (row.kind === "actual-only") return row.orphan ? "Its scheduled shift was deleted" : "Not originally scheduled";
  const { start_time: start, end_time: end } = row.shift;
  const minutes = shiftDurationMinutes(start, end);
  const length = minutes === null ? "" : ` (${formatDuration(minutes)})`;
  return `Scheduled · ${formatTime12Hour(start)} – ${formatTime12Hour(end)}${length}`;
}

/** 'Last saved Sep 29' (the business day it was saved on), or 'Not saved yet'. */
export function lastSavedText(saved: Pick<ShiftActual, "actualized_at"> | null): string {
  if (!saved) return "Not saved yet";
  const day = timestampToBusinessDate(saved.actualized_at);
  return day ? `Last saved ${formatMonthDay(day)}` : "Saved";
}

// ---------------------------------------------------------------------------
// Save

// Types (not interfaces) so the plan passes as Json to save_shift_actuals.
export type ScheduledActualWrite = {
  shift_id: string;
  employee_id: string;
  status: "confirmed" | "adjusted" | "not-worked";
  start_time: string | null;
  end_time: string | null;
  note: string;
};
export type ActualOnlyWrite = {
  id: string;
  employee_id: string;
  work_date: ISODate;
  start_time: string;
  end_time: string;
  note: string;
};
export type ActualsSavePlan = {
  deleteIds: string[];
  scheduled: ScheduledActualWrite[];
  actualOnly: ActualOnlyWrite[];
  changeCount: number;
};

/**
 * The writes that turn the saved records into the draft. Untouched rows (times compared
 * as minutes, notes trimmed) are left out, so `changeCount` counts real changes only and
 * the server stamps actualized_at on those alone. Run findInvalidRow first: a row with
 * a missing employee or time is written with '' (which the database would refuse).
 */
export function planActualsSave(rows: readonly DraftRow[], removed: readonly ActualOnlyRow[]): ActualsSavePlan {
  const deleteIds: string[] = [];
  const scheduled: ScheduledActualWrite[] = [];
  const actualOnly: ActualOnlyWrite[] = [];

  for (const row of rows) {
    if (row.kind === "scheduled") {
      if (row.status === null) {
        if (row.saved) deleteIds.push(row.saved.id);
        continue;
      }
      if (row.saved && row.saved.status === row.status && matchesSavedValues(row, row.saved)) continue;
      const vacated = row.status === "not-worked";
      scheduled.push({
        shift_id: row.shift.id,
        // A vacated shift is recorded under its scheduled employee (P8).
        employee_id: vacated ? row.shift.employee_id : (row.employeeId ?? ""),
        status: row.status,
        start_time: vacated ? null : row.start || null,
        end_time: vacated ? null : row.end || null,
        note: row.note.trim(),
      });
      continue;
    }
    if (row.saved && matchesSavedValues(row, row.saved)) continue;
    actualOnly.push({
      id: row.id,
      employee_id: row.employeeId ?? "",
      work_date: row.date,
      start_time: row.start ?? "",
      end_time: row.end ?? "",
      note: row.note.trim(),
    });
  }
  for (const row of removed) if (row.saved) deleteIds.push(row.saved.id);

  return { deleteIds, scheduled, actualOnly, changeCount: deleteIds.length + scheduled.length + actualOnly.length };
}

/** Whose row this is: the scheduled employee, or whoever actual-only work was added for. */
export function rowOwnerId(row: DraftRow): string {
  return row.kind === "scheduled" ? row.shift.employee_id : row.origin.employeeId;
}

export interface InvalidRow {
  row: DraftRow;
  date: ISODate;
  /** The first control to fix. */
  field: "employee" | "start" | "end";
  message: string;
}

/** The first worked row that can't be saved as it is (P9), in list order. */
export function findInvalidRow(rows: readonly DraftRow[], nameOf: (id: string) => string): InvalidRow | null {
  for (const row of [...rows].sort(compareDraftRows)) {
    if (row.status === null || row.status === "not-worked") continue;
    const date = rowDate(row);
    const where = `${nameOf(rowOwnerId(row))} on ${formatShortDate(date)}`;
    const start = timeToMinutes(row.start);
    const end = timeToMinutes(row.end);
    if (!row.employeeId || start === null || end === null) {
      const field = !row.employeeId ? "employee" : start === null ? "start" : "end";
      return { row, date, field, message: `Add an employee and both times for ${where}.` };
    }
    if (start === end) {
      return { row, date, field: "start", message: `Start and end can't be the same time for ${where}.` };
    }
  }
  return null;
}

/**
 * One line per employee and day where their worked rows overlap, on one timeline across
 * days so an overnight shift that runs into the next morning's is caught. The line names
 * the earlier row's date.
 */
export function overlapWarnings(rows: readonly DraftRow[], nameOf: (id: string) => string): string[] {
  const worked: { employeeId: string; date: ISODate; start: number; end: number }[] = [];
  for (const row of rows) {
    if (row.status === null || row.status === "not-worked" || !row.employeeId) continue;
    const interval = absoluteShiftInterval(rowDate(row), row.start, row.end);
    if (interval) worked.push({ employeeId: row.employeeId, date: rowDate(row), ...interval });
  }
  worked.sort((a, b) => a.start - b.start || a.end - b.end);

  const warnings: string[] = [];
  for (let i = 0; i < worked.length; i += 1) {
    for (let j = i + 1; j < worked.length; j += 1) {
      const a = worked[i];
      const b = worked[j];
      if (a.employeeId !== b.employeeId || !(a.start < b.end && b.start < a.end)) continue;
      const warning = `${nameOf(a.employeeId)} has overlapping actual shifts on ${formatShortDate(a.date)}.`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  return warnings;
}

const MAX_OVERLAP_LINES = 4;

export function overlapConfirmMessage(warnings: readonly string[]): string {
  return `${warnings.slice(0, MAX_OVERLAP_LINES).join("\n")}\n\nSave these actuals anyway?`;
}

// ---------------------------------------------------------------------------
// Views of the saved data

export interface ActualsSummary {
  rowCount: number;
  reviewedCount: number;
  scheduledMinutes: number;
  actualMinutes: number;
  reviewedScheduledMinutes: number;
}

/** Totals over the saved rows, leaving out dates that haven't happened yet. */
export function summarize(pristine: readonly DraftRow[], today: ISODate): ActualsSummary {
  const summary: ActualsSummary = {
    rowCount: 0,
    reviewedCount: 0,
    scheduledMinutes: 0,
    actualMinutes: 0,
    reviewedScheduledMinutes: 0,
  };
  for (const row of pristine) {
    if (isFutureWorkDate(rowDate(row), today)) continue;
    summary.rowCount += 1;
    const scheduled = row.kind === "scheduled" ? minutesWorked(row.shift.start_time, row.shift.end_time) : 0;
    summary.scheduledMinutes += scheduled;
    if (row.status === null) continue;
    summary.reviewedCount += 1;
    summary.reviewedScheduledMinutes += scheduled;
    if (row.status !== "not-worked") summary.actualMinutes += minutesWorked(row.start, row.end);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Estimated labor cost

/** Hours times each employee's hourly rate on the day, added up. */
export interface LaborCost {
  dollars: number;
  /** Employees with hours in the total but no rate on one of those days; those hours add nothing. */
  missingRateIds: string[];
}

export interface LaborCosts {
  /** Every shift on the schedule up to today, at its scheduled times. */
  scheduled: LaborCost;
  /** The reviewed hours (the "Actual reviewed" total), for whoever actually worked them. */
  actual: LaborCost;
}

/**
 * The estimated labor cost of the saved rows, leaving out dates that haven't happened yet
 * (the same rows as summarize). Each shift is priced at the rate in effect on its date.
 */
export function laborCosts(pristine: readonly DraftRow[], rates: readonly EmployeeRate[], today: ISODate): LaborCosts {
  const byEmployee = new Map<string, RatePeriod[]>();
  for (const rate of rates) {
    const list = byEmployee.get(rate.employee_id) ?? [];
    list.push(rate);
    byEmployee.set(rate.employee_id, list);
  }
  // Added up in whole "minute-cents" (minutes x rate in cents), which stays exact, and divided
  // by 60 once: a total on a half cent then rounds up, as Postgres rounds numeric.
  const tally = () => ({ minuteCents: 0, missing: new Set<string>() });
  const scheduled = tally();
  const actual = tally();
  const add = (into: ReturnType<typeof tally>, employeeId: string | null, date: ISODate, minutes: number) => {
    if (employeeId === null || minutes === 0) return;
    const rate = rateForDate(byEmployee.get(employeeId) ?? [], date);
    if (rate === null) into.missing.add(employeeId);
    else into.minuteCents += minutes * Math.round(rate * 100);
  };

  for (const row of pristine) {
    const date = rowDate(row);
    if (isFutureWorkDate(date, today)) continue;
    if (row.kind === "scheduled") {
      add(scheduled, row.shift.employee_id, date, minutesWorked(row.shift.start_time, row.shift.end_time));
    }
    if (row.status !== null && row.status !== "not-worked") {
      add(actual, row.employeeId, date, minutesWorked(row.start, row.end));
    }
  }
  const done = (t: ReturnType<typeof tally>): LaborCost => ({
    dollars: Math.round(t.minuteCents / 60) / 100,
    missingRateIds: [...t.missing],
  });
  return { scheduled: done(scheduled), actual: done(actual) };
}

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** '$1,234.50' */
export function formatDollars(dollars: number): string {
  return CURRENCY.format(dollars);
}

/** Under a cost whose total leaves some hours out: 'No rate for Leo Bennett' or 'No rate for 3 employees'. */
export function missingRateNote(ids: readonly string[], nameOf: (employeeId: string) => string): string | undefined {
  if (ids.length === 0) return undefined;
  if (ids.length > 2) return `No rate for ${ids.length} employees`;
  return `No rate for ${ids.map(nameOf).sort((a, b) => a.localeCompare(b)).join(" and ")}`;
}

export type SummaryLabel =
  | "Scheduled"
  | "Actual reviewed"
  | "Difference"
  | "Est. labor costs (scheduled)"
  | "Est. labor costs (actual)";

export interface SummaryStat {
  label: SummaryLabel;
  value: string;
  /** A short line under the value, e.g. which employees have no rate. */
  note?: string;
}

/**
 * The summary strip. `costs` is null until the pay rates have loaded (or when they can't),
 * which shows a dash for both costs. Without `withCosts` (payroll staff, who can't see pay
 * rates) the two costs are left out.
 */
export function summaryStats(
  s: ActualsSummary,
  costs: LaborCosts | null,
  nameOf: (employeeId: string) => string,
  withCosts = true,
): SummaryStat[] {
  const cost = (label: SummaryLabel, c: LaborCost | undefined, shown: boolean): SummaryStat => {
    if (!c || !shown) return { label, value: "—" };
    const note = missingRateNote(c.missingRateIds, nameOf);
    return note ? { label, value: formatDollars(c.dollars), note } : { label, value: formatDollars(c.dollars) };
  };
  const hours: SummaryStat[] = [
    { label: "Scheduled", value: formatActualHours(s.scheduledMinutes) },
    { label: "Actual reviewed", value: formatActualHours(s.actualMinutes) },
    {
      label: "Difference",
      value: s.reviewedCount ? formatActualDifference(s.actualMinutes - s.reviewedScheduledMinutes) : "—",
    },
  ];
  if (!withCosts) return hours;
  return [
    ...hours,
    cost("Est. labor costs (scheduled)", costs?.scheduled, true),
    cost("Est. labor costs (actual)", costs?.actual, s.reviewedCount > 0),
  ];
}

function reviewedText(reviewed: number, total: number): string {
  return `${reviewed} of ${total} shift${total === 1 ? "" : "s"} reviewed`;
}

export function progressLabel(s: ActualsSummary): string {
  return s.rowCount ? reviewedText(s.reviewedCount, s.rowCount) : "No shifts scheduled this pay period";
}

/** One day tab: 'Tue' / 15 / '2/3', and its spoken label. */
export function dayTab(
  date: ISODate,
  pristine: readonly DraftRow[],
  today: ISODate,
  closed: ReadonlySet<ISODate>,
): { weekday: string; day: number; progressText: string; ariaLabel: string } {
  const rows = pristine.filter((row) => rowDate(row) === date);
  const reviewed = rows.filter((row) => row.status !== null).length;
  let progressText: string;
  let spoken: string;
  if (isFutureWorkDate(date, today)) {
    progressText = "Future";
    spoken = "future date";
  } else if (rows.length) {
    progressText = `${reviewed}/${rows.length}`;
    spoken = reviewedText(reviewed, rows.length);
  } else if (closed.has(date)) {
    progressText = "Closed";
    spoken = "closed";
  } else {
    progressText = "—";
    spoken = "no shifts";
  }
  const longDay = formatISODate(date, { weekday: "long", month: "long", day: "numeric" });
  return {
    weekday: WEEKDAY_SHORT[weekdayOf(date)],
    day: Number(date.slice(8, 10)),
    progressText,
    ariaLabel: `${longDay}, ${spoken}`,
  };
}

/**
 * The day tab a key moves to from tab `index` (WAI tabs: arrows wrap, Home and End jump),
 * or null for any other key. Pass the focused tab's index, not the selected one: the
 * selection follows the URL a moment later, so fast presses would repeat the same step.
 */
export function dayTabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export interface PayrollLine {
  employee: Employee;
  minutes: number;
}

const COUNTED_STATUSES: ReadonlySet<ActualStatus> = new Set(["confirmed", "adjusted", "unscheduled"]);

/**
 * Saved hours per employee for the payroll output: every active employee (0 hours
 * included) plus anyone archived who worked in the period, by name.
 */
export function payrollLines(
  employees: readonly Employee[],
  actuals: readonly ShiftActual[],
  period: DateRange,
): PayrollLine[] {
  const minutes = new Map<string, number>();
  for (const actual of actuals) {
    if (!COUNTED_STATUSES.has(actual.status) || !inPeriod(actual.work_date, period)) continue;
    if (actual.start_time === null || actual.end_time === null) continue;
    // Summed raw, rounded once when formatted.
    minutes.set(
      actual.employee_id,
      (minutes.get(actual.employee_id) ?? 0) + minutesWorked(actual.start_time, actual.end_time),
    );
  }
  return employees
    .map((employee) => ({ employee, minutes: minutes.get(employee.id) ?? 0 }))
    .filter((line) => !line.employee.archived || line.minutes > 0)
    .sort(
      (a, b) =>
        a.employee.name.localeCompare(b.employee.name, "en-US", { sensitivity: "base" }) ||
        (a.employee.id < b.employee.id ? -1 : a.employee.id > b.employee.id ? 1 : 0),
    );
}

/** '- Avery Lane - 12 hours' lines; '' when there are none. */
export function payrollClipboardText(lines: readonly PayrollLine[]): string {
  return lines.map((line) => `- ${line.employee.name} - ${formatPayrollDecimalHours(line.minutes)} hours`).join("\n");
}
