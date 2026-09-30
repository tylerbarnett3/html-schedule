import { createContext, useContext } from "react";
import type { ScheduleChange } from "../../../lib/scheduleChange";

export interface UndoApi {
  /** Records a calendar change the admin can undo. Changes that did nothing are ignored. */
  push(step: { label: string; change: ScheduleChange }): void;
  /** Reverses the newest step and shows a toast; never throws. */
  undo(): Promise<void>;
  canUndo: boolean;
  /** True while an undo is being saved. */
  running: boolean;
  /** Label of the step undo() would reverse, e.g. "Add 4 shifts". */
  nextLabel: string | null;
  clear(): void;
}

/** Provided by <UndoProvider> (./UndoProvider.tsx). */
export const UndoContext = createContext<UndoApi | null>(null);

export function useUndo(): UndoApi {
  const api = useContext(UndoContext);
  if (!api) throw new Error("useUndo must be used inside <UndoProvider>.");
  return api;
}
