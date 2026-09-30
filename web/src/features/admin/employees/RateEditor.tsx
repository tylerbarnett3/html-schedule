import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../../components/Button";
import { emptyRateDraft, startNewRate, type RateDraft } from "../../../lib/rates";
import { makeRateKey, rateFieldId, type RateField } from "./employeeForm";
import "../../../components/Field.css";
import "./RateEditor.css";

export interface RateEditorProps {
  drafts: readonly RateDraft[];
  onChange(drafts: RateDraft[]): void;
  /** Prefix for input ids (see rateFieldId). */
  idPrefix: string;
  /** Input ids to mark invalid after a failed save. */
  invalidIds: ReadonlySet<string>;
  disabled?: boolean;
}

const FIELD_LABELS: Readonly<Record<RateField, string>> = {
  rate: "Hourly Rate",
  start: "Start Date",
  end: "End Date",
};

/**
 * The rate periods in Edit Employee. Inputs keep what was typed; everything is checked
 * when the dialog saves (checkRateDrafts), as on the old page.
 */
export function RateEditor({ drafts, onChange, idPrefix, invalidIds, disabled = false }: RateEditorProps) {
  const id = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const newRateToggle = useRef<HTMLButtonElement>(null);
  const [newRateOpen, setNewRateOpen] = useState(false);
  const [newStart, setNewStart] = useState("");
  const [newRate, setNewRate] = useState("");
  const [newRateError, setNewRateError] = useState<string | null>(null);
  const panelId = `${id}-new-rate`;
  const errorId = `${id}-new-rate-error`;

  // Focus moves wait for the render that adds or removes the inputs.
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

  const update = (index: number, field: RateField, value: string) => {
    onChange(drafts.map((draft, i) => (i === index ? { ...draft, [field]: value } : draft)));
  };

  const addPeriod = () => {
    const added = emptyRateDraft(makeRateKey());
    onChange([...drafts, added]);
    focusLater(() => document.getElementById(rateFieldId(idPrefix, added.key, "rate")));
  };

  const removePeriod = (index: number) => {
    const next = drafts.filter((_, i) => i !== index);
    onChange(next);
    // Focus the period that moved into its place, else the one before, else Add.
    const neighbor = next[Math.min(index, next.length - 1)];
    focusLater(() =>
      neighbor ? document.getElementById(rateFieldId(idPrefix, neighbor.key, "rate")) : addButton.current,
    );
  };

  const openNewRate = () => {
    setNewRateOpen(true);
    focusLater(() => document.getElementById(`${id}-new-start`));
  };

  const closeNewRate = () => {
    setNewRateOpen(false);
    setNewStart("");
    setNewRate("");
    setNewRateError(null);
    focusLater(() => newRateToggle.current);
  };

  const applyNewRate = () => {
    const result = startNewRate(drafts, newStart, newRate, makeRateKey);
    if (!result.ok) {
      setNewRateError(result.message);
      return;
    }
    onChange(result.drafts);
    const added = result.drafts[result.drafts.length - 1];
    setNewRateOpen(false);
    setNewStart("");
    setNewRate("");
    setNewRateError(null);
    focusLater(() => document.getElementById(rateFieldId(idPrefix, added.key, "rate")));
  };

  // Enter in the new-rate fields adds the rate instead of saving the whole dialog.
  const handleNewRateKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    applyNewRate();
  };

  return (
    <div className="rate-editor">
      {drafts.length === 0 ? (
        <p className="rate-editor-empty">No rates defined. Click "Add Rate Period" to add one.</p>
      ) : (
        <>
          <p className="field-hint">Leave Start or End empty for no limit.</p>
          <ol className="rate-editor-list">
            {drafts.map((draft, index) => {
              const titleId = `${id}-${draft.key}-title`;
              const title = `Rate Period ${index + 1}`;
              return (
                <li key={draft.key}>
                  <fieldset className="rate-editor-period" aria-labelledby={titleId} disabled={disabled}>
                    <div className="rate-editor-period-header">
                      <strong id={titleId} className="rate-editor-period-title">
                        {title}
                      </strong>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${title}`}
                        onClick={() => removePeriod(index)}
                      >
                        Delete
                      </Button>
                    </div>
                    <div className="rate-editor-fields">
                      {(["rate", "start", "end"] as const).map((field) => {
                        const inputId = rateFieldId(idPrefix, draft.key, field);
                        return (
                          <div key={field} className="field">
                            <label className="rate-editor-label" htmlFor={inputId}>
                              {FIELD_LABELS[field]}
                            </label>
                            {field === "rate" ? (
                              <input
                                id={inputId}
                                className="field-control rate-editor-control"
                                type="number"
                                inputMode="decimal"
                                step="0.01"
                                min="0"
                                placeholder="15.00"
                                value={draft.rate}
                                aria-invalid={invalidIds.has(inputId) || undefined}
                                onChange={(event) => update(index, "rate", event.target.value)}
                              />
                            ) : (
                              <input
                                id={inputId}
                                className="field-control rate-editor-control"
                                type="date"
                                value={draft[field]}
                                aria-invalid={invalidIds.has(inputId) || undefined}
                                onChange={(event) => update(index, field, event.target.value)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </fieldset>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <div className="rate-editor-actions">
        {/* Plain buttons with the Button classes: these two need refs for focus. */}
        <button ref={addButton} type="button" className="btn btn-secondary btn-md" onClick={addPeriod} disabled={disabled}>
          + Add Rate Period
        </button>
        <button
          ref={newRateToggle}
          type="button"
          className="btn btn-secondary btn-md"
          aria-expanded={newRateOpen}
          aria-controls={panelId}
          onClick={() => (newRateOpen ? closeNewRate() : openNewRate())}
          disabled={disabled}
        >
          New rate starting on…
        </button>
      </div>

      <div id={panelId} className="rate-editor-new" hidden={!newRateOpen} data-new-rate="">
        {newRateOpen ? (
          <>
            <p className="rate-editor-new-intro">
              The current open-ended rate ends the day before, and the new rate starts on this date.
            </p>
            <div className="rate-editor-new-fields">
              <div className="field">
                <label className="rate-editor-label" htmlFor={`${id}-new-start`}>
                  Starts on
                </label>
                <input
                  id={`${id}-new-start`}
                  className="field-control rate-editor-control"
                  type="date"
                  value={newStart}
                  aria-describedby={newRateError ? errorId : undefined}
                  onChange={(event) => setNewStart(event.target.value)}
                  onKeyDown={handleNewRateKeyDown}
                />
              </div>
              <div className="field">
                <label className="rate-editor-label" htmlFor={`${id}-new-rate`}>
                  New Hourly Rate
                </label>
                <input
                  id={`${id}-new-rate`}
                  className="field-control rate-editor-control"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="15.00"
                  value={newRate}
                  aria-describedby={newRateError ? errorId : undefined}
                  onChange={(event) => setNewRate(event.target.value)}
                  onKeyDown={handleNewRateKeyDown}
                />
              </div>
            </div>
            {newRateError ? (
              <p id={errorId} className="field-error" role="alert">
                {newRateError}
              </p>
            ) : null}
            <div className="rate-editor-new-actions">
              <Button variant="primary" size="sm" onClick={applyNewRate}>
                Add New Rate
              </Button>
              <Button variant="ghost" size="sm" onClick={closeNewRate}>
                Cancel
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
