import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Spinner";
import { useConfirm } from "../../components/useConfirm";
import { useToast } from "../../components/useToast";
import {
  hourLogErrorMessage,
  hourLogFailure,
  useLoggableShifts,
  useLogHours,
  useRemoveHourLog,
} from "../../data/hourLogs";
import { formatLongDate } from "../../lib/dates";
import {
  HOUR_LOG_NOTE_MAX_LENGTH,
  hourLogDraft,
  hourLogDraftError,
  hourLogUnchanged,
  loggableShiftDate,
  loggableShiftScheduled,
  loggableShiftStatus,
  overnightHint,
  overnightQuestion,
  type HourLogDraft,
  type LoggableShift,
} from "../../lib/hourLogs";
import type { Employee } from "../../lib/types";
import "../../components/Field.css";
import "./LogHoursDialog.css";

export interface LogHoursDialogProps {
  open: boolean;
  onClose(): void;
  employee: Employee;
}

// `id` changes on every message so a repeated message is announced again.
type Notice = { id: number; text: string };

/**
 * "Log My Hours": the employee picks one of their shifts that has ended and logs the hours
 * they actually worked, for the admin to see in payroll. Until the admin reviews the shift
 * they can change or remove what they logged. Each open starts on the list of shifts.
 */
export function LogHoursDialog({ open, ...props }: LogHoursDialogProps) {
  if (!open) return null;
  return <LogHoursForm {...props} />;
}

