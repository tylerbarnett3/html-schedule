import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Checkbox } from "../../../components/Checkbox";
import { Modal } from "../../../components/Modal";
import { SegmentedControl, type SegmentedOption } from "../../../components/SegmentedControl";
import { Spinner } from "../../../components/Spinner";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import {
  fetchCloseDayCounts,
  fetchEditingRows,
  useAddDaysOff,
  useAddShifts,
  useCloseDays,
} from "../../../data/adminSchedule";
import { useClosedDays, useEmployees } from "../../../data/schedule";
import { formatChipDate, monthOf, type MonthKey } from "../../../lib/dates";
import { DAY_PERIODS, formatPeriod } from "../../../lib/periods";
import { toggleDate } from "../../../lib/requests";
import { undoableCloseChange } from "../../../lib/scheduleChange";
import {
  ADD_ITEM_SAVE_LABELS,
  ADD_ITEM_TITLES,
  ADD_ITEM_TYPE_LABELS,
  addPickerDay,
  closeDaysConfirm,
  closedDaysText,
  planAddSave,
  QUICK_SHIFTS,
  withoutClosedDates,
  type AddItemType,
} from "../../../lib/scheduleEditing";
import { formatShiftTime } from "../../../lib/time";
import type { DayPeriod, Employee, ISODate } from "../../../lib/types";
import { DatePicker } from "../../schedule/DatePicker";
import { useAdminView } from "../useAdminView";
import { useUndo } from "../undo/useUndo";
import { confirmShiftDeletion } from "./scheduleConfirms";
import {
  addDaysOffLabel,
  addShiftsLabel,
  alreadyClosedText,
  closeDaysLabel,
  daysOffAddedText,
  scheduleError,
  shiftsAddedText,
} from "./scheduleText";
import "../../../components/Field.css";
import "./AddItemDialog.css";

export interface AddItemDialogProps {
  /** The day whose "+ Add" was clicked; null while the dialog is closed. */
  date: ISODate | null;
  onClose(): void;
}

const TYPE_OPTIONS: readonly SegmentedOption<AddItemType>[] = (["shift", "day-off", "closed"] as const).map(
  (value) => ({ value, label: ADD_ITEM_TYPE_LABELS[value] }),
);
const PERIOD_OPTIONS: readonly SegmentedOption<DayPeriod>[] = DAY_PERIODS.map((value) => ({
  value,
  label: formatPeriod(value),
}));
const NO_CLOSED_DAYS: ReadonlySet<ISODate> = new Set();
const NO_EMPLOYEES: readonly Employee[] = [];

// The last Start/End typed or picked, kept for the rest of the page session (C13), as the
// old page kept its inputs between openings.
let lastTimes = { start: "09:00", end: "17:00" };

/**
 * "+ Add" on a calendar day: shifts, days off, or closed days, for several dates and
 * employees at once (D4). Each open starts as a Shift on the clicked date with nobody
 * picked, because the form is remounted whenever the dialog opens.
 */
export function AddItemDialog({ date, onClose }: AddItemDialogProps) {
  if (date === null) return null;
  return <AddItemForm key={date} date={date} onClose={onClose} />;
}

