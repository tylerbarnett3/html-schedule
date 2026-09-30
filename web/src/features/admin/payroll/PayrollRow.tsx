import { memo } from "react";
import { payrollLoggedLine, type HourLog } from "../../../lib/hourLogs";
import {
  canResetRow,
  canUseLoggedHours,
  isFutureWorkDate,
  lastSavedText,
  NOTE_MAX_LENGTH,
  NUDGE_MINUTES,
  rowDate,
  rowDifferenceText,
  rowStatusLabel,
  scheduledLine,
  type ClockTime,
  type DraftRow,
  type RowAction,
} from "../../../lib/payroll";
import { toClock } from "../../../lib/time";
import type { Employee, ISODate } from "../../../lib/types";
import { payrollFieldId, type PayrollRowField } from "./payrollFieldId";
import "./PayrollRow.css";

export interface PayrollRowProps {
  row: DraftRow;
  /** The last-saved row; undefined for work added here and not saved yet. */
  pristine: DraftRow | undefined;
  /** Whose row it is: the scheduled employee, or who the work was added for. */
  ownerName: string;
  /** The hours the employee logged for this shift, if any (scheduled rows only). */
  log: HourLog | null;
  /** Who logged them, when that isn't the scheduled employee (the shift changed hands since). */
  loggedBy: string | null;
  /** Every employee, archived included, for "Actual employee". */
  employees: readonly Employee[];
  today: ISODate;
  idPrefix: string;
  /** While a save runs, nothing can change. */
  locked: boolean;
  onAction(key: string, action: RowAction): void;
  onReset(key: string): void;
  onRemove(key: string): void;
}

