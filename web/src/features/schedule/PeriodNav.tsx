import { useId, useRef, useState } from "react";
import { applyRangeEdit, formatRangeLabel, MAX_RANGE_DAYS, shiftRange } from "../../lib/dates";
import type { DateRange, ISODate } from "../../lib/types";
import "./PeriodNav.css";

export interface PeriodNavProps {
  range: DateRange;
  onRangeChange(range: DateRange): void;
}

/** Previous/next arrows, the range heading, and the Start/End date inputs. */
export function PeriodNav({ range, onRangeChange }: PeriodNavProps) {
  const id = useId();
  // Set when the last typed range was cut short at MAX_RANGE_DAYS.
  const [capped, setCapped] = useState(false);
  const label = formatRangeLabel(range);

  const shift = (direction: 1 | -1) => {
    setCapped(false);
    onRangeChange(shiftRange(range, direction));
  };

  const edit = (field: "start" | "end") => (value: string) => {
    const result = applyRangeEdit(field, value, range);
    if (!result) return null;
    setCapped(result.capped);
    if (result.range !== range) onRangeChange(result.range);
    return result.range[field];
  };

  return (
    <nav className="period-nav" aria-label="Schedule dates">
      <button
        type="button"
        className="period-nav-arrow period-nav-prev"
        aria-label="Previous period"
        title="Previous period"
        onClick={() => shift(-1)}
      >
        <ArrowIcon direction="left" />
      </button>
      <div className="period-nav-info">
        <h2 className="period-nav-title" aria-live="polite" aria-atomic="true">
          <span className="period-nav-range">{label.text}</span>{" "}
          <span className="period-nav-days">({label.days} days)</span>
        </h2>
        <div className="period-nav-fields">
          <DateField id={`${id}-start`} label="Start:" value={range.start} onCommit={edit("start")} />
          <DateField id={`${id}-end`} label="End:" value={range.end} onCommit={edit("end")} />
        </div>
        <p className="period-nav-note" role="status">
          {capped ? `Showing up to ${MAX_RANGE_DAYS} days` : ""}
        </p>
      </div>
      <button
        type="button"
        className="period-nav-arrow period-nav-next"
        aria-label="Next period"
        title="Next period"
        onClick={() => shift(1)}
      >
        <ArrowIcon direction="right" />
      </button>
    </nav>
  );
}

interface DateFieldProps {
  id: string;
  label: string;
  value: ISODate;
  /** Applies a finished date; returns the field's new value, or null when the text was ignored. */
  onCommit(value: string): ISODate | null;
}

/**
 * A date input that only applies finished dates. Chromium reports a new value for every
 * keystroke once the text parses (typing 2027 passes through 0002, 0020 and 0202), so
 * typed text waits for Enter or leaving the field, while a date picked from the native
 * picker applies at once. Partial text is never snapped back while the user types.
 */
function DateField({ id, label, value, onCommit }: DateFieldProps) {
  const [draft, setDraft] = useState<string>(value);
  const [shownValue, setShownValue] = useState(value);
  // True while the latest change came from the keyboard.
  const typing = useRef(false);

  // Follow range changes made elsewhere (arrows, the other field).
  if (shownValue !== value) {
    setShownValue(value);
    setDraft(value);
  }

  const commit = (text: string, revertIfIgnored: boolean) => {
    if (text === value) return;
    const applied = onCommit(text);
    if (applied !== null) setDraft(applied);
    else if (revertIfIgnored) setDraft(value);
  };

  return (
    <>
      <label htmlFor={id} className="period-nav-label">
        {label}
      </label>
      <input
        id={id}
        type="date"
        className="period-nav-input"
        min="2000-01-01"
        value={draft}
        onPointerDown={() => {
          typing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            typing.current = false;
            commit(event.currentTarget.value, false);
          } else if (event.key === "Escape") {
            typing.current = false;
            setDraft(value);
          } else if (event.key !== "Tab" && event.key !== "Shift") {
            typing.current = true;
          }
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          if (!typing.current) commit(event.target.value, false);
        }}
        onBlur={(event) => {
          typing.current = false;
          commit(event.currentTarget.value, true);
        }}
      />
    </>
  );
}

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  // lucide arrow-left / arrow-right, as on the old page.
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {direction === "left" ? (
        <>
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </>
      ) : (
        <>
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </>
      )}
    </svg>
  );
}
