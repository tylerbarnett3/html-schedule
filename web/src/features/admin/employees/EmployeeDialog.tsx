import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Modal } from "../../../components/Modal";
import { Spinner } from "../../../components/Spinner";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import {
  employeeErrorMessage,
  fetchEmployeeRecordCounts,
  useDeleteEmployee,
  useEmployeeRates,
  useSaveEmployee,
} from "../../../data/employees";
import { useEmployees } from "../../../data/schedule";
import { activeEmployees, validateEmployeeName } from "../../../lib/employees";
import { pickNewEmployeeColor } from "../../../lib/employeePalette";
import {
  checkRateDrafts,
  parseNewEmployeeRate,
  rateErrorMessage,
  toRateDrafts,
  type EmployeeRate,
  type RateDraft,
  type RateInput,
} from "../../../lib/rates";
import type { Employee } from "../../../lib/types";
import { ColorPicker } from "./ColorPicker";
import { makeRateKey, rateErrorFields, rateFieldId } from "./employeeForm";
import { RateEditor } from "./RateEditor";
import "../../../components/Field.css";
import "./EmployeeDialog.css";

export type EmployeeDialogTarget = { mode: "add" } | { mode: "edit"; employeeId: string };

export interface EmployeeDialogProps {
  target: EmployeeDialogTarget | null;
  onClose(): void;
  /** Called just before closing after the employee was deleted (their row is gone). */
  onDeleted?(employeeId: string): void;
}

