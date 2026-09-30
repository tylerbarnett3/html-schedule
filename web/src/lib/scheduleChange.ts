// What a calendar edit changed, as the admin_* database functions report it. The page keeps
// these so Undo can hand one back to admin_undo, which reverses it. Rows are kept exactly as
// the server sent them: admin_undo compares updated_at to spot rows edited in between.

import type { Json } from "./database.types";
import { isISODate } from "./dates";
import type { Tables } from "./supabase";
import type { ISODate } from "./types";

export type ShiftRow = Tables<"shifts">;
export type TimeOffRow = Tables<"time_off">;

export interface RowChange<T> {
  before: T;
  after: T;
}

/** A payroll record that pointed at a deleted shift, so undo can point it back. */
export interface ActualLink {
  actual_id: string;
  shift_id: string;
}

export interface ScheduleChange {
  /** When the server made the change (its transaction time); null for changes the page builds. */
  made_at: string | null;
  inserted: { shifts: ShiftRow[]; time_off: TimeOffRow[]; closed_days: ISODate[] };
  updated: { shifts: RowChange<ShiftRow>[]; time_off: RowChange<TimeOffRow>[] };
  deleted: {
    shifts: ShiftRow[];
    time_off: TimeOffRow[];
    closed_days: ISODate[];
    actual_links: ActualLink[];
  };
}

export function emptyChange(): ScheduleChange {
  return {
    made_at: null,
    inserted: { shifts: [], time_off: [], closed_days: [] },
    updated: { shifts: [], time_off: [] },
    deleted: { shifts: [], time_off: [], closed_days: [], actual_links: [] },
  };
}

export function isEmptyChange(c: ScheduleChange): boolean {
  return (
    c.inserted.shifts.length === 0 &&
    c.inserted.time_off.length === 0 &&
    c.inserted.closed_days.length === 0 &&
    c.updated.shifts.length === 0 &&
    c.updated.time_off.length === 0 &&
    c.deleted.shifts.length === 0 &&
    c.deleted.time_off.length === 0 &&
    c.deleted.closed_days.length === 0 &&
    c.deleted.actual_links.length === 0
  );
}

const UNEXPECTED = "Unexpected response from the server.";

type JsonObject = { [key: string]: Json | undefined };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(row: JsonObject, keys: readonly string[]): boolean {
  return keys.every((key) => typeof row[key] === "string");
}

// Only the columns the page reads are checked; the rest travel back to admin_undo untouched.
const SHIFT_KEYS = ["id", "employee_id", "shift_date", "start_time", "end_time", "updated_at"] as const;
const TIME_OFF_KEYS = ["id", "employee_id", "off_date", "period", "status", "source", "updated_at"] as const;

function isShiftRow(value: unknown): value is ShiftRow {
  return isObject(value) && hasStrings(value, SHIFT_KEYS);
}

function isTimeOffRow(value: unknown): value is TimeOffRow {
  return isObject(value) && hasStrings(value, TIME_OFF_KEYS);
}

function isActualLink(value: unknown): value is ActualLink {
  return isObject(value) && hasStrings(value, ["actual_id", "shift_id"]);
}

function rowChangeGuard<T>(isRow: (value: unknown) => value is T) {
  return (value: unknown): value is RowChange<T> =>
    isObject(value) && isRow(value.before) && isRow(value.after);
}

function field(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (!isObject(value)) throw new Error(UNEXPECTED);
  return value;
}

function list<T>(parent: JsonObject, key: string, isItem: (value: unknown) => value is T): T[] {
  const value = parent[key];
  if (!Array.isArray(value)) throw new Error(UNEXPECTED);
  const items: T[] = [];
  for (const item of value) {
    if (!isItem(item)) throw new Error(UNEXPECTED);
    items.push(item);
  }
  return items;
}

/** Checks the shape of an admin_* result; throws "Unexpected response from the server." otherwise. */
export function parseScheduleChange(data: Json | null): ScheduleChange {
  if (!isObject(data)) throw new Error(UNEXPECTED);
  const inserted = field(data, "inserted");
  const updated = field(data, "updated");
  const deleted = field(data, "deleted");
  if (typeof data.made_at !== "string") throw new Error(UNEXPECTED);
  return {
    made_at: data.made_at,
    inserted: {
      shifts: list(inserted, "shifts", isShiftRow),
      time_off: list(inserted, "time_off", isTimeOffRow),
      closed_days: list(inserted, "closed_days", isISODate),
    },
    updated: {
      shifts: list(updated, "shifts", rowChangeGuard(isShiftRow)),
      time_off: list(updated, "time_off", rowChangeGuard(isTimeOffRow)),
    },
    deleted: {
      shifts: list(deleted, "shifts", isShiftRow),
      time_off: list(deleted, "time_off", isTimeOffRow),
      closed_days: list(deleted, "closed_days", isISODate),
      actual_links: list(deleted, "actual_links", isActualLink),
    },
  };
}

/** The p_change argument for admin_undo. */
export function toChangeJson(c: ScheduleChange): Json {
  const pair = <T extends JsonObject>({ before, after }: RowChange<T>) => ({ before, after });
  return {
    made_at: c.made_at,
    inserted: {
      shifts: c.inserted.shifts,
      time_off: c.inserted.time_off,
      closed_days: c.inserted.closed_days,
    },
    updated: {
      shifts: c.updated.shifts.map(pair),
      time_off: c.updated.time_off.map(pair),
    },
    deleted: {
      shifts: c.deleted.shifts,
      time_off: c.deleted.time_off,
      closed_days: c.deleted.closed_days,
      actual_links: c.deleted.actual_links.map(({ actual_id, shift_id }) => ({ actual_id, shift_id })),
    },
  };
}

/**
 * The part of a close-days change that undo can reverse: what it took off the days it newly
 * closed. Rows it took off days that were closed already stay deleted: they don't belong on
 * a closed day, and admin_undo won't put rows back on one.
 */
export function undoableCloseChange(change: ScheduleChange): ScheduleChange {
  const closed = new Set(change.inserted.closed_days);
  const shifts = change.deleted.shifts.filter((s) => closed.has(s.shift_date));
  const shiftIds = new Set(shifts.map((s) => s.id));
  return {
    ...change,
    deleted: {
      ...change.deleted,
      shifts,
      time_off: change.deleted.time_off.filter((t) => closed.has(t.off_date)),
      actual_links: change.deleted.actual_links.filter((link) => shiftIds.has(link.shift_id)),
    },
  };
}

/** Reopening is a plain delete, so the page builds its change itself: undo closes the days again. */
export function reopenChange(dates: readonly ISODate[]): ScheduleChange {
  const change = emptyChange();
  change.deleted.closed_days = [...dates];
  return change;
}
