// Rules and messages for the admin's schedule edits: adding shifts and days off, the Edit
// dialog, drag and drop, and setting a date's hours (closing days included). Pure functions over rows fetched at save time,
// so the dialogs and the calendar decide the same way. The database enforces the rest.

import type { DayCard } from "./calendar";
import { formatChipDate, formatDateList, formatShortDate, isISODate } from "./dates";
import { checkHoursTimes, type HoursChoice } from "./hours";
import { formatPeriod, normalizePeriod, periodCoversShiftStart, periodSortValue, periodsConflict } from "./periods";
import { absoluteShiftInterval, compareTimes, formatShiftTime, intervalsOverlap, timeToMinutes, toClock } from "./time";
import type { Availability, DayPeriod, Employee, ISODate, PgTime, Shift, TimeOff } from "./types";

/** The Add dialog's types. Hours sets several dates to standard hours, custom hours or closed. */
export type AddItemType = "shift" | "day-off" | "hours";

export const ADD_ITEM_TYPE_LABELS: Record<AddItemType, string> = {
  shift: "Shift",
  "day-off": "Day Off",
  hours: "Hours",
};

export const ADD_ITEM_TITLES: Record<AddItemType, string> = {
  shift: "Add Shift",
  "day-off": "Add Day Off",
  hours: "Set Hours",
};

const HOURS_SAVE_LABELS: Readonly<Record<HoursChoice, string>> = {
  standard: "Set Standard Hours",
  custom: "Set Custom Hours",
  closed: "Mark Closed",
};

/** Add Shift | Add Day Off | Set Standard Hours | Set Custom Hours | Mark Closed */
export function addItemSaveLabel(type: AddItemType, choice: HoursChoice): string {
  switch (type) {
    case "shift":
      return "Add Shift";
    case "day-off":
      return "Add Day Off";
    case "hours":
      return HOURS_SAVE_LABELS[choice];
  }
}

/** The Add dialog's shortcuts; label each with formatShiftTime. */
export const QUICK_SHIFTS: readonly { start: PgTime; end: PgTime }[] = [
  { start: "09:30", end: "17:00" },
  { start: "10:30", end: "17:00" },
  { start: "12:00", end: "16:00" },
  { start: "12:45", end: "18:00" },
  { start: "16:50", end: "21:00" },
];

/** Longest list a conflict message shows before "… more not shown." */
export const MAX_MESSAGE_LINES = 8;

const UNKNOWN_EMPLOYEE = "Unknown";

// Messages (exact strings from the old page, plus the contract's new ones).
const NO_DATES = "Please select at least one date";
const NO_EMPLOYEES = "Please select at least one employee";
const ADD_ON_CLOSED_DAY = "Reopen closed business days before adding shifts.";
const MISSING_TIMES = "Please fill in start and end times";
const SAME_TIMES = "Start and end times can't be the same.";
const MISSING_EMPLOYEE_OR_DATE = "Please fill in employee and date";
const MOVE_TO_CLOSED_DAY = "Reopen this business day before moving shifts here.";
const CLOSED_DAY_TITLE = "Closed for business";
const PAYROLL_KEPT_LINE = "Payroll hours recorded on these shifts are kept.";
const CONTINUE_LINE = "Continue?";

// ---------------------------------------------------------------------------
// Card routing

/** A pending request, opened in the review dialog. */
export type ReviewTarget = { kind: "time-off"; row: TimeOff } | { kind: "availability"; row: Availability };
/** Opened in the Edit dialog. A day off is approved time off from either source. */
export type EditTarget = { kind: "shift"; row: Shift } | { kind: "day-off"; row: TimeOff };
export type CardAction = { kind: "edit"; target: EditTarget } | { kind: "review"; target: ReviewTarget };

/** What clicking a calendar card does. Approved availability isn't clickable. */
export function cardAction(card: DayCard): CardAction | null {
  switch (card.kind) {
    case "shift":
      return { kind: "edit", target: { kind: "shift", row: card.row } };
    case "pending-time-off":
      return { kind: "review", target: { kind: "time-off", row: card.row } };
    case "time-off":
      return card.row.status === "pending"
        ? { kind: "review", target: { kind: "time-off", row: card.row } }
        : { kind: "edit", target: { kind: "day-off", row: card.row } };
    case "availability":
      return card.row.status === "pending" ? { kind: "review", target: { kind: "availability", row: card.row } } : null;
  }
}

/**
 * Shifts and days off the admin assigned can be dragged. A day off an employee asked for
 * can't, so it isn't moved by accident; its date can still be changed in the Edit dialog.
 */
