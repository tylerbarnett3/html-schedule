import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Modal } from "../../../components/Modal";
import { SegmentedControl, type SegmentedOption } from "../../../components/SegmentedControl";
import { Spinner } from "../../../components/Spinner";
import { useToast } from "../../../components/useToast";
import { useSetCustomHours, useSetStandardHours } from "../../../data/adminSchedule";
import { adminErrorMessage } from "../../../data/errors";
import { useHoursData } from "../../../data/hours";
import { useClosedDays } from "../../../data/schedule";
import { formatLongDate } from "../../../lib/dates";
import {
  dayHoursState,
  HOURS_CHOICE_LABELS,
  HOURS_CHOICES,
  planDayHoursSave,
  standardHoursOn,
  type DayHoursState,
  type Hours,
  type HoursChoice,
} from "../../../lib/hours";
import { isEmptyChange, type ScheduleChange } from "../../../lib/scheduleChange";
import { toClock } from "../../../lib/time";
import type { ISODate } from "../../../lib/types";
import { useUndo } from "../undo/useUndo";
import { keepFocusOnDay } from "./scheduleConfirms";
import {
  alreadyStandardText,
  dayHoursHint,
  hoursErrorMessage,
  hoursSaveText,
  SAVE_FALLBACK,
  sameHoursText,
} from "./scheduleText";
import { useMarkClosed } from "./useMarkClosed";
import "../../../components/Field.css";
import "./DayHoursDialog.css";

export interface DayHoursDialogProps {
  /** The day whose heading was clicked; null while the dialog is closed. */
  date: ISODate | null;
  onClose(): void;
}

const CHOICE_OPTIONS: readonly SegmentedOption<HoursChoice>[] = HOURS_CHOICES.map((value) => ({
  value,
  label: HOURS_CHOICE_LABELS[value],
}));

const HEADER_BUTTON = ".calendar-day-header-button";

function initialChoice(state: DayHoursState): HoursChoice {
  return state.kind === "closed" ? "closed" : state.kind === "custom" ? "custom" : "standard";
}

/**
 * One day's hours (REQUIREMENTS §2): standard hours, custom hours for that date only, or
 * closed (the shared close flow: same confirm, undo and toasts). Opened from a day heading
 * on the admin calendar. Each save is an undo step; a save that changes nothing just closes.
 */
export function DayHoursDialog({ date, onClose }: DayHoursDialogProps) {
  if (date === null) return null;
  return <DayHoursForm key={date} date={date} onClose={onClose} />;
}

