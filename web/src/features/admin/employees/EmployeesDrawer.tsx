import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type Ref,
} from "react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import {
  employeeErrorMessage,
  useEmployeeLogins,
  useEmployeeRates,
  useReorderEmployees,
  useSetEmployeeArchived,
} from "../../../data/employees";
import { useCalendarData, useEmployees } from "../../../data/schedule";
import { useMediaQuery } from "../../../data/useMediaQuery";
import {
  activeEmployees,
  employeeRangeStats,
  formatEmployeeStats,
  NO_SHIFTS,
  reorderedIds,
} from "../../../lib/employees";
import { rateSummary, type EmployeeRate } from "../../../lib/rates";
import type { Employee } from "../../../lib/types";
import { DRAG_TYPE_EMPLOYEE, isEmployeeDrag } from "../dragTypes";
import { useAdminView } from "../useAdminView";
import { SidebarDrawer } from "../../schedule/SidebarDrawer";
import { EmployeeDialog, type EmployeeDialogTarget } from "./EmployeeDialog";
import { EmployeeRow, type RowLine } from "./EmployeeRow";
import "./EmployeesDrawer.css";

// Where focus goes once the list has re-rendered after a move, archive or delete: `key`
// names a registered control, and `ready` says when the list shows the change. A sticky
// request stays until its reorder has settled (a failed one re-renders the old order), or
// until focus moves somewhere else.
type FocusRequest = { key: string; ready(list: readonly Employee[]): boolean; sticky?: boolean };

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The admin sidebar's Employees drawer: add and edit employees, archive them, and set the
 * display order the calendar, filter and PDF use (EM, D7, E5-E12).
 */
