// The admin's review of employee requests: the Requests drawer's lists and groups, and the
// texts for approving, denying and removing. Pure; data/adminRequests.ts reads the rows.

import { addDays, compareISODate, formatChipDate, formatShortDate, timestampToBusinessDate } from "./dates";
import { formatPeriod, normalizePeriod, periodSortValue } from "./periods";
import { removedShiftsText, type ReviewTarget } from "./scheduleEditing";
import type { Availability, DayPeriod, Employee, ISODate, RequestStatus, TimeOff } from "./types";

export type RequestKind = "time-off" | "availability";
export type AdminTimeOff = TimeOff & { reviewed_at: string | null };
export type AdminAvailability = Availability & { reviewed_at: string | null };

/** One requested day, time off or availability, pending or approved. */
export interface RequestItem {
  kind: RequestKind;
  id: string;
  employeeId: string;
  /** "Unknown" when the employee isn't in the list. */
  employeeName: string;
  archived: boolean;
  date: ISODate;
  period: DayPeriod;
  status: RequestStatus;
  requestedAt: string;
  reviewedAt: string | null;
  /** The business is closed that day: the request can only be denied (R6). */
  closed: boolean;
  /** The date is before today; it can still be approved (R2). */
  past: boolean;
}

/** Days one employee asked for in a single submission, reviewed together (R4). */
export interface RequestGroup {
  key: string;
  kind: RequestKind;
  employeeId: string;
  employeeName: string;
  archived: boolean;
  requestedAt: string;
  items: RequestItem[];
}

export type RequestEntry = { type: "single"; item: RequestItem } | { type: "group"; group: RequestGroup };

/** Approved requests stay listed for this many days after their date (R1). */
export const APPROVED_WINDOW_DAYS = 30;

export const ALREADY_REVIEWED_MESSAGE = "This request was already reviewed or removed.";

const UNKNOWN_EMPLOYEE = "Unknown";

const KIND_ORDER: Readonly<Record<RequestKind, number>> = { "time-off": 0, availability: 1 };

export const REQUEST_KIND_LABELS: Readonly<Record<RequestKind, string>> = {
  "time-off": "Time Off",
  availability: "Availability",
};

type RequestRow = {
  id: string;
  employee_id: string;
  period: DayPeriod;
  status: RequestStatus;
  requested_at: string;
  reviewed_at: string | null;
};

/**
 * Employees' requests as drawer items, sorted with compareRequestItems. Days off the admin
 * assigned (source "assigned") aren't requests and are left out.
 */
export function toRequestItems(i: {
  timeOff: readonly AdminTimeOff[];
  availability: readonly AdminAvailability[];
  employees: readonly Employee[];
  closedDays: ReadonlySet<ISODate>;
  today: ISODate;
}): RequestItem[] {
  const employees = new Map(i.employees.map((e) => [e.id, e]));
  const toItem = (kind: RequestKind, row: RequestRow, date: ISODate): RequestItem => {
    const employee = employees.get(row.employee_id);
    return {
      kind,
      id: row.id,
      employeeId: row.employee_id,
      employeeName: employee?.name ?? UNKNOWN_EMPLOYEE,
      archived: employee?.archived ?? false,
      date,
      period: normalizePeriod(row.period),
      status: row.status,
      requestedAt: row.requested_at,
      reviewedAt: row.reviewed_at,
      closed: i.closedDays.has(date),
      past: compareISODate(date, i.today) < 0,
    };
  };
  return [
    ...i.timeOff.filter((row) => row.source === "request").map((row) => toItem("time-off", row, row.off_date)),
    ...i.availability.map((row) => toItem("availability", row, row.available_date)),
  ].sort(compareRequestItems);
}

