import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import { adminErrorMessage } from "../../../data/errors";
import { usePayrollPeriod, useSaveActuals } from "../../../data/payroll";
import { useClosedDays, useEmployees } from "../../../data/schedule";
import { rangeDates } from "../../../lib/dates";
import {
  buildPristineRows,
  findInvalidRow,
  newActualOnlyRow,
  overlapConfirmMessage,
  overlapWarnings,
  payPeriodFromParams,
  payrollClipboardText,
  payrollLines,
  progressLabel,
  rowDate,
  rowOwnerId,
  stepPayPeriod,
  summarize,
  summaryStats,
  type DraftRow,
} from "../../../lib/payroll";
import type { ISODate } from "../../../lib/types";
import { useAdminView } from "../useAdminView";
import { copyText } from "./copyText";
import { PayrollAddPanel, type AddWork, type AddWorkFields } from "./PayrollAddPanel";
import { PayrollDayTabs } from "./PayrollDayTabs";
import { PayrollOutput } from "./PayrollOutput";
import { PayrollPeriodBar } from "./PayrollPeriodBar";
import { payrollFieldId } from "./payrollFieldId";
import { PayrollRow } from "./PayrollRow";
import { PayrollSaveBar } from "./PayrollSaveBar";
import { useLeaveGuard } from "./useLeaveGuard";
import { usePayrollDraft } from "./usePayrollDraft";
import "./PayrollPage.css";

const NO_ROWS: readonly DraftRow[] = [];
const NO_CLOSED_DAYS: ReadonlySet<ISODate> = new Set();
const SAVE_ERROR = "There was an error saving your changes.";

/**
 * Payroll review: what each scheduled shift really was, plus work that was never on the
 * schedule, saved as shift_actuals. The period and day live in the URL (?start=&day=).
 */