/** One shift (or unscheduled work) to review: who worked, when, and the outcome. */
export const PayrollRow = memo(function PayrollRow({
  row,
  pristine,
  ownerName,
  log,
  loggedBy,
  employees,
  today,
  idPrefix,
  locked,
  onAction,
  onReset,
  onRemove,
}: PayrollRowProps) {
  const future = isFutureWorkDate(rowDate(row), today);
  const vacated = row.status === "not-worked";
  const disabled = locked || future;
  const valuesDisabled = disabled || vacated;
  // Notes never set the outcome, so they wait for one (P5). A vacated orphan can't be saved
  // as unscheduled work, so it can only be removed.
  const noteDisabled = disabled || row.status === null || (row.kind === "actual-only" && vacated);
  const showNoteHint = !future && row.status === null;
  const difference = rowDifferenceText(row, today);
  const id = (field: PayrollRowField) => payrollFieldId(idPrefix, row.key, field);
  const ownerId = `${idPrefix}-${row.key}-owner`;
  const outcomeId = `${idPrefix}-${row.key}-outcome`;
  const hintId = `${idPrefix}-${row.key}-hint`;
  const loggedId = `${idPrefix}-${row.key}-logged`;
  const act = (action: RowAction) => onAction(row.key, action);
  const logged =
    log && row.kind === "scheduled"
      ? { employeeId: log.employee_id, start: toClock(log.start_time) ?? "", end: toClock(log.end_time) ?? "" }
      : null;

  const classes = ["payroll-row"];
  if (row.status) classes.push(`is-${row.status}`);

  return (
    <article className={classes.join(" ")} aria-labelledby={ownerId}>
      <header className="payroll-row-header">
        <div className="payroll-row-who">
          <h3 id={ownerId} className="payroll-row-name">
            {ownerName}
          </h3>
          <p className="payroll-row-scheduled">{scheduledLine(row)}</p>
        </div>
        <div className="payroll-row-status-wrap">
          <span className={row.status ? `payroll-row-status is-${row.status}` : "payroll-row-status"}>
            {rowStatusLabel(row, today)}
          </span>
          {difference ? <p className="payroll-row-difference">{difference}</p> : null}
        </div>
      </header>

      <div className="payroll-row-main">
        <div className="payroll-row-employee">
          <label htmlFor={id("employee")} className="payroll-field-label">
            Actual employee
          </label>
          <select
            id={id("employee")}
            className="payroll-input"
            aria-label={`Actual employee for ${ownerName}`}
            value={vacated ? "" : (row.employeeId ?? "")}
            disabled={valuesDisabled}
            onChange={(event) => act({ type: "set-employee", employeeId: event.target.value || null })}
          >
            <option value="">No employee</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
                {employee.archived ? " (Archived)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="payroll-row-times">
          <TimeField
            id={id("start")}
            label="Actual start"
            ariaLabel={`Actual start time for ${ownerName}`}
            nudgeName="start"
            value={row.start}
            disabled={valuesDisabled}
            onChange={(value) => act({ type: "set-time", field: "start", value })}
            onNudge={(delta) => act({ type: "nudge", field: "start", delta })}
          />
          <span className="payroll-row-to" aria-hidden="true">
            to
          </span>
          <TimeField
            id={id("end")}
            label="Actual end"
            ariaLabel={`Actual end time for ${ownerName}`}
            nudgeName="end"
            value={row.end}
            disabled={valuesDisabled}
            onChange={(value) => act({ type: "set-time", field: "end", value })}
            onNudge={(delta) => act({ type: "nudge", field: "end", delta })}
          />
        </div>

        <div className="payroll-row-outcome">
          <span id={outcomeId} className="payroll-field-label">
            Outcome
          </span>
          {row.kind === "actual-only" ? (
            <p className="payroll-row-locked">Actual-only shift</p>
          ) : (
            <div className="payroll-row-outcomes" role="group" aria-labelledby={outcomeId}>
              <button
                type="button"
                className="payroll-mini-btn payroll-outcome"
                aria-pressed={row.status === "confirmed"}
                disabled={disabled}
                onClick={() => act({ type: "confirm" })}
              >
                As scheduled
              </button>
              <button
                type="button"
                className="payroll-mini-btn payroll-outcome payroll-outcome-vacated"
                aria-pressed={vacated}
                disabled={disabled}
                onClick={() => act({ type: "vacate" })}
              >
                Vacated
              </button>
            </div>
          )}
          {log && logged && row.kind === "scheduled" ? (
            <div className="payroll-row-logged">
              <div id={loggedId}>
                <p className="payroll-row-logged-line">{payrollLoggedLine(log, row.shift, loggedBy)}</p>
                {log.note ? <p className="payroll-row-logged-note">“{log.note}”</p> : null}
              </div>
              {/* aria-disabled once used, so focus stays on the button instead of dropping to the page. */}
              <button
                type="button"
                className="payroll-mini-btn payroll-use-logged"
                aria-describedby={loggedId}
                aria-disabled={!canUseLoggedHours(row, logged, today) || undefined}
                disabled={disabled}
                onClick={() => act({ type: "use-logged", ...logged })}
              >
                Use logged hours
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="payroll-row-footer">
        <div className="payroll-row-note">
          <input
            id={id("note")}
            type="text"
            className="payroll-input"
            maxLength={NOTE_MAX_LENGTH}
            placeholder="Optional note"
            aria-label="Optional actual shift note"
            aria-describedby={showNoteHint ? hintId : undefined}
            value={row.note}
            disabled={noteDisabled}
            onChange={(event) => act({ type: "set-note", note: event.target.value })}
          />
          {showNoteHint ? (
            <p id={hintId} className="payroll-row-hint">
              Choose an outcome to add a note.
            </p>
          ) : null}
        </div>
        <div className="payroll-row-actions">
          <span className="payroll-row-saved">{lastSavedText(row.saved)}</span>
          {row.kind === "actual-only" ? (
            <button
              type="button"
              className="payroll-row-btn payroll-row-remove"
              disabled={disabled}
              onClick={() => onRemove(row.key)}
            >
              Remove
            </button>
          ) : null}
          <button
            type="button"
            className="payroll-row-btn"
            disabled={locked || !canResetRow(row, pristine, today)}
            onClick={() => onReset(row.key)}
          >
            Reset
          </button>
        </div>
      </div>
    </article>
  );
});

interface TimeFieldProps {
  id: string;
  label: string;
  ariaLabel: string;
  nudgeName: "start" | "end";
  value: ClockTime | null;
  disabled: boolean;
  onChange(value: ClockTime): void;
  onNudge(delta: number): void;
}

function TimeField({ id, label, ariaLabel, nudgeName, value, disabled, onChange, onNudge }: TimeFieldProps) {
  // A blank time has nothing to move.
  const nudgeDisabled = disabled || !value;
  return (
    <div className="payroll-time">
      <label htmlFor={id} className="payroll-time-label">
        {label}
      </label>
      <input
        id={id}
        type="time"
        className="payroll-input"
        aria-label={ariaLabel}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="payroll-nudge">
        <span className="payroll-nudge-step" aria-hidden="true">
          {NUDGE_MINUTES} min
        </span>
        <button
          type="button"
          className="payroll-mini-btn payroll-nudge-btn"
          aria-label={`Move ${nudgeName} time ${NUDGE_MINUTES} minutes earlier`}
          disabled={nudgeDisabled}
          onClick={() => onNudge(-NUDGE_MINUTES)}
        >
          {"−"}
        </button>
        <button
          type="button"
          className="payroll-mini-btn payroll-nudge-btn"
          aria-label={`Move ${nudgeName} time ${NUDGE_MINUTES} minutes later`}
          disabled={nudgeDisabled}
          onClick={() => onNudge(NUDGE_MINUTES)}
        >
          +
        </button>
      </div>
    </div>
  );
}
