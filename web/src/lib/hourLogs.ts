// Logged hours ("Log My Hours", migration 006): an employee's own account of when they worked
// one of their shifts, for the admin to see while reviewing payroll. Logging isn't a payroll
// review. Which shifts can be logged is decided by the database (my_loggable_shifts): the
// employee's own, from Sep 28, 2026 on, once they have ended, until the admin reviews them.
// Pure functions only.

import { formatChipDate, isISODate } from "./dates";
import { formatActualDifference, formatDuration, sameClock, type ClockTime } from "./payroll";
import type { Tables } from "./supabase";
import { formatShiftTime, formatTime12Hour, isOvernight, shiftDurationMinutes, timeToMinutes, toClock } from "./time";
import type { ISODate, PgTime } from "./types";

export const HOUR_LOG_NOTE_MAX_LENGTH = 160;

/** What an employee logged for a shift, as the admin reads it. */
export type HourLog = Pick<
  Tables<"hour_logs">,
  "shift_id" | "employee_id" | "start_time" | "end_time" | "note" | "updated_at"
>;

export interface LoggedHours {
  start: PgTime;
  end: PgTime;
  note: string;
}

/** A shift the signed-in employee can log now, with what they logged (null until they do). */
export interface LoggableShift {
  shiftId: string;
  date: ISODate;
  start: PgTime;
  end: PgTime;
  log: LoggedHours | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is PgTime {
  return typeof value === "string" && timeToMinutes(value) !== null;
}

/** my_loggable_shifts' rows (newest first, as the database orders them). Throws on anything else. */
export function parseLoggableShifts(data: unknown): LoggableShift[] {
  if (!Array.isArray(data)) throw new Error("Unexpected response when loading your shifts.");
  return data.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.shift_id !== "string" ||
      !isISODate(row.shift_date) ||
      !isTime(row.start_time) ||
      !isTime(row.end_time)
    ) {
      throw new Error("Unexpected response when loading your shifts.");
    }
    const logged = isTime(row.logged_start) && isTime(row.logged_end);
    return {
      shiftId: row.shift_id,
      date: row.shift_date,
      start: row.start_time,
      end: row.end_time,
      log: logged
        ? {
            start: row.logged_start as PgTime,
            end: row.logged_end as PgTime,
            note: typeof row.logged_note === "string" ? row.logged_note : "",
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// The employee's form

export interface HourLogDraft {
  start: ClockTime;
  end: ClockTime;
  note: string;
}

/** The form's first values: what was logged, or else the scheduled times. */
export function hourLogDraft(shift: LoggableShift): HourLogDraft {
  const source = shift.log ?? { start: shift.start, end: shift.end, note: "" };
  return { start: toClock(source.start) ?? "", end: toClock(source.end) ?? "", note: source.note };
}

/** Why the form can't be saved, or null when it can. */
export function hourLogDraftError(draft: HourLogDraft): string | null {
  const start = timeToMinutes(draft.start);
  const end = timeToMinutes(draft.end);
  if (start === null || end === null) return "Enter the time you started and the time you finished.";
  if (start === end) return "Start and end can't be the same time.";
  if (draft.note.trim().length > HOUR_LOG_NOTE_MAX_LENGTH) {
    return `Keep the note to ${HOUR_LOG_NOTE_MAX_LENGTH} characters.`;
  }
  return null;
}

/** True when saving would change nothing (times compared as minutes, the note trimmed). */
export function hourLogUnchanged(shift: LoggableShift, draft: HourLogDraft): boolean {
  const { log } = shift;
  return (
    log !== null &&
    sameClock(log.start, draft.start) &&
    sameClock(log.end, draft.end) &&
    log.note.trim() === draft.note.trim()
  );
}

/** Under the times when they run past midnight: 'Finished after midnight, the next day: 22h 10m in all.' */
export function overnightHint(draft: HourLogDraft): string | null {
  const minutes = shiftDurationMinutes(draft.start, draft.end);
  if (!isOvernight(draft.start, draft.end) || minutes === null) return null;
  return `Finished after midnight, the next day: ${formatDuration(minutes)} in all.`;
}

/**
 * Asked before saving hours that run past midnight on a shift that doesn't, which is most
 * likely AM and PM mixed up (11:00 AM to 9:10 AM is 22h 10m). Null otherwise.
 */
export function overnightQuestion(shift: LoggableShift, draft: HourLogDraft): string | null {
  const minutes = shiftDurationMinutes(draft.start, draft.end);
  if (isOvernight(shift.start, shift.end) || !isOvernight(draft.start, draft.end) || minutes === null) return null;
  return (
    `${formatTime12Hour(draft.start)} to ${formatTime12Hour(draft.end)} the next day is ${formatDuration(minutes)}. ` +
    "Check AM and PM, or save it if you worked past midnight."
  );
}

/** 'Tue, Sep 29' */
export function loggableShiftDate(shift: LoggableShift): string {
  return formatChipDate(shift.date);
}

/** 'Scheduled 11:00 AM - 9:00 PM' */
export function loggableShiftScheduled(shift: LoggableShift): string {
  return `Scheduled ${formatShiftTime({ start_time: shift.start, end_time: shift.end })}`;
}

/** 'Logged 11:05 AM - 9:10 PM', or 'Not logged yet'. */
export function loggableShiftStatus(shift: LoggableShift): string {
  const { log } = shift;
  return log ? `Logged ${formatShiftTime({ start_time: log.start, end_time: log.end })}` : "Not logged yet";
}

// ---------------------------------------------------------------------------
// Payroll

/** Logs by shift id. */
export function hourLogsByShift(logs: readonly HourLog[]): ReadonlyMap<string, HourLog> {
  return new Map(logs.map((log) => [log.shift_id, log]));
}

/**
 * The line under 'Scheduled · …' on a payroll card: 'Logged · 11:05 AM – 9:10 PM (+10 min)',
 * or 'Logged by Mia · …' when someone other than the scheduled employee logged it. The
 * difference is in length from the scheduled hours ('No time difference' when only the times moved).
 */
export function payrollLoggedLine(
  log: Pick<HourLog, "start_time" | "end_time">,
  shift: { start_time: PgTime; end_time: PgTime },
  loggedBy: string | null,
): string {
  const logged = shiftDurationMinutes(log.start_time, log.end_time);
  const scheduled = shiftDurationMinutes(shift.start_time, shift.end_time);
  const asScheduled = sameClock(log.start_time, shift.start_time) && sameClock(log.end_time, shift.end_time);
  const difference = asScheduled
    ? " (as scheduled)"
    : logged === null || scheduled === null
      ? ""
      : ` (${formatActualDifference(logged - scheduled)})`;
  const who = loggedBy === null ? "Logged" : `Logged by ${loggedBy}`;
  return `${who} · ${formatTime12Hour(log.start_time)} – ${formatTime12Hour(log.end_time)}${difference}`;
}
