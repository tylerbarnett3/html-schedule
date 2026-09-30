import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Checkbox";
import { Spinner } from "../../components/Spinner";
import type { Employee } from "../../lib/types";
import { employeeColor } from "./employeeColor";
import { SidebarDrawer } from "./SidebarDrawer";
import "./Sidebar.css";

export interface SidebarProps {
  showTimeOff: boolean;
  onShowTimeOffChange(show: boolean): void;
  showAvailability: boolean;
  onShowAvailabilityChange(show: boolean): void;
  /** Undefined while the employee list is loading. */
  employees: readonly Employee[] | undefined;
  selectedIds: ReadonlySet<string>;
  onToggleEmployee(id: string, selected: boolean): void;
  onSelectAll(): void;
  onClearAll(): void;
  /** Extra sections (usually drawers) between the toggles and the employee filter. */
  beforeFilter?: ReactNode;
  /** Extra sections after the employee filter. */
  afterFilter?: ReactNode;
  className?: string;
}

export function Sidebar({
  showTimeOff,
  onShowTimeOffChange,
  showAvailability,
  onShowAvailabilityChange,
  employees,
  selectedIds,
  onToggleEmployee,
  onSelectAll,
  onClearAll,
  beforeFilter,
  afterFilter,
  className,
}: SidebarProps) {
  const [open, setOpen] = useState(false);

  const total = employees?.length ?? 0;
  const shown = employees?.filter((e) => selectedIds.has(e.id)).length ?? 0;
  // The filter is remembered between visits, so say so when the drawer is closed.
  const filtered = employees !== undefined && shown < total;

  return (
    <aside className={["sidebar", className].filter(Boolean).join(" ")} aria-label="Calendar options">
      <div className="sidebar-section">
        <Checkbox
          label="Show Time Off"
          checked={showTimeOff}
          onChange={(event) => onShowTimeOffChange(event.target.checked)}
        />
      </div>
      <div className="sidebar-section">
        <Checkbox
          label="Show Availability"
          checked={showAvailability}
          onChange={(event) => onShowAvailabilityChange(event.target.checked)}
        />
      </div>
      {beforeFilter}
      <SidebarDrawer
        title="Filter by Employee"
        open={open}
        onOpenChange={setOpen}
        badge={
          filtered ? (
            <>
              {shown} of {total}
              <span className="visually-hidden"> shown</span>
            </>
          ) : null
        }
      >
        <div className="sidebar-filter-actions">
          <Button variant="secondary" className="sidebar-filter-action" onClick={onSelectAll}>
            Select All
          </Button>
          <Button variant="secondary" className="sidebar-filter-action" onClick={onClearAll}>
            Clear All
          </Button>
        </div>
        {employees === undefined ? (
          <div className="sidebar-filter-loading">
            <Spinner size="sm" label="Loading employees..." />
          </div>
        ) : employees.length === 0 ? (
          <p className="sidebar-filter-empty">No employees</p>
        ) : (
          <ul className="sidebar-filter-list">
            {employees.map((employee) => (
              <li key={employee.id}>
                <Checkbox
                  className="sidebar-filter-item"
                  checked={selectedIds.has(employee.id)}
                  onChange={(event) => onToggleEmployee(employee.id, event.target.checked)}
                  label={
                    <span className="sidebar-filter-label">
                      <span
                        className="sidebar-swatch"
                        aria-hidden="true"
                        style={{ background: employeeColor(employee.color) }}
                      />
                      <span className="sidebar-filter-name">{employee.name}</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </SidebarDrawer>
      {afterFilter}
    </aside>
  );
}
