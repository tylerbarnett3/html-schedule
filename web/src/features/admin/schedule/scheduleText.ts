// Toast texts, undo labels and error messages for the admin calendar's writes (§6, §7.1,
// §9 calendar-ui item 6). Pure, so they are unit-tested.

import {
  adminErrorCode,
  adminErrorMessage,
  errorFields,
  SCHEDULE_INFO_CODES,
  type AdminErrorCode,
} from "../../../data/errors";
import { formatChipDate, formatMonthDay, isISODate } from "../../../lib/dates";
import { isDayPeriod } from "../../../lib/periods";
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
 * Marking days closed that all were closed already (the Closed type lets them be picked):
 * an info toast instead of "0 days marked closed".
 */
export const alreadyClosedText = (n: number): string =>
  n === 1 ? "That day is already closed." : "Those days are already closed.";

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
