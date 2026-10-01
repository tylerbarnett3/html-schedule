// Employees and pay rates for the admin Employees drawer. Saves go through save_employee
// and set_employee_order (migration 004); archive and delete are plain table writes.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useState } from "react";
import { applyEmployeeOrder } from "../lib/employees";
import type { EmployeeRate, RateInput } from "../lib/rates";
import { supabase } from "../lib/supabase";
import type { Employee } from "../lib/types";
import { ADMIN_NETWORK_MODE, EMPLOYEE_REORDER_MUTATION_KEY, invalidateAdminData, waitForRefresh } from "./adminKeys";
import { adminErrorCode, errorFields } from "./errors";
import { fetchAll, toError } from "./schedule";

const EMPLOYEES_KEY = ["employees"] as const;
const EMPLOYEE_LOGINS_KEY = ["employees", "logins"] as const;
const EMPLOYEE_RATES_KEY = ["employeeRates"] as const;

/** Every pay rate. Only admins can read them (not payroll staff); anyone else gets an empty list. */
export function fetchEmployeeRates(signal: AbortSignal): Promise<EmployeeRate[]> {
  return fetchAll((from, to) =>
    supabase
      .from("employee_rates")
      .select("id, employee_id, rate, start_date, end_date")
      .order("employee_id")
      .order("start_date", { ascending: true, nullsFirst: true })
      .order("id")
      .range(from, to)
      .abortSignal(signal),
  );
}

/** `enabled: false` skips the read, for someone who can't see rates anyway. */
export function useEmployeeRates({ enabled = true }: { enabled?: boolean } = {}): UseQueryResult<EmployeeRate[]> {
  return useQuery({
    queryKey: EMPLOYEE_RATES_KEY,
    queryFn: ({ signal }) => fetchEmployeeRates(signal),
    enabled,
  });
}

/** Ids of employees linked to a login (E6). Logins themselves are managed by scripts/manage-logins.mjs. */
export function useEmployeeLogins(): UseQueryResult<ReadonlySet<string>> {
  return useQuery({
    queryKey: EMPLOYEE_LOGINS_KEY,
    queryFn: async ({ signal }) => {
      const rows = await fetchAll((from, to) =>
        supabase
          .from("employees")
          .select("id")
          .not("user_id", "is", null)
          .order("id")
          .range(from, to)
          .abortSignal(signal),
      );
      return new Set(rows.map((row) => row.id));
    },
  });
}

export interface SaveEmployeeInput {
  /** null adds a new employee (last in the list). */
  id: string | null;
  name: string;
  color: string;
  /** The employee's complete list of rate periods; periods left out are deleted. */
  rates: RateInput[];
}

/** Adds or updates an employee and their rates in one transaction; resolves to the id. */
export function useSaveEmployee(): UseMutationResult<string, Error, SaveEmployeeInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name, color, rates }) => {
      const { data, error } = await supabase.rpc("save_employee", {
        p_employee: {
          id,
          name,
          color,
          rates: rates.map((r) => ({ id: r.id, rate: r.rate, start_date: r.start_date, end_date: r.end_date })),
        },
      });
      if (error) throw toError(error);
      if (typeof data !== "string") throw new Error("Unexpected response from the server.");
      return data;
    },
    networkMode: ADMIN_NETWORK_MODE,
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}

/** updated is false when the employee no longer exists. */
export function useSetEmployeeArchived(): UseMutationResult<
  { updated: boolean },
  Error,
  { id: string; archived: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, archived }) => {
      const { data, error } = await supabase.from("employees").update({ archived }).eq("id", id).select("id");
      if (error) throw toError(error);
      return { updated: (data?.length ?? 0) > 0 };
    },
    networkMode: ADMIN_NETWORK_MODE,
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}

/**
 * Deletes the employee. The database cascades to their rates, shifts, time off,
 * availability and payroll records; a linked login stays but loses access.
 */
export function useDeleteEmployee(): UseMutationResult<{ deleted: boolean }, Error, { id: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }) => {
      const { data, error } = await supabase.from("employees").delete().eq("id", id).select("id");
      if (error) throw toError(error);
      return { deleted: (data?.length ?? 0) > 0 };
    },
    networkMode: ADMIN_NETWORK_MODE,
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}

type ReorderContext = { next: Employee[] | undefined };
type ReorderVariables = { ids: string[] };

/**
 * The options behind useReorderEmployees, exported for tests. Each call keeps its own
 * rollback state, so make one per list.
 */
