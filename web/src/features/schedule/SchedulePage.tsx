import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { AppHeader } from "../../app/AppHeader";
import { Button } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import { useConfirm } from "../../components/useConfirm";
import { useToast } from "../../components/useToast";
import { requestErrorMessage, useCancelAvailability, useCancelTimeOff } from "../../data/requests";
import { useCalendarData, useClosedDays, useEmployees } from "../../data/schedule";
import { useBusinessToday } from "../../data/useBusinessToday";
import { usePersistentState } from "../../data/usePersistentState";
import { useAuth } from "../../lib/auth";
import { buildCalendarDays } from "../../lib/calendar";
import { defaultRange, formatShortDate } from "../../lib/dates";
import type { DateRange, ISODate } from "../../lib/types";
import { CalendarGrid } from "./CalendarGrid";
import type { CancellableCard } from "./DayCard";
import { PeriodNav } from "./PeriodNav";
import { RequestDialog, type RequestDialogKind } from "./RequestDialog";
import { Sidebar } from "./Sidebar";
import "./SchedulePage.css";

// Deselected ids are stored (not selected ones) so employees added later show by default.
const HIDDEN_EMPLOYEES_KEY = "schedule.employeeFilter.v1";
const SHOW_TIME_OFF_KEY = "schedule.showTimeOff.v1";
const SHOW_AVAILABILITY_KEY = "schedule.showAvailability.v1";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The submit fallback ("…submitting…") doesn't fit a cancel; reuse only the specific wording. */
function cancelErrorMessage(error: unknown): string {
  const message = requestErrorMessage(error, "time-off");
  return message === requestErrorMessage(null, "time-off")
    ? "Couldn't cancel the request. Please try again."
    : message;
}

/** Puts keyboard focus on a day's heading when the focused Cancel button went away with its card. */
function keepFocusNear(date: ISODate): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
  document.querySelector<HTMLElement>(`[data-date="${date}"] .calendar-day-header`)?.focus();
}

