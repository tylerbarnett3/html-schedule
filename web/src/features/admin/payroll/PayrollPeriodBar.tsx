import { useId, useRef, useState } from "react";
import { parsePeriodStartInput } from "../../../lib/payroll";
import type { DateRange, ISODate } from "../../../lib/types";
import "./PayrollPeriodBar.css";

export interface PayrollPeriodBarProps {
  period: DateRange;
  /** "4 of 19 shifts reviewed"; empty while the period loads. */
  progress: string;
  disabled: boolean;
  onStep(direction: 1 | -1): void;
  /** Resolves false when the change was cancelled (the draft had changes to keep). */
  onStartChange(start: ISODate): Promise<boolean>;
}

/** Previous/next pay period, the Start date (End follows it) and the review progress. */
export function PayrollPeriodBar({ period, progress, disabled, onStep, onStartChange }: PayrollPeriodBarProps) {
  const id = useId();
  return (
    <div className="payroll-period" role="group" aria-label="Pay period">
      <button
        type="button"
        className="payroll-period-arrow"
        aria-label="Previous pay period"
        title="Previous pay period"
        disabled={disabled}
        onClick={() => onStep(-1)}
      >
        <Chevron direction="left" />
      </button>
      <div className="payroll-period-copy">
        <div className="payroll-period-fields">
          <div className="payroll-period-field">
            <label htmlFor={`${id}-start`}>Start</label>
            <StartDateField id={`${id}-start`} value={period.start} disabled={disabled} onCommit={onStartChange} />
          </div>
          <div className="payroll-period-field">
            <label htmlFor={`${id}-end`}>End</label>
            <input
              id={`${id}-end`}
              type="date"
              className="payroll-period-input"
              value={period.end}
              readOnly
              aria-readonly="true"
              tabIndex={-1}
            />
          </div>
        </div>
        <p className="payroll-period-progress">{progress}</p>
      </div>
      <button
        type="button"
        className="payroll-period-arrow"
        aria-label="Next pay period"
        title="Next pay period"
        disabled={disabled}
        onClick={() => onStep(1)}
      >
        <Chevron direction="right" />
      </button>
    </div>
  );
}

interface StartDateFieldProps {
  id: string;
  value: ISODate;
  disabled: boolean;
  onCommit(value: ISODate): Promise<boolean>;
}

/**
 * The Start input commits only on Enter or leaving the field (U1), never per keystroke or
 * on a native-picker pick alone: Chromium reports a value for every finished segment, so
 * typing 2026-10-01 would pass through other dates on the way. An unfinished or cleared
 * value goes back to the current start, and so does a change the user then cancels.
 */
function StartDateField({ id, value, disabled, onCommit }: StartDateFieldProps) {
  const [draft, setDraft] = useState<string>(value);
  const [shownValue, setShownValue] = useState(value);
  // The value being confirmed: opening the confirm blurs the input, which must not ask again.
  const committing = useRef<string | null>(null);

  // Follow period changes made elsewhere (the arrows, the URL).
  if (shownValue !== value) {
    setShownValue(value);
    setDraft(value);
  }

  const commit = async (text: string) => {
    if (committing.current !== null) return;
    const start = parsePeriodStartInput(text);
    if (start === null || start === value) {
      setDraft(value);
      return;
    }
    committing.current = start;
    try {
      if (!(await onCommit(start))) setDraft(value);
    } finally {
      committing.current = null;
    }
  };

  return (
    <input
      id={id}
      type="date"
      className="payroll-period-input"
      min="2000-01-01"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          setDraft(value);
        }
      }}
      onBlur={(event) => void commit(event.currentTarget.value)}
    />
  );
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}
