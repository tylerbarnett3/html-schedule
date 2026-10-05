import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { useAlert } from "../../../components/useAlert";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import { invalidateAdminData } from "../../../data/adminKeys";
import { fetchEditingRows, useSetStandardHours, useUpdateDayOff, useUpdateShift } from "../../../data/adminSchedule";
import { adminErrorMessage } from "../../../data/errors";
import { useHoursData } from "../../../data/hours";
import { useCalendarData, useClosedDays, useEmployees } from "../../../data/schedule";
import { useMediaQuery } from "../../../data/useMediaQuery";
import { buildCalendarDays, type CalendarDay, type DayCard } from "../../../lib/calendar";
import { formatDayLabel } from "../../../lib/dates";
import { isEmptyChange } from "../../../lib/scheduleChange";
import {
  canDragCard,
  cardAction,
  checkCardDrop,
  type EditTarget,
  type ReviewTarget,
} from "../../../lib/scheduleEditing";
import type { Employee, ISODate, Shift, TimeOff } from "../../../lib/types";
import { CalendarGrid, type CalendarDragAndDrop } from "../../schedule/CalendarGrid";
import { PeriodNav } from "../../schedule/PeriodNav";
import { AdminSidebar } from "../AdminSidebar";
import { RequestReviewDialog } from "../requests/RequestReviewDialog";
import { useAdminView } from "../useAdminView";
import { useUndo } from "../undo/useUndo";
import { AddItemDialog } from "./AddItemDialog";
import { DayHoursDialog } from "./DayHoursDialog";
import { EditItemDialog } from "./EditItemDialog";
import { confirmPayrollHours, confirmShiftDeletion, keepFocusOnDay } from "./scheduleConfirms";
import {
  ALREADY_REMOVED,
  dayOffMovedText,
  failureTone,
  hoursSaveText,
  scheduleError,
  shiftMovedText,
} from "./scheduleText";
import "./AdminSchedulePage.css";

// Drag and drop is a mouse enhancement (C3); touch users move items with the Edit dialog.
const FINE_POINTER_QUERY = "(pointer: fine)";
const REOPEN_FALLBACK = "Couldn't reopen the day. Please try again.";

/**
 * The admin calendar: the employee page's calendar with every card clickable, "+ Add" and
 * "Reopen day" on each day, each day heading opening that day's hours, and drag and drop
 * between days. Every write can be undone from the toolbar.
 */