export function SchedulePage() {
  const auth = useAuth();
  const profile = auth.status === "signed-in" ? auth.profile : null;
  const employee = profile?.employee ?? null;
  const today = useBusinessToday();
  const confirm = useConfirm();
  const toast = useToast();

  const [range, setRange] = useState<DateRange>(() => defaultRange(today));
  const [showTimeOff, setShowTimeOff] = usePersistentState(SHOW_TIME_OFF_KEY, true);
  const [showAvailability, setShowAvailability] = usePersistentState(SHOW_AVAILABILITY_KEY, true);
  const [hiddenIds, setHiddenIds] = usePersistentState<string[]>(HIDDEN_EMPLOYEES_KEY, [], isStringArray);
  const [dialog, setDialog] = useState<RequestDialogKind | null>(null);
  // Rows whose cancel is in flight. Each row is independent, so several can run at once.
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(() => new Set());
  const cancelling = useRef(new Set<string>());

  const employeesQuery = useEmployees();
  const calendarQuery = useCalendarData(range);
  const closedQuery = useClosedDays();
  const cancelTimeOff = useCancelTimeOff();
  const cancelAvailability = useCancelAvailability();

  const employees = employeesQuery.data;
  const calendarData = calendarQuery.data;
  const closedDays = closedQuery.data;

  const selectedIds = useMemo(() => {
    const hidden = new Set(hiddenIds);
    return new Set((employees ?? []).filter((e) => !hidden.has(e.id)).map((e) => e.id));
  }, [employees, hiddenIds]);

  const meId = employee?.id ?? null;
  // While a new range loads, calendarData still holds the previous range's rows. The grid
  // shows the new range's dates right away (so they match the period heading): days the
  // old rows cover keep their cards, the rest show a loading placeholder.
  const days = useMemo(() => {
    if (!employees || !calendarData || !closedDays) return null;
    return buildCalendarDays({
      range,
      today,
      employees,
      shifts: calendarData.shifts,
      timeOff: calendarData.timeOff,
      availability: calendarData.availability,
      closedDays,
      selectedEmployeeIds: selectedIds,
      showTimeOff,
      showAvailability,
      meId,
    });
  }, [range, today, employees, calendarData, closedDays, selectedIds, showTimeOff, showAvailability, meId]);

  const toggleEmployee = (id: string, selected: boolean) => {
    const known = new Set((employees ?? []).map((e) => e.id));
    // Drop ids of employees that no longer exist while we're here.
    setHiddenIds((current) => {
      const rest = current.filter((hiddenId) => hiddenId !== id && known.has(hiddenId));
      return selected ? rest : [...rest, id];
    });
  };

  const closeDialog = useCallback(() => setDialog(null), []);

  const setCancelling = (id: string, running: boolean) => {
    if (running) cancelling.current.add(id);
    else cancelling.current.delete(id);
    setCancellingIds(new Set(cancelling.current));
  };

  const handleCancel = async (card: CancellableCard) => {
    const id = card.row.id;
    if (cancelling.current.has(id)) return;
    const isTimeOff = card.kind === "pending-time-off";
    const date = isTimeOff ? card.row.off_date : card.row.available_date;
    const when = formatShortDate(date);
    const confirmed = await confirm({
      title: "Cancel request?",
      message: isTimeOff
        ? `Cancel your ${card.row.period} time-off request for ${when}?`
        : `Cancel your ${card.row.period} availability for ${when}?`,
      confirmLabel: "Cancel request",
      cancelLabel: "Keep it",
      tone: "danger",
    });
    if (!confirmed || cancelling.current.has(id)) return;

    setCancelling(id, true);
    try {
      // Resolves after the calendar has been refetched (see src/data/requests.ts).
      const { deleted } = await (isTimeOff ? cancelTimeOff : cancelAvailability).mutateAsync({ id });
      if (deleted) {
        toast.show(isTimeOff ? "Time-off request cancelled." : "Availability request cancelled.", "success");
      } else {
        toast.show("This request was already reviewed or removed.", "info");
      }
    } catch (error) {
      toast.show(cancelErrorMessage(error), "error");
    } finally {
      setCancelling(id, false);
      // Runs after the refreshed calendar has rendered.
      window.setTimeout(() => keepFocusNear(date), 0);
    }
  };

  let actions: ReactNode = null;
  if (employee && !employee.archived) {
    actions = (
      <>
        <Button variant="gold" onClick={() => setDialog("time-off")}>
          Request Time Off
        </Button>
        <Button variant="gold" onClick={() => setDialog("availability")}>
          Request Availability
        </Button>
      </>
    );
  } else if (employee) {
    actions = (
      <p className="schedule-header-note">
        Requests are off because your employee record is archived. Ask your manager.
      </p>
    );
  } else if (profile?.isAdmin) {
    actions = <p className="schedule-header-note">Signed in as admin — requests are for employee logins.</p>;
  }

  const queries = [employeesQuery, calendarQuery, closedQuery];
  const failed = queries.filter((query) => query.isError && query.data === undefined);
  // A refetch (after a request, or on focus) that failed keeps the old rows on screen.
  const outdated = queries.filter((query) => query.isError && query.data !== undefined);
  const busy = calendarQuery.isPlaceholderData;

  let content: ReactNode;
  if (failed.length > 0) {
    content = (
      <div className="schedule-status" role="alert">
        <p className="schedule-error">Unable to load schedule. Please refresh the page.</p>
        <Button variant="primary" onClick={() => failed.forEach((query) => void query.refetch())}>
          Retry
        </Button>
      </div>
    );
  } else if (!days) {
    content = (
      <div className="schedule-status">
        <Spinner size="lg" label="Loading..." showLabel />
      </div>
    );
  } else {
    content = (
      <>
        {busy ? (
          <div className="schedule-refreshing">
            <Spinner size="sm" label="Loading dates..." />
          </div>
        ) : null}
        <CalendarGrid days={days} loading={busy} onCancel={handleCancel} cancellingIds={cancellingIds} />
      </>
    );
  }

  return (
    <>
      <AppHeader actions={actions} />
      <div className="schedule-main">
        <Sidebar
          showTimeOff={showTimeOff}
          onShowTimeOffChange={setShowTimeOff}
          showAvailability={showAvailability}
          onShowAvailabilityChange={setShowAvailability}
          employees={employees}
          selectedIds={selectedIds}
          onToggleEmployee={toggleEmployee}
          onSelectAll={() => setHiddenIds([])}
          onClearAll={() => setHiddenIds((employees ?? []).map((e) => e.id))}
        />
        <main className="schedule-area">
          <PeriodNav range={range} onRangeChange={setRange} />
          {/* Stays mounted so the warning is announced when it appears. */}
          <div className="schedule-outdated-region" role="status">
            {failed.length === 0 && outdated.length > 0 ? (
              <div className="schedule-outdated">
                <p>Couldn't refresh the schedule, so it may be out of date.</p>
                <Button size="sm" onClick={() => outdated.forEach((query) => void query.refetch())}>
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
          <section
            className={busy ? "schedule-calendar schedule-calendar-busy" : "schedule-calendar"}
            aria-label="Schedule"
            aria-busy={busy || days === null}
          >
            {content}
          </section>
        </main>
      </div>
      {employee && !employee.archived ? (
        <RequestDialog
          kind={dialog ?? "time-off"}
          open={dialog !== null}
          onClose={closeDialog}
          employee={employee}
          today={today}
        />
      ) : null}
    </>
  );
}
