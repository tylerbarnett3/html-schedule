import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Checkbox } from "../../../components/Checkbox";
import { Modal } from "../../../components/Modal";
import { SegmentedControl, type SegmentedOption } from "../../../components/SegmentedControl";
import { Spinner } from "../../../components/Spinner";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import {
  fetchEditingRows,
  useAddDaysOff,
  useAddShifts,
  useSetCustomHours,
  useSetStandardHours,
} from "../../../data/adminSchedule";
import { useHoursData } from "../../../data/hours";
import { useClosedDays, useEmployees } from "../../../data/schedule";
import { formatChipDate, monthOf, type MonthKey } from "../../../lib/dates";
import {
  HOURS_CHOICE_LABELS,
  HOURS_CHOICES,
  specialHoursOn,
  standardHoursOn,
  type Hours,
  type HoursChoice,
} from "../../../lib/hours";
import { DAY_PERIODS, formatPeriod } from "../../../lib/periods";
import { toggleDate } from "../../../lib/requests";
import { isEmptyChange, type ScheduleChange } from "../../../lib/scheduleChange";
import {
  ADD_ITEM_TITLES,
  ADD_ITEM_TYPE_LABELS,
  addItemSaveLabel,
  addPickerDay,
  planAddSave,
  QUICK_SHIFTS,
  withoutClosedDates,
  type AddItemType,
} from "../../../lib/scheduleEditing";
import { formatShiftTime, toClock } from "../../../lib/time";
import type { DayPeriod, Employee, ISODate } from "../../../lib/types";
import { DatePicker } from "../../schedule/DatePicker";
import { useAdminView } from "../useAdminView";
import { useUndo } from "../undo/useUndo";
import { confirmShiftDeletion, keepFocusOnDay } from "./scheduleConfirms";
import {
  addDaysOffLabel,
  addHoursHint,
  addShiftsLabel,
  alreadyStandardText,
  daysOffAddedText,
  hoursErrorMessage,
  hoursSaveText,
  sameHoursText,
  scheduleError,
  shiftsAddedText,
} from "./scheduleText";
import { useMarkClosed } from "./useMarkClosed";
import "../../../components/Field.css";
import "./AddItemDialog.css";

export interface AddItemDialogProps {
  /** The day whose "+ Add" was clicked; null while the dialog is closed. */
  date: ISODate | null;
  onClose(): void;
}

const TYPE_OPTIONS: readonly SegmentedOption<AddItemType>[] = (["shift", "day-off", "hours"] as const).map(
  (value) => ({ value, label: ADD_ITEM_TYPE_LABELS[value] }),
);
const HOURS_OPTIONS: readonly SegmentedOption<HoursChoice>[] = HOURS_CHOICES.map((value) => ({
  value,
  label: HOURS_CHOICE_LABELS[value],
}));
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
 * "+ Add" on a calendar day: shifts, days off, or hours (standard, custom or closed), for
 * several dates and employees at once (D4). Each open starts as a Shift on the clicked date
 * with nobody picked, because the form is remounted whenever the dialog opens.
 */
export function AddItemDialog({ date, onClose }: AddItemDialogProps) {
  if (date === null) return null;
  return <AddItemForm key={date} date={date} onClose={onClose} />;
}