function LogHoursForm({ employee, onClose }: Omit<LogHoursDialogProps, "open">) {
  const formId = useId();
  const startId = useId();
  const endId = useId();
  const noteId = useId();
  const introId = useId();
  const chosenId = useId();

  // The shift being logged (as it was when picked); null shows the list.
  const [chosen, setChosen] = useState<LoggableShift | null>(null);
  const chosenRef = useRef<LoggableShift | null>(null);
  const [draft, setDraft] = useState<HourLogDraft>({ start: "", end: "", note: "" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const busyRef = useRef(false);
  const noticeId = useRef(0);
  const mounted = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  // The shift whose button gets focus when the list is back on screen.
  const focusShift = useRef<string | null>(null);
  const focusedList = useRef(false);

  const shiftsQuery = useLoggableShifts(employee.id);
  const logHours = useLogHours();
  const removeLog = useRemoveHourLog();
  const confirm = useConfirm();
  const toast = useToast();

  const shifts = shiftsQuery.data;
  const loadFailed = shifts === undefined && shiftsQuery.isError;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView({ block: "nearest" });
  }, [notice]);

  // Back on the list: focus the shift just logged (or the first one, if it has left the list).
  // On the first load the list replaces the spinner, so focus moves from Close to the list.
  useEffect(() => {
    if (chosen !== null || shifts === undefined) return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-shift]") ?? [])];
    const target = focusShift.current;
    if (target !== null) {
      focusShift.current = null;
      const intro = document.getElementById(introId);
      (buttons.find((button) => button.dataset.shift === target) ?? buttons[0] ?? intro)?.focus();
    } else if (!focusedList.current) {
      const active = document.activeElement;
      const onClose = active instanceof HTMLElement && active.closest(".modal-footer") !== null;
      if (active === null || active === document.body || onClose) buttons[0]?.focus();
    }
    focusedList.current = true;
  }, [chosen, shifts, introId]);

  useEffect(() => {
    chosenRef.current = chosen;
    if (chosen !== null) startRef.current?.focus();
  }, [chosen]);

  const showNotice = (text: string) => {
    noticeId.current += 1;
    setNotice({ id: noticeId.current, text });
  };

  const setWorking = (value: "save" | "remove" | null) => {
    busyRef.current = value !== null;
    if (mounted.current) setBusy(value);
  };

  const choose = (shift: LoggableShift) => {
    if (busyRef.current) return;
    setChosen(shift);
    setDraft(hourLogDraft(shift));
    setNotice(null);
  };

  /** Back to the list from this shift's form, unless another shift's form is open by now. */
  const leaveForm = (shiftId: string) => {
    if (chosenRef.current?.shiftId !== shiftId) return;
    focusShift.current = shiftId;
    setChosen(null);
    setNotice(null);
  };

  // Back waits for a save or remove to finish, so its result lands on this shift's form.
  const goBack = () => {
    if (busyRef.current || chosen === null) return;
    leaveForm(chosen.shiftId);
  };

  const change = (values: Partial<HourLogDraft>) => {
    setDraft((current) => ({ ...current, ...values }));
    setNotice(null);
  };

  /** A failed write shows in the form, or as a toast once the dialog has gone. */
  const report = (shift: LoggableShift, error: unknown, action: "save" | "remove") => {
    const text = hourLogErrorMessage(error, action);
    if (!mounted.current) {
      toast.show(text, "error");
      return;
    }
    // The shift has left the list (or never was in it): say why, on the list.
    if (hourLogFailure(error) !== "other") {
      toast.show(text, "info");
      leaveForm(shift.shiftId);
      return;
    }
    if (chosenRef.current?.shiftId === shift.shiftId) showNotice(text);
  };

  const done = (shift: LoggableShift, text: string) => {
    toast.show(text, "success");
    if (mounted.current) leaveForm(shift.shiftId);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current || chosen === null) return;
    setNotice(null);
    const problem = hourLogDraftError(draft);
    if (problem !== null) {
      showNotice(problem);
      return;
    }
    if (hourLogUnchanged(chosen, draft)) {
      leaveForm(chosen.shiftId);
      return;
    }
    const shift = chosen;
    const values = draft;
    const question = overnightQuestion(shift, values);
    if (question !== null) {
      const save = await confirm({
        title: "Finished the next day?",
        message: question,
        confirmLabel: "Save anyway",
        cancelLabel: "Go back",
      });
      if (!save || !mounted.current || busyRef.current) return;
    }
    setWorking("save");
    try {
      await logHours.mutateAsync({ shiftId: shift.shiftId, ...values });
      done(shift, `${shift.log ? "Updated your hours" : "Logged your hours"} for ${loggableShiftDate(shift)}.`);
    } catch (error) {
      report(shift, error, "save");
    } finally {
      setWorking(null);
    }
  };

  const handleRemove = async () => {
    if (busyRef.current || chosen === null) return;
    setNotice(null);
    const shift = chosen;
    const when = loggableShiftDate(shift);
    const remove = await confirm({
      title: "Remove logged hours?",
      message: `Remove the hours you logged for ${when}?`,
      confirmLabel: "Remove",
      cancelLabel: "Keep",
      tone: "danger",
    });
    if (!remove || !mounted.current || busyRef.current) return;
    setWorking("remove");
    try {
      const removed = await removeLog.mutateAsync({ shiftId: shift.shiftId });
      done(shift, removed ? `Removed the hours you logged for ${when}.` : `Nothing was logged for ${when}.`);
    } catch (error) {
      report(shift, error, "remove");
    } finally {
      setWorking(null);
    }
  };

  const retry = () => void shiftsQuery.refetch();

  const list =
    shifts !== undefined ? (
      shifts.length === 0 ? (
        <p className="log-hours-empty">No shifts to log right now.</p>
      ) : (
        <ul ref={listRef} className="log-hours-list" aria-label="Shifts to log">
          {shifts.map((shift) => (
            <li key={shift.shiftId}>
              <button
                type="button"
                className={shift.log ? "log-hours-shift is-logged" : "log-hours-shift"}
                data-shift={shift.shiftId}
                onClick={() => choose(shift)}
              >
                <span className="log-hours-shift-date">{loggableShiftDate(shift)}</span>
                <span className="log-hours-shift-scheduled">{loggableShiftScheduled(shift)}</span>
                <span className="log-hours-shift-status">{loggableShiftStatus(shift)}</span>
              </button>
            </li>
          ))}
        </ul>
      )
    ) : loadFailed ? (
      <div className="log-hours-status" role="alert">
        <p className="log-hours-error">Couldn't load your shifts.</p>
        <Button variant="secondary" size="sm" onClick={retry}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="log-hours-status">
        <Spinner size="sm" label="Loading your shifts..." showLabel />
      </div>
    );

  const listFooter = (
    <Button variant="secondary" onClick={onClose}>
      Close
    </Button>
  );

  const formFooter = chosen ? (
    <>
      <Button variant="secondary" aria-disabled={busy !== null || undefined} onClick={goBack}>
        Back
      </Button>
      {chosen.log ? (
        <Button variant="danger" aria-disabled={busy !== null || undefined} onClick={() => void handleRemove()}>
          {busy === "remove" ? (
            <>
              <Spinner size="sm" decorative className="log-hours-spinner" />
              Removing...
            </>
          ) : (
            "Remove"
          )}
        </Button>
      ) : null}
      {/* aria-disabled rather than disabled keeps focus on the button while saving. */}
      <Button type="submit" form={formId} variant="primary" aria-disabled={busy !== null || undefined}>
        {busy === "save" ? (
          <>
            <Spinner size="sm" decorative className="log-hours-spinner" />
            Saving...
          </>
        ) : (
          "Save Hours"
        )}
      </Button>
    </>
  ) : null;

  // One dialog for both steps, so switching between them keeps it open (and focus inside it).
  return (
    <Modal
      open
      onClose={onClose}
      title="Log My Hours"
      describedBy={chosen ? chosenId : introId}
      footer={chosen ? formFooter : listFooter}
      className="log-hours-dialog"
    >
      {chosen === null ? (
        <>
          <p id={introId} className="log-hours-intro" tabIndex={-1}>
            Pick a shift to log the hours you actually worked. A shift shows here once it ends, and you can
            change what you logged until your manager reviews it.
          </p>
          {list}
        </>
      ) : (
        <form
          id={formId}
          className="log-hours-form"
          onSubmit={(event) => void handleSubmit(event)}
          aria-busy={busy !== null}
          noValidate
        >
          <div id={chosenId} className="log-hours-chosen">
            <p className="log-hours-chosen-date">{formatLongDate(chosen.date)}</p>
            <p className="log-hours-chosen-scheduled">{loggableShiftScheduled(chosen)}</p>
          </div>

          <div className="log-hours-times">
            <div className="field">
              <label htmlFor={startId} className="field-label">
                Started
              </label>
              <input
                ref={startRef}
                id={startId}
                type="time"
                className="field-control"
                value={draft.start}
                onChange={(event) => change({ start: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={endId} className="field-label">
                Finished
              </label>
              <input
                id={endId}
                type="time"
                className="field-control"
                value={draft.end}
                onChange={(event) => change({ end: event.target.value })}
              />
            </div>
          </div>
          {overnightHint(draft) ? <p className="field-hint log-hours-overnight">{overnightHint(draft)}</p> : null}

          <div className="field">
            <label htmlFor={noteId} className="field-label">
              Note (optional)
            </label>
            <input
              id={noteId}
              type="text"
              className="field-control"
              maxLength={HOUR_LOG_NOTE_MAX_LENGTH}
              value={draft.note}
              onChange={(event) => change({ note: event.target.value })}
            />
          </div>

          <div className="log-hours-messages">
            {notice ? (
              <p key={notice.id} ref={noticeRef} className="field-error" role="alert">
                {notice.text}
              </p>
            ) : null}
          </div>
        </form>
      )}
    </Modal>
  );
}
