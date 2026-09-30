// Business hours (migration 005): the weekly sets and the per-date custom hours. Staff read
// them; only admins save them. The per-date writes are calendar edits (data/adminSchedule.ts);
// the weekly editor saves here, off the undo stack.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useMemo } from "react";
import {
  NO_HOURS,
  toCustomHoursMap,
  toHoursSets,
  type Hours,
  type HoursData,
  type HoursSet,
  type WeeklyHoursPayload,
} from "../lib/hours";
import { supabase } from "../lib/supabase";
import type { ISODate } from "../lib/types";
import { ADMIN_NETWORK_MODE, invalidateAdminData, waitForRefresh } from "./adminKeys";
import { fetchAll, toError } from "./schedule";

export const WEEKLY_HOURS_KEY = ["weeklyHours"] as const;
export const CUSTOM_HOURS_KEY = ["customHours"] as const;

// A signal that never aborts, for callers outside react-query.
const noSignal = () => new AbortController().signal;

/** Every weekly_hours row (small table), as sets. */
export async function fetchWeeklyHours(signal: AbortSignal = noSignal()): Promise<HoursSet[]> {
  const rows = await fetchAll((from, to) =>
    supabase
      .from("weekly_hours")
      .select("id, starts_on, weekday, open_time, close_time")
      .order("starts_on", { ascending: true, nullsFirst: true })
      .order("weekday")
      .order("id")
      .range(from, to)
      .abortSignal(signal),
  );
  return toHoursSets(rows);
}

/** Every custom_hours row. */
export async function fetchCustomHours(signal: AbortSignal = noSignal()): Promise<ReadonlyMap<ISODate, Hours>> {
  const rows = await fetchAll((from, to) =>
    supabase
      .from("custom_hours")
      .select("hours_date, open_time, close_time")
      .order("hours_date")
      .range(from, to)
      .abortSignal(signal),
  );
  return toCustomHoursMap(rows);
}

export function useWeeklyHours(): UseQueryResult<HoursSet[]> {
  return useQuery({
    queryKey: WEEKLY_HOURS_KEY,
    queryFn: ({ signal }) => fetchWeeklyHours(signal),
  });
}

export function useCustomHours(): UseQueryResult<ReadonlyMap<ISODate, Hours>> {
  return useQuery({
    queryKey: CUSTOM_HOURS_KEY,
    queryFn: ({ signal }) => fetchCustomHours(signal),
  });
}

export interface HoursQuery {
  /**
   * Memoized.
   * - Weekly query without data (pending or failed): NO_HOURS as a whole (no sets and an empty custom map), even when
   *   the custom query has data. Custom rows without the weekly sets would all look special (+3 too).
   * - Weekly data loaded (including a successful []): { sets: weekly.data, custom: custom.data ?? empty map }.
   *   A successful [] with custom rows still shows them (H5).
   */
  data: HoursData;
  /**
   * Neither query is still pending (each has data or has failed). A read that has failed once
   * stays settled while it is tried again: react-query reports a failed read with no data as
   * pending on every refetch (window focus, a new observer), and that must not hide the calendar.
   */
  ready: boolean;
  /** A query failed and has no data (also while it is being tried again). */
  failed: boolean;
  weekly: UseQueryResult<HoursSet[]>;
  custom: UseQueryResult<ReadonlyMap<ISODate, Hours>>;
}

/** Both hours queries together, for the calendars and the Day Hours dialog. Hours never block the calendar. */
export function useHoursData(): HoursQuery {
  const weekly = useWeeklyHours();
  const custom = useCustomHours();
  const data = useMemo<HoursData>(
    () => (weekly.data === undefined ? NO_HOURS : { sets: weekly.data, custom: custom.data ?? NO_HOURS.custom }),
    [weekly.data, custom.data],
  );
  const reads = [weekly, custom];
  return {
    data,
    ready: reads.every((read) => !read.isPending || read.errorUpdateCount > 0),
    failed: reads.some((read) => read.data === undefined && (read.isError || read.errorUpdateCount > 0)),
    weekly,
    custom,
  };
}

/** save_weekly_hours: the weekly editor's Save. Not an undo step; it refreshes everything like any admin write. */
export function useSaveWeeklyHours(): UseMutationResult<void, Error, WeeklyHoursPayload> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: WeeklyHoursPayload) => {
      const { error } = await supabase.rpc("save_weekly_hours", { p_hours: payload });
      if (error) throw toError(error);
    },
    networkMode: ADMIN_NETWORK_MODE,
    // Also after errors: the write may have reached the database even if the reply was lost.
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}
