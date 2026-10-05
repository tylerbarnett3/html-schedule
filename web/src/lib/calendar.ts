// Turns the loaded rows into what each calendar day shows, in display order.

import { rangeDates } from "./dates";
import { NO_HOURS, specialHoursOn, type Hours, type HoursData } from "./hours";
import { formatPeriod, periodSortValue } from "./periods";
import { applyReviews, type ShiftReview } from "./reviewedShifts";
import { compareTimes, formatShiftTime } from "./time";
import type { Availability, DateRange, Employee, ISODate, Shift, TimeOff } from "./types";

export const PENDING_COLOR = "#FDB913";
export const BUSY_PENDING_COLOR = "#9333EA";
type PendingColor = typeof PENDING_COLOR | typeof BUSY_PENDING_COLOR;

export type DayCard =
  | {
      kind: "pending-time-off";
      row: TimeOff;
      employee: Employee;
      label: string;
      color: "#FDB913" | "#9333EA";
      canCancel: boolean;
    }
  | { kind: "shift"; row: Shift; employee: Employee; label: string }
  /** A shift reviewed in Payroll, as recorded (row.id is the payroll record's). Locked here. */
  | { kind: "reviewed"; row: Shift; employee: Employee; label: string }
  | { kind: "time-off"; row: TimeOff; employee: Employee; label: string }
  | {
      kind: "availability";
      row: Availability;
      employee: Employee;
      label: string;
      pending: boolean;
      canCancel: boolean;
    };

export interface CalendarDay {
  date: ISODate;
  closed: boolean;
  isToday: boolean;
  cards: DayCard[];
  /** Hours to show after the date: set only on open days whose hours differ from the standard (specialHoursOn). */
  specialHours: Hours | null;
}

export interface CalendarInput {
  range: DateRange;
  today: ISODate;
  employees: readonly Employee[];
  shifts: readonly Shift[];
  /** Payroll's records: reviewed shifts show as recorded (see applyReviews). */
  reviews: readonly ShiftReview[];
  timeOff: readonly TimeOff[];
  availability: readonly Availability[];
  closedDays: ReadonlySet<ISODate>;
  selectedEmployeeIds: ReadonlySet<string>;
  showTimeOff: boolean;
  showAvailability: boolean;
  meId: string | null;
  /** Business hours; missing means no day shows special hours. */
  hours?: HoursData;
}

/** 'DAY OFF', 'MORNING OFF', or 'PENDING TIME OFF - EVENING'. */
export function timeOffCardLabel(row: Pick<TimeOff, "period" | "status">): string {
  const period = formatPeriod(row.period).toUpperCase();
  if (row.status === "pending") return `PENDING TIME OFF - ${period}`;
  return row.period === "full-day" ? "DAY OFF" : `${period} OFF`;
}

/** 'AVAILABLE - FULL DAY' or 'PENDING AVAILABILITY - MORNING'. */
export function availabilityCardLabel(row: Pick<Availability, "period" | "status">): string {
  const period = formatPeriod(row.period).toUpperCase();
  return row.status === "pending" ? `PENDING AVAILABILITY - ${period}` : `AVAILABLE - ${period}`;
}

/**
 * A busy day's 4th and later pending requests (rank is 0-based, by request time over
 * every employee's pending requests that day) turn purple so the manager notices.
 */
export function pendingCardColor(rank: number, totalForDay: number): PendingColor {
  return totalForDay >= 4 && rank >= 3 ? BUSY_PENDING_COLOR : PENDING_COLOR;
}

/** Day cells plus blank cells to fill out the last week row. */
export function calendarCellCount(dayCount: number): number {
  return dayCount > 0 ? Math.ceil(dayCount / 7) * 7 : 0;
}

export function toClosedDaySet(
  rows: ReadonlyArray<{ closed_date: string | null }>,
): ReadonlySet<ISODate> {
  const closed = new Set<ISODate>();
  for (const row of rows) {
    if (row.closed_date) closed.add(row.closed_date.slice(0, 10));
  }
  return closed;
}

export function groupByDate<T>(rows: readonly T[], dateOf: (row: T) => ISODate): Map<ISODate, T[]> {
  const groups = new Map<ISODate, T[]>();
  for (const row of rows) {
    const date = dateOf(row);
    const group = groups.get(date);
    if (group) group.push(row);
    else groups.set(date, [row]);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Ordering

const nameCollator = new Intl.Collator("en");

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Fractions beyond milliseconds are trimmed first: some browsers won't parse microseconds.
function timestampMs(ts: string): number {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, "$1"));
}

/** Postgres timestamps like '2026-09-28T15:34:17.123456+00:00', earliest first. */
function compareTimestamps(a: string, b: string): number {
  const aMs = timestampMs(a);
  const bMs = timestampMs(b);
  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs;
  // Same millisecond (or unparseable): the strings still order microseconds correctly.
  return compareStrings(a, b);
}

