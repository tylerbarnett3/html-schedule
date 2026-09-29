import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Spinner";
import { useConfirm } from "../../components/useConfirm";
import { useToast } from "../../components/useToast";
import {
  fetchHighVolumeRows,
  requestErrorMessage,
  useRequestAvailability,
  useRequestTimeOff,
} from "../../data/requests";
import { useClosedDays, useMyRequests } from "../../data/schedule";
import { addMonths, formatDateList, formatShortDate, monthOf, type MonthKey } from "../../lib/dates";
import { DAY_PERIODS, isDayPeriod, PERIOD_OPTION_LABELS } from "../../lib/periods";
import {
  hasAvailabilityConflict,
  hasTimeOffConflict,
  highVolumeDates,
  highVolumeWarning,
  isPickerDateDisabled,
  MAX_MONTHS_AHEAD,
  requestResultMessage,
  toggleDate,
} from "../../lib/requests";
import type { DayPeriod, Employee, ISODate } from "../../lib/types";
import { DatePicker, type DatePickerDay } from "./DatePicker";
import "./RequestDialog.css";

export type RequestDialogKind = "time-off" | "availability";

export interface RequestDialogProps {
  kind: RequestDialogKind;
  open: boolean;
  onClose(): void;
  employee: Employee;
  today: ISODate;
}

const COPY = {
  "time-off": {
    title: "Request Time Off",
    periodLabel: "Time Off Needed",
    conflictTitle: "Already requested",
    conflictError: "One or more selected dates already has a conflicting time-off request for that part of the day.",
  },
  availability: {
    title: "Request Availability",
    periodLabel: "Available For",
    conflictTitle: "Availability already marked",
    conflictError: "One or more selected dates already has overlapping availability.",
  },
} as const;

const CLOSED_TITLE = "Closed for business";
const NO_CLOSED_DAYS: ReadonlySet<ISODate> = new Set();

// `id` changes on every message so a repeated message is announced again.
type Notice = { id: number; tone: "error" | "info"; text: string };

/**
 * Time-off and availability request dialog. Each open starts fresh (full day, no dates,
 * current month) because the form is remounted whenever the dialog opens.
 */
export function RequestDialog({ open, ...props }: RequestDialogProps) {
  if (!open) return null;
  return <RequestDialogForm key={props.kind} {...props} />;
}