/** A calendar card's request as a drawer item (null for a day off the admin assigned). */
export function reviewTargetItem(
  target: ReviewTarget,
  i: { employees: readonly Employee[]; closedDays: ReadonlySet<ISODate>; today: ISODate },
): RequestItem | null {
  const items =
    target.kind === "time-off"
      ? toRequestItems({ ...i, timeOff: [{ ...target.row, reviewed_at: null }], availability: [] })
      : toRequestItems({ ...i, timeOff: [], availability: [{ ...target.row, reviewed_at: null }] });
  return items[0] ?? null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The old drawer's order (date, employee name, time off before availability), then period,
 * request time and id so equal rows always come out the same way.
 */
export function compareRequestItems(a: RequestItem, b: RequestItem): number {
  return (
    compareISODate(a.date, b.date) ||
    a.employeeName.localeCompare(b.employeeName, "en-US") ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    periodSortValue(a.period) - periodSortValue(b.period) ||
    compareStrings(a.requestedAt, b.requestedAt) ||
    compareStrings(a.id, b.id)
  );
}

/** The Pending and Approved tabs, each keeping the input order. */
export function splitRequests(items: readonly RequestItem[]): { pending: RequestItem[]; approved: RequestItem[] } {
  return {
    pending: items.filter((item) => item.status === "pending"),
    approved: items.filter((item) => item.status === "approved"),
  };
}

/** Pending requests of both kinds, straight from the rows (the badges' count). */
export function pendingRequestCount(rows: {
  timeOff: readonly Pick<TimeOff, "status">[];
  availability: readonly Pick<Availability, "status">[];
}): number {
  const pending = (row: { status: RequestStatus }) => row.status === "pending";
  return rows.timeOff.filter(pending).length + rows.availability.filter(pending).length;
}

function groupKey(item: RequestItem): string {
  return `${item.kind}|${item.employeeId}|${item.requestedAt}`;
}

/**
 * Pending items with the same kind, employee and exact requested_at were sent together, so
 * two or more of them on open days become one group (R4). Days on closed dates stay single,
 * since they can only be denied. A group sits where its first day would.
 */
export function groupPending(pending: readonly RequestItem[]): RequestEntry[] {
  const groupable = (item: RequestItem) => item.status === "pending" && !item.closed;
  const members = new Map<string, RequestItem[]>();
  for (const item of pending) {
    if (!groupable(item)) continue;
    const key = groupKey(item);
    const list = members.get(key);
    if (list) list.push(item);
    else members.set(key, [item]);
  }

  const entries: RequestEntry[] = [];
  const placed = new Set<string>();
  for (const item of pending) {
    const key = groupKey(item);
    const items = groupable(item) ? members.get(key) : undefined;
    if (!items || items.length < 2) {
      entries.push({ type: "single", item });
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    entries.push({
      type: "group",
      group: {
        key,
        kind: item.kind,
        employeeId: item.employeeId,
        employeeName: item.employeeName,
        archived: item.archived,
        requestedAt: item.requestedAt,
        items,
      },
    });
  }
  return entries;
}

/** The first date the Approved tab lists: today − 30 (R1). */
export function approvedWindowStart(today: ISODate): ISODate {
  return addDays(today, -APPROVED_WINDOW_DAYS);
}

/** "Mon, Oct 5 - Evening" */
export function requestItemDetail(i: Pick<RequestItem, "date" | "period">): string {
  return `${formatChipDate(i.date)} - ${formatPeriod(i.period)}`;
}

/** "Requested: Sep 29, 2026" (the business day in New York), or "Requested: Unknown". */
export function requestedOnText(ts: string | null): string {
  const date = timestampToBusinessDate(ts);
  return `Requested: ${date ? formatShortDate(date) : "Unknown"}`;
}

/** "Approved Sep 30, 2026", or null when the approval date isn't known. */
export function approvedOnText(ts: string | null): string | null {
  const date = timestampToBusinessDate(ts);
  return date ? `Approved ${formatShortDate(date)}` : null;
}

export interface ToastText {
  title: string;
  message: string;
}

export interface ConfirmText {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** Contract §7.1 "Approve time off" / "Approve availability". */
export function approveToast(kind: RequestKind, name: string, days: number, removedShifts: number): ToastText {
  if (kind === "availability") {
    return {
      title: "Availability Approved",
      message: days === 1 ? `Availability approved for ${name}` : `${days} days of availability approved for ${name}`,
    };
  }
  const approved = days === 1 ? `Day off approved for ${name}` : `${days} days approved for ${name}`;
  const removed = removedShifts > 0 ? `; ${removedShiftsText(removedShifts)}` : "";
  return { title: "Time Off Approved", message: `${approved}${removed}` };
}

/**
 * "Approve all" on a group approves every day or none. When some days were already reviewed or
 * cancelled, nothing is approved, and this says so (info tone). `stillPending` is how many of
 * the `total` days are still waiting, read fresh; null when that read failed.
 */
export function groupNotApprovedMessage(total: number, stillPending: number | null): string {
  // Nothing left to review: the plain message (§7.1 "Already reviewed").
  if (stillPending === 0) return ALREADY_REVIEWED_MESSAGE;
  if (stillPending === null || stillPending >= total) {
    return "Nothing was approved because some of these days were already reviewed or removed. The list has been refreshed.";
  }
  const gone = total - stillPending;
  const left = stillPending === 1 ? "The other day is" : `The other ${stillPending} days are`;
  return `Nothing was approved because ${gone} of the ${total} days ${gone === 1 ? "was" : "were"} already reviewed or removed. ${left} still pending.`;
}

/** Contract §7.1 "Deny time off" / "Deny availability" (info tone). */
export function denyToast(kind: RequestKind, name: string, count: number): ToastText {
  return {
    title: kind === "time-off" ? "Time Off Denied" : "Availability Denied",
    message:
      count === 1 ? `Request denied and removed for ${name}` : `${count} requests denied and removed for ${name}`,
  };
}

/** Contract §7.3 "Deny (one / group)". */
export function denyConfirm(kind: RequestKind, name: string, count: number): ConfirmText {
  const noun = kind === "time-off" ? "time-off" : "availability";
  if (count === 1) {
    return {
      title: "Deny request?",
      message: `Deny ${name}'s ${noun} request for this day? This will delete the request.`,
      confirmLabel: "Deny",
      cancelLabel: "Keep request",
    };
  }
  return {
    title: "Deny requests?",
    message: `Deny ${name}'s ${count} ${noun} requests? This will delete the requests.`,
    confirmLabel: "Deny all",
    cancelLabel: "Keep requests",
  };
}

type RemovedRequest = Pick<RequestItem, "kind" | "employeeName" | "date" | "period">;

/** Contract §7.3 "Remove approved request" / "Remove approved availability". */
export function removeApprovedConfirm(item: RemovedRequest): ConfirmText {
  if (item.kind === "time-off") {
    return {
      title: "Remove approved time off?",
      message: `${item.employeeName} asked for this time off. Removing it deletes the approval, and they aren't notified.`,
      confirmLabel: "Remove",
      cancelLabel: "Keep",
    };
  }
  return {
    title: "Remove approved availability?",
    message: `${item.employeeName}'s ${normalizePeriod(item.period)} availability on ${formatShortDate(item.date)} will be deleted.`,
    confirmLabel: "Remove",
    cancelLabel: "Keep",
  };
}

/** Contract §7.1 "Remove approved": "Nora Patel's morning time off on Oct 11, 2026 was removed." */
export function removeApprovedToast(item: RemovedRequest): ToastText {
  const what = item.kind === "time-off" ? "time off" : "availability";
  return {
    title: item.kind === "time-off" ? "Time Off Removed" : "Availability Removed",
    message: `${item.employeeName}'s ${normalizePeriod(item.period)} ${what} on ${formatShortDate(item.date)} was removed.`,
  };
}
