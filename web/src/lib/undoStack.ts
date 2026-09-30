// The admin page's undo history: calendar changes from this session, newest last.

import { isEmptyChange, type ScheduleChange } from "./scheduleChange";

export const MAX_UNDO_STEPS = 20;

export interface UndoStep {
  id: number;
  label: string;
  change: ScheduleChange;
}

/** Adds a step on top. A change that did nothing isn't worth an Undo; the oldest steps drop off past 20. */
export function pushStep(stack: readonly UndoStep[], step: UndoStep): UndoStep[] {
  if (isEmptyChange(step.change)) return [...stack];
  return [...stack, step].slice(-MAX_UNDO_STEPS);
}

/** The stack without its newest step. */
export function dropTop(stack: readonly UndoStep[]): UndoStep[] {
  return stack.slice(0, -1);
}
