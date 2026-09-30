import { useEmployees } from "../../data/schedule";
import { Sidebar } from "../schedule/Sidebar";
import { EmployeesDrawer } from "./employees/EmployeesDrawer";
import { AdminBusinessHours } from "./hours/AdminBusinessHours";
import { RequestsDrawer } from "./requests/RequestsDrawer";
import { useAdminView } from "./useAdminView";
import "./AdminSidebar.css";

/** The employee page's sidebar plus the Employees, Requests and Business Hours drawers around the filter. */
export function AdminSidebar() {
  const view = useAdminView();
  const employees = useEmployees().data;

  return (
    <Sidebar
      className="admin-sidebar"
      showTimeOff={view.showTimeOff}
      onShowTimeOffChange={view.setShowTimeOff}
      showAvailability={view.showAvailability}
      onShowAvailabilityChange={view.setShowAvailability}
      employees={employees}
      selectedIds={view.selectedEmployeeIds}
      onToggleEmployee={view.toggleEmployee}
      onSelectAll={view.selectAllEmployees}
      onClearAll={view.clearAllEmployees}
      beforeFilter={<EmployeesDrawer />}
      afterFilter={
        <>
          <RequestsDrawer />
          <AdminBusinessHours />
        </>
      }
    />
  );
}