export function canDragCard(card: DayCard): boolean {
  if (card.kind === "shift") return true;
  return card.kind === "time-off" && card.row.status === "approved" && card.row.source === "assigned";
}

// ---------------------------------------------------------------------------
// Ordering and names

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Valid dates only, de-duplicated and in date order. */
function sortedDates(dates: readonly string[]): ISODate[] {
  return uniqueValues(dates.filter(isISODate)).sort(compareStrings);
}

const nameCollator = new Intl.Collator("en");

interface EmployeeLookup {
  name(id: string): string;
  /** Employee list order (display_order, name, id); unknown employees go last, by id. */
  compare(aId: string, bId: string): number;
}

function employeeLookup(employees: readonly Employee[]): EmployeeLookup {
  const byId = new Map(employees.map((e) => [e.id, e]));
  return {
    name: (id) => byId.get(id)?.name ?? UNKNOWN_EMPLOYEE,
    compare(aId, bId) {
      const a = byId.get(aId);
      const b = byId.get(bId);
      if (a && b) {
        return a.display_order - b.display_order || nameCollator.compare(a.name, b.name) || compareStrings(a.id, b.id);
      }
      if (a) return -1;
      if (b) return 1;
      return compareStrings(aId, bId);
    },
  };
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Same time of day by minutes, so '09:00' matches '09:00:00' and '24:00' matches '00:00'. */
function sameTime(a: PgTime | null | undefined, b: PgTime | null | undefined): boolean {
  const aMinutes = timeToMinutes(a);
  const bMinutes = timeToMinutes(b);
  return aMinutes !== null && bMinutes !== null && aMinutes % 1440 === bMinutes % 1440;
}

// ---------------------------------------------------------------------------
// Shift conflicts

export type TimeOffReason = "approved full-day time off" | "approved morning time off" | "approved evening time off";

export type ShiftConflict =
  | { type: "shift"; shift: Shift }
  | { type: "time-off"; timeOff: TimeOff; reason: TimeOffReason };

export interface ShiftCheck {
  employeeId: string;
  date: ISODate;
  startTime: PgTime;
  endTime: PgTime;
  ignoreShiftId?: string | null;
  ignoreTimeOffId?: string | null;
}

function timeOffReason(period: DayPeriod): TimeOffReason {
  const normalized = normalizePeriod(period);
  return normalized === "full-day"
    ? "approved full-day time off"
    : normalized === "morning"
      ? "approved morning time off"
      : "approved evening time off";
}

/**
 * The first thing that stops this shift from being saved. Approved time off (either source)
 * that covers the shift's start on its date comes first; pending requests never block. Then
 * the same employee's shifts, compared on one timeline across days so overnight shifts that
 * spill into the next morning are caught (touching times don't overlap), earliest first.
 */
export function findShiftConflict(
  check: ShiftCheck,
  shifts: readonly Shift[],
  timeOff: readonly TimeOff[],
): ShiftConflict | null {
  const blocking = timeOff
    .filter(
      (t) =>
        t.status === "approved" &&
        t.employee_id === check.employeeId &&
        t.off_date === check.date &&
        t.id !== check.ignoreTimeOffId &&
        periodCoversShiftStart(t.period, check.startTime),
    )
    .sort((a, b) => periodSortValue(a.period) - periodSortValue(b.period) || compareStrings(a.id, b.id));
  const timeOffHit = blocking[0];
  if (timeOffHit) return { type: "time-off", timeOff: timeOffHit, reason: timeOffReason(timeOffHit.period) };

  const requested = absoluteShiftInterval(check.date, check.startTime, check.endTime);
  if (!requested) return null;
  // Shifts are under 24 hours, so only the day before, the day itself and the day after can
  // overlap; the timeline comparison needs no date filter.
  let first: { shift: Shift; start: number } | null = null;
  for (const shift of shifts) {
    if (shift.employee_id !== check.employeeId || shift.id === check.ignoreShiftId) continue;
    const existing = absoluteShiftInterval(shift.shift_date, shift.start_time, shift.end_time);
    if (!existing || !intervalsOverlap(requested, existing)) continue;
    if (!first || (existing.start - first.start || compareStrings(shift.id, first.shift.id)) < 0) {
      first = { shift, start: existing.start };
    }
  }
  return first ? { type: "shift", shift: first.shift } : null;
}

export interface ShiftConflictEntry {
  employeeId: string;
  employeeName: string;
  date: ISODate;
  conflict: ShiftConflict;
}

/** At most one conflict per date and employee: dates outer, employees inner, as given. */
export function getShiftSubmissionConflicts(input: {
  employeeIds: readonly string[];
  dates: readonly ISODate[];
  startTime: PgTime;
  endTime: PgTime;
  ignoreShiftId?: string | null;
  ignoreTimeOffId?: string | null;
  shifts: readonly Shift[];
  timeOff: readonly TimeOff[];
  employees: readonly Employee[];
}): ShiftConflictEntry[] {
  const lookup = employeeLookup(input.employees);
  const entries: ShiftConflictEntry[] = [];
  for (const date of uniqueValues(input.dates)) {
    for (const employeeId of uniqueValues(input.employeeIds)) {
      const conflict = findShiftConflict(
        {
          employeeId,
          date,
          startTime: input.startTime,
          endTime: input.endTime,
          ignoreShiftId: input.ignoreShiftId,
          ignoreTimeOffId: input.ignoreTimeOffId,
        },
        input.shifts,
        input.timeOff,
      );
      if (conflict) entries.push({ employeeId, employeeName: lookup.name(employeeId), date, conflict });
    }
  }
  return entries;
}

interface ShiftListItem {
  date: ISODate;
  employeeId: string;
  employeeName: string;
  shift: Pick<Shift, "id" | "start_time" | "end_time">;
}

/**
 * 'Sep 30, 2026\n  - Avery Lane: 9:00 AM - 3:00 PM' blocks, one per date (first-seen order),
 * listing each employee's shifts together. A shift listed twice appears once.
 */
function shiftDateBlocks(items: readonly ShiftListItem[]): { text: string; shiftCount: number }[] {
  const byDate = new Map<ISODate, Map<string, { name: string; shifts: ShiftListItem["shift"][]; ids: Set<string> }>>();
  for (const item of items) {
    let byEmployee = byDate.get(item.date);
    if (!byEmployee) {
      byEmployee = new Map();
      byDate.set(item.date, byEmployee);
    }
    let group = byEmployee.get(item.employeeId);
    if (!group) {
      group = { name: item.employeeName, shifts: [], ids: new Set() };
      byEmployee.set(item.employeeId, group);
    }
    if (group.ids.has(item.shift.id)) continue;
    group.ids.add(item.shift.id);
    group.shifts.push(item.shift);
  }
  return [...byDate].map(([date, byEmployee]) => {
    const lines = [...byEmployee.values()].flatMap((group) =>
      group.shifts.map((shift) => `  - ${group.name}: ${formatShiftTime(shift)}`),
    );
    return { text: `${formatShortDate(date)}\n${lines.join("\n")}`, shiftCount: lines.length };
  });
}

/**
 * The old page's message. Shift conflicts are listed under the existing shift's own date
 * (an overnight shift from the day before shows under that day), then one line per
 * time-off conflict. At most 8 blocks or lines are shown.
 */
export function buildShiftConflictMessage(conflicts: readonly ShiftConflictEntry[]): string {
  const shiftItems: ShiftListItem[] = [];
  const timeOffLines: string[] = [];
  for (const entry of conflicts) {
    const { conflict } = entry;
    if (conflict.type === "shift") {
      shiftItems.push({
        date: conflict.shift.shift_date,
        employeeId: entry.employeeId,
        employeeName: entry.employeeName,
        shift: conflict.shift,
      });
    } else {
      timeOffLines.push(`${entry.employeeName} already has ${conflict.reason} on ${formatShortDate(entry.date)}.`);
    }
  }
  const allLines = [...shiftDateBlocks(shiftItems).map((block) => block.text), ...timeOffLines];
  const lines = allLines.slice(0, MAX_MESSAGE_LINES);
  const hidden = allLines.length - lines.length;
  if (hidden > 0) lines.push(`${plural(hidden, "more conflict")} not shown.`);
  return `This shift cannot be saved because it conflicts with existing schedule items:\n\n${lines.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Shifts a day off takes out

export interface CoveredShift {
  employeeId: string;
  employeeName: string;
  date: ISODate;
  shift: Shift;
}

/**
 * Shifts on these employees' dates whose start the period covers, one entry per shift, in
 * date, employee (list order), start time, id order.
 */
function coveredShifts(
  days: readonly { employeeId: string; date: ISODate; period: DayPeriod }[],
  shifts: readonly Shift[],
  employees: readonly Employee[],
  ignoreShiftId?: string | null,
): CoveredShift[] {
  const lookup = employeeLookup(employees);
  const seen = new Set<string>();
  const covered: CoveredShift[] = [];
  for (const day of days) {
    for (const shift of shifts) {
      if (
        seen.has(shift.id) ||
        shift.id === ignoreShiftId ||
        shift.employee_id !== day.employeeId ||
        shift.shift_date !== day.date ||
        !periodCoversShiftStart(day.period, shift.start_time)
      ) {
        continue;
      }
      seen.add(shift.id);
      covered.push({ employeeId: day.employeeId, employeeName: lookup.name(day.employeeId), date: day.date, shift });
    }
  }
  return covered.sort(
    (a, b) =>
      compareStrings(a.date, b.date) ||
      lookup.compare(a.employeeId, b.employeeId) ||
      compareTimes(a.shift.start_time, b.shift.start_time) ||
      compareStrings(a.shift.id, b.shift.id),
  );
}

/** Shifts that adding (or moving) a day off for these employees and dates would delete. */
export function getDayOffConflicts(input: {
  employeeIds: readonly string[];
  dates: readonly ISODate[];
  period: DayPeriod;
  shifts: readonly Shift[];
  employees: readonly Employee[];
  ignoreShiftId?: string | null;
}): CoveredShift[] {
  const days = input.dates.flatMap((date) =>
    input.employeeIds.map((employeeId) => ({ employeeId, date, period: input.period })),
  );
  return coveredShifts(days, input.shifts, input.employees, input.ignoreShiftId);
}

/** Shifts that approving these time-off requests would delete. */
export function getApprovalConflicts(
  requests: readonly Pick<TimeOff, "employee_id" | "off_date" | "period">[],
  shifts: readonly Shift[],
  employees: readonly Employee[],
): CoveredShift[] {
  const days = requests.map((r) => ({ employeeId: r.employee_id, date: r.off_date, period: r.period }));
  return coveredShifts(days, shifts, employees);
}

export function uniqueShiftIds(conflicts: readonly CoveredShift[]): string[] {
  return uniqueValues(conflicts.map((c) => c.shift.id));
}

/** Adds the payroll line to a deletion confirm built without it (for example a plan's confirmMessage). */
export function withPayrollKeptNote(message: string): string {
  const tail = `\n\n${CONTINUE_LINE}`;
  return message.endsWith(tail)
    ? `${message.slice(0, -tail.length)}\n\n${PAYROLL_KEPT_LINE}${tail}`
    : `${message}\n\n${PAYROLL_KEPT_LINE}`;
}

/**
 * The confirm before shifts are deleted, in the given order. Shows 8 date blocks, then
 * counts the shifts in the rest.
 */
export function buildShiftDeletionMessage(
  conflicts: readonly CoveredShift[],
  action: "add-day-off" | "approve",
  options?: { payrollKept?: boolean },
): string {
  const blocks = shiftDateBlocks(conflicts);
  const lines = blocks.slice(0, MAX_MESSAGE_LINES).map((block) => block.text);
  const hidden = blocks.slice(MAX_MESSAGE_LINES).reduce((sum, block) => sum + block.shiftCount, 0);
  if (hidden > 0) lines.push(`${plural(hidden, "more conflicting shift")} not shown.`);
  const intro =
    action === "approve"
      ? "Approving this time off will DELETE existing shifts that conflict:"
      : "Adding this day off will DELETE existing shifts that conflict:";
  const payroll = options?.payrollKept ? `\n\n${PAYROLL_KEPT_LINE}` : "";
  return `${intro}\n\n${lines.join("\n\n")}${payroll}\n\n${CONTINUE_LINE}`;
}

// ---------------------------------------------------------------------------
// Days off that overlap other time off

type TimeOffKey = Pick<TimeOff, "employee_id" | "off_date" | "period">;

function matchingTimeOff(
  input: {
    employeeIds: readonly string[];
    dates: readonly ISODate[];
    period: DayPeriod;
    timeOff: readonly TimeOff[];
    ignoreTimeOffId?: string | null;
  },
  status: TimeOff["status"],
  compareEmployees: (aId: string, bId: string) => number,
): TimeOff[] {
  const employeeIds = new Set(input.employeeIds);
  const dates = new Set(input.dates);
  return input.timeOff
    .filter(
      (t) =>
        t.status === status &&
        t.id !== input.ignoreTimeOffId &&
        employeeIds.has(t.employee_id) &&
        dates.has(t.off_date) &&
        periodsConflict(input.period, t.period),
    )
    .sort(
      (a, b) =>
        compareStrings(a.off_date, b.off_date) ||
        compareEmployees(a.employee_id, b.employee_id) ||
        periodSortValue(a.period) - periodSortValue(b.period) ||
        compareStrings(a.id, b.id),
    );
}

/** Approved time off (either source) that the new day off would overlap. */
export function getDuplicateDayOffConflicts(input: {
  employeeIds: readonly string[];
  dates: readonly ISODate[];
  period: DayPeriod;
  timeOff: readonly TimeOff[];
  employees: readonly Employee[];
  ignoreTimeOffId?: string | null;
}): TimeOff[] {
  return matchingTimeOff(input, "approved", employeeLookup(input.employees).compare);
}

/** Accepts full rows, or just the fields a `pending_request` error's details carry. */
export function buildDuplicateDayOffMessage(
  conflicts: readonly TimeOffKey[],
  requestedPeriod: DayPeriod,
  employees: readonly Employee[],
): string {
  const lookup = employeeLookup(employees);
  const lines = conflicts.slice(0, MAX_MESSAGE_LINES).map((t) => {
    const name = lookup.name(t.employee_id);
    return `${name} already has ${formatPeriod(t.period)} off on ${formatShortDate(t.off_date)}.`;
  });
  const hidden = conflicts.length - lines.length;
  if (hidden > 0) lines.push(`${plural(hidden, "more duplicate")} not shown.`);
  const intro = `This ${formatPeriod(requestedPeriod)} day off cannot be added because it overlaps existing day off:`;
  return `${intro}\n\n${lines.join("\n")}`;
}

/**
 * The same employees' pending requests that a new day off would overlap. The admin has to
 * approve or deny those first.
 */
export function getPendingRequestBlocks(input: {
  employeeIds: readonly string[];
  dates: readonly ISODate[];
  period: DayPeriod;
  timeOff: readonly TimeOff[];
  ignoreTimeOffId?: string | null;
}): TimeOff[] {
  const order = new Map(input.employeeIds.map((id, index) => [id, index]));
  const position = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  return matchingTimeOff(input, "pending", (a, b) => position(a) - position(b) || compareStrings(a, b));
}

/** Accepts full rows, or the `{employee_id, off_date, period}` details of a `pending_request` error. */
export function buildPendingBlockMessage(blocks: readonly TimeOffKey[], employees: readonly Employee[]): string {
  const lookup = employeeLookup(employees);
  const lines = blocks.slice(0, MAX_MESSAGE_LINES).map((t) => {
    const request = `${formatPeriod(t.period)} request on ${formatShortDate(t.off_date)}`;
    return `Approve or deny ${lookup.name(t.employee_id)}'s pending ${request} first.`;
  });
  const hidden = blocks.length - lines.length;
  if (hidden > 0) lines.push(`${hidden} more not shown.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Add dialog

/**
 * A day in the Add dialog's picker. Closed days can be picked only with Hours (any choice:
 * standard and custom hours reopen them, and closing them again changes nothing).
 */
export function addPickerDay(
  date: ISODate,
  closedDays: ReadonlySet<ISODate>,
  type: AddItemType,
): { disabled: boolean; title?: string; marker?: "closed" } {
  if (!closedDays.has(date)) return { disabled: false };
  return { disabled: type !== "hours", title: CLOSED_DAY_TITLE, marker: "closed" };
}

/** Switching the Add dialog away from Hours drops the closed dates. */
export function withoutClosedDates(selected: readonly ISODate[], closedDays: ReadonlySet<ISODate>): ISODate[] {
  return selected.filter((d) => !closedDays.has(d));
}

type NewShiftRow = { employee_id: string; shift_date: ISODate; start_time: PgTime; end_time: PgTime };
type NewDayOffRow = { employee_id: string; off_date: ISODate; period: DayPeriod };

export type AddPlan =
  | { kind: "error"; message: string }
  | { kind: "close-days"; dates: ISODate[] }
  | { kind: "standard-hours"; dates: ISODate[] }
  /** open and close as 'HH:MM'. */
  | { kind: "custom-hours"; dates: ISODate[]; open: string; close: string }
  | { kind: "add-shifts"; rows: NewShiftRow[] }
  | { kind: "add-days-off"; rows: NewDayOffRow[]; deleteShiftIds: string[]; confirmMessage: string | null };

/** Clock values for a shift write, or the message explaining what's wrong with them. */
function checkShiftTimes(startTime: string, endTime: string): { start: string; end: string } | { error: string } {
  const start = toClock(startTime);
  const end = toClock(endTime);
  if (start === null || end === null) return { error: MISSING_TIMES };
  if (sameTime(start, end)) return { error: SAME_TIMES };
  return { start, end };
}

/** Pending blocks, then overlapping days off, then the shifts it would delete. */
function planDayOff(input: {
  employeeIds: readonly string[];
  dates: readonly ISODate[];
  period: DayPeriod;
  shifts: readonly Shift[];
  timeOff: readonly TimeOff[];
  employees: readonly Employee[];
  ignoreShiftId?: string | null;
  ignoreTimeOffId?: string | null;
}): { error: string } | { deleteShiftIds: string[]; confirmMessage: string | null } {
  const pending = getPendingRequestBlocks(input);
  if (pending.length > 0) return { error: buildPendingBlockMessage(pending, input.employees) };
  const duplicates = getDuplicateDayOffConflicts(input);
  if (duplicates.length > 0) {
    return { error: buildDuplicateDayOffMessage(duplicates, input.period, input.employees) };
  }
  const covered = getDayOffConflicts(input);
  return {
    deleteShiftIds: uniqueShiftIds(covered),
    confirmMessage: covered.length > 0 ? buildShiftDeletionMessage(covered, "add-day-off") : null,
  };
}

/** Hours for the picked dates: close them, put them back on standard hours, or give them custom hours. */
function planHours(dates: ISODate[], choice: HoursChoice, openTime: string, closeTime: string): AddPlan {
  switch (choice) {
    case "closed":
      return { kind: "close-days", dates };
    case "standard":
      return { kind: "standard-hours", dates };
    case "custom": {
      const times = checkHoursTimes(openTime, closeTime);
      if (!times.ok) return { kind: "error", message: times.message };
      return { kind: "custom-hours", dates, open: times.open, close: times.close };
    }
  }
}

/**
 * Checks the Add dialog in the old page's order and says what to write: dates; Hours closes
 * the dates, puts them back on standard hours or checks the custom times (no employees
 * needed, and closed dates are allowed); employees; closed dates; for shifts the times,
 * start ≠ end and conflicts; for days off pending requests, overlapping days off, then a
 * confirm for deleted shifts. Rows go date by date, employees in the given order.
 */
export function planAddSave(input: {
  type: AddItemType;
  dates: readonly ISODate[];
  employeeIds: readonly string[];
  startTime: string;
  endTime: string;
  period: DayPeriod;
  hoursChoice: HoursChoice;
  openTime: string;
  closeTime: string;
  closedDays: ReadonlySet<ISODate>;
  shifts: readonly Shift[];
  timeOff: readonly TimeOff[];
  employees: readonly Employee[];
}): AddPlan {
  const dates = sortedDates(input.dates);
  if (dates.length === 0) return { kind: "error", message: NO_DATES };
  if (input.type === "hours") return planHours(dates, input.hoursChoice, input.openTime, input.closeTime);

  const employeeIds = uniqueValues(input.employeeIds.filter((id) => id !== ""));
  if (employeeIds.length === 0) return { kind: "error", message: NO_EMPLOYEES };
  if (dates.some((d) => input.closedDays.has(d))) return { kind: "error", message: ADD_ON_CLOSED_DAY };

  switch (input.type) {
    case "shift": {
      const times = checkShiftTimes(input.startTime, input.endTime);
      if ("error" in times) return { kind: "error", message: times.error };
      const conflicts = getShiftSubmissionConflicts({
        employeeIds,
        dates,
        startTime: times.start,
        endTime: times.end,
        shifts: input.shifts,
        timeOff: input.timeOff,
        employees: input.employees,
      });
      if (conflicts.length > 0) return { kind: "error", message: buildShiftConflictMessage(conflicts) };
      const { start, end } = times;
      return {
        kind: "add-shifts",
        rows: dates.flatMap((date) =>
          employeeIds.map((employee_id) => ({ employee_id, shift_date: date, start_time: start, end_time: end })),
        ),
      };
    }
    case "day-off": {
      const period = normalizePeriod(input.period);
      const plan = planDayOff({
        employeeIds,
        dates,
        period,
        shifts: input.shifts,
        timeOff: input.timeOff,
        employees: input.employees,
      });
      if ("error" in plan) return { kind: "error", message: plan.error };
      return {
        kind: "add-days-off",
        rows: dates.flatMap((date) => employeeIds.map((employee_id) => ({ employee_id, off_date: date, period }))),
        ...plan,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Edit dialog

export interface EditForm {
  type: "shift" | "day-off";
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
  period: DayPeriod;
}

/** The dialog's starting values. A day off gets 9-5 in case it's changed into a shift. */
export function editFormFor(target: EditTarget): EditForm {
  if (target.kind === "shift") {
    const { row } = target;
    return {
      type: "shift",
      employeeId: row.employee_id,
      date: row.shift_date,
      startTime: toClock(row.start_time) ?? "09:00",
      endTime: toClock(row.end_time) ?? "17:00",
      period: "full-day",
    };
  }
  const { row } = target;
  return {
    type: "day-off",
    employeeId: row.employee_id,
    date: row.off_date,
    startTime: "09:00",
    endTime: "17:00",
    period: normalizePeriod(row.period),
  };
}

export type EditWrite =
  | { op: "update-shift"; id: string; employeeId: string; date: ISODate; startTime: PgTime; endTime: PgTime }
  | { op: "update-day-off"; id: string; employeeId: string; date: ISODate; period: DayPeriod; deleteShiftIds: string[] }
  | {
      op: "convert-to-day-off";
      shiftId: string;
      employeeId: string;
      date: ISODate;
      period: DayPeriod;
      deleteShiftIds: string[];
    }
  | {
      op: "convert-to-shift";
      timeOffId: string;
      employeeId: string;
      date: ISODate;
      startTime: PgTime;
      endTime: PgTime;
    };

export type EditPlan =
  | { kind: "error"; message: string }
  | { kind: "noop" }
  | { kind: "write"; write: EditWrite; confirmMessage: string | null };

function isUnchanged(target: EditTarget, form: EditForm): boolean {
  if (target.kind === "shift") {
    const { row } = target;
    return (
      form.type === "shift" &&
      form.employeeId === row.employee_id &&
      form.date === row.shift_date &&
      sameTime(form.startTime, row.start_time) &&
      sameTime(form.endTime, row.end_time)
    );
  }
  const { row } = target;
  return (
    form.type === "day-off" &&
    form.employeeId === row.employee_id &&
    form.date === row.off_date &&
    normalizePeriod(form.period) === normalizePeriod(row.period)
  );
}

/**
 * Checks the Edit dialog and says what to write. Order: employee and date; an employee's
 * own request can't change hands or become a shift; times for a shift; no change → noop;
 * closed date; then shift conflicts, or pending requests, overlapping days off and a confirm
 * for the shifts a day off would delete.
 */
export function planEditSave(
  target: EditTarget,
  form: EditForm,
  ctx: {
    closedDays: ReadonlySet<ISODate>;
    shifts: readonly Shift[];
    timeOff: readonly TimeOff[];
    employees: readonly Employee[];
  },
): EditPlan {
  const employeeId = form.employeeId;
  const date = form.date;
  if (employeeId === "" || !isISODate(date)) return { kind: "error", message: MISSING_EMPLOYEE_OR_DATE };

  if (target.kind === "day-off" && target.row.source === "request") {
    const requestedBy = `This time off was requested by ${employeeLookup(ctx.employees).name(target.row.employee_id)}`;
    if (form.type === "shift") {
      return { kind: "error", message: `${requestedBy}, so it can't be changed into a shift.` };
    }
    if (employeeId !== target.row.employee_id) {
      return { kind: "error", message: `${requestedBy}, so it can't be moved to another employee.` };
    }
  }

  let times: { start: string; end: string } | null = null;
  if (form.type === "shift") {
    const checked = checkShiftTimes(form.startTime, form.endTime);
    if ("error" in checked) return { kind: "error", message: checked.error };
    times = checked;
  }

  if (isUnchanged(target, form)) return { kind: "noop" };
  if (ctx.closedDays.has(date)) return { kind: "error", message: MOVE_TO_CLOSED_DAY };

  if (times) {
    const conflicts = getShiftSubmissionConflicts({
      employeeIds: [employeeId],
      dates: [date],
      startTime: times.start,
      endTime: times.end,
      ignoreShiftId: target.kind === "shift" ? target.row.id : null,
      ignoreTimeOffId: target.kind === "day-off" ? target.row.id : null,
      shifts: ctx.shifts,
      timeOff: ctx.timeOff,
      employees: ctx.employees,
    });
    if (conflicts.length > 0) return { kind: "error", message: buildShiftConflictMessage(conflicts) };
    const { start: startTime, end: endTime } = times;
    const write: EditWrite =
      target.kind === "shift"
        ? { op: "update-shift", id: target.row.id, employeeId, date, startTime, endTime }
        : { op: "convert-to-shift", timeOffId: target.row.id, employeeId, date, startTime, endTime };
    return { kind: "write", write, confirmMessage: null };
  }

  const period = normalizePeriod(form.period);
  const plan = planDayOff({
    employeeIds: [employeeId],
    dates: [date],
    period,
    shifts: ctx.shifts,
    timeOff: ctx.timeOff,
    employees: ctx.employees,
    ignoreShiftId: target.kind === "shift" ? target.row.id : null,
    ignoreTimeOffId: target.kind === "day-off" ? target.row.id : null,
  });
  if ("error" in plan) return { kind: "error", message: plan.error };
  const { deleteShiftIds } = plan;
  const write: EditWrite =
    target.kind === "shift"
      ? { op: "convert-to-day-off", shiftId: target.row.id, employeeId, date, period, deleteShiftIds }
      : { op: "update-day-off", id: target.row.id, employeeId, date, period, deleteShiftIds };
  return { kind: "write", write, confirmMessage: plan.confirmMessage };
}

