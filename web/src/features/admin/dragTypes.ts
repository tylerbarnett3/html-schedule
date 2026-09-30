// Drag-and-drop data types for the admin page (decision C3). The payload is the row id.
// Day bodies accept only the shift and time-off types; the employee list only the employee
// type, so dragging one kind never highlights the other's drop targets.

export const DRAG_TYPE_SHIFT = "application/x-mad-potter-shift";
export const DRAG_TYPE_TIME_OFF = "application/x-mad-potter-time-off";
export const DRAG_TYPE_EMPLOYEE = "application/x-mad-potter-employee";

export type CalendarDragKind = "shift" | "time-off";

export const CALENDAR_DRAG_TYPES: Readonly<Record<CalendarDragKind, string>> = {
  shift: DRAG_TYPE_SHIFT,
  "time-off": DRAG_TYPE_TIME_OFF,
};

/**
 * Which calendar item a drag carries, from its types list. During dragenter/dragover only
 * the types can be read (not the data), so this is how drop targets decide to light up.
 */
export function calendarDragKind(types: readonly string[]): CalendarDragKind | null {
  if (types.includes(DRAG_TYPE_SHIFT)) return "shift";
  if (types.includes(DRAG_TYPE_TIME_OFF)) return "time-off";
  return null;
}

export function isEmployeeDrag(types: readonly string[]): boolean {
  return types.includes(DRAG_TYPE_EMPLOYEE);
}
