// Logged hours for the signed-in employee ("Log My Hours"). Everything goes through the
// database functions in migration 006, which decide which shifts can be logged: employees
// can't read the payroll reviews those rules depend on.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { parseLoggableShifts, type LoggableShift } from "../lib/hourLogs";
import { supabase } from "../lib/supabase";
import { waitForRefresh } from "./adminKeys";
import { errorFields, NETWORK_ERROR } from "./errors";
import { toError } from "./schedule";

export type LogHoursVariables = { shiftId: string; start: string; end: string; note: string };
export type RemoveHourLogVariables = { shiftId: string };

export const LOGGABLE_SHIFTS_KEY = "loggableShifts";

/**
 * The employee's shifts they can log now, newest first. Read fresh each time the dialog
 * opens: shifts become loggable as they end, and leave once the admin reviews them.
 */
export function useLoggableShifts(employeeId: string): UseQueryResult<LoggableShift[]> {
  return useQuery({
    queryKey: [LOGGABLE_SHIFTS_KEY, employeeId],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc("my_loggable_shifts").abortSignal(signal);
      if (error) throw toError(error);
      return parseLoggableShifts(data);
    },
    refetchOnMount: "always",
  });
}

// Waited for, so the list already shows the change when the caller's message appears
// (except after a network failure; see waitForRefresh). Payroll too, for an admin who also
// works shifts.
async function refreshLogs(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: [LOGGABLE_SHIFTS_KEY] }),
    client.invalidateQueries({ queryKey: ["payroll"] }),
  ]);
}

export function useLogHours(): UseMutationResult<void, Error, LogHoursVariables> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ shiftId, start, end, note }: LogHoursVariables) => {
      const { error } = await supabase.rpc("log_shift_hours", {
        p_shift_id: shiftId,
        p_start: start,
        p_end: end,
        p_note: note.trim(),
      });
      if (error) throw toError(error);
    },
    // Tried at once even when the device reports being offline, so the dialog shows the
    // "Couldn't reach" message instead of saving much later by itself.
    networkMode: "always",
    // Also after errors: the log may have been saved even if the reply was lost.
    onSettled: (_data, error) => waitForRefresh(refreshLogs(client), error),
  });
}

/** Resolves to false when there was nothing to remove. */
export function useRemoveHourLog(): UseMutationResult<boolean, Error, RemoveHourLogVariables> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ shiftId }: RemoveHourLogVariables) => {
      const { data, error } = await supabase.rpc("remove_hour_log", { p_shift_id: shiftId });
      if (error) throw toError(error);
      return data === true;
    },
    networkMode: "always",
    onSettled: (_data, error) => waitForRefresh(refreshLogs(client), error),
  });
}

export type HourLogFailure = "reviewed" | "gone" | "not-over" | "other";

/**
 * Why logging (or removing) failed. "reviewed", "gone" and "not-over" mean the shift is no
 * longer in the list (or not yet); the list has been refreshed by then.
 */
export function hourLogFailure(error: unknown): HourLogFailure {
  const { message, code } = errorFields(error);
  if (message === "already_reviewed") return "reviewed";
  if (message === "shift_not_over") return "not-over";
  if (message === "not_found" || code === "P0002") return "gone";
  return "other";
}

/** Plain-language message for a failed log or remove. */
export function hourLogErrorMessage(error: unknown, action: "save" | "remove"): string {
  const { message, code } = errorFields(error);
  switch (hourLogFailure(error)) {
    case "reviewed":
      return "Your manager has already reviewed this shift in payroll, so its hours can't be changed.";
    case "gone":
      return "This shift was changed or removed from your schedule. The list has been refreshed.";
    case "not-over":
      return "This shift hasn't ended yet. Log your hours after it ends.";
    case "other":
      break;
  }
  // not_linked: the login has no employee (e.g. an admin); employee_archived. Both 42501.
  if (message === "not_linked" || message === "employee_archived" || code === "42501") {
    return "Your login can't log hours. Ask your manager.";
  }
  if (NETWORK_ERROR.test(message)) return "Couldn't reach the schedule. Check your connection and try again.";
  if (code === "PGRST301" || code === "PGRST303" || /jwt/i.test(message)) {
    return "Your sign-in has expired. Sign out, then sign in again.";
  }
  if (message === "invalid_input" || code === "22023") return "Check the times and try again.";
  return action === "save" ? "There was an error saving your hours." : "There was an error removing your hours.";
}
