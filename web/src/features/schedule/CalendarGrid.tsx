import { useMediaQuery } from "../../data/useMediaQuery";
import { calendarCellCount, type CalendarDay } from "../../lib/calendar";
import { formatDayLabel, weekdayHeaders } from "../../lib/dates";
import { DayCard, type CancellableCard } from "./DayCard";
import "./CalendarGrid.css";

/** Phones get a one-column agenda list instead of the 7-column grid. */
const MOBILE_QUERY = "(max-width: 768px)";

export interface CalendarGridProps {
  days: readonly CalendarDay[];
  /** The rows for these dates are still loading: empty days show a placeholder, not "No shifts". */
  loading?: boolean;
  onCancel(card: CancellableCard): void;
  /** Row ids of the requests whose cancellation is in flight. */
  cancellingIds: ReadonlySet<string>;
}

const CLOSED_LETTERS = ["C", "L", "O", "S", "E", "D"];

export function CalendarGrid({ days, loading = false, onCancel, cancellingIds }: CalendarGridProps) {
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
  onCancel(card: CancellableCard): void;
  cancellingIds: ReadonlySet<string>;
}

function CalendarDayCell({ day, mobile, loading, onCancel, cancellingIds }: CalendarDayCellProps) {
  const fullLabel = formatDayLabel(day.date, "mobile");
  const classes = ["calendar-day", day.isToday ? "calendar-day-today" : null].filter(Boolean).join(" ");

  return (
    <li className={classes} data-date={day.date}>
      {/* tabIndex -1: focus can land here after a cancelled card disappears. */}
      <h3 className="calendar-day-header" tabIndex={-1}>
        {mobile ? (
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
      </h3>
      <div className="calendar-day-body">
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
      </div>
    </li>
  );
}
