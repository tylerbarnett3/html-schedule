// Toast texts, undo labels and error messages for the admin calendar's writes (§6, §7.1,
// §9 calendar-ui item 6). Pure, so they are unit-tested.

import {
  adminErrorCode,
  adminErrorMessage,
  errorFields,
  SCHEDULE_INFO_CODES,
  type AdminErrorCode,
} from "../../../data/errors";
import { formatChipDate, formatMonthDay, formatShortDate, isISODate } from "../../../lib/dates";
import {
  formatHoursRange,
  HOURS_MESSAGES,
  type DayHoursState,
  type Hours,
  type HoursChoice,
} from "../../../lib/hours";
import { isDayPeriod } from "../../../lib/periods";
import type { ScheduleChange } from "../../../lib/scheduleChange";
import { buildPendingBlockMessage, removedShiftsText } from "../../../lib/scheduleEditing";
import type { DayPeriod, Employee, ISODate } from "../../../lib/types";

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** "; 2 conflicting shifts removed" after a day-off message, when any were. */
export function withRemovedShifts(message: string, removed: number): string {
  return removed > 0 ? `${message}; ${removedShiftsText(removed)}` : message;
}

// ---------------------------------------------------------------------------
// Undo labels (§6)

export const addShiftsLabel = (n: number): string => `Add ${plural(n, "shift")}`;
export const addDaysOffLabel = (n: number): string => `Add ${plural(n, "day")} off`;
export const closeDaysLabel = (n: number): string => `Close ${plural(n, "day")}`;
/** 'Reopen Oct 9' */
export const reopenLabel = (date: ISODate): string => `Reopen ${formatMonthDay(date)}`;

// ---------------------------------------------------------------------------
// Success toasts (§7.1)

/** '3 shifts added' */
export const shiftsAddedText = (n: number): string => `${plural(n, "shift")} added`;
/** '2 days off added; 1 conflicting shift removed' */
export const daysOffAddedText = (n: number, removed: number): string =>
  withRemovedShifts(`${plural(n, "day")} off added`, removed);
/** 'Shift moved to Mon, Oct 5' */
export const shiftMovedText = (date: ISODate): string => `Shift moved to ${formatChipDate(date)}`;
/** 'Day off moved to Mon, Oct 5', plus the removed shifts. */
export const dayOffMovedText = (date: ISODate, removed: number): string =>
  withRemovedShifts(`Day off moved to ${formatChipDate(date)}`, removed);
/**
 * Marking days closed that all were closed already (Hours → Closed lets them be picked):
 * an info toast instead of "0 days marked closed".
 */
export const alreadyClosedText = (n: number): string =>
  n === 1 ? "That day is already closed." : "Those days are already closed.";

// ---------------------------------------------------------------------------
// Business hours for single dates (Day Hours dialog, Add → Hours, Reopen day)

export const HOURS_UPDATED_TITLE = "Hours Updated";
const HOURS_FALLBACK = "Couldn't save the hours. Please try again.";

function uniqueDates(dates: readonly ISODate[]): ISODate[] {
  return [...new Set(dates)];
}

/** 'Oct 31' for one date, '3 days' for more (unique dates). */
function whichDays(dates: readonly ISODate[], format: (date: ISODate) => string): string {
  const unique = uniqueDates(dates);
  return unique.length === 1 ? format(unique[0]) : plural(unique.length, "day");
}

/** 'Set custom hours for Oct 31' | 'Set custom hours for 3 days' (unique dates) */
export function customHoursLabel(dates: readonly ISODate[]): string {
  return `Set custom hours for ${whichDays(dates, formatMonthDay)}`;
}

/** 'Set standard hours for Oct 31' | 'Set standard hours for 3 days' */
export function standardHoursLabel(dates: readonly ISODate[]): string {
  return `Set standard hours for ${whichDays(dates, formatMonthDay)}`;
}

/** 'Sat, Oct 31: 9:00 AM - 5:00 PM' | '3 days: 9:00 AM - 5:00 PM' */
export function customHoursText(dates: readonly ISODate[], hours: Hours): string {
  return `${whichDays(dates, formatChipDate)}: ${formatHoursRange(hours)}`;
}

/** 'Sat, Oct 31: standard hours' | '3 days: standard hours' */
export function standardHoursText(dates: readonly ISODate[]): string {
  return `${whichDays(dates, formatChipDate)}: standard hours`;
}

export const REOPENED_TITLE = "Business Day Reopened";

/** The undo label and the success toast for an hours write that changed something. */
export interface HoursSaveText {
  label: string;
  title: string;
  message: string;
}

/**
 * Words for a non-empty change from setting dates to custom hours (`hours`) or to standard
 * hours (`hours` null), picked from what the change did, so the same result reads the same
 * from Day Hours, Add → Hours and Reopen day:
 * - custom hours stored or changed: "Set custom hours for …" / "Sat, Oct 31: 9:00 AM - 5:00 PM";
 * - one day reopened with no custom hours stored: "Reopen Oct 9" / "Business Day Reopened";
 * - otherwise: "Set standard hours for …" / "Sat, Oct 31: standard hours". Custom hours equal
 *   to a day's standard hours count as standard (REQUIREMENTS §2), so the server stores none.
 */
