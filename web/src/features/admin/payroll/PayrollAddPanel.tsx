import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/Button";
import { addWorkError, NOTE_MAX_LENGTH } from "../../../lib/payroll";
import type { DateRange, Employee, ISODate } from "../../../lib/types";
import "./PayrollAddPanel.css";

/** Start, End and Note keep their values between openings (only the note clears on add). */
export interface AddWorkFields {
  start: string;
  end: string;
  note: string;
}

export interface AddWork extends AddWorkFields {
  employeeId: string;
  date: ISODate;
}

export interface PayrollAddPanelProps {
  id: string;
  /** Active employees, in display order (E10). */
  employees: readonly Employee[];
  period: DateRange;
  today: ISODate;
  /** The day that was selected when the panel opened. */
  initialDate: ISODate;
  fields: AddWorkFields;
  onFieldsChange(fields: AddWorkFields): void;
  onAdd(work: AddWork): void;
  onCancel(): void;
}

/** "Add unscheduled shift": work that happened but was never on the schedule (P10). */
export function PayrollAddPanel({
  id,
  employees,
  period,
  today,
  initialDate,
  fields,
  onFieldsChange,
  onAdd,
  onCancel,
}: PayrollAddPanelProps) {
  const fieldId = useId();
  const [employeeId, setEmployeeId] = useState(() => employees[0]?.id ?? "");
  const [date, setDate] = useState<string>(initialDate);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const firstField = useRef<HTMLSelectElement>(null);

  // Focus moves into the panel when it opens.
  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const change = (next: Partial<AddWorkFields>) => {
    setError(null);
    onFieldsChange({ ...fields, ...next });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = addWorkError(
      { employeeId: employeeId || null, date, start: fields.start, end: fields.end },
      period,
      today,
    );
    if (problem) {
      setError(problem);
      return;
    }
    onAdd({ employeeId, date, ...fields });
  };

  return (
    <section
      id={id}
      className="payroll-add"
      aria-labelledby={`${fieldId}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h3 id={`${fieldId}-title`} className="payroll-add-title">
        Add work that was not on the schedule
      </h3>
      <form onSubmit={submit} noValidate>
        <div className="payroll-add-grid">
          <div className="payroll-add-field">
            <label htmlFor={`${fieldId}-employee`}>Employee</label>
            <select
              ref={firstField}
              id={`${fieldId}-employee`}
              className="payroll-input"
              value={employeeId}
              onChange={(event) => {
                setError(null);
                setEmployeeId(event.target.value);
              }}
            >
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </div>
          <div className="payroll-add-field">
            <label htmlFor={`${fieldId}-date`}>Date</label>
            <input
              id={`${fieldId}-date`}
              type="date"
              className="payroll-input"
              min={period.start}
              max={period.end}
              value={date}
              onChange={(event) => {
                setError(null);
                setDate(event.target.value);
              }}
            />
          </div>
          <div className="payroll-add-field">
            <label htmlFor={`${fieldId}-start`}>Start</label>
            <input
              id={`${fieldId}-start`}
              type="time"
              className="payroll-input"
              value={fields.start}
              onChange={(event) => change({ start: event.target.value })}
            />
          </div>
          <div className="payroll-add-field">
            <label htmlFor={`${fieldId}-end`}>End</label>
            <input
              id={`${fieldId}-end`}
              type="time"
              className="payroll-input"
              value={fields.end}
              onChange={(event) => change({ end: event.target.value })}
            />
          </div>
          <div className="payroll-add-field payroll-add-note">
            <label htmlFor={`${fieldId}-note`}>Note (optional)</label>
            <input
              id={`${fieldId}-note`}
              type="text"
              className="payroll-input"
              maxLength={NOTE_MAX_LENGTH}
              placeholder="Why this shift was added"
              value={fields.note}
              onChange={(event) => change({ note: event.target.value })}
            />
          </div>
        </div>
        {/* Stays mounted so a new message is announced. */}
        <p className="payroll-add-error" role="alert">
          {error ? (
            <>
              <strong>{error.title}.</strong> {error.message}
            </>
          ) : null}
        </p>
        <div className="payroll-add-actions">
          <Button variant="success" type="submit">
            Add to actuals
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
