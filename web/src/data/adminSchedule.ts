// Calendar edits for the admin schedule page. Every write goes through one database
// function (migration 004) that checks it and returns a ScheduleChange for Undo.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { Json } from "../lib/database.types";
import { addDays } from "../lib/dates";
import { parseScheduleChange, toChangeJson, type ScheduleChange } from "../lib/scheduleChange";
import type { EditingShift } from "../lib/scheduleEditing";
import { supabase, type DayPeriod } from "../lib/supabase";
import { toClock } from "../lib/time";
import type { ISODate, PgTime, TimeOff } from "../lib/types";
import { ADMIN_NETWORK_MODE, invalidateAdminData, waitForRefresh } from "./adminKeys";
import { fetchAll, SHIFT_COLUMNS, TIME_OFF_COLUMNS, toError, toTimeOffRow } from "./schedule";

export type NewShift = { employee_id: string; shift_date: ISODate; start_time: PgTime; end_time: PgTime };
export type NewDayOff = { employee_id: string; off_date: ISODate; period: DayPeriod };

// Ids and dates go into the URL (?col=in.(...)), so long lists are sent in pieces.
const CHUNK_SIZE = 100;

function chunks<T>(items: readonly T[], size: number = CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Times go to the database as 'HH:MM', the same as the time inputs show. */
function clock(t: PgTime): string {
  return toClock(t) ?? t;
}

/**
 * The rows a save or drop is checked against, read fresh rather than from the calendar
 * cache: these employees' shifts on the dates and the days either side (overnight
 * shifts), marked when Payroll has reviewed them; the hours Payroll recorded these
 * employees as working on those days (the calendar's reviewed cards); and their time off of
 * any status on the dates.
 */
export async function fetchEditingRows(i: {
  employeeIds: readonly string[];
  dates: readonly ISODate[];
}): Promise<{ shifts: EditingShift[]; worked: EditingShift[]; timeOff: TimeOff[] }> {
  const employeeIds = unique(i.employeeIds);
  const dates = unique(i.dates);
  if (employeeIds.length === 0 || dates.length === 0) return { shifts: [], worked: [], timeOff: [] };
  const shiftDates = unique(dates.flatMap((d) => [addDays(d, -1), d, addDays(d, 1)]));

  const shiftReads = chunks(employeeIds).flatMap((ids) =>
    chunks(shiftDates).map((days) =>
      fetchAll((from, to) =>
        supabase
          .from("shifts")
          .select(SHIFT_COLUMNS)
          .in("employee_id", ids)
          .in("shift_date", days)
          .order("shift_date")
          .order("start_time")
          .order("id")
          .range(from, to),
      ),
    ),
  );
  const timeOffReads = chunks(employeeIds).flatMap((ids) =>
    chunks(dates).map((days) =>
      fetchAll((from, to) =>
        supabase
          .from("time_off")
          .select(TIME_OFF_COLUMNS)
          .in("employee_id", ids)
          .in("off_date", days)
          .order("off_date")
          .order("requested_at")
          .order("id")
          .range(from, to),
      ),
    ),
  );
  const workedReads = chunks(employeeIds).flatMap((ids) =>
    chunks(shiftDates).map((days) =>
      fetchAll((from, to) =>
        supabase
          .from("shift_actuals")
          .select("id, shift_id, employee_id, work_date, start_time, end_time")
          .in("employee_id", ids)
          .in("work_date", days)
          .neq("status", "not-worked")
          .order("id")
          .range(from, to),
      ),
    ),
  );
  const [shiftPages, workedPages, timeOff] = await Promise.all([
    Promise.all(shiftReads),
    Promise.all(workedReads),
    Promise.all(timeOffReads),
  ]);
  const shifts = shiftPages.flat();
  const reviewed = await fetchShiftIdsWithActuals(shifts.map((s) => s.id));
  const worked: EditingShift[] = [];
  for (const r of workedPages.flat()) {
    if (r.start_time === null || r.end_time === null) continue;
    worked.push({
      id: r.id,
      employee_id: r.employee_id,
      shift_date: r.work_date,
      start_time: r.start_time,
      end_time: r.end_time,
      reviewed: true,
      reviewOf: r.shift_id,
    });
  }
  return {
    shifts: shifts.map((s) => (reviewed.has(s.id) ? { ...s, reviewed: true } : s)),
    worked,
    timeOff: timeOff.flat().map(toTimeOffRow),
  };
}

/** Which of these shifts have payroll hours recorded (a shift_actuals row). */
export async function fetchShiftIdsWithActuals(shiftIds: readonly string[]): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  for (const ids of chunks(unique(shiftIds))) {
    const rows = await fetchAll((from, to) =>
      supabase.from("shift_actuals").select("shift_id").in("shift_id", ids).order("id").range(from, to),
    );
    for (const row of rows) if (row.shift_id) found.add(row.shift_id);
  }
  return found;
}

async function countRows(
  table: "shifts" | "time_off",
  column: "shift_date" | "off_date",
  dates: readonly ISODate[],
): Promise<number> {
  let total = 0;
  for (const days of chunks(unique(dates))) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .in(column, days);
    if (error) throw toError(error);
    total += count ?? 0;
  }
  return total;
}

/** How many shifts and time-off entries (any status) closing these days would delete. */
export async function fetchCloseDayCounts(dates: readonly ISODate[]): Promise<{ shifts: number; timeOff: number }> {
  const [shifts, timeOff] = await Promise.all([
    countRows("shifts", "shift_date", dates),
    countRows("time_off", "off_date", dates),
  ]);
  return { shifts, timeOff };
}

