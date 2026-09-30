import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Modal } from "../../../components/Modal";
import { SegmentedControl, type SegmentedOption } from "../../../components/SegmentedControl";
import { Spinner } from "../../../components/Spinner";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import {
  fetchEditingRows,
  useConvertToDayOff,
  useConvertToShift,
  useDeleteScheduleItems,
  useUpdateDayOff,
  useUpdateShift,
} from "../../../data/adminSchedule";
import { useClosedDays, useEmployees } from "../../../data/schedule";
import { formatShortDate, timestampToBusinessDate } from "../../../lib/dates";
import { DAY_PERIODS, formatPeriod } from "../../../lib/periods";
import { isEmptyChange } from "../../../lib/scheduleChange";
import {
  editFormFor,
  planEditSave,
  type EditForm,
  type EditTarget,
  type EditWrite,
} from "../../../lib/scheduleEditing";
import { timeToMinutes } from "../../../lib/time";
import type { DayPeriod, Employee, ISODate } from "../../../lib/types";
import { useUndo } from "../undo/useUndo";
import { confirmPayrollHours, confirmShiftDeletion, keepFocusOnDay } from "./scheduleConfirms";
import { ALREADY_REMOVED, failureTone, scheduleError, withRemovedShifts } from "./scheduleText";
import "../../../components/Field.css";
import "./EditItemDialog.css";

export interface EditItemDialogProps {
  /** The shift or approved day off whose card was clicked; null while closed. */
  target: EditTarget | null;
  onClose(): void;
}

type ItemType = EditForm["type"];

const TYPE_OPTIONS: readonly SegmentedOption<ItemType>[] = [
  { value: "shift", label: "Shift" },
  { value: "day-off", label: "Day Off" },
];
const PERIOD_OPTIONS: readonly SegmentedOption<DayPeriod>[] = DAY_PERIODS.map((value) => ({
  value,
  label: formatPeriod(value),
}));
const NO_CLOSED_DAYS: ReadonlySet<ISODate> = new Set();
const NO_EMPLOYEES: readonly Employee[] = [];

/**
 * One Edit dialog for a shift or a day off (C7). The Type control changes a shift into an
 * assigned day off and back. A day off an employee requested (C8) keeps its employee and
 * stays a day off; only its date and period change, and "Remove" revokes it.
 */
export function EditItemDialog({ target, onClose }: EditItemDialogProps) {
  if (target === null) return null;
  return <EditItemForm key={`${target.kind}-${target.row.id}`} target={target} onClose={onClose} />;
}

function employeeName(employees: readonly Employee[], id: string): string {
  return employees.find((e) => e.id === id)?.name ?? "Unknown";
}

function itemDate(target: EditTarget): ISODate {
  return target.kind === "shift" ? target.row.shift_date : target.row.off_date;
}

/** Only the date changed: the payroll confirm says the hours move with the shift. */
function isDateOnlyMove(target: EditTarget, write: EditWrite): boolean {
  if (target.kind !== "shift" || write.op !== "update-shift") return false;
  const { row } = target;
  return (
    write.employeeId === row.employee_id &&
    write.date !== row.shift_date &&
    timeToMinutes(write.startTime) === timeToMinutes(row.start_time) &&
    timeToMinutes(write.endTime) === timeToMinutes(row.end_time)
  );
}

