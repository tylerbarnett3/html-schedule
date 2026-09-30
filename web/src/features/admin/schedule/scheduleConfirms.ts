// The confirms a calendar write may need before it runs (§7.3, decision C10). Payroll
// hours are read fresh each time, never from a cache.

import type { Confirm } from "../../../components/useConfirm";
import { fetchShiftIdsWithActuals } from "../../../data/adminSchedule";
import { payrollHoursMessage, withPayrollKeptNote } from "../../../lib/scheduleEditing";
import type { ISODate } from "../../../lib/types";

/**
 * "Delete conflicting shifts?" before a day off takes shifts out. When any of them has
 * payroll hours, the message says those hours are kept.
 */
export async function confirmShiftDeletion(
  confirm: Confirm,
  message: string,
  deleteShiftIds: readonly string[],
): Promise<boolean> {
  const withHours = deleteShiftIds.length > 0 ? await fetchShiftIdsWithActuals(deleteShiftIds) : new Set<string>();
  return confirm({
    title: "Delete conflicting shifts?",
    message: withHours.size > 0 ? withPayrollKeptNote(message) : message,
    confirmLabel: "Delete shifts",
    cancelLabel: "Cancel",
    tone: "danger",
  });
}

/**
 * "Payroll hours recorded" before a shift with a shift_actuals row is moved, edited,
 * changed into a day off or deleted. True (no question) when it has none.
 */
export async function confirmPayrollHours(
  confirm: Confirm,
  shiftId: string,
  kind: "move" | "edit" | "delete" | "convert",
  newDate?: ISODate,
): Promise<boolean> {
  const withHours = await fetchShiftIdsWithActuals([shiftId]);
  if (!withHours.has(shiftId)) return true;
  return confirm({
    title: "Payroll hours recorded",
    message: payrollHoursMessage(kind, newDate),
    confirmLabel: "Continue",
    cancelLabel: "Cancel",
    tone: "default",
  });
}

// Long enough for a closing dialog to commit and hand focus back (or fail to, because the
// card it came from has gone).
const FOCUS_CHECK_DELAY_MS = 80;

/**
 * After a card or button leaves the calendar, put keyboard focus on its day (the element
 * matching `selector` inside it) instead of leaving it on the page body.
 */
export function keepFocusOnDay(date: ISODate, selector = ".calendar-day-header"): void {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
    const day = document.querySelector(`[data-date="${date}"]`);
    (day?.querySelector<HTMLElement>(selector) ?? day?.querySelector<HTMLElement>(".calendar-day-header"))?.focus();
  }, FOCUS_CHECK_DELAY_MS);
}
