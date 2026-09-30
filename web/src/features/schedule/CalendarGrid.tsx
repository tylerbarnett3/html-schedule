import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useMediaQuery } from "../../data/useMediaQuery";
import { calendarCellCount, type CalendarDay, type DayCard as CalendarCard } from "../../lib/calendar";
import { formatDayLabel, weekdayHeaders } from "../../lib/dates";
import { dayHeaderText } from "../../lib/hours";
import { formatTime12Hour } from "../../lib/time";
import type { ISODate } from "../../lib/types";
import { CALENDAR_DRAG_TYPES, calendarDragKind, type CalendarDragKind } from "../admin/dragTypes";
import { DayCard, type CancellableCard } from "./DayCard";
import "./CalendarGrid.css";

/** Phones get a one-column agenda list instead of the 7-column grid. */
const MOBILE_QUERY = "(max-width: 768px)";

/** Admin page: cards can be dragged onto another day. */
export interface CalendarDragAndDrop {
  canDrag(card: CalendarCard): boolean;
  onDrop(drop: { kind: CalendarDragKind; id: string; date: ISODate }): void;
}

export interface CalendarGridProps {
  days: readonly CalendarDay[];
  /** The rows for these dates are still loading: empty days show a placeholder, not "No shifts". */
  loading?: boolean;
  /** Employee page: Cancel Request on the signed-in employee's own pending cards. */
  onCancel?(card: CancellableCard): void;
  /** Row ids of the requests whose cancellation is in flight. */
  cancellingIds?: ReadonlySet<string>;
  /** Admin page: cards open on click (see DayCard). */
  onOpenCard?(card: CalendarCard): void;
  /** Admin page: extra controls at the end of each day, e.g. "+ Add" or "Reopen day". */
  renderDayFooter?(day: CalendarDay): ReactNode;
  /** Admin page: drag and drop between days (leave out on touch screens). */
  dragAndDrop?: CalendarDragAndDrop;
  /** Admin page: the day heading becomes a button that opens that day's hours. */
  onOpenDay?(date: ISODate): void;
}

const CLOSED_LETTERS = ["C", "L", "O", "S", "E", "D"];
const NOT_CANCELLING: ReadonlySet<string> = new Set();

export function CalendarGrid({
  days,
  loading = false,
  onCancel,
  cancellingIds = NOT_CANCELLING,
  onOpenCard,
  renderDayFooter,
  dragAndDrop,
  onOpenDay,
}: CalendarGridProps) {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const start = days.length > 0 ? days[0].date : null;
  // Blank cells complete the last week row on the grid; the agenda list has none.
  const fillers = mobile ? 0 : calendarCellCount(days.length) - days.length;

  return (
    <div className="calendar">
      {/* Columns follow the range's first weekday. Each day heading names its own
          weekday, so this row is only a visual aid. */}
      {!mobile && start ? (
        <div className="calendar-weekdays" aria-hidden="true">
          {weekdayHeaders(start).map((name) => (
            <div key={name} className="calendar-weekday">
              {name}
            </div>
          ))}
        </div>
      ) : null}
      <ol className="calendar-days">
        {days.map((day) => (
          <CalendarDayCell
            key={day.date}
            day={day}
            mobile={mobile}
            loading={loading}
            onCancel={onCancel}
            cancellingIds={cancellingIds}
            onOpenCard={onOpenCard}
            footer={renderDayFooter ? renderDayFooter(day) : null}
            dragAndDrop={dragAndDrop}
            onOpenDay={onOpenDay}
          />
        ))}
        {Array.from({ length: fillers }, (_, i) => (
          <li key={`filler-${i}`} className="calendar-day calendar-filler" aria-hidden="true" />
        ))}
      </ol>
    </div>
  );
}

interface CalendarDayCellProps {
  day: CalendarDay;
  mobile: boolean;
  loading: boolean;
  onCancel?(card: CancellableCard): void;
  cancellingIds: ReadonlySet<string>;
  onOpenCard?(card: CalendarCard): void;
  footer: ReactNode;
  dragAndDrop?: CalendarDragAndDrop;
  onOpenDay?(date: ISODate): void;
}

