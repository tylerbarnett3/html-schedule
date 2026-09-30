import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "../../../components/Button";
import { Modal } from "../../../components/Modal";
import { Spinner } from "../../../components/Spinner";
import { useToast } from "../../../components/useToast";
import { useSaveWeeklyHours } from "../../../data/hours";
import { addDays, WEEKDAY_LONG } from "../../../lib/dates";
import {
  addHoursChange,
  editedCurrentHours,
  emptyHoursDraft,
  hoursDraftSubtitle,
  hoursDraftTitle,
  isEarlierDraft,
  planWeeklyHoursSave,
  startEditsToday,
  toHoursDrafts,
  WEEKDAYS_MONDAY_FIRST,
  type HoursDraft,
  type HoursSet,
  type Weekday,
  type WeeklyHoursPayload,
} from "../../../lib/hours";
import type { ISODate } from "../../../lib/types";
import {
  hoursInputId,
  makeHoursDraftKey,
  NEW_HOURS_INTRO,
  NEW_HOURS_PENDING,
  NEW_HOURS_TOGGLE,
  removeChangeSuffix,
  WEEKLY_EARLIER_HINT,
  WEEKLY_HOURS_SAVED,
  WEEKLY_HOURS_TITLE,
  WEEKLY_INTRO,
  WEEKLY_INTRO_FIRST,
  weeklyHoursErrorMessage,
} from "./hoursText";
import { ApplyHoursDialog, type ApplyHoursChoice } from "./ApplyHoursDialog";
import "../../../components/Field.css";
import "./WeeklyHoursDialog.css";

export interface WeeklyHoursDialogProps {
  open: boolean;
  sets: readonly HoursSet[];
  today: ISODate;
  onClose(): void;
}

/**
 * The weekly business hours editor (§4.6): the current set, upcoming changes, "New hours
 * starting on…", and the earlier sets, which can be corrected. Save/Cancel; not an undo
 * step. Each opening starts fresh from the sets it was opened with.
 */
export function WeeklyHoursDialog({ open, sets, today, onClose }: WeeklyHoursDialogProps) {
  if (!open) return null;
  return <WeeklyHoursForm sets={sets} today={today} onClose={onClose} />;
}

type TimeField = "open" | "close";
type Message = { id: number; text: string };
type FormError = Message & { inputId: string | null };

const TIME_FIELDS: readonly TimeField[] = ["open", "close"];

