import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  addDays,
  compareISODate,
  formatISODate,
  formatMonthLabel,
  monthGrid,
  monthOf,
  nextMonth,
  prevMonth,
  WEEKDAY_SHORT,
  type MonthKey,
} from "../../lib/dates";
import { canGoNextMonth, canGoPrevMonth, pickerBounds } from "../../lib/requests";
import type { ISODate } from "../../lib/types";
import "./DatePicker.css";

export interface DatePickerDay {
  disabled: boolean;
  /** Tooltip saying why the day can't be picked. */
  title?: string;
  /** Tints closed days and days that already have a request. */
  marker?: "closed" | "requested";
}

export interface DatePickerProps {
  month: MonthKey;
  onMonthChange(month: MonthKey): void;
  today: ISODate;
  selected: readonly ISODate[];
  onToggle(date: ISODate): void;
  getDay(date: ISODate): DatePickerDay;
  /**
   * Which dates the month arrows and keyboard can reach. Left out, it is the employee
   * request window (pickerBounds). null means no limit: the arrows always work and the
   * keyboard looks at most a year either way for a day that can be picked.
   */
  bounds?: { min: ISODate; max: ISODate } | null;
}

/** How far the keyboard searches for a pickable day when the picker has no bounds. */
const UNBOUNDED_SEARCH_DAYS = 366;

const ARROW_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
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

/**
 * Sunday-first month grid of toggle buttons. Only one day is in the tab order; arrow
 * keys move between days that can be picked (crossing months), Home/End jump to the
 * first/last pickable day of the month, Page Up/Down change month.
 */
export function DatePicker({ month, onMonthChange, today, selected, onToggle, getDay, bounds }: DatePickerProps) {
  const labelId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusDate, setFocusDate] = useState<ISODate | null>(null);
  const moveFocus = useRef(false);

  const { leadingBlanks, days } = useMemo(() => monthGrid(month), [month]);
  // Full dates for screen readers ("Monday, October 5, 2026"); the button shows only the day.
  const dayLabels = useMemo(
    () => days.map((d) => formatISODate(d, { weekday: "long", month: "long", day: "numeric", year: "numeric" })),
    [days],
  );
  const cells = days.map((date, i) => ({ date, label: dayLabels[i], ...getDay(date) }));
  const selectedSet = new Set(selected);

  let canPrev: boolean;
  let canNext: boolean;
  if (bounds === undefined) {
    canPrev = canGoPrevMonth(month, today);
    canNext = canGoNextMonth(month, today);
  } else if (bounds === null) {
    canPrev = true;
    canNext = true;
  } else {
    canPrev = month > monthOf(bounds.min);
    canNext = nextMonth(month) <= monthOf(bounds.max);
  }

  const enabledInMonth = cells.filter((cell) => !cell.disabled).map((cell) => cell.date);
  const tabbable =
    (focusDate !== null && enabledInMonth.includes(focusDate) ? focusDate : undefined) ??
    enabledInMonth.find((d) => selectedSet.has(d)) ??
    (enabledInMonth.includes(today) ? today : undefined) ??
    enabledInMonth[0];

  useEffect(() => {
    if (!moveFocus.current || focusDate === null) return;
    moveFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
  });

  // Next pickable day from `start`, stepping one day at a time in `direction`.
  // Days in other months are checked through getDay too, so conflicts are respected.
  const findEnabled = (start: ISODate, direction: 1 | -1, stayInMonth: boolean): ISODate | null => {
    const { min, max } =
      bounds === undefined
        ? pickerBounds(today)
        : (bounds ?? { min: addDays(start, -UNBOUNDED_SEARCH_DAYS), max: addDays(start, UNBOUNDED_SEARCH_DAYS) });
    const first = compareISODate(start, min) < 0 ? min : compareISODate(start, max) > 0 ? max : start;
    for (let d = first; compareISODate(d, min) >= 0 && compareISODate(d, max) <= 0; d = addDays(d, direction)) {
      if (stayInMonth && monthOf(d) !== month) return null;
      if (!getDay(d).disabled) return d;
    }
    return null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = event.target instanceof HTMLElement ? event.target.dataset.date : undefined;
    if (from === undefined || event.altKey || event.ctrlKey || event.metaKey) return;

    let next: ISODate | null;
    const step = ARROW_STEPS[event.key];
    if (step !== undefined) {
      next = findEnabled(addDays(from, step), step > 0 ? 1 : -1, false);
    } else if (event.key === "Home") {
      next = findEnabled(days[0], 1, true);
    } else if (event.key === "End") {
      next = findEnabled(days[days.length - 1], -1, true);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      const forward = event.key === "PageDown";
      if (forward ? !canNext : !canPrev) {
        event.preventDefault();
        return;
      }
      const target = forward ? nextMonth(month) : prevMonth(month);
      const targetDays = monthGrid(target).days;
      const sameDay = targetDays[Math.min(Number(from.slice(8, 10)), targetDays.length) - 1];
      next = findEnabled(sameDay, 1, false) ?? findEnabled(sameDay, -1, false);
    } else {
      return;
    }

    event.preventDefault();
    if (next === null) return;
    if (monthOf(next) !== month) onMonthChange(monthOf(next));
    setFocusDate(next);
    moveFocus.current = true;
  };

  return (
    <div className="date-picker">
      <div className="date-picker-nav">
        <button
          type="button"
          className="date-picker-nav-button"
          aria-label="Previous month"
          title="Previous month"
          // aria-disabled (not disabled) keeps focus on the button at the first month.
          aria-disabled={!canPrev}
          onClick={() => {
            if (canPrev) onMonthChange(prevMonth(month));
          }}
        >
          <ArrowIcon direction="left" />
        </button>
        <span id={labelId} className="date-picker-month" aria-live="polite">
          {formatMonthLabel(month)}
        </span>
        <button
          type="button"
          className="date-picker-nav-button"
          aria-label="Next month"
          title="Next month"
          aria-disabled={!canNext}
          onClick={() => {
            if (canNext) onMonthChange(nextMonth(month));
          }}
        >
          <ArrowIcon direction="right" />
        </button>
      </div>

      <div ref={gridRef} className="date-picker-grid" role="group" aria-labelledby={labelId} onKeyDown={handleKeyDown}>
        {WEEKDAY_SHORT.map((weekday) => (
          <span key={weekday} className="date-picker-weekday" aria-hidden="true">
            {weekday}
          </span>
        ))}
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <span key={`blank-${i}`} className="date-picker-blank" aria-hidden="true" />
        ))}
        {cells.map(({ date, label, disabled, title, marker }) => {
          const isSelected = selectedSet.has(date);
          const isToday = date === today;
          const classes = [
            "date-picker-day",
            isSelected && "is-selected",
            isToday && "is-today",
            marker && `is-${marker}`,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={date}
              type="button"
              className={classes}
              data-date={date}
              disabled={disabled}
              title={title}
              // Disabled buttons can't be focused, so a keyboard or screen reader user never
              // meets the tooltip; the reason goes in the name too. A closed day that can
              // still be picked (to mark it closed) says so as well.
              aria-label={[label, isToday && "today", (disabled || marker === "closed") && title?.toLowerCase()]
                .filter(Boolean)
                .join(", ")}
              aria-pressed={isSelected}
              tabIndex={date === tabbable ? 0 : -1}
              onClick={() => onToggle(date)}
              onFocus={() => setFocusDate(date)}
            >
              {Number(date.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