export function AdminSchedulePage() {
  const view = useAdminView();
  const toast = useToast();
  const alert = useAlert();
  const confirm = useConfirm();
  const undo = useUndo();
  const client = useQueryClient();
  const finePointer = useMediaQuery(FINE_POINTER_QUERY);

  const employeesQuery = useEmployees();
  const calendarQuery = useCalendarData(view.range);
  const closedQuery = useClosedDays();
  const hours = useHoursData();
  const updateShift = useUpdateShift();
  const updateDayOff = useUpdateDayOff();
  const setStandardHours = useSetStandardHours();

  const [addDate, setAddDate] = useState<ISODate | null>(null);
  const [hoursDate, setHoursDate] = useState<ISODate | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [reopening, setReopening] = useState<ReadonlySet<ISODate>>(() => new Set());
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);

  const employees = employeesQuery.data;
  const calendarData = calendarQuery.data;
  const closedDays = closedQuery.data;
  const { range, today, selectedEmployeeIds, showTimeOff, showAvailability } = view;

  const hoursData = hours.data;
  // A read that has failed once stays ready while it is tried again (see useHoursData), so
  // a dialog opening or the window regaining focus never sends the calendar back to "Loading...".
  const hoursReady = hours.ready;

  // While a new range loads, calendarData still holds the previous range's rows (see
  // SchedulePage): the new dates show at once, with placeholders where rows are missing.
  // The hours are waited for (loaded or failed), so the headings don't change after the
  // first paint; hours that failed to load never hold the calendar up.
  const days = useMemo(() => {
    if (!employees || !calendarData || !closedDays || !hoursReady) return null;
    return buildCalendarDays({
      range,
      today,
      employees,
      shifts: calendarData.shifts,
      reviews: calendarData.reviews,
      timeOff: calendarData.timeOff,
      availability: calendarData.availability,
      closedDays,
      selectedEmployeeIds,
      showTimeOff,
      showAvailability,
      meId: null,
      hours: hoursData,
    });
  }, [
    range,
    today,
    employees,
    calendarData,
    closedDays,
    hoursReady,
    hoursData,
    selectedEmployeeIds,
    showTimeOff,
    showAvailability,
  ]);

  const openCard = useCallback((card: DayCard) => {
    const action = cardAction(card);
    if (action?.kind === "edit") setEditTarget(action.target);
    else if (action?.kind === "review") setReviewTarget(action.target);
  }, []);

  const closeAdd = useCallback(() => setAddDate(null), []);
  const closeHours = useCallback(() => setHoursDate(null), []);
  const closeEdit = useCallback(() => setEditTarget(null), []);
  const closeReview = useCallback(() => {
    // An approved or denied request's card is replaced or removed, so the dialog can't hand
    // focus back to it; keep keyboard focus on that day instead of the page body.
    if (reviewTarget) {
      keepFocusOnDay(reviewTarget.kind === "time-off" ? reviewTarget.row.off_date : reviewTarget.row.available_date);
    }
    setReviewTarget(null);
  }, [reviewTarget]);

  // ---------------------------------------------------------------------------
  // Drag and drop (C3, C4)

  /** A refused drop explains itself in an alert: there is no dialog to show it in (§7.2). */
  const refuse = (kind: "shift" | "day off", message: string) =>
    alert({ title: kind === "shift" ? "Can't move this shift" : "Can't move this day off", message });

  const reportMoveError = (caught: unknown, kind: "shift" | "day off", allEmployees: readonly Employee[]) => {
    const failure = scheduleError(caught, { adding: false, employees: allEmployees });
    if (failure.rule) void refuse(kind, failure.message);
    else toast.show(failure.message, failureTone(failure));
  };

  const moveShift = async (
    row: Shift,
    date: ISODate,
    allEmployees: readonly Employee[],
    closed: ReadonlySet<ISODate>,
  ) => {
    // Same day and closed days need no rows.
    const quick = checkCardDrop({
      card: { kind: "shift", row },
      targetDate: date,
      closedDays: closed,
      shifts: [],
      timeOff: [],
      employees: allEmployees,
    });
    if (quick.kind === "noop") return;
    if (quick.kind === "blocked") {
      await refuse("shift", quick.message);
      return;
    }
    // Read fresh (C15), including the shift itself in case it changed since the calendar loaded.
    const rows = await fetchEditingRows({ employeeIds: [row.employee_id], dates: [date, row.shift_date] });
    const current = rows.shifts.find((s) => s.id === row.id);
    if (!current) {
      toast.show(ALREADY_REMOVED, "info");
      await invalidateAdminData(client);
      return;
    }
    const plan = checkCardDrop({
      card: { kind: "shift", row: current },
      targetDate: date,
      closedDays: closed,
      ...rows,
      employees: allEmployees,
    });
    if (plan.kind === "noop") return;
    if (plan.kind === "blocked") {
      await refuse("shift", plan.message);
      return;
    }
    if (!(await confirmPayrollHours(confirm, current.id, "move", date))) return;
    const change = await updateShift.mutateAsync({
      id: current.id,
      employeeId: current.employee_id,
      date,
      startTime: current.start_time,
      endTime: current.end_time,
    });
    undo.push({ label: "Move shift", change });
    toast.show(shiftMovedText(date), "success");
  };

  const moveDayOff = async (
    row: TimeOff,
    date: ISODate,
    allEmployees: readonly Employee[],
    closed: ReadonlySet<ISODate>,
  ) => {
    const quick = checkCardDrop({
      card: { kind: "time-off", row },
      targetDate: date,
      closedDays: closed,
      shifts: [],
      timeOff: [],
      employees: allEmployees,
    });
    if (quick.kind === "noop") return;
    if (quick.kind === "blocked") {
      await refuse("day off", quick.message);
      return;
    }
    const rows = await fetchEditingRows({ employeeIds: [row.employee_id], dates: [date, row.off_date] });
    const current = rows.timeOff.find((t) => t.id === row.id);
    if (!current || current.status !== "approved") {
      toast.show(ALREADY_REMOVED, "info");
      await invalidateAdminData(client);
      return;
    }
    const plan = checkCardDrop({
      card: { kind: "time-off", row: current },
      targetDate: date,
      closedDays: closed,
      ...rows,
      employees: allEmployees,
    });
    if (plan.kind === "noop") return;
    if (plan.kind === "blocked") {
      await refuse("day off", plan.message);
      return;
    }
    if (
      plan.confirmMessage !== null &&
      !(await confirmShiftDeletion(confirm, plan.confirmMessage, plan.deleteShiftIds))
    ) {
      return;
    }
    const change = await updateDayOff.mutateAsync({
      id: current.id,
      employeeId: current.employee_id,
      date,
      period: current.period,
      deleteShiftIds: plan.deleteShiftIds,
    });
    undo.push({ label: "Move day off", change });
    toast.show(dayOffMovedText(date, change.deleted.shifts.length), "success", { title: "Day Off Updated" });
  };

  const handleDrop: CalendarDragAndDrop["onDrop"] = ({ kind, id, date }) => {
    if (movingRef.current || !calendarData || !employees || !closedDays) return;
    const shift = kind === "shift" ? calendarData.shifts.find((s) => s.id === id) : undefined;
    const timeOff = kind === "time-off" ? calendarData.timeOff.find((t) => t.id === id) : undefined;
    // Only assigned days off move by drag (AM1); a requested one changes in the Edit dialog.
    if (!shift && !(timeOff && timeOff.status === "approved" && timeOff.source === "assigned")) return;

    movingRef.current = true;
    setMoving(true);
    const run = shift
      ? moveShift(shift, date, employees, closedDays).catch((caught: unknown) =>
          reportMoveError(caught, "shift", employees),
        )
      : timeOff
        ? moveDayOff(timeOff, date, employees, closedDays).catch((caught: unknown) =>
            reportMoveError(caught, "day off", employees),
          )
        : Promise.resolve();
    void run.finally(() => {
      movingRef.current = false;
      setMoving(false);
    });
  };

  const dragAndDrop: CalendarDragAndDrop | undefined = finePointer
    ? { canDrag: canDragCard, onDrop: handleDrop }
    : undefined;

  // ---------------------------------------------------------------------------
  // Reopen (C6): back to standard hours (H12), a shortcut for Day Hours → Standard hours.

  const reopen = async (date: ISODate) => {
    if (reopening.has(date)) return;
    setReopening((current) => new Set(current).add(date));
    try {
      const change = await setStandardHours.mutateAsync({ dates: [date] });
      if (isEmptyChange(change)) {
        toast.show(ALREADY_REMOVED, "info");
      } else {
        // "Reopen Oct 9", or "Set standard hours for Oct 9" when someone reopened it first
        // but it had custom hours, and those were cleared.
        const text = hoursSaveText([date], change, null);
        undo.push({ label: text.label, change });
        toast.show(text.message, "success", { title: text.title });
      }
    } catch (caught) {
      toast.show(adminErrorMessage(caught, REOPEN_FALLBACK), "error");
    } finally {
      setReopening((current) => {
        const next = new Set(current);
        next.delete(date);
        return next;
      });
      // The Reopen button is replaced by "+ Add"; keep keyboard focus in that day.
      keepFocusOnDay(date, ".admin-day-add");
    }
  };

  const renderDayFooter = (day: CalendarDay): ReactNode => {
    const label = formatDayLabel(day.date, "mobile");
    if (day.closed) {
      const busy = reopening.has(day.date);
      return (
        <Button
          variant="secondary"
          size="sm"
          className="admin-day-reopen"
          aria-label={`Reopen day, ${label}`}
          aria-disabled={busy || undefined}
          onClick={() => void reopen(day.date)}
        >
          {busy ? "Reopening..." : "Reopen day"}
        </Button>
      );
    }
    return (
      <button
        type="button"
        className="admin-day-add"
        aria-label={`Add to ${label}`}
        onClick={() => setAddDate(day.date)}
      >
        + Add
      </button>
    );
  };

  // ---------------------------------------------------------------------------

  const queries = [employeesQuery, calendarQuery, closedQuery];
  const failed = queries.filter((query) => query.isError && query.data === undefined);
  // A refetch (after a change, or on focus) that failed keeps the old rows on screen. The
  // hours never block the calendar, but a failed refresh of them is reported the same way.
  const outdated = [...queries, hours.weekly, hours.custom].filter(
    (query) => query.isError && query.data !== undefined,
  );
  const busy = calendarQuery.isPlaceholderData;

  let content: ReactNode;
  if (failed.length > 0) {
    content = (
      <div className="admin-schedule-status" role="alert">
        <p className="admin-schedule-error">Unable to load schedule. Please refresh the page.</p>
        <Button variant="primary" onClick={() => failed.forEach((query) => void query.refetch())}>
          Retry
        </Button>
      </div>
    );
  } else if (!days) {
    content = (
      <div className="admin-schedule-status">
        <Spinner size="lg" label="Loading..." showLabel />
      </div>
    );
  } else {
    content = (
      <>
        {busy || moving ? (
          <div className="admin-schedule-refreshing">
            <Spinner size="sm" label={moving ? "Moving..." : "Loading dates..."} />
          </div>
        ) : null}
        <CalendarGrid
          days={days}
          loading={busy}
          onOpenCard={openCard}
          renderDayFooter={renderDayFooter}
          dragAndDrop={dragAndDrop}
          onOpenDay={setHoursDate}
        />
      </>
    );
  }

  return (
    <div className="admin-main">
      <AdminSidebar />
      <main className="admin-area">
        <PeriodNav range={range} onRangeChange={view.setRange} />
        {/* Stays mounted so the warning is announced when it appears. */}
        <div className="admin-schedule-outdated-region" role="status">
          {failed.length === 0 && outdated.length > 0 ? (
            <div className="admin-schedule-outdated">
              <p>Couldn't refresh the schedule, so it may be out of date.</p>
              <Button size="sm" onClick={() => outdated.forEach((query) => void query.refetch())}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
        <section
          className={busy ? "admin-schedule-calendar admin-schedule-calendar-busy" : "admin-schedule-calendar"}
          aria-label="Schedule"
          aria-busy={busy || days === null || moving}
        >
          {content}
        </section>
      </main>
      <AddItemDialog date={addDate} onClose={closeAdd} />
      <DayHoursDialog date={hoursDate} onClose={closeHours} />
      <EditItemDialog target={editTarget} onClose={closeEdit} />
      <RequestReviewDialog target={reviewTarget} onClose={closeReview} />
    </div>
  );
}