// ---------------------------------------------------------------------------
// Mutations. Each resolves after invalidateAdminData has refetched (except after a network
// failure, see waitForRefresh), so the caller's toast describes what the calendar already shows.

type M<V> = UseMutationResult<ScheduleChange, Error, V>;

type RpcReply = {
  data: Json | null;
  error: { message: string; details?: string | null; hint?: string | null; code?: string | null } | null;
};

function toChange({ data, error }: RpcReply): ScheduleChange {
  if (error) throw toError(error);
  return parseScheduleChange(data);
}

function useScheduleMutation<V>(write: (variables: V) => Promise<ScheduleChange>): M<V> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    networkMode: ADMIN_NETWORK_MODE,
    // Also after errors: the write may have reached the database even if the reply was lost.
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}

export function useAddShifts(): M<{ rows: NewShift[] }> {
  return useScheduleMutation(async ({ rows }) =>
    toChange(
      await supabase.rpc("admin_add_shifts", {
        p_shifts: rows.map((row) => ({
          employee_id: row.employee_id,
          shift_date: row.shift_date,
          start_time: clock(row.start_time),
          end_time: clock(row.end_time),
        })),
      }),
    ),
  );
}

export function useAddDaysOff(): M<{ days: NewDayOff[]; deleteShiftIds: string[] }> {
  return useScheduleMutation(async ({ days, deleteShiftIds }) =>
    toChange(
      await supabase.rpc("admin_add_days_off", {
        p_days: days.map((day) => ({ employee_id: day.employee_id, off_date: day.off_date, period: day.period })),
        p_delete_shift_ids: deleteShiftIds,
      }),
    ),
  );
}

export function useUpdateShift(): M<{
  id: string;
  employeeId: string;
  date: ISODate;
  startTime: PgTime;
  endTime: PgTime;
}> {
  return useScheduleMutation(async ({ id, employeeId, date, startTime, endTime }) =>
    toChange(
      await supabase.rpc("admin_update_shift", {
        p_id: id,
        p_employee_id: employeeId,
        p_shift_date: date,
        p_start_time: clock(startTime),
        p_end_time: clock(endTime),
      }),
    ),
  );
}

export function useUpdateDayOff(): M<{
  id: string;
  employeeId: string;
  date: ISODate;
  period: DayPeriod;
  deleteShiftIds: string[];
}> {
  return useScheduleMutation(async ({ id, employeeId, date, period, deleteShiftIds }) =>
    toChange(
      await supabase.rpc("admin_update_day_off", {
        p_id: id,
        p_employee_id: employeeId,
        p_off_date: date,
        p_period: period,
        p_delete_shift_ids: deleteShiftIds,
      }),
    ),
  );
}

export function useConvertToDayOff(): M<{
  shiftId: string;
  employeeId: string;
  date: ISODate;
  period: DayPeriod;
  deleteShiftIds: string[];
}> {
  return useScheduleMutation(async ({ shiftId, employeeId, date, period, deleteShiftIds }) =>
    toChange(
      await supabase.rpc("admin_convert_to_day_off", {
        p_shift_id: shiftId,
        p_employee_id: employeeId,
        p_off_date: date,
        p_period: period,
        p_delete_shift_ids: deleteShiftIds,
      }),
    ),
  );
}

export function useConvertToShift(): M<{
  timeOffId: string;
  employeeId: string;
  date: ISODate;
  startTime: PgTime;
  endTime: PgTime;
}> {
  return useScheduleMutation(async ({ timeOffId, employeeId, date, startTime, endTime }) =>
    toChange(
      await supabase.rpc("admin_convert_to_shift", {
        p_time_off_id: timeOffId,
        p_employee_id: employeeId,
        p_shift_date: date,
        p_start_time: clock(startTime),
        p_end_time: clock(endTime),
      }),
    ),
  );
}

/** Ids that are already gone are skipped; an empty change means someone removed them first. */
export function useDeleteScheduleItems(): M<{ shiftIds?: string[]; timeOffIds?: string[] }> {
  return useScheduleMutation(async ({ shiftIds = [], timeOffIds = [] }) =>
    toChange(await supabase.rpc("admin_delete_items", { p_shift_ids: shiftIds, p_time_off_ids: timeOffIds })),
  );
}

/** inserted.closed_days lists only the days that weren't closed already. Custom hours on the days are cleared too. */
export function useCloseDays(): M<{ dates: ISODate[] }> {
  return useScheduleMutation(async ({ dates }) =>
    toChange(await supabase.rpc("admin_close_days", { p_dates: dates })),
  );
}

/** admin_set_custom_hours; closed dates are reopened, hours equal to standard clear the row. */
export function useSetCustomHours(): M<{ dates: ISODate[]; open: PgTime; close: PgTime }> {
  return useScheduleMutation(async ({ dates, open, close }) =>
    toChange(
      await supabase.rpc("admin_set_custom_hours", {
        p_dates: dates,
        p_open_time: clock(open),
        p_close_time: clock(close),
      }),
    ),
  );
}

/** admin_set_standard_hours; also the "Reopen day" button. Reopens closed dates and clears custom hours. */
export function useSetStandardHours(): M<{ dates: ISODate[] }> {
  return useScheduleMutation(async ({ dates }) =>
    toChange(await supabase.rpc("admin_set_standard_hours", { p_dates: dates })),
  );
}

/** Reverses a change. Fails with undo_stale, changing nothing, when the rows changed since. */
export function useUndoChange(): UseMutationResult<void, Error, { change: ScheduleChange }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ change }: { change: ScheduleChange }) => {
      const { error } = await supabase.rpc("admin_undo", { p_change: toChangeJson(change) });
      if (error) throw toError(error);
    },
    networkMode: ADMIN_NETWORK_MODE,
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}