function EditItemForm({ target, onClose }: { target: EditTarget; onClose(): void }) {
  const formId = useId();
  const employeeId = useId();
  const dateId = useId();
  const startId = useId();
  const endId = useId();

  const [form, setForm] = useState<EditForm>(() => editFormFor(target));
  const [error, setError] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const busyRef = useRef(false);
  const errorId = useRef(0);
  const mounted = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const employeesQuery = useEmployees();
  const closedQuery = useClosedDays();
  const updateShift = useUpdateShift();
  const updateDayOff = useUpdateDayOff();
  const convertToDayOff = useConvertToDayOff();
  const convertToShift = useConvertToShift();
  const deleteItems = useDeleteScheduleItems();
  const undo = useUndo();
  const confirm = useConfirm();
  const toast = useToast();

  const employees = employeesQuery.data ?? NO_EMPLOYEES;
  const closedDays = closedQuery.data ?? NO_CLOSED_DAYS;
  const requested = target.kind === "day-off" && target.row.source === "request";
  const ownerName = employeeName(employees, target.row.employee_id);
  const title = target.kind === "shift" ? "Edit Shift" : requested ? "Approved Time Off" : "Edit Day Off";

  // Active employees, plus whoever the item belongs to now even if archived (C17).
  const choices = useMemo(
    () => employees.filter((e) => !e.archived || e.id === target.row.employee_id),
    [employees, target.row.employee_id],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const update = (patch: Partial<EditForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const showError = (text: string) => {
    errorId.current += 1;
    setError({ id: errorId.current, text });
  };

  const setWorking = (value: "save" | "delete" | null) => {
    busyRef.current = value !== null;
    if (mounted.current) setBusy(value);
  };

  /** Shows a failed write in the dialog; a row that is gone closes it instead. */
  const report = (caught: unknown, write: EditWrite | null) => {
    const requestLocked =
      write?.op === "convert-to-shift"
        ? `This time off was requested by ${ownerName}, so it can't be changed into a shift.`
        : `This time off was requested by ${ownerName}, so it can't be moved to another employee.`;
    const failure = scheduleError(caught, { adding: false, employees, requestLocked });
    if (failure.code === "not_found" || !mounted.current) {
      // A removed row is info (the page has refreshed); anything else is an error.
      toast.show(failure.message, failureTone(failure));
      if (mounted.current) onClose();
      return;
    }
    showError(failure.message);
  };

  const runWrite = async (write: EditWrite) => {
    switch (write.op) {
      case "update-shift": {
        const { id, employeeId, date, startTime, endTime } = write;
        const change = await updateShift.mutateAsync({ id, employeeId, date, startTime, endTime });
        undo.push({ label: "Edit shift", change });
        toast.show("Shift updated", "success");
        return;
      }
      case "update-day-off": {
        const { id, employeeId, date, period, deleteShiftIds } = write;
        const change = await updateDayOff.mutateAsync({ id, employeeId, date, period, deleteShiftIds });
        undo.push({ label: "Edit day off", change });
        toast.show(withRemovedShifts("Day off updated", change.deleted.shifts.length), "success", {
          title: "Day Off Updated",
        });
        return;
      }
      case "convert-to-day-off": {
        const { shiftId, employeeId, date, period, deleteShiftIds } = write;
        const change = await convertToDayOff.mutateAsync({ shiftId, employeeId, date, period, deleteShiftIds });
        undo.push({ label: "Change shift to day off", change });
        // §7.1 gives Convert no removed-shifts suffix; the confirm already listed them.
        toast.show("Changed to a day off", "success");
        return;
      }
      case "convert-to-shift": {
        const { timeOffId, employeeId, date, startTime, endTime } = write;
        const change = await convertToShift.mutateAsync({ timeOffId, employeeId, date, startTime, endTime });
        undo.push({ label: "Change day off to shift", change });
        toast.show("Changed to a shift", "success");
      }
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    setError(null);

    const ctx = { closedDays, employees };
    // The checks that need no rows first (fields, request rules, closed day, no change).
    const first = planEditSave(target, form, { ...ctx, shifts: [], timeOff: [] });
    if (first.kind === "error") {
      showError(first.message);
      return;
    }
    if (first.kind === "noop") {
      onClose();
      return;
    }

    let write: EditWrite | null = null;
    setWorking("save");
    try {
      // Conflicts are checked against rows read now, not the calendar cache (C15).
      const rows = await fetchEditingRows({ employeeIds: [form.employeeId], dates: [form.date] });
      if (!mounted.current) return;
      const plan = planEditSave(target, form, { ...ctx, ...rows });
      if (plan.kind === "error") {
        showError(plan.message);
        return;
      }
      if (plan.kind === "noop") {
        onClose();
        return;
      }
      write = plan.write;

      // Payroll hours on the shift being changed (C10), then the shifts a day off deletes.
      if (target.kind === "shift") {
        setWorking(null);
        const kind = write.op === "convert-to-day-off" ? "convert" : isDateOnlyMove(target, write) ? "move" : "edit";
        const ok = await confirmPayrollHours(confirm, target.row.id, kind, write.date);
        if (!ok || !mounted.current) return;
        setWorking("save");
      }
      if (plan.confirmMessage !== null && (write.op === "update-day-off" || write.op === "convert-to-day-off")) {
        setWorking(null);
        const ok = await confirmShiftDeletion(confirm, plan.confirmMessage, write.deleteShiftIds);
        if (!ok || !mounted.current) return;
        setWorking("save");
      }

      await runWrite(write);
      onClose();
      keepFocusOnDay(write.date);
    } catch (caught) {
      report(caught, write);
    } finally {
      setWorking(null);
    }
  };

  const handleDelete = async () => {
    if (busyRef.current) return;
    setError(null);
    const isShift = target.kind === "shift";
    const ok = await confirm(
      isShift
        ? {
            title: "Delete shift?",
            message: "Are you sure you want to delete this shift?",
            confirmLabel: "Delete",
            cancelLabel: "Cancel",
            tone: "danger",
          }
        : requested
          ? {
              title: "Remove approved time off?",
              message: `${ownerName} asked for this time off. Removing it deletes the approval, and they aren't notified.`,
              confirmLabel: "Remove",
              cancelLabel: "Keep",
              tone: "danger",
            }
          : {
              title: "Delete day off?",
              message: "Are you sure you want to delete this day off?",
              confirmLabel: "Delete",
              cancelLabel: "Cancel",
              tone: "danger",
            },
    );
    if (!ok || !mounted.current) return;

    try {
      // Asked after "Delete shift?", and only for a shift with payroll hours (C10).
      if (isShift && !(await confirmPayrollHours(confirm, target.row.id, "delete"))) return;
      if (!mounted.current) return;
      setWorking("delete");
      const change = await deleteItems.mutateAsync(
        isShift ? { shiftIds: [target.row.id] } : { timeOffIds: [target.row.id] },
      );
      if (isEmptyChange(change)) {
        // Someone else removed it first; the calendar has been refreshed.
        toast.show(ALREADY_REMOVED, "info");
      } else {
        undo.push({ label: isShift ? "Delete shift" : requested ? "Remove time off" : "Delete day off", change });
        toast.show(isShift ? "Shift deleted" : requested ? "Time off removed" : "Day off deleted", "success");
      }
      onClose();
      keepFocusOnDay(itemDate(target));
    } catch (caught) {
      report(caught, null);
    } finally {
      setWorking(null);
    }
  };

  const requestedOn = requested ? timestampToBusinessDate(target.row.requested_at) : null;

  const footer = (
    <>
      <Button
        variant="danger"
        className="edit-item-delete"
        aria-disabled={busy !== null || undefined}
        onClick={() => void handleDelete()}
      >
        {busy === "delete" ? (
          <>
            <Spinner size="sm" decorative className="edit-item-spinner" />
            {requested ? "Removing..." : "Deleting..."}
          </>
        ) : requested ? (
          "Remove"
        ) : (
          "Delete"
        )}
      </Button>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form={formId} variant="success" aria-disabled={busy !== null || undefined}>
        {busy === "save" ? (
          <>
            <Spinner size="sm" decorative className="edit-item-spinner" />
            Saving...
          </>
        ) : (
          "Save Changes"
        )}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={title} footer={footer} className="edit-item-dialog">
      <form
        id={formId}
        className="edit-item-form"
        onSubmit={(event) => void handleSubmit(event)}
        aria-busy={busy !== null}
        noValidate
      >
        {requested ? (
          <p className="edit-item-requested">
            Requested by <strong>{ownerName}</strong>
            {requestedOn ? ` on ${formatShortDate(requestedOn)}` : null}
          </p>
        ) : (
          <SegmentedControl
            label="Type"
            options={TYPE_OPTIONS}
            value={form.type}
            onChange={(type) => update({ type })}
          />
        )}

        <div className="field">
          <label htmlFor={employeeId} className="field-label">
            Employee
          </label>
          <select
            id={employeeId}
            className="field-control"
            value={form.employeeId}
            disabled={requested}
            onChange={(event) => update({ employeeId: event.target.value })}
          >
            {form.employeeId === "" || !choices.some((e) => e.id === form.employeeId) ? (
              <option value="">Select employee</option>
            ) : null}
            {choices.map((e) => (
              <option key={e.id} value={e.id}>
                {e.archived ? `${e.name} (archived)` : e.name}
              </option>
            ))}
          </select>
          {requested ? (
            <p className="field-hint">A requested day off stays with the employee who asked for it.</p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={dateId} className="field-label">
            Date
          </label>
          <input
            id={dateId}
            type="date"
            className="field-control"
            value={form.date}
            onChange={(event) => update({ date: event.target.value })}
          />
        </div>

        {form.type === "shift" ? (
          <div className="edit-item-times">
            <div className="field">
              <label htmlFor={startId} className="field-label">
                Start Time
              </label>
              <input
                id={startId}
                type="time"
                className="field-control"
                value={form.startTime}
                onChange={(event) => update({ startTime: event.target.value })}
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
                value={form.endTime}
                onChange={(event) => update({ endTime: event.target.value })}
              />
            </div>
          </div>
        ) : (
          <SegmentedControl
            label="Day Off Type"
            options={PERIOD_OPTIONS}
            value={form.period}
            onChange={(period) => update({ period })}
          />
        )}

        <div className="edit-item-messages">
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
