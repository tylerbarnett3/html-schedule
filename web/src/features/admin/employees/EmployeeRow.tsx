import { useId, type KeyboardEvent, type Ref } from "react";
import type { Employee } from "../../../lib/types";
import { employeeFill } from "../../schedule/employeeColor";
import "../../../components/Button.css";
import "./EmployeesDrawer.css";

/** One line under the name: text, "loading" (shown as "…"), or null to leave it out. */
export type RowLine = string | "loading" | null;

export interface EmployeeRowReorder {
  /** Position among the active employees (0-based) and how many there are. */
  position: number;
  count: number;
  /** "handle" (mouse: drag or arrow keys) or "buttons" (touch: Move up / Move down). */
  mode: "handle" | "buttons";
  /** id of the text explaining the arrow keys. */
  hintId: string;
  onMove(to: number, focus: "handle" | "up" | "down"): void;
}

export interface EmployeeRowProps {
  employee: Employee;
  stats: RowLine;
  rate: RowLine;
  /** Undefined while logins are loading. */
  hasLogin: boolean | undefined;
  onEdit(): void;
  onToggleArchive(): void;
  /** Null for archived employees, who keep their place but aren't reordered here. */
  reorder: EmployeeRowReorder | null;
  draggable: boolean;
  dragging: boolean;
  /** Where the dragged employee would land: a line above or below this row. */
  dropPosition: "before" | "after" | null;
  /** Registers the row's focusable controls (keys "handle", "edit", "archive", "up", "down"). */
  focusRef(control: string): Ref<HTMLButtonElement>;
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {[6, 12, 18].map((y) =>
        [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="currentColor" />),
      )}
    </svg>
  );
}

function ArrowIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d={direction === "up" ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Screen readers get ", " between the lines, which are only separated visually.
const SEPARATOR = <span className="visually-hidden">, </span>;

function Line({ value, className }: { value: RowLine; className: string }) {
  if (value === null) return null;
  if (value === "loading") {
    return (
      <span className={className}>
        <span aria-hidden="true">…</span>
        <span className="visually-hidden">Loading</span>
        {SEPARATOR}
      </span>
    );
  }
  return (
    <span className={className}>
      {value}
      {SEPARATOR}
    </span>
  );
}

/** An employee in the Employees drawer: edit button, stats, rate, login and archive (EM §1, D7, E6). */
export function EmployeeRow({
  employee,
  stats,
  rate,
  hasLogin,
  onEdit,
  onToggleArchive,
  reorder,
  draggable,
  dragging,
  dropPosition,
  focusRef,
}: EmployeeRowProps) {
  const metaId = useId();
  const name = employee.name;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!reorder) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const to = reorder.position + (event.key === "ArrowUp" ? -1 : 1);
      if (to >= 0 && to < reorder.count) reorder.onMove(to, "handle");
    }
  };

  return (
    <li
      className="employee-row"
      data-employee-id={employee.id}
      data-archived={employee.archived || undefined}
      data-reorder={reorder?.mode}
      data-dragging={dragging || undefined}
      data-drop={dropPosition ?? undefined}
      draggable={draggable || undefined}
    >
      {reorder?.mode === "handle" ? (
        <button
          ref={focusRef("handle")}
          type="button"
          className="employee-row-handle"
          aria-label={`Reorder ${name}`}
          aria-describedby={reorder.hintId}
          title="Drag, or use the arrow keys, to reorder"
          onKeyDown={handleKeyDown}
        >
          <GripIcon />
        </button>
      ) : null}
      {/* Its click area stretches over the whole row (CSS), as on the old page. */}
      <button
        ref={focusRef("edit")}
        type="button"
        className="employee-row-edit"
        aria-label={`Edit ${name}`}
        aria-describedby={metaId}
        onClick={onEdit}
      >
        <span
          className="employee-row-swatch"
          aria-hidden="true"
          style={{ background: employeeFill(employee.color) }}
        />
        <span className="employee-row-name">{name}</span>
      </button>
      {/* The Button look (ghost, small) on a plain button, which can take a ref. */}
      <button
        ref={focusRef("archive")}
        type="button"
        className="btn btn-ghost btn-sm employee-row-archive"
        aria-label={`${employee.archived ? "Unarchive" : "Archive"} ${name}`}
        onClick={onToggleArchive}
      >
        {employee.archived ? "Unarchive" : "Archive"}
      </button>
      <span id={metaId} className="employee-row-meta">
        <Line value={stats} className="employee-row-line" />
        <span className="employee-row-line employee-row-rate-line">
          <Line value={rate} className="employee-row-rate" />
          {hasLogin === undefined ? null : (
            <span className={hasLogin ? "employee-row-login" : "employee-row-login employee-row-no-login"}>
              {hasLogin ? "Login" : "No login"}
            </span>
          )}
        </span>
      </span>
      {reorder?.mode === "buttons" ? (
        <span className="employee-row-move">
          <button
            ref={focusRef("up")}
            type="button"
            className="employee-row-move-btn"
            aria-label={`Move ${name} up`}
            disabled={reorder.position === 0}
            onClick={() => reorder.onMove(reorder.position - 1, "up")}
          >
            <ArrowIcon direction="up" />
          </button>
          <button
            ref={focusRef("down")}
            type="button"
            className="employee-row-move-btn"
            aria-label={`Move ${name} down`}
            disabled={reorder.position === reorder.count - 1}
            onClick={() => reorder.onMove(reorder.position + 1, "down")}
          >
            <ArrowIcon direction="down" />
          </button>
        </span>
      ) : null}
    </li>
  );
}