/** Add Employee and Edit Employee (EM §2-3). Each opening starts from a fresh form. */
export function EmployeeDialog({ target, onClose, onDeleted }: EmployeeDialogProps) {
  if (!target) return null;
  return (
    <EmployeeDialogContent
      key={target.mode === "add" ? "add" : target.employeeId}
      target={target}
      onClose={onClose}
      onDeleted={onDeleted}
    />
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** E5 confirm text, with the counts of what the delete cascades to. */
function deleteMessage(name: string, counts: { shifts: number; timeOff: number; payroll: number }): string {
  return (
    `This permanently deletes ${name} and their ${plural(counts.shifts, "shift", "shifts")}, ` +
    `${plural(counts.timeOff, "time-off entry", "time-off entries")} and ` +
    `${plural(counts.payroll, "payroll record", "payroll records")}. It can't be undone.` +
    "\n\nTo keep their history, archive them instead."
  );
}

type FormError = { message: string; fieldIds: string[] };

// A partly typed date (or a number input holding "1e") reads as "" but isn't empty.
function findUnfinishedInput(form: HTMLFormElement | null): HTMLInputElement | null {
  if (!form) return null;
  return Array.from(form.querySelectorAll("input")).find((input) => input.validity.badInput) ?? null;
}

function unfinishedMessage(input: HTMLInputElement): string {
  return input.type === "date"
    ? "Finish typing the date, or clear it."
    : "Enter the hourly rate as a number, for example 15.50.";
}

function EmployeeDialogContent({ target, onClose, onDeleted }: EmployeeDialogProps & { target: EmployeeDialogTarget }) {
  const id = useId();
  const formId = `${id}-form`;
  const nameId = `${id}-name`;
  const rateId = `${id}-rate`;
  const errorId = `${id}-error`;
  const ratesPrefix = `${id}-rates`;
  const formRef = useRef<HTMLFormElement>(null);

  const employeesQuery = useEmployees();
  const ratesQuery = useEmployeeRates();
  const employees = employeesQuery.data;
  const employee: Employee | undefined =
    target.mode === "edit" ? employees?.find((e) => e.id === target.employeeId) : undefined;
  const editing = target.mode === "edit";

  const save = useSaveEmployee();
  const remove = useDeleteEmployee();
  const confirm = useConfirm();
  const toast = useToast();

  const [name, setName] = useState(() => employee?.name ?? "");
  const [color, setColor] = useState(() =>
    employee ? employee.color : pickNewEmployeeColor(activeEmployees(employees ?? []).map((e) => e.color)),
  );
  const [newRate, setNewRate] = useState("");
  const [drafts, setDrafts] = useState<RateDraft[] | null>(() =>
    editing && ratesQuery.data ? ratesFor(ratesQuery.data, target.employeeId) : null,
  );
  const [error, setError] = useState<FormError | null>(null);
  // "counting" reads what a delete would remove; the button stays focusable meanwhile so
  // focus can come back to it when the confirm is cancelled.
  const [deleteStage, setDeleteStage] = useState<"idle" | "counting" | "deleting">("idle");

  // The rates may still be loading when Edit opens; start from them once they arrive.
  if (target.mode === "edit" && drafts === null && ratesQuery.data) {
    setDrafts(ratesFor(ratesQuery.data, target.employeeId));
  }

  const deleting = deleteStage === "deleting";
  const busy = save.isPending || deleting;
  const invalidIds = new Set(error?.fieldIds ?? []);

  // A disabled Save button drops focus while saving; after an error with no field to
  // point at, the message takes focus instead.
  const focusMessage = useRef(false);
  useLayoutEffect(() => {
    if (!focusMessage.current) return;
    focusMessage.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) document.getElementById(errorId)?.focus();
  });

  const fail = (message: string, fieldIds: string[] = []) => {
    setError({ message, fieldIds });
    const first = fieldIds[0];
    if (first) document.getElementById(first)?.focus();
    else focusMessage.current = true;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const unfinished = findUnfinishedInput(formRef.current);
    if (unfinished) {
      fail(unfinishedMessage(unfinished), [unfinished.id]);
      return;
    }
    const nameError = validateEmployeeName(name, employees ?? [], employee?.id ?? null);
    if (nameError) {
      fail(nameError, [nameId]);
      return;
    }
    const trimmed = name.trim();

    let rates: RateInput[];
    if (target.mode === "add") {
      const parsed = parseNewEmployeeRate(newRate);
      if (!parsed.ok) {
        fail(parsed.message, [rateId]);
        return;
      }
      rates = parsed.rate === null ? [] : [{ id: null, rate: parsed.rate, start_date: null, end_date: null }];
    } else {
      if (drafts === null) return;
      // "New rate starting on…" is still open with something typed in it.
      const pending = Array.from(formRef.current?.querySelectorAll("[data-new-rate] input") ?? []).find(
        (input) => input instanceof HTMLInputElement && input.value !== "",
      );
      if (pending) {
        fail("Add the new rate or cancel it before saving.", [pending.id]);
        return;
      }
      const checked = checkRateDrafts(drafts);
      if (!checked.ok) {
        const fieldIds = rateErrorFields(checked.error).flatMap(([index, field]) => {
          const draft = drafts[index];
          return draft ? [rateFieldId(ratesPrefix, draft.key, field)] : [];
        });
        fail(rateErrorMessage(checked.error), fieldIds);
        return;
      }
      rates = checked.rates;
    }

    setError(null);
    try {
      await save.mutateAsync({ id: employee?.id ?? null, name: trimmed, color, rates });
      toast.show(editing ? `Saved ${trimmed}.` : `Added ${trimmed}.`, "success");
      onClose();
    } catch (saveError) {
      fail(employeeErrorMessage(saveError, "save", trimmed));
    }
  };

  const handleDelete = async () => {
    if (!employee || busy || deleteStage !== "idle") return;
    setError(null);
    setDeleteStage("counting");
    try {
      const counts = await fetchEmployeeRecordCounts(employee.id);
      const confirmed = await confirm({
        title: `Delete ${employee.name}?`,
        message: deleteMessage(employee.name, counts),
        confirmLabel: "Delete employee",
        cancelLabel: "Keep employee",
        tone: "danger",
      });
      if (!confirmed) return;
      setDeleteStage("deleting");
      const { deleted } = await remove.mutateAsync({ id: employee.id });
      if (deleted) toast.show(`Deleted ${employee.name}.`, "success");
      else toast.show("This employee was already removed.", "info");
      onDeleted?.(employee.id);
      onClose();
    } catch (deleteError) {
      fail(employeeErrorMessage(deleteError, "delete"));
    } finally {
      setDeleteStage("idle");
    }
  };

  // Deleted elsewhere (another tab) since the list was drawn.
  if (editing && employees && !employee) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Edit Employee"
        size="sm"
        footer={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <p className="employee-dialog-message">This employee was already removed.</p>
      </Modal>
    );
  }

  const ratesFailed = editing && drafts === null && ratesQuery.isError;

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={editing ? "Edit Employee" : "Add Employee"}
      size="md"
      className="employee-dialog"
      footer={
        editing ? (
          <>
            <Button variant="danger" className="employee-dialog-delete" onClick={handleDelete} disabled={busy}>
              {deleting ? "Deleting…" : "Delete Employee"}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="success" type="submit" form={formId} disabled={busy || drafts === null}>
              {save.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="success" type="submit" form={formId} disabled={busy}>
              {save.isPending ? "Saving…" : "Add Employee"}
            </Button>
          </>
        )
      }
    >
      <form id={formId} ref={formRef} className="employee-dialog-form" noValidate onSubmit={handleSubmit}>
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            className="field-control"
            type="text"
            autoComplete="off"
            placeholder="Enter name"
            value={name}
            data-autofocus=""
            aria-invalid={invalidIds.has(nameId) || undefined}
            aria-describedby={invalidIds.has(nameId) ? errorId : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        {editing ? null : (
          <div className="field">
            <label className="field-label" htmlFor={rateId}>
              Hourly Rate (optional)
            </label>
            <input
              id={rateId}
              className="field-control"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="15.00 (leave empty if no rate)"
              value={newRate}
              aria-invalid={invalidIds.has(rateId) || undefined}
              aria-describedby={invalidIds.has(rateId) ? errorId : undefined}
              onChange={(event) => setNewRate(event.target.value)}
            />
          </div>
        )}

        <ColorPicker value={color} onChange={setColor} previewName={name} />

        {editing ? (
          <section className="employee-dialog-rates" aria-labelledby={`${id}-rates-title`}>
            <h3 id={`${id}-rates-title`} className="employee-dialog-rates-title">
              Hourly Rates
            </h3>
            {drafts !== null ? (
              <RateEditor
                drafts={drafts}
                onChange={setDrafts}
                idPrefix={ratesPrefix}
                invalidIds={invalidIds}
              />
            ) : ratesFailed ? (
              <div className="employee-dialog-rates-error">
                <p className="field-error" role="alert">
                  Couldn't load the pay rates, so they can't be edited yet.
                </p>
                <Button variant="secondary" size="sm" onClick={() => void ratesQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : (
              <div className="employee-dialog-rates-loading">
                <Spinner size="sm" label="Loading pay rates..." />
              </div>
            )}
          </section>
        ) : null}

        {error ? (
          <p id={errorId} className="field-error employee-dialog-error" role="alert" tabIndex={-1}>
            {error.message}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function ratesFor(rates: readonly EmployeeRate[], employeeId: string): RateDraft[] {
  return toRateDrafts(
    rates.filter((r) => r.employee_id === employeeId),
    makeRateKey,
  );
}