export function hoursSaveText(dates: readonly ISODate[], change: ScheduleChange, hours: Hours | null): HoursSaveText {
  const unique = uniqueDates(dates);
  if (hours !== null && (change.inserted.custom_hours.length > 0 || change.updated.custom_hours.length > 0)) {
    return { label: customHoursLabel(unique), title: HOURS_UPDATED_TITLE, message: customHoursText(unique, hours) };
  }
  if (unique.length === 1 && change.deleted.closed_days.length > 0) {
    return { label: reopenLabel(unique[0]), title: REOPENED_TITLE, message: formatShortDate(unique[0]) };
  }
  return { label: standardHoursLabel(unique), title: HOURS_UPDATED_TITLE, message: standardHoursText(unique) };
}

/** Custom hours the days already had: an info toast, never a fake success. */
export function sameHoursText(n: number): string {
  return n === 1 ? "That day already has those hours." : "Those days already have those hours.";
}

/** Standard hours on days that already had them. */
export function alreadyStandardText(n: number): string {
  return n === 1 ? "That day already has standard hours." : "Those days already have standard hours.";
}

/** A failed hours write: the time check, else the shared admin messages. */
export function hoursErrorMessage(error: unknown): string {
  return adminErrorCode(error) === "check_failed" ? HOURS_MESSAGES.order : adminErrorMessage(error, HOURS_FALLBACK);
}

/** The hint under the Day Hours choice: what saving it does to this day. */
export function dayHoursHint(choice: HoursChoice, state: DayHoursState, standard: Hours | null): string {
  if (choice === "closed") {
    return state.kind === "closed"
      ? "This day is closed."
      : "Closing deletes this day's shifts and time off. Payroll records and availability are kept.";
  }
  const base = standard
    ? `Standard hours for this day: ${formatHoursRange(standard)}.`
    : "No standard hours are set yet.";
  return state.kind === "closed" ? `Reopens the day. ${base}` : base;
}

const ADD_HOURS_HINTS: Readonly<Record<HoursChoice, string>> = {
  standard: "Pick the days to put back on standard hours. Closed days are reopened.",
  custom: "Pick the days that get these hours. Closed days are reopened.",
  closed: "Pick the days to close. Their shifts and time off are deleted; payroll records and availability are kept.",
};

/** The hint for Add → Hours. */
export function addHoursHint(choice: HoursChoice): string {
  return ADD_HOURS_HINTS[choice];
}

// ---------------------------------------------------------------------------
// Errors (§9 calendar-ui item 6)

export const SAVE_FALLBACK = "Couldn't save changes. Please try again.";
export const ALREADY_REMOVED = "This item was changed or removed. The page has been refreshed.";
const ADD_ON_CLOSED_DAY = "Reopen closed business days before adding shifts.";
const MOVE_TO_CLOSED_DAY = "Reopen this business day before moving shifts here.";
const DAY_OFF_OVERLAP = "That employee already has time off for that part of the day. Refresh and try again.";
const DUPLICATE_SHIFT = "That shift already exists.";
const SAME_TIMES = "Start and end times can't be the same.";

/** The pending request a `pending_request` error names in its details (JSON). */
export function pendingRequestDetail(
  details: string,
): { employee_id: string; off_date: ISODate; period: DayPeriod } | null {
  let value: unknown;
  try {
    value = JSON.parse(details);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const employeeId = "employee_id" in value ? value.employee_id : undefined;
  const offDate = "off_date" in value ? value.off_date : undefined;
  const period = "period" in value ? value.period : undefined;
  if (typeof employeeId !== "string" || !isISODate(offDate) || !isDayPeriod(period)) return null;
  return { employee_id: employeeId, off_date: offDate, period };
}

// Codes that mean "the schedule doesn't allow this" (the database's backstop for the
// checks the page already runs), as opposed to a failed connection or a lost row.
const RULE_CODES: ReadonlySet<AdminErrorCode> = new Set([
  "closed_day",
  "pending_request",
  "day_off_overlap",
  "duplicate",
  "check_failed",
  "request_locked",
]);

export interface ScheduleError {
  code: AdminErrorCode;
  message: string;
  /** A schedule rule refused the change (shown like the page's own checks). */
  rule: boolean;
}

/**
 * The message for a failed calendar write. `adding` picks the closed-day wording;
 * `requestLocked` is the C8 message for the change that was attempted.
 */
export function scheduleError(
  error: unknown,
  options: { adding: boolean; employees: readonly Employee[]; requestLocked?: string },
): ScheduleError {
  const code = adminErrorCode(error);
  let message: string;
  switch (code) {
    case "closed_day":
      message = options.adding ? ADD_ON_CLOSED_DAY : MOVE_TO_CLOSED_DAY;
      break;
    case "pending_request": {
      const detail = pendingRequestDetail(errorFields(error).details);
      message = detail ? buildPendingBlockMessage([detail], options.employees) : SAVE_FALLBACK;
      break;
    }
    case "day_off_overlap":
      message = DAY_OFF_OVERLAP;
      break;
    case "duplicate":
      message = DUPLICATE_SHIFT;
      break;
    case "check_failed":
      message = SAME_TIMES;
      break;
    case "request_locked":
      message = options.requestLocked ?? SAVE_FALLBACK;
      break;
    default:
      message = adminErrorMessage(error, SAVE_FALLBACK);
  }
  return { code, message, rule: RULE_CODES.has(code) };
}

/**
 * The tone of a failed write shown as a toast. A row someone else changed or removed is not
 * a failure: the page has been refreshed, so it is info, as everywhere else it can happen
 * (§7.1, "already reviewed or removed").
 */
export function failureTone(failure: ScheduleError): "info" | "error" {
  return SCHEDULE_INFO_CODES.includes(failure.code) ? "info" : "error";
}