/** Employee list order: display_order, then name, then id. */
function compareEmployees(a: Employee, b: Employee): number {
  return (
    a.display_order - b.display_order ||
    nameCollator.compare(a.name, b.name) ||
    compareStrings(a.id, b.id)
  );
}

type Placed<T> = { row: T; employee: Employee };

function compareTimeOff(a: Placed<TimeOff>, b: Placed<TimeOff>): number {
  return (
    compareTimestamps(a.row.requested_at, b.row.requested_at) ||
    compareEmployees(a.employee, b.employee) ||
    periodSortValue(a.row.period) - periodSortValue(b.row.period) ||
    compareStrings(a.row.id, b.row.id)
  );
}

function compareShifts(a: Placed<Shift>, b: Placed<Shift>): number {
  return (
    compareTimes(a.row.start_time, b.row.start_time) ||
    compareTimes(a.row.end_time, b.row.end_time) ||
    compareEmployees(a.employee, b.employee) ||
    compareStrings(a.row.id, b.row.id)
  );
}

function compareAvailability(a: Placed<Availability>, b: Placed<Availability>): number {
  return (
    nameCollator.compare(a.employee.name, b.employee.name) ||
    periodSortValue(a.row.period) - periodSortValue(b.row.period) ||
    compareEmployees(a.employee, b.employee) ||
    compareStrings(a.row.id, b.row.id)
  );
}

// ---------------------------------------------------------------------------

/**
 * One entry per date in the range. Within a day: pending time off (oldest request
 * first), shifts (by start time; reviewed ones as payroll recorded them, and none for a
 * shift that wasn't worked), approved time off, then availability (by name).
 * Closed days show no cards. Rows for employees missing from `employees` are skipped.
 * Open days whose custom hours differ from the standard carry them in specialHours.
 */
export function buildCalendarDays(input: CalendarInput): CalendarDay[] {
  const { closedDays, selectedEmployeeIds, showTimeOff, showAvailability, meId, today } = input;
  const hours = input.hours ?? NO_HOURS;
  const employeesById = new Map(input.employees.map((e) => [e.id, e]));

  function place<T extends { employee_id: string }>(rows: readonly T[] | undefined): Placed<T>[] {
    const placed: Placed<T>[] = [];
    for (const row of rows ?? []) {
      const employee = employeesById.get(row.employee_id);
      if (employee) placed.push({ row, employee });
    }
    return placed;
  }
  const isVisible = (item: Placed<unknown>) => selectedEmployeeIds.has(item.employee.id);
  const isMine = (employeeId: string) => meId !== null && employeeId === meId;

  const { scheduled, reviewed } = applyReviews(input.shifts, input.reviews);
  const shiftsByDate = groupByDate(scheduled, (s) => s.shift_date);
  const reviewedByDate = groupByDate(reviewed, (s) => s.shift_date);
  const timeOffByDate = groupByDate(input.timeOff, (t) => t.off_date);
  const availabilityByDate = groupByDate(input.availability, (a) => a.available_date);

  return rangeDates(input.range).map((date): CalendarDay => {
    const closed = closedDays.has(date);
    const day: CalendarDay = {
      date,
      closed,
      isToday: date === today,
      cards: [],
      specialHours: specialHoursOn(date, hours, closedDays),
    };
    if (closed) return day;

    const timeOff = showTimeOff ? place(timeOffByDate.get(date)) : [];

    // Rank against everyone's pending requests, so a card's color doesn't change with the filter.
    const allPending = timeOff.filter((t) => t.row.status === "pending").sort(compareTimeOff);
    allPending.forEach((item, rank) => {
      if (!isVisible(item)) return;
      day.cards.push({
        kind: "pending-time-off",
        ...item,
        label: timeOffCardLabel(item.row),
        color: pendingCardColor(rank, allPending.length),
        canCancel: isMine(item.row.employee_id),
      });
    });

    const shifts = [
      ...place(shiftsByDate.get(date)).map((item) => ({ kind: "shift" as const, ...item })),
      ...place(reviewedByDate.get(date)).map((item) => ({ kind: "reviewed" as const, ...item })),
    ];
    for (const item of shifts.filter(isVisible).sort(compareShifts)) {
      day.cards.push({ ...item, label: formatShiftTime(item.row) });
    }

    const approved = timeOff.filter((t) => t.row.status !== "pending" && isVisible(t)).sort(compareTimeOff);
    for (const item of approved) {
      day.cards.push({ kind: "time-off", ...item, label: timeOffCardLabel(item.row) });
    }

    if (showAvailability) {
      const availability = place(availabilityByDate.get(date)).filter(isVisible).sort(compareAvailability);
      for (const item of availability) {
        const pending = item.row.status === "pending";
        day.cards.push({
          kind: "availability",
          ...item,
          label: availabilityCardLabel(item.row),
          pending,
          canCancel: pending && isMine(item.row.employee_id),
        });
      }
    }

    return day;
  });
}