// ---------------------------------------------------------------------------
// Drag and drop

export type DropCard = { kind: "shift"; row: Shift } | { kind: "time-off"; row: TimeOff };
export type DropResult =
  | { kind: "noop" }
  | { kind: "blocked"; message: string }
  | { kind: "move"; deleteShiftIds: string[]; confirmMessage: string | null };

/**
 * Moving a card to another date keeps its employee, times and period. Same date: nothing.
 * Closed date: blocked. A shift is blocked by conflicts; a day off by pending requests or
 * overlapping days off, and confirms the shifts it would delete. Pending rows don't move.
 */
export function checkCardDrop(input: {
  card: DropCard;
  targetDate: ISODate;
  closedDays: ReadonlySet<ISODate>;
  shifts: readonly Shift[];
  timeOff: readonly TimeOff[];
  employees: readonly Employee[];
}): DropResult {
  const { card, targetDate } = input;
  const currentDate = card.kind === "shift" ? card.row.shift_date : card.row.off_date;
  if (!isISODate(targetDate) || targetDate === currentDate) return { kind: "noop" };
  if (card.kind === "time-off" && card.row.status !== "approved") return { kind: "noop" };
  if (input.closedDays.has(targetDate)) return { kind: "blocked", message: MOVE_TO_CLOSED_DAY };

  if (card.kind === "shift") {
    const conflicts = getShiftSubmissionConflicts({
      employeeIds: [card.row.employee_id],
      dates: [targetDate],
      startTime: card.row.start_time,
      endTime: card.row.end_time,
      ignoreShiftId: card.row.id,
      shifts: input.shifts,
      timeOff: input.timeOff,
      employees: input.employees,
    });
    if (conflicts.length > 0) return { kind: "blocked", message: buildShiftConflictMessage(conflicts) };
    return { kind: "move", deleteShiftIds: [], confirmMessage: null };
  }

  const plan = planDayOff({
    employeeIds: [card.row.employee_id],
    dates: [targetDate],
    period: normalizePeriod(card.row.period),
    shifts: input.shifts,
    timeOff: input.timeOff,
    employees: input.employees,
    ignoreTimeOffId: card.row.id,
  });
  if ("error" in plan) return { kind: "blocked", message: plan.error };
  return { kind: "move", ...plan };
}

