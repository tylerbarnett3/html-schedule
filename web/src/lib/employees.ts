// Employee list helpers for the admin Employees drawer: range stats, ordering and names.

import { compareISODate } from "./dates";
import { shiftDurationMinutes } from "./time";
import type { DateRange, Employee, Shift } from "./types";

export interface EmployeeRangeStats {
  shiftCount: number;
  minutes: number;
}

/** For employees with no shifts in the range. */
export const NO_SHIFTS: EmployeeRangeStats = { shiftCount: 0, minutes: 0 };

/**
 * Shift count and minutes per scheduled employee, for shifts dated inside the range (E12).
 * Overnight shifts count their full length on their own date. Time off, availability and
 * payroll hours never count.
 */
export function employeeRangeStats(
  shifts: readonly Pick<Shift, "employee_id" | "shift_date" | "start_time" | "end_time">[],
  range: DateRange,
): Map<string, EmployeeRangeStats> {
  const stats = new Map<string, EmployeeRangeStats>();
  for (const shift of shifts) {
    if (compareISODate(shift.shift_date, range.start) < 0 || compareISODate(shift.shift_date, range.end) > 0) continue;
    const current = stats.get(shift.employee_id) ?? NO_SHIFTS;
    stats.set(shift.employee_id, {
      shiftCount: current.shiftCount + 1,
      minutes: current.minutes + (shiftDurationMinutes(shift.start_time, shift.end_time) ?? 0),
    });
  }
  return stats;
}

/** '1 shift, 6.0 hrs' */
export function formatEmployeeStats(s: EmployeeRangeStats): string {
  return `${s.shiftCount} shift${s.shiftCount !== 1 ? "s" : ""}, ${(s.minutes / 60).toFixed(1)} hrs`;
}

export function activeEmployees<T extends { archived: boolean }>(list: readonly T[]): T[] {
  return list.filter((e) => !e.archived);
}

/**
 * Takes the item at `from` out and puts it back at `to` (the old drop rule): dropping on
 * a lower row lands after it, on a higher row before it. Returns a copy.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** The display_order that puts a new employee last. */
export function nextDisplayOrder(list: readonly { display_order: number }[]): number {
  return list.length === 0 ? 0 : Math.max(...list.map((e) => e.display_order)) + 1;
}

/** The rows whose display_order must change for this order (0-based positions). */
export function changedOrders(
  list: readonly Pick<Employee, "id" | "display_order">[],
  orderedIds: readonly string[],
): { id: string; display_order: number }[] {
  const positions = new Map(orderedIds.map((id, position) => [id, position]));
  return list.flatMap((e) => {
    const position = positions.get(e.id);
    return position !== undefined && position !== e.display_order ? [{ id: e.id, display_order: position }] : [];
  });
}

/**
 * Every employee id in the order set_employee_order expects after moving one active
 * employee (E11): the active employees in their new order, then the archived ones as
 * they were. `from` and `to` are positions among the active employees.
 */
export function reorderedIds(list: readonly Pick<Employee, "id" | "archived">[], from: number, to: number): string[] {
  const active = moveItem(activeEmployees(list), from, to);
  return [...active, ...list.filter((e) => e.archived)].map((e) => e.id);
}

/**
 * The list in the given order with display_order set to each position, for the optimistic
 * reorder. Anyone missing from `orderedIds` (added meanwhile) stays after, in list order.
 */
export function applyEmployeeOrder<T extends Pick<Employee, "id" | "display_order">>(
  list: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  const listed = new Set(orderedIds);
  const ordered = [
    ...orderedIds.flatMap((id) => {
      const employee = byId.get(id);
      return employee ? [employee] : [];
    }),
    ...list.filter((e) => !listed.has(e.id)),
  ];
  return ordered.map((e, position) => (e.display_order === position ? e : { ...e, display_order: position }));
}

/**
 * The name error to show, or null. Names are compared trimmed and ignoring case, like the
 * database's duplicate_name check (E4).
 */
export function validateEmployeeName(
  name: string,
  others: readonly Pick<Employee, "id" | "name">[],
  selfId: string | null,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Please enter an employee name";
  const wanted = trimmed.toLowerCase();
  const clash = others.find((e) => e.id !== selfId && e.name.trim().toLowerCase() === wanted);
  return clash ? `There's already an employee named ${clash.name.trim()}.` : null;
}