function RequestDialogForm({ kind, onClose, employee, today }: Omit<RequestDialogProps, "open">) {
  const copy = COPY[kind];
  const formId = useId();
  const periodId = useId();
  const selectedLabelId = useId();

  const [period, setPeriod] = useState<DayPeriod>("full-day");
  const [selected, setSelected] = useState<ISODate[]>([]);
  const [month, setMonth] = useState<MonthKey>(() => monthOf(today));
  const [removedNote, setRemovedNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const noticeId = useRef(0);
  const mounted = useRef(false);

  const noticeRef = useRef<HTMLParagraphElement>(null);
  const selectedBoxRef = useRef<HTMLDivElement>(null);
  const chipListRef = useRef<HTMLUListElement>(null);
  const chipToFocus = useRef<number | null>(null);

  const confirm = useConfirm();
  const toast = useToast();
  const myRequests = useMyRequests(employee.id, today);
  const closedDays = useClosedDays();
  const requestTimeOff = useRequestTimeOff();
  const requestAvailability = useRequestAvailability();
  const submitMutation = kind === "time-off" ? requestTimeOff.mutateAsync : requestAvailability.mutateAsync;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Bring a new message into view; on phones the form scrolls inside the sheet.
  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView({ block: "nearest" });
  }, [notice]);

  // After a chip's × removes it, keep focus in the chip list instead of losing it.
  useEffect(() => {
    const index = chipToFocus.current;
    if (index === null) return;
    chipToFocus.current = null;
    const buttons = chipListRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    const target = buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : selectedBoxRef.current;
    target?.focus();
  }, [selected]);

  const closed = closedDays.data ?? NO_CLOSED_DAYS;
  const mine = myRequests.data;
  const ready = mine !== undefined && closedDays.data !== undefined;
  const loadFailed = !ready && (myRequests.isError || closedDays.isError);

  const hasConflict = (d: ISODate, p: DayPeriod): boolean =>
    kind === "time-off"
      ? hasTimeOffConflict(d, p, mine?.timeOff ?? [], closed)
      : hasAvailabilityConflict(d, p, mine?.availability ?? [], closed);

  const getDay = (d: ISODate): DatePickerDay => {
    const conflict = hasConflict(d, period);
    const disabled = isPickerDateDisabled(d, today, closed, conflict);
    if (closed.has(d)) return { disabled, title: CLOSED_TITLE, marker: "closed" };
    if (conflict) return { disabled, title: copy.conflictTitle, marker: "requested" };
    return { disabled };
  };

  // "Today" can move on past midnight; keep the month inside the picker's window.
  const firstMonth = monthOf(today);
  const lastMonth = addMonths(firstMonth, MAX_MONTHS_AHEAD);
  const shownMonth = month < firstMonth ? firstMonth : month > lastMonth ? lastMonth : month;

  const showNotice = (tone: Notice["tone"], text: string) => {
    noticeId.current += 1;
    setNotice({ id: noticeId.current, tone, text });
  };

  const clearMessages = () => {
    setRemovedNote(null);
    setNotice(null);
  };

  const toggle = (d: ISODate) => {
    if (busyRef.current) return;
    setSelected((current) => toggleDate(current, d));
    clearMessages();
  };

  const removeDate = (d: ISODate) => {
    if (busyRef.current) return;
    chipToFocus.current = selected.indexOf(d);
    setSelected(selected.filter((s) => s !== d));
    clearMessages();
  };

  // Dates that clash with the new part of the day are dropped rather than left
  // selected-but-disabled (the old page kept them and then refused to submit).
  const changePeriod = (value: string) => {
    if (busyRef.current || !isDayPeriod(value)) return;
    const dropped = selected.filter((d) => hasConflict(d, value));
    setPeriod(value);
    setSelected(selected.filter((d) => !hasConflict(d, value)));
    setNotice(null);
    setRemovedNote(
      dropped.length > 0
        ? `Removed dates that already have a request for that part of the day: ${formatDateList(dropped)}`
        : null,
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    setNotice(null);

    if (selected.length === 0) {
      showNotice("error", "Please select at least one date");
      return;
    }
    // Closed days count as conflicts too, as on the old page.
    if (selected.some((d) => hasConflict(d, period))) {
      showNotice("error", copy.conflictError);
      return;
    }

    const dates = selected;
    busyRef.current = true;
    setBusy(true);
    try {
      if (kind === "time-off") {
        // Counted fresh so the warning reflects requests made since the page loaded.
        const busyDates = highVolumeDates(dates, await fetchHighVolumeRows(dates));
        // Cancel, Escape and × stay live during the check; closing then abandons the submit.
        if (!mounted.current) return;
        const warning = highVolumeWarning(busyDates);
        if (warning !== null) {
          // Not busy while asking, so focus can return to the Submit button afterwards.
          setBusy(false);
          const submitAnyway = await confirm({
            title: busyDates.length > 1 ? "Busy days" : "Busy day",
            message: warning,
            confirmLabel: "Submit anyway",
            cancelLabel: "Go back",
          });
          if (!submitAnyway || !mounted.current) return;
          setBusy(true);
        }
      }

      const result = await submitMutation({ dates, period });
      const outcome = requestResultMessage(kind, result);
      if (outcome === null) return;
      if (outcome.closeDialog) {
        toast.show(outcome.text, "success");
        if (mounted.current) onClose();
      } else if (mounted.current) {
        showNotice("info", outcome.text);
      } else {
        toast.show(outcome.text, "info");
      }
    } catch (error) {
      const text = requestErrorMessage(error, kind);
      if (mounted.current) showNotice("error", text);
      else toast.show(text, "error");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      {/* aria-disabled rather than disabled keeps focus on the button while submitting. */}
      <Button type="submit" form={formId} variant="primary" aria-disabled={busy || undefined}>
        {busy ? (
          <>
            <Spinner size="sm" decorative className="request-dialog-spinner" />
            Submitting...
          </>
        ) : (
          "Submit Request"
        )}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={copy.title} footer={footer} className="request-dialog">
      <form id={formId} className="request-dialog-form" onSubmit={handleSubmit} aria-busy={busy} noValidate>
        <p className="request-dialog-requester">
          Requesting as <strong>{employee.name}</strong>
        </p>

        <div className="request-dialog-field">
          <label htmlFor={periodId} className="request-dialog-label">
            {copy.periodLabel}
          </label>
          <select
            id={periodId}
            className="request-dialog-select"
            value={period}
            onChange={(event) => changePeriod(event.target.value)}
          >
            {DAY_PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_OPTION_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        {ready ? (
          <DatePicker
            month={shownMonth}
            onMonthChange={setMonth}
            today={today}
            selected={selected}
            onToggle={toggle}
            getDay={getDay}
          />
        ) : loadFailed ? (
          <div className="request-dialog-load-error" role="alert">
            <p>Unable to load your existing requests. Please try again.</p>
            <Button
              size="sm"
              onClick={() => {
                void myRequests.refetch();
                void closedDays.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : (
          <div className="request-dialog-loading">
            <Spinner label="Loading dates..." showLabel />
          </div>
        )}

        <div
          ref={selectedBoxRef}
          className="request-dialog-selected"
          role="group"
          aria-labelledby={selectedLabelId}
          tabIndex={-1}
        >
          <p id={selectedLabelId} className="request-dialog-label">
            Selected Dates:
          </p>
          {selected.length === 0 ? (
            <p className="request-dialog-empty">No dates selected</p>
          ) : (
            <ul ref={chipListRef} className="request-dialog-chips">
              {selected.map((d) => {
                const label = formatShortDate(d);
                const conflict = ready && hasConflict(d, period);
                return (
                  <li
                    key={d}
                    className={conflict ? "request-dialog-chip is-conflict" : "request-dialog-chip"}
                    title={conflict ? (closed.has(d) ? CLOSED_TITLE : copy.conflictTitle) : undefined}
                  >
                    <span>{label}</span>
                    <button
                      type="button"
                      className="request-dialog-chip-remove"
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

        {/* Live regions stay mounted so their messages are announced when they appear. */}
        <div className="request-dialog-messages">
          <div aria-live="polite">
            {removedNote ? <p className="request-dialog-note">{removedNote}</p> : null}
          </div>
          <div aria-live="assertive">
            {notice ? (
              <p
                key={notice.id}
                ref={noticeRef}
                className={`request-dialog-notice request-dialog-notice-${notice.tone}`}
              >
                {notice.text}
              </p>
            ) : null}
          </div>
        </div>
      </form>
    </Modal>
  );
}