function DayHoursForm({ date, onClose }: { date: ISODate; onClose(): void }) {
  const formId = useId();
  const dateLineId = useId();
  const openId = useId();
  const closeId = useId();

  // Until the admin picks or types something, the form follows the day's current state
  // (the data is normally loaded already: the calendar waits for it).
  const [picked, setPicked] = useState<HoursChoice | null>(null);
  const [typed, setTyped] = useState<{ open: string; close: string } | null>(null);
  const [error, setError] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const errorId = useRef(0);
  const mounted = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const closedQuery = useClosedDays();
  const hours = useHoursData();
  const setStandard = useSetStandardHours();
  const setCustom = useSetCustomHours();
  const markClosed = useMarkClosed();
  const undo = useUndo();
  const toast = useToast();

  const closedDays = closedQuery.data;
  const reads = [closedQuery, hours.weekly, hours.custom];
  // A read that failed stays failed (with Retry) until it loads: react-query reports it as
  // pending again while it is retried, and the Retry button must not vanish under focus.
  const failed = reads.some((read) => read.data === undefined && (read.isError || read.errorUpdateCount > 0));
  const loading = !failed && reads.some((read) => read.data === undefined);
  const retrying = failed && reads.some((read) => read.isFetching);
  const ready = !loading && !failed && closedDays !== undefined;

  const state: DayHoursState = closedDays ? dayHoursState(date, hours.data, closedDays) : { kind: "standard" };
  const standard = standardHoursOn(hours.data.sets, date);
  const choice = picked ?? initialChoice(state);
  // The custom hours if the day has them, else its standard hours, else blank.
  const prefill = state.kind === "custom" ? state.hours : standard;
  const times = typed ?? { open: toClock(prefill?.open) ?? "", close: toClock(prefill?.close) ?? "" };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // The form replaced the spinner or the load error (whose Retry button had focus): start on
  // the chosen segment, as when the dialog opens with the hours loaded.
  useEffect(() => {
    if (!ready) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      formRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
    }
  }, [ready]);

  const showError = (text: string) => {
    errorId.current += 1;
    setError({ id: errorId.current, text });
  };

  const setWorking = (value: boolean) => {
    busyRef.current = value;
    if (mounted.current) setBusy(value);
  };

  /** A failed write shows in the dialog, or as a toast once the dialog has gone. */
  const report = (message: string) => {
    if (mounted.current) showError(message);
    else toast.show(message, "error");
  };

  const finish = () => {
    if (mounted.current) onClose();
    // The Modal normally hands focus back to the heading button; this is the fallback.
    keepFocusOnDay(date, HEADER_BUTTON);
  };

  const changeChoice = (next: HoursChoice) => {
    setPicked(next);
    setError(null);
  };

  const changeTimes = (open: string, close: string) => {
    setTyped({ open, close });
    setError(null);
  };

  const retry = () => {
    if (retrying) return;
    for (const read of reads) void read.refetch();
  };

  /** An undo step and a success toast worded by what the change did (hoursSaveText). */
  const announce = (change: ScheduleChange, custom: Hours | null) => {
    const text = hoursSaveText([date], change, custom);
    undo.push({ label: text.label, change });
    toast.show(text.message, "success", { title: text.title });
  };

  const saveStandard = async () => {
    const change = await setStandard.mutateAsync({ dates: [date] });
    if (isEmptyChange(change)) toast.show(alreadyStandardText(1), "info");
    else announce(change, null);
  };

  const saveCustom = async (open: string, close: string) => {
    const change = await setCustom.mutateAsync({ dates: [date], open, close });
    if (isEmptyChange(change)) toast.show(sameHoursText(1), "info");
    else announce(change, { open, close });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current || !ready) return;
    setError(null);

    const plan = planDayHoursSave({ state, standard, choice, open: times.open, close: times.close });
    switch (plan.kind) {
      case "error":
        showError(plan.message);
        return;
      case "noop":
        finish();
        return;
      case "close":
        setWorking(true);
        try {
          const result = await markClosed([date], { isMounted: () => mounted.current, setWorking });
          if (result === "done") finish();
        } catch (caught) {
          report(adminErrorMessage(caught, SAVE_FALLBACK));
        } finally {
          setWorking(false);
        }
        return;
      case "standard":
      case "custom":
        setWorking(true);
        try {
          if (plan.kind === "standard") await saveStandard();
          else await saveCustom(plan.open, plan.close);
          finish();
        } catch (caught) {
          report(hoursErrorMessage(caught));
        } finally {
          setWorking(false);
        }
    }
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      {/* aria-disabled rather than disabled keeps focus on the button while saving. */}
      <Button
        type="submit"
        form={formId}
        variant="success"
        className={busy ? "day-hours-working" : undefined}
        aria-disabled={busy || !ready || undefined}
      >
        {busy ? (
          <>
            <Spinner size="sm" decorative className="day-hours-spinner" />
            Saving...
          </>
        ) : (
          "Save Changes"
        )}
      </Button>
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Day Hours"
      describedBy={dateLineId}
      size="md"
      footer={footer}
      className="day-hours-dialog"
    >
      <p id={dateLineId} className="day-hours-date">
        {formatLongDate(date)}
      </p>
      <form
        ref={formRef}
        id={formId}
        className="day-hours-form"
        onSubmit={(event) => void handleSubmit(event)}
        aria-busy={busy}
        noValidate
      >
        {loading ? (
          <div className="day-hours-status">
            <Spinner size="sm" label="Loading hours..." showLabel />
          </div>
        ) : failed ? (
          <div className="day-hours-status">
            {/* A new alert after each failed try, so a retry that fails again is announced. */}
            <p
              key={retrying ? "retrying" : "failed"}
              className="day-hours-error"
              role={retrying ? undefined : "alert"}
            >
              Couldn't load the business hours.
            </p>
            <Button
              variant="secondary"
              size="sm"
              className={retrying ? "day-hours-working" : undefined}
              aria-disabled={retrying || undefined}
              onClick={retry}
            >
              {retrying ? <Spinner size="sm" decorative /> : null}
              Retry
            </Button>
          </div>
        ) : (
          <>
            <SegmentedControl label="Hours" options={CHOICE_OPTIONS} value={choice} onChange={changeChoice} />
            {choice === "custom" ? (
              <div className="day-hours-times">
                <div className="field">
                  <label htmlFor={openId} className="field-label">
                    Open Time
                  </label>
                  <input
                    id={openId}
                    type="time"
                    className="field-control"
                    value={times.open}
                    onChange={(event) => changeTimes(event.target.value, times.close)}
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
                    value={times.close}
                    onChange={(event) => changeTimes(times.open, event.target.value)}
                  />
                </div>
              </div>
            ) : null}
            <p className="field-hint">{dayHoursHint(choice, state, standard)}</p>
          </>
        )}

        <div className="day-hours-messages">
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
