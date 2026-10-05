import { keepPreviousData, skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { PostgrestError } from "@supabase/supabase-js";
import { toClosedDaySet } from "../lib/calendar";
import { addDays } from "../lib/dates";
import type { ShiftReview } from "../lib/reviewedShifts";
import { supabase } from "../lib/supabase";
import type {
  Availability,
  DateRange,
  Employee,
  ISODate,
  Shift,
  TimeOff,
  TimeOffSource,
} from "../lib/types";

/** The most rows PostgREST returns for one request (max_rows in supabase/config.toml). */
export const PAGE_SIZE = 1000;

type ErrorLike = { message: string; details?: string | null; hint?: string | null; code?: string | null };

/**
 * supabase-js returns errors as plain objects (network failures included), so wrap them
 * in a real Error before handing them to react-query.
 */
export function toError(error: ErrorLike): Error {
  if (error instanceof Error) return error;
  return new PostgrestError({
    message: error.message,
    details: error.details ?? "",
    hint: error.hint ?? "",
    code: error.code ?? "",
  });
}

type Page<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: ErrorLike | null }>;

/**
 * Reads every row of a query, one .range() page at a time, because PostgREST silently
 * stops at PAGE_SIZE rows. The query's order must end in a unique column (id) so pages
 * don't overlap or skip rows. pageSize must not exceed PAGE_SIZE.
 */
export async function fetchAll<T>(page: Page<T>, pageSize: number = PAGE_SIZE): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw toError(error);
    if (!data) return rows;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

/** The column is text with a check constraint, so the generated type is just string. */
export function toTimeOffSource(source: string): TimeOffSource {
  return source === "assigned" ? "assigned" : "request";
}

/** A time_off row with its source narrowed from string to TimeOffSource. */
export function toTimeOffRow<R extends { source: string }>(row: R): Omit<R, "source"> & { source: TimeOffSource } {
  return { ...row, source: toTimeOffSource(row.source) };
}

export const EMPLOYEE_COLUMNS = "id, name, color, display_order, archived";
export const SHIFT_COLUMNS = "id, employee_id, shift_date, start_time, end_time";
export const TIME_OFF_COLUMNS = "id, employee_id, off_date, period, status, source, requested_at";
export const AVAILABILITY_COLUMNS = "id, employee_id, available_date, period, status, requested_at";

// A signal that never aborts, for callers outside react-query.
const noSignal = () => new AbortController().signal;

/** All employees, archived included: old rows and the filter still need their names. */
export function fetchEmployees(signal: AbortSignal = noSignal()): Promise<Employee[]> {
  return fetchAll((from, to) =>
    supabase
      .from("employees")
      .select(EMPLOYEE_COLUMNS)
      .order("display_order")
      .order("created_at", { ascending: false })
      .order("name")
      .order("id")
      .range(from, to)
      .abortSignal(signal),
  );
}

// PostgREST's "no such function": the database doesn't have reviewed_shifts yet
// (20261005000001_reviewed_shifts.sql not applied), so no shift shows as reviewed.
const MISSING_FUNCTION = "PGRST202";

/** The payroll records for the range's reviewed shifts, without their notes (see ShiftReview). */
async function fetchReviews(range: DateRange, signal: AbortSignal): Promise<ShiftReview[]> {
  try {
    return await fetchAll((from, to) =>
      supabase
        .rpc("reviewed_shifts", { p_start: range.start, p_end: range.end })
        .order("work_date")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === MISSING_FUNCTION) return [];
    throw error;
  }
}

export type CalendarData = {
  shifts: Shift[];
  timeOff: TimeOff[];
  availability: Availability[];
  /** Payroll's records for the range: the calendar shows reviewed shifts as recorded (applyReviews). */
  reviews: ShiftReview[];
};

export async function fetchCalendarData(
  range: DateRange,
  signal: AbortSignal = noSignal(),
): Promise<CalendarData> {
  const [shifts, timeOff, availability, reviews] = await Promise.all([
    fetchAll((from, to) =>
      supabase
        .from("shifts")
        .select(SHIFT_COLUMNS)
        .gte("shift_date", range.start)
        .lte("shift_date", range.end)
        .order("shift_date")
        .order("start_time")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    ),
    fetchAll((from, to) =>
      supabase
        .from("time_off")
        .select(TIME_OFF_COLUMNS)
        .gte("off_date", range.start)
        .lte("off_date", range.end)
        .order("off_date")
        .order("requested_at")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    ),
    fetchAll((from, to) =>
      supabase
        .from("availability")
        .select(AVAILABILITY_COLUMNS)
        .gte("available_date", range.start)
        .lte("available_date", range.end)
        .order("available_date")
        .order("requested_at")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    ),
    fetchReviews(range, signal),
  ]);
  return { shifts, timeOff: timeOff.map(toTimeOffRow), availability, reviews };
}

/** Every closed day; the table is small, and the date picker looks a year ahead. */
export async function fetchClosedDays(signal: AbortSignal = noSignal()): Promise<ReadonlySet<ISODate>> {
  const rows = await fetchAll((from, to) =>
    supabase
      .from("closed_days")
      .select("closed_date")
      .order("closed_date")
      .range(from, to)
      .abortSignal(signal),
  );
  return toClosedDaySet(rows);
}

export type MyRequests = { timeOff: TimeOff[]; availability: Availability[] };

/** One employee's rows from today through a year out: the date picker's window. */
export async function fetchMyRequests(
  employeeId: string,
  today: ISODate,
  signal: AbortSignal = noSignal(),
): Promise<MyRequests> {
  const last = addDays(today, 365);
  const [timeOff, availability] = await Promise.all([
    fetchAll((from, to) =>
      supabase
        .from("time_off")
        .select(TIME_OFF_COLUMNS)
        .eq("employee_id", employeeId)
        .gte("off_date", today)
        .lte("off_date", last)
        .order("off_date")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    ),
    fetchAll((from, to) =>
      supabase
        .from("availability")
        .select(AVAILABILITY_COLUMNS)
        .eq("employee_id", employeeId)
        .gte("available_date", today)
        .lte("available_date", last)
        .order("available_date")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    ),
  ]);
  return { timeOff: timeOff.map(toTimeOffRow), availability };
}

export function useEmployees(): UseQueryResult<Employee[]> {
  return useQuery({
    queryKey: ["employees"],
    queryFn: ({ signal }) => fetchEmployees(signal),
  });
}

export function useCalendarData(range: DateRange): UseQueryResult<CalendarData> {
  return useQuery({
    queryKey: ["calendar", range.start, range.end],
    queryFn: ({ signal }) => fetchCalendarData(range, signal),
    // Keep showing the previous range while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export function useClosedDays(): UseQueryResult<ReadonlySet<ISODate>> {
  return useQuery({
    queryKey: ["closedDays"],
    queryFn: ({ signal }) => fetchClosedDays(signal),
  });
}

export function useMyRequests(employeeId: string | null, today: ISODate): UseQueryResult<MyRequests> {
  return useQuery({
    queryKey: ["myRequests", employeeId, today],
    queryFn:
      employeeId === null ? skipToken : ({ signal }) => fetchMyRequests(employeeId, today, signal),
  });
}