function CalendarDayCell({
  day,
  mobile,
  loading,
  onCancel,
  cancellingIds,
  onOpenCard,
  footer,
  dragAndDrop,
  onOpenDay,
}: CalendarDayCellProps) {
  const classes = ["calendar-day", day.isToday ? "calendar-day-today" : null].filter(Boolean).join(" ");
  const drop = useDayDropTarget(day.date, dragAndDrop);
  const heading = <DayHeading day={day} mobile={mobile} />;

  return (
    <li className={classes} data-date={day.date}>
      {/* tabIndex -1: focus can land here after a cancelled card disappears. */}
      {onOpenDay ? (
        <h3 className="calendar-day-header calendar-day-header-openable" tabIndex={-1}>
          {/* Rendered on closed days too, always in the same place, so the Day Hours dialog
              hands focus back to it. The heading text stays in its name. */}
          <button
            type="button"
            className="calendar-day-header-button"
            aria-haspopup="dialog"
            onClick={() => onOpenDay(day.date)}
          >
            {heading}
            <span className="visually-hidden">, edit hours</span>
          </button>
        </h3>
      ) : (
        <h3 className="calendar-day-header" tabIndex={-1}>
          {heading}
        </h3>
      )}
      <div className={drop.over ? "calendar-day-body is-drop-target" : "calendar-day-body"} {...drop.handlers}>
        {day.closed ? (
          <p className="calendar-closed">
            <span className="calendar-closed-letters" aria-hidden="true">
              {CLOSED_LETTERS.map((letter, i) => (
                <span key={i}>{letter}</span>
              ))}
            </span>
            <span className="visually-hidden">Closed</span>
          </p>
        ) : day.cards.length > 0 ? (
          <ul className="calendar-cards">
            {day.cards.map((card) => (
              <DayCard
                key={`${card.kind}-${card.row.id}`}
                card={card}
                onCancel={onCancel}
                cancelling={cancellingIds.has(card.row.id)}
                onOpen={onOpenCard}
                draggable={dragAndDrop?.canDrag(card)}
              />
            ))}
          </ul>
        ) : loading ? (
          // The section is aria-busy while loading; this is only a visual placeholder.
          <div className="calendar-skeleton" aria-hidden="true">
            <span />
            <span />
          </div>
        ) : (
          // The old page left empty desktop days blank; screen readers still get the text.
          <p className={mobile ? "calendar-empty" : "visually-hidden"}>No shifts scheduled</p>
        )}
        {footer ? <div className="calendar-day-footer">{footer}</div> : null}
      </div>
    </li>
  );
}

/**
 * A day heading's content. A day whose hours differ from the standard shows them after the
 * date ('31 Oct (9:00 AM - 5:00 PM)'); screen readers hear the phone text on both layouts.
 * Every other day renders exactly as it always has.
 */
function DayHeading({ day, mobile }: { day: CalendarDay; mobile: boolean }) {
  const fullLabel = formatDayLabel(day.date, "mobile");
  const hours = day.specialHours;
  return (
    <>
      {hours ? (
        <>
          <span className="calendar-day-title" aria-hidden="true">
            <span className="calendar-day-date">{mobile ? fullLabel : formatDayLabel(day.date, "desktop")}</span>
            {/* Lines break only at " - " or before the hours, never inside "9:00 AM". */}
            <span className="calendar-day-hours">
              {"("}
              <span className="calendar-day-time">{formatTime12Hour(hours.open)}</span>
              {" - "}
              <span className="calendar-day-time">{formatTime12Hour(hours.close)}</span>
              {")"}
            </span>
          </span>
          <span className="visually-hidden">{dayHeaderText(day.date, "mobile", hours)}</span>
        </>
      ) : mobile ? (
        <span className="calendar-day-date">{fullLabel}</span>
      ) : (
        <>
          <span className="calendar-day-date" aria-hidden="true">
            {formatDayLabel(day.date, "desktop")}
          </span>
          <span className="visually-hidden">{fullLabel}</span>
        </>
      )}
      {/* The narrow desktop cells mark today with the gold date pill alone. */}
      {day.isToday ? (
        <span className={mobile ? "calendar-today-tag" : "visually-hidden"}>
          <span className="visually-hidden">, </span>Today
        </span>
      ) : null}
    </>
  );
}

type DropHandlers = {
  onDragEnter?(event: DragEvent<HTMLDivElement>): void;
  onDragOver?(event: DragEvent<HTMLDivElement>): void;
  onDragLeave?(event: DragEvent<HTMLDivElement>): void;
  onDrop?(event: DragEvent<HTMLDivElement>): void;
};

/**
 * A day body as a drop zone for calendar cards only (decision C3): other drags (an
 * employee row, text, files) get no highlight and can't be dropped. Entering and leaving
 * the cards inside fires enter/leave pairs, so a counter decides when the drag has left.
 */
function useDayDropTarget(
  date: ISODate,
  dragAndDrop: CalendarDragAndDrop | undefined,
): { over: boolean; handlers: DropHandlers } {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  // A drag that ends elsewhere (Escape, or dropped outside the page) may never send the
  // matching dragleave; clear the highlight when any drag ends.
  useEffect(() => {
    if (!over) return;
    const reset = () => {
      depth.current = 0;
      setOver(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [over]);

  if (!dragAndDrop) return { over: false, handlers: {} };

  const kindOf = (event: DragEvent<HTMLDivElement>) => calendarDragKind(Array.from(event.dataTransfer.types));

  return {
    over,
    handlers: {
      onDragEnter(event) {
        if (!kindOf(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver(event) {
        if (!kindOf(event)) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragLeave(event) {
        if (!kindOf(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop(event) {
        const kind = kindOf(event);
        depth.current = 0;
        setOver(false);
        if (!kind) return;
        event.preventDefault();
        const id = event.dataTransfer.getData(CALENDAR_DRAG_TYPES[kind]);
        if (id) dragAndDrop.onDrop({ kind, id, date });
      },
    },
  };
}