// ---------------------------------------------------------------------------
// Confirms and toasts

/** The "Payroll hours recorded" confirm; a move names the new date ('Mon, Oct 5'). */
export function payrollHoursMessage(kind: "move" | "edit" | "delete" | "convert", newDate?: ISODate): string {
  const intro = "This shift has payroll hours recorded.";
  switch (kind) {
    case "move":
      return newDate && isISODate(newDate)
        ? `${intro} They'll be kept and moved to ${formatChipDate(newDate)}.`
        : `${intro} They'll be kept and moved with the shift.`;
    case "edit":
      return `${intro} They'll be kept as recorded; check them in Payroll if this change affects pay.`;
    case "delete":
    case "convert":
      return `${intro} They'll be kept in Payroll as hours without a scheduled shift.`;
  }
}

/** Dates are listed when there are 5 or fewer. */
const MAX_LISTED_CLOSE_DATES = 5;

/** The confirm before closing days deletes anything; null when nothing would be deleted. */
export function closeDaysConfirm(
  dates: readonly ISODate[],
  counts: { shifts: number; timeOff: number },
): { title: string; message: string } | null {
  if (counts.shifts <= 0 && counts.timeOff <= 0) return null;
  const sorted = sortedDates(dates);
  const which = sorted.length <= MAX_LISTED_CLOSE_DATES ? formatDateList(sorted) : plural(sorted.length, "day");
  return {
    title: "Close for business?",
    message:
      `Closing ${which} will delete ${plural(counts.shifts, "shift")} and ` +
      `${plural(counts.timeOff, "time-off entry", "time-off entries")}. Payroll records and availability are kept.`,
  };
}

/** '1 conflicting shift removed' / '2 conflicting shifts removed' */
export function removedShiftsText(n: number): string {
  return `${plural(n, "conflicting shift")} removed`;
}

/** '1 day marked closed' / '3 days marked closed' */
export function closedDaysText(n: number): string {
  return `${plural(n, "day")} marked closed`;
}
