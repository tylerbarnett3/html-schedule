import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useEmployees } from "../../data/schedule";
import { useBusinessToday } from "../../data/useBusinessToday";
import { usePersistentState } from "../../data/usePersistentState";
import { defaultRange } from "../../lib/dates";
import type { DateRange } from "../../lib/types";
import { AdminViewContext, type AdminView } from "./useAdminView";

// Separate from the employee page's schedule.* keys: an admin who is also an employee can
// filter each page differently. Deselected ids are stored so new employees show by default.
const HIDDEN_EMPLOYEES_KEY = "admin.employeeFilter.v1";
const SHOW_TIME_OFF_KEY = "admin.showTimeOff.v1";
const SHOW_AVAILABILITY_KEY = "admin.showAvailability.v1";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Holds the admin view state above the routes, so it survives going to Payroll and back. */
export function AdminViewProvider({ children }: { children: ReactNode }) {
  const today = useBusinessToday();
  const [range, setRange] = useState<DateRange>(() => defaultRange(today));
  const [showTimeOff, setShowTimeOff] = usePersistentState(SHOW_TIME_OFF_KEY, true);
  const [showAvailability, setShowAvailability] = usePersistentState(SHOW_AVAILABILITY_KEY, true);
  const [hiddenIds, setHiddenIds] = usePersistentState<string[]>(HIDDEN_EMPLOYEES_KEY, [], isStringArray);
  const [requestsDrawerOpen, setRequestsDrawerOpen] = useState(false);
  const employees = useEmployees().data;

  const selectedEmployeeIds = useMemo(() => {
    const hidden = new Set(hiddenIds);
    return new Set((employees ?? []).filter((e) => !hidden.has(e.id)).map((e) => e.id));
  }, [employees, hiddenIds]);

  const toggleEmployee = useCallback(
    (id: string, selected: boolean) => {
      const known = new Set((employees ?? []).map((e) => e.id));
      // Drop ids of employees that no longer exist while we're here.
      setHiddenIds((current) => {
        const rest = current.filter((hiddenId) => hiddenId !== id && known.has(hiddenId));
        return selected ? rest : [...rest, id];
      });
    },
    [employees, setHiddenIds],
  );

  const selectAllEmployees = useCallback(() => setHiddenIds([]), [setHiddenIds]);
  const clearAllEmployees = useCallback(
    () => setHiddenIds((employees ?? []).map((e) => e.id)),
    [employees, setHiddenIds],
  );

  const view = useMemo<AdminView>(
    () => ({
      today,
      range,
      setRange,
      showTimeOff,
      setShowTimeOff,
      showAvailability,
      setShowAvailability,
      selectedEmployeeIds,
      toggleEmployee,
      selectAllEmployees,
      clearAllEmployees,
      requestsDrawerOpen,
      setRequestsDrawerOpen,
    }),
    [
      today,
      range,
      showTimeOff,
      setShowTimeOff,
      showAvailability,
      setShowAvailability,
      selectedEmployeeIds,
      toggleEmployee,
      selectAllEmployees,
      clearAllEmployees,
      requestsDrawerOpen,
    ],
  );

  return <AdminViewContext.Provider value={view}>{children}</AdminViewContext.Provider>;
}