export function employeeReorderOptions(
  client: QueryClient,
): UseMutationOptions<void, Error, ReorderVariables, ReorderContext> {
  // The order the database last accepted, and how many reorders haven't finished.
  let accepted: Employee[] | undefined;
  let running = 0;

  return {
    mutationKey: EMPLOYEE_REORDER_MUTATION_KEY,
    scope: { id: "employee-reorder" },
    networkMode: ADMIN_NETWORK_MODE,
    mutationFn: async ({ ids }) => {
      const { error } = await supabase.rpc("set_employee_order", { p_ids: ids });
      if (error) throw toError(error);
    },
    onMutate: async ({ ids }) => {
      // A refetch finishing now would put the old order back on screen.
      await client.cancelQueries({ queryKey: EMPLOYEES_KEY, exact: true });
      const current = client.getQueryData<Employee[]>(EMPLOYEES_KEY);
      if (running === 0) accepted = current;
      running += 1;
      const next = current ? applyEmployeeOrder(current, ids) : undefined;
      if (next) client.setQueryData(EMPLOYEES_KEY, next);
      return { next };
    },
    onSuccess: (_data, _variables, context) => {
      accepted = context.next;
    },
    onError: () => {
      // A later reorder carries this move too and will settle the order; only the last
      // one to finish rolls back.
      if (running === 1 && accepted) client.setQueryData(EMPLOYEES_KEY, accepted);
    },
    onSettled: async (_data, error) => {
      running -= 1;
      // invalidateAdminData only marks the employee list stale while a reorder runs, and
      // this reorder still counts as running until onSettled returns. So the last one to
      // finish refetches the list itself, which also picks up any employee change that
      // settled in the meantime.
      const refresh = Promise.all([
        invalidateAdminData(client),
        running === 0 ? client.invalidateQueries({ queryKey: EMPLOYEES_KEY }) : undefined,
      ]);
      await waitForRefresh(refresh, error);
    },
  };
}

/**
 * Saves a new display order (E11). `ids` is every employee in the new order. The list
 * shows the new order at once (the only optimistic update); on failure it goes back to
 * the last order the database accepted. Once the last reorder settles, the list is
 * refetched.
 *
 * Reorders run one at a time (a shared scope), so quick arrow-key moves reach the
 * database in the order they were made. Use this hook in one place only: it remembers
 * the last accepted order between calls.
 */
export function useReorderEmployees(): UseMutationResult<void, Error, ReorderVariables> {
  const client = useQueryClient();
  const [options] = useState(() => employeeReorderOptions(client));
  return useMutation(options);
}

async function countFor(table: "shifts" | "time_off" | "shift_actuals", employeeId: string): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("employee_id", employeeId);
  if (error) throw toError(error);
  return count ?? 0;
}

/** What deleting this employee would also delete, for the confirm (E5). */
export async function fetchEmployeeRecordCounts(
  id: string,
): Promise<{ shifts: number; timeOff: number; payroll: number }> {
  const [shifts, timeOff, payroll] = await Promise.all([
    countFor("shifts", id),
    countFor("time_off", id),
    countFor("shift_actuals", id),
  ]);
  return { shifts, timeOff, payroll };
}

/**
 * Wording for a failed employee write (EM §9). `name` is the name being saved, for the
 * duplicate-name message.
 */
export function employeeErrorMessage(
  error: unknown,
  action: "save" | "delete" | "reorder" | "archive",
  name?: string,
): string {
  const { message } = errorFields(error);
  const code = adminErrorCode(error);
  if (code === "duplicate_name") {
    return name ? `There's already an employee named ${name}.` : "There's already an employee with that name.";
  }
  if (code === "overlap" || message.includes("employee_rates_no_overlap")) {
    return "Rate periods cannot overlap. Please adjust the dates.";
  }
  if (message.includes("employee_rates_check")) return "End date must be after start date for all rate periods";
  if (message.includes("employee_rates_rate_positive")) return "Hourly rate must be greater than 0 or left empty";
  if (message.includes("employees_name_check")) return "Please enter an employee name";
  if (message.includes("employees_color_hex")) return "Pick a color.";
  switch (code) {
    case "not_admin":
      return "Only admins can change employees.";
    case "not_found":
      return "This employee was already removed.";
    case "network":
      return "Couldn't reach the schedule. Check your connection and try again.";
    case "auth_expired":
      return "Your sign-in has expired. Sign out, then sign in again.";
    default:
      return action === "delete" ? "There was an error deleting this employee." : "There was an error saving your changes.";
  }
}
