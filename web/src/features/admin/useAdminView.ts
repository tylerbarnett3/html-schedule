import { createContext, useContext } from "react";
import type { DateRange, ISODate } from "../../lib/types";

/** What the admin is looking at; shared by the toolbar, sidebar and schedule page. */
export interface AdminView {
  /** Business "today" (America/New_York); moves on at midnight. */
  today: ISODate;
  /** Starts at today…today+34 on every load; not saved (T3). */
  range: DateRange;
  setRange(range: DateRange): void;
  showTimeOff: boolean;
  setShowTimeOff(show: boolean): void;
  showAvailability: boolean;
  setShowAvailability(show: boolean): void;
  /** Everyone except the employees the admin unticked in the filter. */
  selectedEmployeeIds: ReadonlySet<string>;
  toggleEmployee(id: string, selected: boolean): void;
  selectAllEmployees(): void;
  clearAllEmployees(): void;
  requestsDrawerOpen: boolean;
  setRequestsDrawerOpen(open: boolean): void;
}

/** Provided by <AdminViewProvider> (./AdminViewProvider.tsx). */
export const AdminViewContext = createContext<AdminView | null>(null);

export function useAdminView(): AdminView {
  const view = useContext(AdminViewContext);
  if (!view) throw new Error("useAdminView must be used inside <AdminViewProvider>.");
  return view;
}
