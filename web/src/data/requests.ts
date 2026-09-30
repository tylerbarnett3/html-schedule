import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { isISODate } from "../lib/dates";
import { supabase, type DayPeriod } from "../lib/supabase";
import type { ISODate, RequestResult, TimeOff } from "../lib/types";
import { errorFields, NETWORK_ERROR } from "./errors";
import { fetchAll, toError, toTimeOffSource } from "./schedule";

export type RequestKind = "time-off" | "availability";
export type RequestVariables = { dates: ISODate[]; period: DayPeriod };
export type CancelVariables = { id: string };
export type CancelResult = { deleted: boolean };

function isDateArray(value: unknown): value is ISODate[] {
  return Array.isArray(value) && value.every(isISODate);
}

function parseRequestResult(data: unknown): RequestResult {
  if (typeof data === "object" && data !== null && "submitted" in data && "skipped" in data) {
    const { submitted, skipped } = data;
    if (isDateArray(submitted) && isDateArray(skipped)) return { submitted, skipped };
  }
  throw new Error("Unexpected response when submitting a request.");
}

/**
 * Submits through the database functions, which apply the request rules and report
 * each date as submitted or skipped.
 */
export async function submitRequest(kind: RequestKind, { dates, period }: RequestVariables): Promise<RequestResult> {
  const args = { p_dates: dates, p_period: period };
  const { data, error } =
    kind === "time-off"
      ? await supabase.rpc("request_time_off", args)
      : await supabase.rpc("request_availability", args);
  if (error) throw toError(error);
  return parseRequestResult(data);
}

/**
 * Deletes one of my pending requests. Row-level security silently skips rows that aren't
 * mine or were already approved, so ask for the deleted rows back to know if it worked.
 */
export async function cancelRequest(kind: RequestKind, id: string): Promise<CancelResult> {
  const { data, error } =
    kind === "time-off"
      ? await supabase.from("time_off").delete().eq("id", id).eq("status", "pending").select("id")
      : await supabase.from("availability").delete().eq("id", id).eq("status", "pending").select("id");
  if (error) throw toError(error);
  return { deleted: data.length > 0 };
}

/** Everyone's requested time off (pending or approved) on these dates, for the busy-day warning. */
export async function fetchHighVolumeRows(
  dates: ISODate[],
): Promise<Pick<TimeOff, "off_date" | "status" | "source">[]> {
  if (dates.length === 0) return [];
  const rows = await fetchAll((from, to) =>
    supabase
      .from("time_off")
      .select("off_date, status, source")
      .in("off_date", dates)
      .eq("source", "request")
      .order("off_date")
      .order("id")
      .range(from, to),
  );
  return rows.map((row) => ({ ...row, source: toTimeOffSource(row.source) }));
}

// Wait for the refetch so the calendar already shows the change when the caller's
// success message appears.
async function refreshRequests(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["calendar"] }),
    client.invalidateQueries({ queryKey: ["myRequests"] }),
  ]);
}

function useSubmitRequest(kind: RequestKind): UseMutationResult<RequestResult, Error, RequestVariables> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (variables: RequestVariables) => submitRequest(kind, variables),
    // Also refresh after errors: a request can reach the database even if the reply is lost.
    onSettled: () => refreshRequests(client),
  });
}

function useCancelRequest(kind: RequestKind): UseMutationResult<CancelResult, Error, CancelVariables> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: CancelVariables) => cancelRequest(kind, id),
    onSettled: () => refreshRequests(client),
  });
}

export function useRequestTimeOff(): UseMutationResult<RequestResult, Error, RequestVariables> {
  return useSubmitRequest("time-off");
}

export function useRequestAvailability(): UseMutationResult<RequestResult, Error, RequestVariables> {
  return useSubmitRequest("availability");
}

export function useCancelTimeOff(): UseMutationResult<CancelResult, Error, CancelVariables> {
  return useCancelRequest("time-off");
}

export function useCancelAvailability(): UseMutationResult<CancelResult, Error, CancelVariables> {
  return useCancelRequest("availability");
}

export const NO_REQUEST_ACCESS_MESSAGE = "Your login can't submit requests. Ask your manager.";

/** Plain-language message for a failed submit. */
export function requestErrorMessage(error: unknown, kind: RequestKind): string {
  const { message, code } = errorFields(error);
  // not_linked: the login has no employee (e.g. an admin); employee_archived: raised
  // by the database rules. Both come back as insufficient_privilege (42501).
  if (message === "not_linked" || message === "employee_archived" || code === "42501") {
    return NO_REQUEST_ACCESS_MESSAGE;
  }
  if (NETWORK_ERROR.test(message)) {
    return "Couldn't reach the schedule. Check your connection and try again.";
  }
  if (code === "PGRST301" || code === "PGRST303" || /jwt/i.test(message)) {
    return "Your sign-in has expired. Sign out, then sign in again.";
  }
  return kind === "time-off"
    ? "There was an error submitting your time-off request."
    : "There was an error submitting availability.";
}