export function PayrollPage() {
  const { today } = useAdminView();
  const confirm = useConfirm();
  const toast = useToast();
  const id = useId();

  const [searchParams, setSearchParams] = useSearchParams();
  const startParam = searchParams.get("start");
  const dayParam = searchParams.get("day");
  const { period, selected } = useMemo(
    () => payPeriodFromParams({ start: startParam, day: dayParam }, today),
    [startParam, dayParam, today],
  );

  const employeesQuery = useEmployees();
  const closedQuery = useClosedDays();
  const payrollQuery = usePayrollPeriod(period);
  const save = useSaveActuals();

  const employees = employeesQuery.data;
  const closedDays = closedQuery.data ?? NO_CLOSED_DAYS;
  // Placeholder data belongs to the previous period, so it isn't shown as this one's.
  const data = payrollQuery.isPlaceholderData ? undefined : payrollQuery.data;

  const pristine = useMemo(
    () => (data ? buildPristineRows({ period, shifts: data.shifts, actuals: data.actuals }) : NO_ROWS),
    [data, period],
  );
  const draft = usePayrollDraft(pristine, today);
  const saving = save.isPending;
  useLeaveGuard(draft.dirty);

  const [addOpen, setAddOpen] = useState(false);
  const [addFields, setAddFields] = useState<AddWorkFields>({ start: "09:00", end: "17:00", note: "" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const saveBar = useRef<HTMLDivElement>(null);
  const saveStatusId = `${id}-save-status`;
  // An element to focus once it's on screen (after a day switch renders it).
  const pendingFocus = useRef<string | null>(null);
  // Set when a save or a discard empties the draft, which turns off the save bar's buttons.
  const refocusSaveBar = useRef(false);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const element = document.getElementById(target);
    if (element) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  // Save and Cancel are disabled once the draft is clean, so focus on them would drop to the
  // page. Keep it in the bar, on its status text, unless it has already moved elsewhere.
  useEffect(() => {
    if (!refocusSaveBar.current || draft.dirty) return;
    refocusSaveBar.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && !saveBar.current?.contains(active)) return;
    document.getElementById(saveStatusId)?.focus();
  });

  // Put the defaults in the URL, so a reload or a shared link keeps the place (P2).
  useEffect(() => {
    if (startParam === period.start && dayParam === selected) return;
    setSearchParams({ start: period.start, day: selected }, { replace: true });
  }, [startParam, dayParam, period.start, selected, setSearchParams]);

  const showDay = useCallback(
    (start: ISODate, day: ISODate) => setSearchParams({ start, day }, { replace: true }),
    [setSearchParams],
  );

  const employeesById = useMemo(() => new Map((employees ?? []).map((e) => [e.id, e])), [employees]);
  const nameOf = useCallback(
    (employeeId: string) => employeesById.get(employeeId)?.name ?? "Unknown employee",
    [employeesById],
  );
  const activeEmployees = useMemo(() => (employees ?? []).filter((e) => !e.archived), [employees]);

  const summary = useMemo(() => summarize(pristine, today), [pristine, today]);
  const lines = useMemo(
    () => (data && employees ? payrollLines(employees, data.actuals, period) : []),
    [data, employees, period],
  );
  const outputText = payrollClipboardText(lines);
  const dates = useMemo(() => rangeDates(period), [period]);
  const dayRows = draft.rows.filter((row) => rowDate(row) === selected);

  const selectDay = (day: ISODate) => {
    setAddOpen(false);
    showDay(period.start, day);
  };

  const discardFor = async (title: string, message: string): Promise<boolean> =>
    !draft.dirty ||
    confirm({ title, message, confirmLabel: "Discard changes", cancelLabel: "Keep editing", tone: "danger" });

  /** A new period opens on its first day (P2). */
  const changePeriod = async (start: ISODate): Promise<boolean> => {
    const ok = await discardFor(
      "Change pay period?",
      "Change the date range and discard your unsaved payroll changes?",
    );
    if (!ok) return false;
    draft.clear();
    setAddOpen(false);
    setSaveError(null);
    showDay(start, start);
    return true;
  };

  const discard = async () => {
    if (!draft.dirty || saving) return;
    if (!(await discardFor("Discard changes?", "Discard the unsaved actual shift changes for this pay period?")))
      return;
    draft.clear();
    setSaveError(null);
    refocusSaveBar.current = true;
  };

  const saveActuals = async () => {
    if (!draft.dirty || saving) return;
    const invalid = findInvalidRow(draft.rows, nameOf);
    if (invalid) {
      setSaveError(invalid.message);
      if (invalid.date !== selected) selectDay(invalid.date);
      pendingFocus.current = payrollFieldId(id, invalid.row.key, invalid.field);
      return;
    }
    setSaveError(null);
    const warnings = overlapWarnings(draft.rows, nameOf);
    if (warnings.length > 0) {
      const go = await confirm({
        title: "Overlapping shifts",
        message: overlapConfirmMessage(warnings),
        confirmLabel: "Save anyway",
        cancelLabel: "Go back",
        tone: "default",
      });
      if (!go) return;
    }
    try {
      // Resolves after the refetch, so dropping the draft shows the saved rows at once.
      await save.mutateAsync(draft.plan);
      draft.clear();
      refocusSaveBar.current = true;
      toast.show("The published schedule is unchanged.", "success", { title: "Actuals saved" });
    } catch (error) {
      toast.show(adminErrorMessage(error, SAVE_ERROR), "error", { title: "Save Failed" });
    }
  };

  const copyHours = async () => {
    if (!outputText) {
      toast.show("Add an active employee before copying payroll hours.", "info", { title: "No active employees" });
      return;
    }
    try {
      await copyText(outputText);
      const n = lines.length;
      toast.show(`${n} employee${n === 1 ? "" : "s"} copied to your clipboard.`, "success", {
        title: "Payroll hours copied",
      });
    } catch {
      toast.show("Your browser denied clipboard access. Try again after allowing clipboard permissions.", "error", {
        title: "Could not copy payroll hours",
      });
    }
  };

  const closeAddPanel = () => {
    setAddOpen(false);
    addButton.current?.focus();
  };

  const addWork = (work: AddWork) => {
    draft.add(
      newActualOnlyRow({
        id: crypto.randomUUID(),
        employeeId: work.employeeId,
        date: work.date,
        start: work.start,
        end: work.end,
        note: work.note,
      }),
    );
    setSaveError(null);
    setAddFields({ start: work.start, end: work.end, note: "" });
    closeAddPanel();
    if (work.date !== selected) showDay(period.start, work.date);
  };

  const { apply, reset, remove } = draft;
  const onAction = useCallback<typeof apply>(
    (key, action) => {
      setSaveError(null);
      apply(key, action);
    },
    [apply],
  );

  // Removing a row (or resetting one that was never saved) takes the focused button with it.
  const keepFocusInList = useCallback(() => {
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) panel.current?.focus();
    });
  }, []);
  const onReset = useCallback(
    (key: string) => {
      setSaveError(null);
      reset(key);
      keepFocusInList();
    },
    [reset, keepFocusInList],
  );
  const onRemove = useCallback(
    (key: string) => {
      setSaveError(null);
      remove(key);
      keepFocusInList();
    },
    [remove, keepFocusInList],
  );

  const failed = [employeesQuery, closedQuery, payrollQuery].filter((q) => q.isError && q.data === undefined);
  const outdated = [employeesQuery, closedQuery, payrollQuery].filter((q) => q.isError && q.data !== undefined);
  const ready = data !== undefined && employees !== undefined && closedQuery.data !== undefined;

  const tabId = (date: ISODate) => `${id}-tab-${date}`;
  const panelId = `${id}-panel`;
  const addPanelId = `${id}-add`;

  let body;
  if (failed.length > 0) {
    body = (
      <div className="payroll-status">
        <p className="payroll-error">Unable to load payroll. Please refresh the page.</p>
        <Button variant="primary" onClick={() => failed.forEach((query) => void query.refetch())}>
          Retry
        </Button>
      </div>
    );
  } else if (!ready) {
    body = (
      <div className="payroll-status">
        <Spinner size="lg" label="Loading payroll..." showLabel />
      </div>
    );
  } else {
    body = (
      <>
        <dl className="payroll-summary">
          {summaryStats(summary).map((stat) => (
            <div key={stat.label} className="payroll-stat">
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
        <PayrollOutput text={outputText} stale={draft.dirty || saving} onCopy={() => void copyHours()} />
        <PayrollDayTabs
          dates={dates}
          selected={selected}
          pristine={pristine}
          today={today}
          closedDays={closedDays}
          panelId={panelId}
          tabId={tabId}
          onSelect={selectDay}
        />
        <div className="payroll-command-bar">
          {/* A plain button: <Button> doesn't pass a ref through. */}
          <button
            ref={addButton}
            type="button"
            className="btn btn-secondary btn-md"
            aria-expanded={addOpen}
            aria-controls={addPanelId}
            disabled={saving}
            onClick={() => setAddOpen((open) => !open)}
          >
            Add unscheduled shift
          </button>
        </div>
        {addOpen ? (
          <PayrollAddPanel
            id={addPanelId}
            employees={activeEmployees}
            period={period}
            today={today}
            initialDate={selected}
            fields={addFields}
            onFieldsChange={setAddFields}
            onAdd={addWork}
            onCancel={closeAddPanel}
          />
        ) : null}
        <div
          ref={panel}
          id={panelId}
          role="tabpanel"
          aria-labelledby={tabId(selected)}
          className="payroll-list"
          tabIndex={dayRows.length === 0 ? 0 : -1}
        >
          {dayRows.length === 0 ? (
            <div className="payroll-empty">
              <strong>{closedDays.has(selected) ? "Closed for business" : "No shifts to review"}</strong>
            </div>
          ) : (
            dayRows.map((row) => (
              <PayrollRow
                key={row.key}
                row={row}
                pristine={draft.pristineByKey.get(row.key)}
                ownerName={nameOf(rowOwnerId(row))}
                employees={employees}
                today={today}
                idPrefix={id}
                locked={saving}
                onAction={onAction}
                onReset={onReset}
                onRemove={onRemove}
              />
            ))
          )}
        </div>
      </>
    );
  }

  return (
    <main className="admin-area payroll" aria-labelledby={`${id}-title`}>
      <div className="payroll-heading">
        <h2 id={`${id}-title`} className="payroll-title">
          Payroll
        </h2>
        <Link to="/admin" className="btn btn-secondary btn-md payroll-back">
          Back to schedule
        </Link>
      </div>
      {/* One grid cell, so the empty status region below adds no gap. */}
      <div className="payroll-period-wrap">
        <PayrollPeriodBar
          period={period}
          progress={ready ? progressLabel(summary) : ""}
          disabled={saving}
          onStep={(direction) => void changePeriod(stepPayPeriod(period, direction).start)}
          onStartChange={changePeriod}
        />
        {/* Stays mounted so the warning is announced when it appears. */}
        <div role="status">
          {failed.length === 0 && outdated.length > 0 ? (
            <div className="payroll-outdated">
              <p>Couldn't refresh payroll, so it may be out of date.</p>
              <Button size="sm" onClick={() => outdated.forEach((query) => void query.refetch())}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {body}
      <PayrollSaveBar
        ref={saveBar}
        statusId={saveStatusId}
        changeCount={draft.plan.changeCount}
        saving={saving}
        error={saveError}
        onDiscard={() => void discard()}
        onSave={() => void saveActuals()}
      />
    </main>
  );
}