export function EmployeesDrawer() {
  const view = useAdminView();
  const employeesQuery = useEmployees();
  const calendarQuery = useCalendarData(view.range);
  const ratesQuery = useEmployeeRates();
  const loginsQuery = useEmployeeLogins();
  const setArchived = useSetEmployeeArchived();
  const reorder = useReorderEmployees();
  const confirm = useConfirm();
  const toast = useToast();
  const canDrag = useMediaQuery("(pointer: fine)");

  const [open, setOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [dialog, setDialog] = useState<EmployeeDialogTarget | null>(null);
  const [drag, setDrag] = useState<{ id: string; overId: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The employee whose move just failed, until the list shows the restored order.
  const [failedMove, setFailedMove] = useState<{ id: string; name: string } | null>(null);
  const moveCount = useRef(0);
  const dragDepth = useRef(0);
  const archiving = useRef(false);
  const focusTargets = useRef(new Map<string, HTMLElement>());
  const focusRequest = useRef<FocusRequest | null>(null);

  const id = useId();
  const hintId = `${id}-reorder-hint`;
  const archivedListId = `${id}-archived`;

  const employees = employeesQuery.data;
  const active = useMemo(() => activeEmployees(employees ?? []), [employees]);
  const archived = useMemo(() => (employees ?? []).filter((e) => e.archived), [employees]);

  // A failed move has put the saved order back (and refetched it) by the time mutateAsync
  // rejects. Say where the employee is now, so the live region doesn't keep claiming the
  // move happened. Runs on the first render that shows that list.
  if (failedMove !== null && employees) {
    const position = active.findIndex((e) => e.id === failedMove.id);
    setFailedMove(null);
    setAnnouncement(
      position === -1
        ? `Couldn't move ${failedMove.name}.`
        : `Couldn't move ${failedMove.name}; back at position ${position + 1} of ${active.length}.`,
    );
  }

  // Stats come from the shifts on screen (E12). While the calendar still shows the
  // previous range, its shifts would give wrong numbers.
  const shifts = calendarQuery.data?.shifts;
  const stats = useMemo(() => (shifts ? employeeRangeStats(shifts, view.range) : null), [shifts, view.range]);
  const statsLoading = calendarQuery.isPlaceholderData || (!shifts && !calendarQuery.isError);
  const ratesByEmployee = useMemo(() => {
    const map = new Map<string, EmployeeRate[]>();
    for (const rate of ratesQuery.data ?? []) map.set(rate.employee_id, [...(map.get(rate.employee_id) ?? []), rate]);
    return map;
  }, [ratesQuery.data]);

  const statsLine = (employeeId: string): RowLine => {
    if (statsLoading) return "loading";
    if (!stats) return null;
    return formatEmployeeStats(stats.get(employeeId) ?? NO_SHIFTS);
  };

  const rateLine = (employeeId: string): RowLine => {
    if (ratesQuery.data) return rateSummary(ratesByEmployee.get(employeeId) ?? [], view.range);
    return ratesQuery.isError ? null : "loading";
  };

  const focusRef = useCallback(
    (key: string): Ref<HTMLButtonElement> =>
      (element) => {
        if (!element) return;
        focusTargets.current.set(key, element);
        return () => {
          if (focusTargets.current.get(key) === element) focusTargets.current.delete(key);
        };
      },
    [],
  );

  // Moving a row re-inserts its DOM node (or replaces it, for archive and delete), which
  // drops focus to the page. Put it back on the matching control once the list shows the
  // change. A passive effect, so a closing dialog has already given focus back (or not).
  useEffect(() => {
    const request = focusRequest.current;
    if (!request || !employees || dialog !== null || !request.ready(employees)) return;
    if (!request.sticky) focusRequest.current = null;
    const target = focusTargets.current.get(request.key);
    const current = document.activeElement;
    if (target && target !== current && (current === null || current === document.body)) target.focus();
  }, [employees, dialog]);

  useEffect(() => {
    const forget = (event: FocusEvent) => {
      const request = focusRequest.current;
      if (request && event.target !== focusTargets.current.get(request.key)) focusRequest.current = null;
    };
    document.addEventListener("focusin", forget);
    return () => document.removeEventListener("focusin", forget);
  }, []);

  const moveEmployee = (employee: Employee, to: number, focusKey: string | null) => {
    if (!employees) return;
    const from = active.findIndex((e) => e.id === employee.id);
    if (from === -1 || to < 0 || to >= active.length || from === to) return;
    const ids = reorderedIds(employees, from, to);
    const request: FocusRequest | null = focusKey ? { key: focusKey, ready: () => true, sticky: true } : null;
    focusRequest.current = request;
    const move = ++moveCount.current;
    setFailedMove(null);
    setAnnouncement(`${employee.name} moved to position ${to + 1} of ${active.length}.`);
    reorder
      .mutateAsync({ ids })
      .catch((error: unknown) => {
        toast.show(employeeErrorMessage(error, "reorder"), "error");
        // Only the last move rolls the list back; a later one carries this move too, and
        // its announcement stands.
        if (moveCount.current === move) setFailedMove({ id: employee.id, name: employee.name });
      })
      .finally(() => {
        // Let the settled list render first.
        setTimeout(() => {
          if (focusRequest.current === request) focusRequest.current = null;
        }, 0);
      });
  };

  const toggleArchive = async (employee: Employee) => {
    if (archiving.current) return;
    const archive = !employee.archived;
    if (archive) {
      const confirmed = await confirm({
        title: `Archive ${employee.name}?`,
        message: "They will no longer be available for new shifts.",
        confirmLabel: "Archive",
        cancelLabel: "Cancel",
        tone: "default",
      });
      if (!confirmed) return;
    }
    // Archived rows move into the collapsed group, so focus goes to its toggle; an
    // unarchived row comes back with an Archive button.
    focusRequest.current = {
      key: archive ? "archived-toggle" : `archive:${employee.id}`,
      ready: (list) => list.find((e) => e.id === employee.id)?.archived === archive,
    };
    archiving.current = true;
    try {
      const { updated } = await setArchived.mutateAsync({ id: employee.id, archived: archive });
      if (!updated) {
        focusRequest.current = null;
        toast.show("This employee was already removed.", "info");
        return;
      }
      toast.show(archive ? `${employee.name} archived.` : `${employee.name} unarchived.`, "success");
    } catch (error) {
      focusRequest.current = null;
      toast.show(employeeErrorMessage(error, "archive"), "error");
    } finally {
      archiving.current = false;
    }
  };

  // Drag and drop among the active employees (C3): only this list's own drags count.
  const rowOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>("[data-employee-id]") : null;

  const endDrag = () => {
    dragDepth.current = 0;
    setDrag(null);
  };

  const handleDragStart = (event: DragEvent<HTMLOListElement>) => {
    const row = rowOf(event.target);
    const employeeId = row?.dataset.employeeId;
    if (!canDrag || !employeeId) return;
    event.dataTransfer.setData(DRAG_TYPE_EMPLOYEE, employeeId);
    event.dataTransfer.effectAllowed = "move";
    dragDepth.current = 0;
    setDrag({ id: employeeId, overId: null });
  };

  const accepts = (event: DragEvent<HTMLOListElement>) => drag !== null && isEmployeeDrag(event.dataTransfer.types);

  const handleDragOver = (event: DragEvent<HTMLOListElement>) => {
    if (!accepts(event)) return;
    const overId = rowOf(event.target)?.dataset.employeeId;
    if (!overId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (drag && drag.overId !== overId) setDrag({ ...drag, overId });
  };

  const handleDragEnter = (event: DragEvent<HTMLOListElement>) => {
    if (accepts(event)) dragDepth.current += 1;
  };

  const handleDragLeave = (event: DragEvent<HTMLOListElement>) => {
    if (!accepts(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0 && drag?.overId) setDrag({ ...drag, overId: null });
  };

  const handleDrop = (event: DragEvent<HTMLOListElement>) => {
    if (!accepts(event)) return;
    event.preventDefault();
    const draggedId = event.dataTransfer.getData(DRAG_TYPE_EMPLOYEE) || drag?.id;
    const overId = rowOf(event.target)?.dataset.employeeId;
    endDrag();
    const dragged = active.find((e) => e.id === draggedId);
    const to = active.findIndex((e) => e.id === overId);
    if (dragged && to !== -1) moveEmployee(dragged, to, null);
  };

  const dropPosition = (employeeId: string, position: number): "before" | "after" | null => {
    if (!drag || drag.overId !== employeeId || drag.id === employeeId) return null;
    const from = active.findIndex((e) => e.id === drag.id);
    if (from === -1) return null;
    return position < from ? "before" : "after";
  };

  const rowProps = (employee: Employee) => ({
    employee,
    stats: statsLine(employee.id),
    rate: rateLine(employee.id),
    hasLogin: loginsQuery.data?.has(employee.id),
    onEdit: () => setDialog({ mode: "edit", employeeId: employee.id }),
    onToggleArchive: () => void toggleArchive(employee),
    focusRef: (control: string) => focusRef(`${control}:${employee.id}`),
  });

  let content;
  if (employees === undefined) {
    content = employeesQuery.isError ? (
      <div className="employees-status">
        <p className="employees-error">Unable to load employees.</p>
        <Button variant="secondary" size="sm" onClick={() => void employeesQuery.refetch()}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="employees-status">
        <Spinner size="sm" label="Loading employees..." />
      </div>
    );
  } else if (employees.length === 0) {
    content = <p className="employees-empty">No employees added yet</p>;
  } else {
    content = (
      <>
        {active.length > 0 ? (
          <ol
            className="employees-list"
            aria-label="Employees in display order"
            onDragStart={handleDragStart}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onDragEnd={endDrag}
          >
            {active.map((employee, position) => (
              <EmployeeRow
                key={employee.id}
                {...rowProps(employee)}
                reorder={{
                  position,
                  count: active.length,
                  mode: canDrag ? "handle" : "buttons",
                  hintId,
                  onMove: (to, focus) => {
                    // A move button that just became disabled can't keep focus; use the other one.
                    let control: string = focus;
                    if (focus === "up" && to === 0) control = "down";
                    if (focus === "down" && to === active.length - 1) control = "up";
                    moveEmployee(employee, to, `${control}:${employee.id}`);
                  },
                }}
                draggable={canDrag}
                dragging={drag?.id === employee.id}
                dropPosition={dropPosition(employee.id, position)}
              />
            ))}
          </ol>
        ) : null}
        {archived.length > 0 ? (
          <div className="employees-archived">
            <button
              ref={focusRef("archived-toggle")}
              type="button"
              className="employees-archived-toggle"
              aria-expanded={archivedOpen}
              aria-controls={archivedListId}
              onClick={() => setArchivedOpen(!archivedOpen)}
            >
              <span>Archived ({archived.length})</span>
              <span className="employees-archived-chevron" aria-hidden="true">
                ▼
              </span>
            </button>
            <ul id={archivedListId} className="employees-list employees-archived-list" hidden={!archivedOpen}>
              {archived.map((employee) => (
                <EmployeeRow
                  key={employee.id}
                  {...rowProps(employee)}
                  reorder={null}
                  draggable={false}
                  dragging={false}
                  dropPosition={null}
                />
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <SidebarDrawer title="Employees" open={open} onOpenChange={setOpen}>
        <div className="employees-drawer">
          {/* The Button look on a plain button, which can take a ref. */}
          <button
            ref={focusRef("add-employee")}
            type="button"
            className="btn btn-primary btn-md employees-add"
            onClick={() => setDialog({ mode: "add" })}
          >
            <PlusIcon />
            Add Employee
          </button>
          {content}
          <p id={hintId} hidden>
            Press the up or down arrow key to move this employee.
          </p>
          <p className="visually-hidden" aria-live="polite">
            {announcement}
          </p>
        </div>
      </SidebarDrawer>
      <EmployeeDialog
        target={dialog}
        onClose={() => setDialog(null)}
        onDeleted={(employeeId) => {
          focusRequest.current = {
            key: "add-employee",
            ready: (list) => !list.some((e) => e.id === employeeId),
          };
        }}
      />
    </>
  );
}
