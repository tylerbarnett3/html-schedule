// Payroll reads and the actuals save. Reading is plain table access (admins only, by RLS);
// the save goes through save_shift_actuals (migration 004), which writes in one transaction
// and stamps actualized_at and work_date on the server.

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Json } from "../lib/database.types";
import type { ActualsSavePlan, ShiftActual } from "../lib/payroll";
import { supabase } from "../lib/supabase";
import type { DateRange, Shift } from "../lib/types";
import { ADMIN_NETWORK_MODE, invalidateAdminData, waitForRefresh } from "./adminKeys";
import { fetchAll, SHIFT_COLUMNS, toError } from "./schedule";

const ACTUAL_COLUMNS = "id, shift_id, employee_id, work_date, start_time, end_time, status, note, actualized_at";

// Ids go into the URL (?shift_id=in.(...)), so long lists are read in pieces.
const CHUNK_SIZE = 100;

export type PayrollData = { shifts: Shift[]; actuals: ShiftActual[] };

export async function fetchPayrollPeriod(period: DateRange, signal: AbortSignal): Promise<PayrollData> {
  const [shifts, actuals] = await Promise.all([
    fetchAll((from, to) =>
      supabase
        .from("shifts")
        .select(SHIFT_COLUMNS)
        .gte("shift_date", period.start)
        .lte("shift_date", period.end)
        .order("shift_date")
        .order("start_time")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    ),
    fetchAll((from, to) =>
      supabase
        .from("shift_actuals")
        .select(ACTUAL_COLUMNS)
        .gte("work_date", period.start)
        .lte("work_date", period.end)
        .order("work_date")
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    ),
  ]);

  // A record normally shares its shift's date (a trigger keeps them together). Read the
  // period's other shifts' records by shift id too, so one that drifted still shows.
  const found = new Set(actuals.map((actual) => actual.shift_id));
  const missing = shifts.map((shift) => shift.id).filter((id) => !found.has(id));
  const byId = new Map(actuals.map((actual) => [actual.id, actual]));
  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    const ids = missing.slice(i, i + CHUNK_SIZE);
    const rows = await fetchAll((from, to) =>
      supabase
        .from("shift_actuals")
        .select(ACTUAL_COLUMNS)
        .in("shift_id", ids)
        .order("id")
        .range(from, to)
        .abortSignal(signal),
    );
    for (const row of rows) byId.set(row.id, row);
  }
  return { shifts, actuals: [...byId.values()] };
}

export function usePayrollPeriod(period: DateRange): UseQueryResult<PayrollData> {
  return useQuery({
    queryKey: ["payroll", period.start, period.end],
    queryFn: ({ signal }) => fetchPayrollPeriod(period, signal),
    placeholderData: keepPreviousData,
  });
}

function toSaveResult(data: Json | null): { deleted: number; saved: number } {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const { deleted, saved } = data;
    if (typeof deleted === "number" && typeof saved === "number") return { deleted, saved };
  }
  throw new Error("Unexpected response from the server.");
}

/**
 * Saves a plan from planActualsSave. Resolves after invalidateAdminData has refetched, so
 * the page can drop its draft without the old values flashing back.
 */
export function useSaveActuals(): UseMutationResult<{ deleted: number; saved: number }, Error, ActualsSavePlan> {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ["payroll", "save"],
    networkMode: ADMIN_NETWORK_MODE,
    mutationFn: async (plan: ActualsSavePlan) => {
      const { data, error } = await supabase.rpc("save_shift_actuals", {
        p_plan: { delete_ids: plan.deleteIds, scheduled: plan.scheduled, actual_only: plan.actualOnly },
      });
      if (error) throw toError(error);
      return toSaveResult(data);
    },
    // Also after errors: the save may have reached the database even if the reply was lost.
    onSettled: (_data, error) => waitForRefresh(invalidateAdminData(client), error),
  });
}
