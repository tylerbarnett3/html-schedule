import type { CSSProperties } from "react";
import { formatShortDate } from "../../lib/dates";
import { BUSY_PENDING_COLOR, type DayCard as CalendarCard } from "../../lib/calendar";
import { employeeColor, shiftCardColors } from "./employeeColor";
import "./DayCard.css";

/** Cards that carry a Cancel Request button when they belong to the signed-in employee. */
export type CancellableCard = Extract<CalendarCard, { kind: "pending-time-off" | "availability" }>;

export interface DayCardProps {
  card: CalendarCard;
  onCancel(card: CancellableCard): void;
  /** True while this card's cancel request is in flight. */
  cancelling: boolean;
}

function cardDate(card: CalendarCard): string {
  switch (card.kind) {
    case "shift":
      return card.row.shift_date;
    case "availability":
      return card.row.available_date;
    default:
      return card.row.off_date;
  }
}

export function DayCard({ card, onCancel, cancelling }: DayCardProps) {
  let variant: string;
  let style: CSSProperties | undefined;
  switch (card.kind) {
    case "shift": {
      const { background, darkText } = shiftCardColors(employeeColor(card.employee.color));
      variant = darkText ? "day-card-shift day-card-shift-light" : "day-card-shift";
      style = { background };
      break;
    }
    case "pending-time-off":
      variant = card.color === BUSY_PENDING_COLOR ? "day-card-pending day-card-pending-busy" : "day-card-pending";
      break;
    case "time-off":
      variant = "day-card-off";
      break;
    case "availability":
      variant = card.pending ? "day-card-availability day-card-availability-pending" : "day-card-availability";
      break;
  }

  const cancellable: CancellableCard | null =
    (card.kind === "pending-time-off" || card.kind === "availability") && card.canCancel ? card : null;

  return (
    <li className={`day-card ${variant}`} style={style}>
      <div className="day-card-name">{card.employee.name}</div>
      <div className="day-card-label">{card.label}</div>
      {cancellable ? (
        <button
          type="button"
          className="day-card-cancel"
          // aria-disabled rather than disabled, so focus stays put while the cancel runs.
          aria-disabled={cancelling || undefined}
          onClick={() => {
            if (!cancelling) onCancel(cancellable);
          }}
        >
          {cancelling ? "Cancelling..." : "Cancel Request"}
          <span className="visually-hidden">
            {` (${card.label.toLowerCase()}, ${formatShortDate(cardDate(card))})`}
          </span>
        </button>
      ) : null}
    </li>
  );
}
