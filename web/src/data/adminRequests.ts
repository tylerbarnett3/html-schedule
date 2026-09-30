// Reading and reviewing employees' requests on the admin page (the Requests drawer and the
// calendar's review dialog). Approvals go through database functions that check the rows are
// still pending; denials and removals filter on status, so 0 rows means someone got there first.

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Json } from "../lib/database.types";
import {
  approvedWindowStart,
  pendingRequestCount,
  type AdminAvailability,
  type AdminTimeOff,
  type RequestKind,
} from "../lib/adminRequests";
import { parseScheduleChange, type ScheduleChange } from "../lib/scheduleChange";
import { supabase } from "../lib/supabase";
import type { ISODate } from "../lib/types";
import { ADMIN_NETWORK_MODE, invalidateAdminData, waitForRefresh } from "./adminKeys";
import { AVAILABILITY_COLUMNS, fetchAll, TIME_OFF_COLUMNS, toError, toTimeOffRow } from "./schedule";
import { useBusinessToday } from "./useBusinessToday";

export type AdminRequests = { timeOff: AdminTimeOff[]; availability: AdminAvailability[] };

const ADMIN_TIME_OFF_COLUMNS = `${TIME_OFF_COLUMNS}, reviewed_at` as const;
const ADMIN_AVAILABILITY_COLUMNS = `${AVAILABILITY_COLUMNS}, reviewed_at` as const;

// There's no realtime (R8): poll while the admin page is open, and refetch on focus.
const REFETCH_INTERVAL_MS = 60_000;

/**
 * Every pending request, whatever its date, plus approved requests from today − 30 on (R1).
 * Days off the admin assigned aren't requests, so only time off with source "request".
 */
export async function fetchAdminRequests(today: ISODate, signal?: AbortSignal): Promise<AdminRequests> {
  const from = approvedWindowStart(today);
  const [timeOff, availability] = await Promise.all([
    fetchAll((start, end) => {
      const query = supabase
        .from("time_off")
        .select(ADMIN_TIME_OFF_COLUMNS)
        .eq("source", "request")
        .or(`status.eq.pending,off_date.gte.${from}`)
        .order("off_date")
        .order("id")
        .range(start, end);
      return signal ? query.abortSignal(signal) : query;
    }),
    fetchAll((start, end) => {
      const query = supabase
        .from("availability")
        .select(ADMIN_AVAILABILITY_COLUMNS)
        .or(`status.eq.pending,available_date.gte.${from}`)
        .order("available_date")
        .order("id")
        .range(start, end);
      return signal ? query.abortSignal(signal) : query;
    }),
  ]);
  return { timeOff: timeOff.map(toTimeOffRow), availability };
}

function adminRequestsQuery(today: ISODate) {
  return queryOptions({
    queryKey: ["adminRequests", today],
    queryFn: ({ signal }) => fetchAdminRequests(today, signal),
    refetchOnWindowFocus: true,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}

export function useAdminRequests(today: ISODate): UseQueryResult<AdminRequests> {
  return useQuery(adminRequestsQuery(today));
}

/**
 * Which of these requests are still pending, read fresh. Used after an all-or-nothing approval
 * found some of them weren't, to tell the admin what's left.
 */
export async function fetchPendingRequestIds(kind: RequestKind, ids: readonly string[]): Promise<ReadonlySet<string>> {
  const { data, error } =
    kind === "time-off"
      ? await supabase
          .from("time_off")
          .select("id")
          .in("id", [...ids])
          .eq("status", "pending")
          .eq("source", "request")
      : await supabase.from("availability").select("id").in("id", [...ids]).eq("status", "pending");
  if (error) throw toError(error);
  return new Set(data.map((row) => row.id));
}

/** Pending time off plus pending availability, for the badges; undefined until loaded. */
export function usePendingRequestCount(): number | undefined {
  const today = useBusinessToday();
  return useQuery({ ...adminRequestsQuery(today), select: pendingRequestCount }).data;
}

// ---------------------------------------------------------------------------
// Reviews. None of these go on the undo stack (R11).

type ErrorLike = { message: string; details?: string | null; hint?: string | null; code?: string | null };

function useReviewMutation<R, V>(write: (variables: V) => Promise<R>): UseMutationResult<R, Error, V> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: write,
    networkMode: ADMIN_NETWORK_MODE,
    // Also after errors: the write may have reached the database even if the reply was lost.
    // Awaited, so the caller's toast appears once the drawer and calendar show the result.
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}

function deletedCount({ data, error }: { data: { id: string }[] | null; error: ErrorLike | null }): {
  deleted: number;
} {
  if (error) throw toError(error);
  return { deleted: data?.length ?? 0 };
}

/**
 * Approves pending time-off requests and deletes the covered shifts the admin agreed to, all
 * at once. Fails with request_not_pending (nothing changes) if any of them isn't pending any more.
 */
export function useApproveTimeOff(): UseMutationResult<
  ScheduleChange,
  Error,
  { ids: string[]; deleteShiftIds: string[] }
> {
  return useReviewMutation(async ({ ids, deleteShiftIds }: { ids: string[]; deleteShiftIds: string[] }) => {
    const { data, error } = await supabase.rpc("approve_time_off", {
      p_ids: ids,
      p_delete_shift_ids: deleteShiftIds,
    });
    if (error) throw toError(error);
    return parseScheduleChange(data);
  });
}

/** Deletes the requests that are still pending; the count says how many that was. */
export function useDenyTimeOff(): UseMutationResult<{ deleted: number }, Error, { ids: string[] }> {
  return useReviewMutation(async ({ ids }: { ids: string[] }) =>
    deletedCount(await supabase.from("time_off").delete().in("id", ids).eq("status", "pending").select("id")),
  );
}

function approvedIdCount(data: Json | null): number {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const approved = data.approved_ids;
    if (Array.isArray(approved)) return approved.length;
  }
  throw new Error("Unexpected response from the server.");
}

/** Approves pending availability, all or nothing (request_not_pending otherwise). */
export function useApproveAvailability(): UseMutationResult<{ approved: number }, Error, { ids: string[] }> {
  return useReviewMutation(async ({ ids }: { ids: string[] }) => {
    const { data, error } = await supabase.rpc("approve_availability", { p_ids: ids });
    if (error) throw toError(error);
    return { approved: approvedIdCount(data) };
  });
}

export function useDenyAvailability(): UseMutationResult<{ deleted: number }, Error, { ids: string[] }> {
  return useReviewMutation(async ({ ids }: { ids: string[] }) =>
    deletedCount(await supabase.from("availability").delete().in("id", ids).eq("status", "pending").select("id")),
  );
}

/** Takes back approved availability (R5). Approved time off is removed with useDeleteScheduleItems. */
export function useRemoveApprovedAvailability(): UseMutationResult<{ deleted: number }, Error, { id: string }> {
  return useReviewMutation(async ({ id }: { id: string }) =>
    deletedCount(await supabase.from("availability").delete().eq("id", id).eq("status", "approved").select("id")),
  );
}
