import { useRef, useState, type CSSProperties, type DragEvent } from "react";
import { formatDayLabel, formatShortDate } from "../../lib/dates";
import { BUSY_PENDING_COLOR, type DayCard as CalendarCard } from "../../lib/calendar";
import { cardAction } from "../../lib/scheduleEditing";
import { CALENDAR_DRAG_TYPES } from "../admin/dragTypes";
import { employeeCardPaint } from "./employeeColor";
import "./DayCard.css";

/** Cards that carry a Cancel Request button when they belong to the signed-in employee. */
export type CancellableCard = Extract<CalendarCard, { kind: "pending-time-off" | "availability" }>;

export interface DayCardProps {
  card: CalendarCard;
  /** Employee page: shows Cancel Request on the signed-in employee's own pending cards. */
  onCancel?(card: CancellableCard): void;
  /** True while this card's cancel request is in flight. */
  cancelling?: boolean;
  /**
   * Admin page: the card becomes a button that opens it (Edit, or the request review).
   * Cards with nothing to open (approved availability) stay plain.
   */
  onOpen?(card: CalendarCard): void;
  /** Admin page, mouse only: the card can be dragged onto another day. */
  draggable?: boolean;
}

function cardDate(card: CalendarCard): string {
  switch (card.kind) {
    case "shift":
    case "reviewed":
      return card.row.shift_date;
    case "availability":
      return card.row.available_date;
    default:
      return card.row.off_date;
  }
}

export function DayCard({ card, onCancel, cancelling = false, onOpen, draggable = false }: DayCardProps) {
  const [dragging, setDragging] = useState(false);
  const dragActive = useRef(false);
  let variant: string;
  let style: CSSProperties | undefined;
  switch (card.kind) {
    case "shift": {
      // The employee's color as custom properties; DayCard.css draws the card from them.
      const paint = employeeCardPaint(card.employee.color);
      variant = paint.className;
      style = paint.style;
      break;
    }
    case "reviewed":
      variant = "day-card-reviewed";
      break;
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
    onCancel && (card.kind === "pending-time-off" || card.kind === "availability") && card.canCancel ? card : null;
  const openable = onOpen !== undefined && cardAction(card) !== null;
  const canDrag = draggable && (card.kind === "shift" || card.kind === "time-off");

  const classes = [
    "day-card",
    variant,
    openable && "day-card-openable",
    canDrag && "day-card-draggable",
    dragging && "is-dragging",
  ]
    .filter(Boolean)
    .join(" ");

  const handleDragStart = (event: DragEvent<HTMLLIElement>) => {
    // Only the calendar's own type is set (no text/plain), so the id can't be dropped into
    // a text field and only day bodies light up (decision C3).
    event.dataTransfer.setData(CALENDAR_DRAG_TYPES[card.kind === "shift" ? "shift" : "time-off"], card.row.id);
    event.dataTransfer.effectAllowed = "move";
    // Dim the card after the browser has taken its drag image (unless the drag already ended).
    dragActive.current = true;
    requestAnimationFrame(() => {
      if (dragActive.current) setDragging(true);
    });
  };

  const handleDragEnd = () => {
    dragActive.current = false;
    setDragging(false);
  };

  return (
    <li
      className={classes}
      style={style}
      draggable={canDrag || undefined}
      onDragStart={canDrag ? handleDragStart : undefined}
      onDragEnd={canDrag ? handleDragEnd : undefined}
    >
      {openable ? (
        <button
          type="button"
          className="day-card-open"
          aria-label={`${card.employee.name}, ${card.label}, ${formatDayLabel(cardDate(card), "mobile")}`}
          onClick={() => onOpen?.(card)}
        >
          <span className="day-card-name">{card.employee.name}</span>
          <span className="day-card-label">{card.label}</span>
        </button>
      ) : (
        <>
          <div className="day-card-name">{card.employee.name}</div>
          <div className="day-card-label">{card.label}</div>
        </>
      )}
      {card.kind === "reviewed" ? <ReviewedMark /> : null}
      {cancellable ? (
        <button
          type="button"
          className="day-card-cancel"
          // aria-disabled rather than disabled, so focus stays put while the cancel runs.
          aria-disabled={cancelling || undefined}
          onClick={() => {
            if (!cancelling) onCancel?.(cancellable);
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

/** Lucide's circle-check in the card's top right corner. */
function ReviewedMark() {
  return (
    <span className="day-card-reviewed-mark">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <title>Hours reviewed</title>
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
      <span className="visually-hidden">, hours reviewed</span>
    </span>
  );
}