function AddItemForm({ date, onClose }: { date: ISODate; onClose(): void }) {
  const formId = useId();
  const startId = useId();
  const endId = useId();
  const datesLabelId = useId();

  const [type, setType] = useState<AddItemType>("shift");
  const [dates, setDates] = useState<ISODate[]>([date]);
  const [month, setMonth] = useState<MonthKey>(() => monthOf(date));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [startTime, setStartTime] = useState(lastTimes.start);
  const [endTime, setEndTime] = useState(lastTimes.end);
  const [period, setPeriod] = useState<DayPeriod>("full-day");
  const [error, setError] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const errorId = useRef(0);
  const mounted = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const chipListRef = useRef<HTMLUListElement>(null);
  const datesBoxRef = useRef<HTMLDivElement>(null);
  const chipToFocus = useRef<number | null>(null);

  const { today } = useAdminView();
  const employeesQuery = useEmployees();
  const closedQuery = useClosedDays();
  const addShifts = useAddShifts();
  const addDaysOff = useAddDaysOff();
  const closeDays = useCloseDays();
  const undo = useUndo();
  const confirm = useConfirm();
  const toast = useToast();

  const employees = employeesQuery.data ?? NO_EMPLOYEES;
  const closedDays = closedQuery.data ?? NO_CLOSED_DAYS;
  // New work goes to active employees only (C17, E10).
  const active = useMemo(() => employees.filter((e) => !e.archived), [employees]);
  const pickedIds = active.filter((e) => picked.has(e.id)).map((e) => e.id);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // After a chip's × removes it, keep focus in the chip list instead of losing it.
  useEffect(() => {
    const index = chipToFocus.current;
    if (index === null) return;
    chipToFocus.current = null;
    const buttons = chipListRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    const target = buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : datesBoxRef.current;
    target?.focus();
  }, [dates]);

  const showError = (text: string) => {
    errorId.current += 1;
    setError({ id: errorId.current, text });
  };

  const changeType = (next: AddItemType) => {
    setType(next);
    // Only Closed can pick closed days; the others drop them (the old page did the same).
    if (next !== "closed") setDates((current) => withoutClosedDates(current, closedDays));
    setError(null);
  };

  const toggleEmployee = (id: string, checked: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setError(null);
  };

  const toggle = (d: ISODate) => {
    if (addPickerDay(d, closedDays, type).disabled) return;
    setDates((current) => toggleDate(current, d));
    setError(null);
  };

  const removeDate = (d: ISODate) => {
    chipToFocus.current = dates.indexOf(d);
    setDates(dates.filter((s) => s !== d));
    setError(null);
  };

  const changeTimes = (start: string, end: string) => {
    setStartTime(start);
    setEndTime(end);
    lastTimes = { start, end };
    setError(null);
  };

  const setWorking = (value: boolean) => {
    busyRef.current = value;
    if (mounted.current) setBusy(value);
  };

  const close = () => {
    if (mounted.current) onClose();
  };

  const markClosed = async (closeDates: ISODate[]) => {
    const ask = closeDaysConfirm(closeDates, await fetchCloseDayCounts(closeDates));
    if (!mounted.current) return;
    if (ask) {
      // Not busy while asking, so focus can come back to the button afterwards.
      setWorking(false);
      const ok = await confirm({ ...ask, confirmLabel: "Mark Closed", cancelLabel: "Cancel", tone: "danger" });
      if (!ok || !mounted.current) return;
      setWorking(true);
    }
    const change = await closeDays.mutateAsync({ dates: closeDates });
    const closedCount = change.inserted.closed_days.length;
    // Closed can pick days that are closed already; what it clears off them can't be undone
    // (and when every day was closed already, there is nothing to undo, so no step is added).
    undo.push({ label: closeDaysLabel(closedCount), change: undoableCloseChange(change) });
    if (closedCount > 0) {
      toast.show(closedDaysText(closedCount), "success", { title: "Closed for Business" });
    } else {
      toast.show(alreadyClosedText(closeDates.length), "info");
    }
    close();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    setError(null);

    const input = { type, dates, employeeIds: pickedIds, startTime, endTime, period, closedDays, employees };
    // The quick checks (dates, employees, closed days, times) need no rows.
    const first = planAddSave({ ...input, shifts: [], timeOff: [] });
    if (first.kind === "error") {
      showError(first.message);
      return;
    }

    setWorking(true);
    try {
      if (first.kind === "close-days") {
        await markClosed(first.dates);
        return;
      }
      // Conflicts are checked against rows read now, not the calendar cache (C15).
      const rows = await fetchEditingRows({ employeeIds: pickedIds, dates });
      if (!mounted.current) return;
      const plan = planAddSave({ ...input, ...rows });
      if (plan.kind === "error") {
        showError(plan.message);
        return;
      }
      if (plan.kind === "add-shifts") {
        const change = await addShifts.mutateAsync({ rows: plan.rows });
        const added = change.inserted.shifts.length;
        undo.push({ label: addShiftsLabel(added), change });
        toast.show(shiftsAddedText(added), "success");
        close();
      } else if (plan.kind === "add-days-off") {
        if (plan.confirmMessage !== null) {
          setWorking(false);
          const ok = await confirmShiftDeletion(confirm, plan.confirmMessage, plan.deleteShiftIds);
          if (!ok || !mounted.current) return;
          setWorking(true);
        }
        const change = await addDaysOff.mutateAsync({ days: plan.rows, deleteShiftIds: plan.deleteShiftIds });
        const added = change.inserted.time_off.length;
        undo.push({ label: addDaysOffLabel(added), change });
        toast.show(daysOffAddedText(added, change.deleted.shifts.length), "success", { title: "Day Off Added" });
        close();
      }
    } catch (caught) {
      const { message } = scheduleError(caught, { adding: true, employees });
      if (mounted.current) showError(message);
      else toast.show(message, "error");
    } finally {
      setWorking(false);
    }
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      {/* aria-disabled rather than disabled keeps focus on the button while saving. */}
      <Button type="submit" form={formId} variant="primary" aria-disabled={busy || undefined}>
        {busy ? (
          <>
            <Spinner size="sm" decorative className="add-item-spinner" />
            Saving...
          </>
        ) : (
          ADD_ITEM_SAVE_LABELS[type]
        )}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={ADD_ITEM_TITLES[type]} size="lg" footer={footer} className="add-item-dialog">
      <form id={formId} className="add-item-form" onSubmit={handleSubmit} aria-busy={busy} noValidate>
        <div className="add-item-main">
          <SegmentedControl
            label="Schedule item type"
            hideLabel
            options={TYPE_OPTIONS}
            value={type}
            onChange={changeType}
          />

          {type === "closed" ? (
            <p className="add-item-hint">
              Pick the days to close. Their shifts and time off are deleted; payroll records and availability are kept.
            </p>
          ) : (
            <fieldset className="add-item-employees">
              <legend className="field-label">Employee(s)</legend>
              {employeesQuery.isPending ? (
                <div className="add-item-loading">
                  <Spinner size="sm" label="Loading employees..." showLabel />
                </div>
              ) : active.length === 0 ? (
                <p className="add-item-empty">No active employees available</p>
              ) : (
                <ul className="add-item-employee-list">
                  {active.map((employee) => (
                    <li key={employee.id}>
                      <Checkbox
                        appearance="plain"
                        className="add-item-employee"
                        checked={picked.has(employee.id)}
                        onChange={(event) => toggleEmployee(employee.id, event.target.checked)}
                        label={<span className="add-item-employee-name">{employee.name}</span>}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}

          {type === "day-off" ? (
            <SegmentedControl
              label="Day Off Type"
              options={PERIOD_OPTIONS}
              value={period}
              onChange={(value) => {
                setPeriod(value);
                setError(null);
              }}
            />
          ) : null}

          {type === "shift" ? (
            <>
              <div className="add-item-times">
                <div className="field">
                  <label htmlFor={startId} className="field-label">
                    Start Time
                  </label>
                  <input
                    id={startId}
                    type="time"
                    className="field-control"
                    value={startTime}
                    onChange={(event) => changeTimes(event.target.value, endTime)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={endId} className="field-label">
                    End Time
                  </label>
                  <input
                    id={endId}
                    type="time"
                    className="field-control"
                    value={endTime}
                    onChange={(event) => changeTimes(startTime, event.target.value)}
                  />
                </div>
              </div>
              <div className="add-item-quick">
                <p className="add-item-quick-title" aria-hidden="true">
                  Quick Shifts
                </p>
                <div className="add-item-quick-list" role="group" aria-label="Quick shift shortcuts">
                  {QUICK_SHIFTS.map((quick) => (
                    <button
                      key={quick.start}
                      type="button"
                      className="add-item-quick-chip"
                      onClick={() => changeTimes(quick.start, quick.end)}
                    >
                      {formatShiftTime({ start_time: quick.start, end_time: quick.end })}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <div className="add-item-dates">
          <DatePicker
            month={month}
            onMonthChange={setMonth}
            today={today}
            selected={dates}
            onToggle={toggle}
            getDay={(d) => addPickerDay(d, closedDays, type)}
            bounds={null}
          />
          <div
            ref={datesBoxRef}
            className="add-item-selected"
            role="group"
            aria-labelledby={datesLabelId}
            tabIndex={-1}
          >
            <p id={datesLabelId} className="field-label">
              Selected Dates:
            </p>
            {dates.length === 0 ? (
              <p className="add-item-empty-dates">No dates selected</p>
            ) : (
              <ul ref={chipListRef} className="add-item-chips">
                {dates.map((d) => {
                  const label = formatChipDate(d);
                  return (
                    <li key={d} className="add-item-chip">
                      <span>{label}</span>
                      <button
                        type="button"
                        className="add-item-chip-remove"
                        aria-label={`Remove ${label}`}
                        onClick={() => removeDate(d)}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="add-item-messages">
          {error ? (
            <p key={error.id} ref={errorRef} className="field-error" role="alert">
              {error.text}
            </p>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