function WeeklyHoursForm({ sets: openedSets, today: openedToday, onClose }: Omit<WeeklyHoursDialogProps, "open">) {
  // What the editor opened with: a refetch while it is open doesn't change what it plans against.
  const [{ sets, today }] = useState(() => ({ sets: openedSets, today: openedToday }));
  const firstTime = sets.length === 0;
  const [drafts, setDrafts] = useState<HoursDraft[]>(() =>
    firstTime ? [emptyHoursDraft()] : toHoursDrafts(sets, today),
  );
  const [panelOpen, setPanelOpen] = useState(false);
  // Earlier sets (the first set and past changes) start folded to their title.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [newStart, setNewStart] = useState("");
  const [panelError, setPanelError] = useState<Message | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  // Save found edited current hours and is asking how they apply (ApplyHoursDialog).
  const [asking, setAsking] = useState<{ since: ISODate | null; payload: WeeklyHoursPayload } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(false);
  const messageCount = useRef(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const startInputRef = useRef<HTMLInputElement>(null);

  const save = useSaveWeeklyHours();
  const toast = useToast();

  const id = useId();
  const formId = `${id}-form`;
  const errorId = `${id}-error`;
  const panelId = `${id}-new-hours`;
  const startId = `${id}-new-start`;
  const panelErrorId = `${id}-new-error`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Focus moves wait for the render that adds or removes what they point at.
  const pendingFocus = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const focusLater = (target: () => HTMLElement | null | undefined) => {
    pendingFocus.current = target;
  };
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    target()?.focus();
  });

  const nextMessageId = () => {
    messageCount.current += 1;
    return messageCount.current;
  };

  /** Shows the message (a new element each time, so it is announced again) and focuses its input or itself. */
  const fail = (text: string, inputId: string | null) => {
    setError({ id: nextMessageId(), text, inputId });
    focusLater(() => document.getElementById(inputId ?? errorId));
  };

  const setWorking = (busy: boolean) => {
    savingRef.current = busy;
    if (mounted.current) setSaving(busy);
  };

  const setTime = (key: string, weekday: Weekday, field: TimeField, value: string) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === key
          ? { ...draft, days: { ...draft.days, [weekday]: { ...draft.days[weekday], [field]: value } } }
          : draft,
      ),
    );
    setError(null);
  };

  const toggleDraft = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const removeDraft = (key: string) => {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
    setError(null);
    focusLater(() => toggleRef.current);
  };

  const openPanel = () => {
    setPanelOpen(true);
    focusLater(() => startInputRef.current);
  };

  const resetPanel = () => {
    setPanelOpen(false);
    setNewStart("");
    setPanelError(null);
  };

  const closePanel = () => {
    resetPanel();
    if (error?.inputId === startId) setError(null);
    focusLater(() => toggleRef.current);
  };

  const addChange = () => {
    const result = addHoursChange(drafts, newStart, makeHoursDraftKey);
    if (!result.ok) {
      setPanelError({ id: nextMessageId(), text: result.message });
      return;
    }
    setDrafts(result.drafts);
    resetPanel();
    setError(null);
    focusLater(() => document.getElementById(hoursInputId(id, result.added.key, 1, "open")));
  };

  // Enter in "Starts on" adds the change instead of saving the whole dialog.
  const handleStartKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addChange();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;

    // A date typed (even partly) into "New hours starting on…" that was never added.
    const start = startInputRef.current;
    if (panelOpen && start && (start.value !== "" || start.validity.badInput)) {
      fail(NEW_HOURS_PENDING, start.id);
      return;
    }

    // A partly typed time reads as "" in its draft, so it is checked as blank.
    const plan = planWeeklyHoursSave(drafts, sets, today);
    if (plan.kind === "error") {
      // Unfold an earlier set so its input can take focus.
      setExpanded((current) => (current.has(plan.draftKey) ? current : new Set(current).add(plan.draftKey)));
      fail(plan.message, hoursInputId(id, plan.draftKey, plan.weekday, plan.field));
      return;
    }
    if (plan.kind === "noop") {
      onClose();
      return;
    }

    const edited = editedCurrentHours(drafts, sets, today);
    if (edited) {
      setAsking({ since: edited.since, payload: plan.payload });
      return;
    }
    await saveHours(plan.payload);
  };

  const applyEdits = (choice: ApplyHoursChoice) => {
    const pending = asking;
    setAsking(null);
    if (!pending) return;
    if (choice === "correct") {
      void saveHours(pending.payload);
      return;
    }
    const moved = startEditsToday(drafts, sets, today, makeHoursDraftKey);
    if (!moved.ok) {
      fail(moved.message, null);
      return;
    }
    const plan = planWeeklyHoursSave(moved.drafts, sets, today);
    if (plan.kind === "error") {
      fail(plan.message, null);
      return;
    }
    if (plan.kind === "noop") onClose();
    else void saveHours(plan.payload);
  };

  const saveHours = async (payload: WeeklyHoursPayload) => {
    if (savingRef.current) return;
    setError(null);
    setWorking(true);
    try {
      await save.mutateAsync(payload);
      toast.show(WEEKLY_HOURS_SAVED, "success");
      onClose();
    } catch (caught) {
      const text = weeklyHoursErrorMessage(caught);
      if (mounted.current) fail(text, null);
      else toast.show(text, "error");
    } finally {
      setWorking(false);
    }
  };

  const currentStart = drafts[0]?.startsOn ?? null;
  const entries = drafts.map((draft, index) => ({ draft, index, earlier: isEarlierDraft(drafts, index) }));
  const earlier = entries.filter((entry) => entry.earlier);

  const renderDraft = (draft: HoursDraft, index: number, kind: "removable" | "fixed" | "collapsible") => {
    const title = hoursDraftTitle(drafts, index);
    const subtitle = hoursDraftSubtitle(drafts, index);
    const collapsible = kind === "collapsible";
    const open = !collapsible || expanded.has(draft.key);
    const gridId = `${id}-${draft.key}-days`;
    return (
      <fieldset
        key={draft.key}
        className={collapsible ? "weekly-hours-set weekly-hours-set-collapsible" : "weekly-hours-set"}
        data-draft={draft.key}
      >
        {collapsible ? (
          <legend className="weekly-hours-legend weekly-hours-legend-toggle">
            <h3 className="weekly-hours-title">
              <button
                type="button"
                className="weekly-hours-expand"
                aria-expanded={open}
                aria-controls={gridId}
                onClick={() => toggleDraft(draft.key)}
              >
                <span className="weekly-hours-expand-text">
                  <span>{title}</span>
                  {subtitle ? <span className="weekly-hours-since">{subtitle}</span> : null}
                </span>
                <span className="weekly-hours-chevron" aria-hidden="true">
                  ▼
                </span>
              </button>
            </h3>
          </legend>
        ) : (
          <legend className="weekly-hours-legend">
            <h3 className="weekly-hours-title">{title}</h3>
            {subtitle ? <span className="weekly-hours-since">{subtitle}</span> : null}
          </legend>
        )}
        {kind === "removable" ? (
          <Button variant="ghost" size="sm" className="weekly-hours-remove" onClick={() => removeDraft(draft.key)}>
            Remove Change
            <span className="visually-hidden">{removeChangeSuffix(draft.startsOn)}</span>
          </Button>
        ) : null}
        <div id={gridId} className="weekly-hours-grid" hidden={!open}>
          <div className="weekly-hours-head" aria-hidden="true">
            <span className="weekly-hours-head-day" />
            <span>Open</span>
            <span>Close</span>
          </div>
          {WEEKDAYS_MONDAY_FIRST.map((weekday) => {
            const day = WEEKDAY_LONG[weekday];
            return (
              <div key={weekday} className="weekly-hours-row">
                <span className="weekly-hours-day">{day}</span>
                {TIME_FIELDS.map((field) => {
                  const inputId = hoursInputId(id, draft.key, weekday, field);
                  const invalid = error?.inputId === inputId;
                  return (
                    <Fragment key={field}>
                      <label className="visually-hidden" htmlFor={inputId}>
                        {`${day} ${field} time`}
                      </label>
                      <input
                        id={inputId}
                        type="time"
                        className="field-control weekly-hours-input"
                        value={draft.days[weekday][field]}
                        data-autofocus={index === 0 && weekday === 1 && field === "open" ? "" : undefined}
                        aria-invalid={invalid || undefined}
                        aria-describedby={invalid ? errorId : undefined}
                        onChange={(event) => setTime(draft.key, weekday, field, event.target.value)}
                      />
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      </fieldset>
    );
  };

  const startInvalid = error?.inputId === startId;

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form={formId} variant="success" aria-disabled={saving || undefined}>
        {saving ? (
          <>
            <Spinner size="sm" decorative className="weekly-hours-spinner" />
            Saving…
          </>
        ) : (
          "Save Changes"
        )}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={WEEKLY_HOURS_TITLE} size="md" className="weekly-hours-dialog" footer={footer}>
      <form
        id={formId}
        className="weekly-hours-form"
        noValidate
        aria-busy={saving}
        onSubmit={(event) => void handleSubmit(event)}
      >
        <p className="field-hint">{firstTime ? WEEKLY_INTRO_FIRST : WEEKLY_INTRO}</p>

        {entries
          .filter((entry) => !entry.earlier)
          .map(({ draft, index }) => renderDraft(draft, index, index > 0 ? "removable" : "fixed"))}

        {firstTime ? null : (
          <div className="weekly-hours-new">
            {/* A plain button with the Button classes: it takes focus back after Cancel and Remove. */}
            <button
              ref={toggleRef}
              type="button"
              className="btn btn-secondary btn-md weekly-hours-toggle"
              aria-expanded={panelOpen}
              aria-controls={panelId}
              onClick={() => (panelOpen ? closePanel() : openPanel())}
            >
              {NEW_HOURS_TOGGLE}
            </button>
            <div id={panelId} className="weekly-hours-panel" hidden={!panelOpen} data-new-hours="">
              {panelOpen ? (
                <>
                  <p className="weekly-hours-panel-intro">{NEW_HOURS_INTRO}</p>
                  <div className="field">
                    <label className="weekly-hours-label" htmlFor={startId}>
                      Starts on
                    </label>
                    <input
                      ref={startInputRef}
                      id={startId}
                      type="date"
                      className="field-control weekly-hours-start"
                      min={currentStart === null ? undefined : addDays(currentStart, 1)}
                      value={newStart}
                      aria-invalid={startInvalid || undefined}
                      aria-describedby={panelError ? panelErrorId : startInvalid ? errorId : undefined}
                      onChange={(event) => {
                        setNewStart(event.target.value);
                        setPanelError(null);
                      }}
                      onKeyDown={handleStartKeyDown}
                    />
                  </div>
                  {panelError ? (
                    <p key={panelError.id} id={panelErrorId} className="field-error" role="alert">
                      {panelError.text}
                    </p>
                  ) : null}
                  <div className="weekly-hours-panel-actions">
                    <Button variant="primary" size="sm" onClick={addChange}>
                      Add Change
                    </Button>
                    <Button variant="ghost" size="sm" onClick={closePanel}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        )}

        {earlier.length > 0 ? (
          <>
            <p className="field-hint weekly-hours-earlier">{WEEKLY_EARLIER_HINT}</p>
            {earlier.map(({ draft, index }) => renderDraft(draft, index, "collapsible"))}
          </>
        ) : null}

        {error ? (
          <p key={error.id} id={errorId} className="field-error weekly-hours-error" role="alert" tabIndex={-1}>
            {error.text}
          </p>
        ) : null}
      </form>
      {asking ? (
        <ApplyHoursDialog
          since={asking.since}
          today={today}
          onChoose={applyEdits}
          onBack={() => setAsking(null)}
        />
      ) : null}
    </Modal>
  );
}
