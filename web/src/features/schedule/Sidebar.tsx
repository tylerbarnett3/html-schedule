import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Checkbox";
import { Spinner } from "../../components/Spinner";
import type { Employee } from "../../lib/types";
import { employeeColor } from "./employeeColor";
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
}: SidebarProps) {
  const drawerId = useId();
  const [open, setOpen] = useState(false);

  const total = employees?.length ?? 0;
  const shown = employees?.filter((e) => selectedIds.has(e.id)).length ?? 0;
  // The filter is remembered between visits, so say so when the drawer is closed.
  const filtered = employees !== undefined && shown < total;

  return (
    <aside className="sidebar" aria-label="Calendar options">
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
      <div className="sidebar-section">
        <h2 className="sidebar-drawer-heading">
          <button
            type="button"
            className="sidebar-drawer-toggle"
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="sidebar-drawer-title">Filter by Employee</span>
            {filtered ? (
              <span className="sidebar-drawer-count">
                {shown} of {total}
                <span className="visually-hidden"> shown</span>
              </span>
            ) : null}
            <span className="sidebar-drawer-chevron" aria-hidden="true">
              ▼
            </span>
          </button>
        </h2>
        <div id={drawerId} className="sidebar-drawer" data-open={open}>
          <div className="sidebar-drawer-inner">
            <div className="sidebar-drawer-content">
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
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