function AddItemForm({ date, onClose }: { date: ISODate; onClose(): void }) {
  const formId = useId();
  const startId = useId();
  const endId = useId();
  const openId = useId();
  const closeId = useId();
  const datesLabelId = useId();

  const [type, setType] = useState<AddItemType>("shift");
  const [dates, setDates] = useState<ISODate[]>([date]);
  const [month, setMonth] = useState<MonthKey>(() => monthOf(date));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [startTime, setStartTime] = useState(lastTimes.start);
  const [endTime, setEndTime] = useState(lastTimes.end);
  const [period, setPeriod] = useState<DayPeriod>("full-day");
  const [hoursChoice, setHoursChoice] = useState<HoursChoice>("custom");
  // Null until typed: the custom times follow the clicked day's current hours until then.
  const [typedHours, setTypedHours] = useState<{ open: string; close: string } | null>(null);
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
  const hours = useHoursData();
  const addShifts = useAddShifts();
  const addDaysOff = useAddDaysOff();
  const setStandard = useSetStandardHours();
  const setCustom = useSetCustomHours();
  const markClosed = useMarkClosed();
  const undo = useUndo();
  const confirm = useConfirm();
  const toast = useToast();

  const employees = employeesQuery.data ?? NO_EMPLOYEES;
  const closedDays = closedQuery.data ?? NO_CLOSED_DAYS;
  // New work goes to active employees only (C17, E10).
  const active = useMemo(() => employees.filter((e) => !e.archived), [employees]);
  const pickedIds = active.filter((e) => picked.has(e.id)).map((e) => e.id);
  // Custom hours start from the clicked day's hours: its special hours, else its standard
  // hours, else blank. They are separate from the Shift times remembered between opens.
  const clickedHours = specialHoursOn(date, hours.data, closedDays) ?? standardHoursOn(hours.data.sets, date);
  const hoursTimes = typedHours ?? {
    open: toClock(clickedHours?.open) ?? "",
    close: toClock(clickedHours?.close) ?? "",
  };

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
    // Only Hours can pick closed days; the others drop them (the old page did the same).
    if (next !== "hours") setDates((current) => withoutClosedDates(current, closedDays));
    setError(null);
  };

  const changeHoursChoice = (next: HoursChoice) => {
    setHoursChoice(next);
    setError(null);
  };

  const changeHoursTimes = (open: string, close: string) => {
    setTypedHours({ open, close });
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

  /** A failed write shows in the dialog, or as a toast once the dialog has gone. */
  const report = (message: string) => {
    if (mounted.current) showError(message);
    else toast.show(message, "error");
  };

  const closeDates = async (closing: ISODate[]) => {
    try {
      const result = await markClosed(closing, { isMounted: () => mounted.current, setWorking });
      if (result !== "done") return;
      close();
      // The clicked day's "+ Add" is replaced by "Reopen day"; keep keyboard focus there.
      if (closing.includes(date)) keepFocusOnDay(date, ".admin-day-reopen");
    } catch (caught) {
      report(scheduleError(caught, { adding: true, employees }).message);
    }
  };

  /** An undo step and a success toast worded by what the change did (hoursSaveText). */
  const announceHours = (hoursDates: ISODate[], change: ScheduleChange, custom: Hours | null) => {
    const text = hoursSaveText(hoursDates, change, custom);
    undo.push({ label: text.label, change });
    toast.show(text.message, "success", { title: text.title });
  };

  const saveStandardHours = async (hoursDates: ISODate[]) => {
    try {
      const change = await setStandard.mutateAsync({ dates: hoursDates });
      if (isEmptyChange(change)) toast.show(alreadyStandardText(hoursDates.length), "info");
      else announceHours(hoursDates, change, null);
      close();
    } catch (caught) {
      report(hoursErrorMessage(caught));
    }
  };

  const saveCustomHours = async (hoursDates: ISODate[], open: string, closeTime: string) => {
    try {
      const change = await setCustom.mutateAsync({ dates: hoursDates, open, close: closeTime });
      if (isEmptyChange(change)) toast.show(sameHoursText(hoursDates.length), "info");
      else announceHours(hoursDates, change, { open, close: closeTime });
      close();
    } catch (caught) {
      report(hoursErrorMessage(caught));
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    setError(null);

    const input = {
      type,
      dates,
      employeeIds: pickedIds,
      startTime,
      endTime,
      period,
      hoursChoice,
      openTime: hoursTimes.open,
      closeTime: hoursTimes.close,
      closedDays,
      employees,
    };
    // The quick checks (dates, hours, employees, closed days, times) need no rows.
    const first = planAddSave({ ...input, shifts: [], timeOff: [] });
    if (first.kind === "error") {
      showError(first.message);
      return;
    }

    setWorking(true);
    try {
      // Hours need no rows; each path reports its own errors.
      if (first.kind === "close-days") {
        await closeDates(first.dates);
        return;
      }
      if (first.kind === "standard-hours") {
        await saveStandardHours(first.dates);
        return;
      }
      if (first.kind === "custom-hours") {
        await saveCustomHours(first.dates, first.open, first.close);
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
          addItemSaveLabel(type, hoursChoice)
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

          {type === "hours" ? (
            <>
              <SegmentedControl
                label="Hours"
                options={HOURS_OPTIONS}
                value={hoursChoice}
                onChange={changeHoursChoice}
              />
              {hoursChoice === "custom" ? (
                <div className="add-item-times">
                  <div className="field">
                    <label htmlFor={openId} className="field-label">
                      Open Time
                    </label>
                    <input
                      id={openId}
                      type="time"
                      className="field-control"
                      value={hoursTimes.open}
                      onChange={(event) => changeHoursTimes(event.target.value, hoursTimes.close)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={closeId} className="field-label">
                      Close Time
                    </label>
                    <input
                      id={closeId}
                      type="time"
                      className="field-control"
                      value={hoursTimes.close}
                      onChange={(event) => changeHoursTimes(hoursTimes.open, event.target.value)}
                    />
                  </div>
                </div>
              ) : null}
              <p className="add-item-hint">{addHoursHint(hoursChoice)}</p>
            </>
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
