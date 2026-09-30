import type { KeyboardEvent } from "react";
import { dayTab, dayTabKeyTarget, type DraftRow } from "../../../lib/payroll";
import type { ISODate } from "../../../lib/types";
import "./PayrollDayTabs.css";

export interface PayrollDayTabsProps {
  dates: readonly ISODate[];
  selected: ISODate;
  /** Saved rows: the tabs show saved progress, like the summary. */
  pristine: readonly DraftRow[];
  today: ISODate;
  closedDays: ReadonlySet<ISODate>;
  panelId: string;
  tabId(date: ISODate): string;
  onSelect(date: ISODate): void;
}

/** The 14 days of the period as tabs (7 × 2), with arrow keys and roving focus. */
export function PayrollDayTabs({
  dates,
  selected,
  pristine,
  today,
  closedDays,
  panelId,
  tabId,
  onSelect,
}: PayrollDayTabsProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Step from the focused tab, not `selected`: the URL update behind `selected` lands a
    // few frames later, so fast presses would otherwise all start from the same tab.
    const focusedId = event.target instanceof HTMLElement ? event.target.id : "";
    const focused = dates.findIndex((date) => tabId(date) === focusedId);
    const index = focused === -1 ? dates.indexOf(selected) : focused;
    const next = dayTabKeyTarget(event.key, index, dates.length);
    if (next === null) return;
    event.preventDefault();
    const date = dates[next];
    onSelect(date);
    document.getElementById(tabId(date))?.focus();
  };

  return (
    <div className="payroll-tabs" role="tablist" aria-label="Days in pay period" onKeyDown={onKeyDown}>
      {dates.map((date) => {
        const tab = dayTab(date, pristine, today, closedDays);
        const active = date === selected;
        return (
          <button
            key={date}
            id={tabId(date)}
            type="button"
            role="tab"
            className={active ? "payroll-tab payroll-tab-active" : "payroll-tab"}
            aria-selected={active}
            aria-controls={panelId}
            aria-label={tab.ariaLabel}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(date)}
          >
            <span className="payroll-tab-day">
              <span>{tab.weekday}</span> <span>{tab.day}</span>
            </span>
            <span className="payroll-tab-progress">{tab.progressText}</span>
          </button>
        );
      })}
    </div>
  );
}
