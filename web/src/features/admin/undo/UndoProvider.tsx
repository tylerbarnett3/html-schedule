import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "../../../components/useToast";
import { adminErrorCode, adminErrorMessage } from "../../../data/errors";
import { useUndoChange } from "../../../data/adminSchedule";
import { useAuth } from "../../../lib/auth";
import type { ScheduleChange } from "../../../lib/scheduleChange";
import { pushStep, type UndoStep } from "../../../lib/undoStack";
import { UndoContext, type UndoApi } from "./useUndo";

/**
 * The session's undo history for calendar edits (§6). It lives above the admin routes, so it
 * survives a trip to Payroll; it is gone after a reload, and cleared when someone else signs in.
 */
export function UndoProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const auth = useAuth();
  const userId = auth.status === "signed-in" ? auth.session.user.id : null;
  const { mutateAsync } = useUndoChange();

  const [stack, setStack] = useState<UndoStep[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const nextId = useRef(1);

  // Another login on the same tab must not undo the previous admin's changes.
  const [stackOwner, setStackOwner] = useState(userId);
  if (stackOwner !== userId) {
    setStackOwner(userId);
    setStack([]);
  }

  const push = useCallback((step: { label: string; change: ScheduleChange }) => {
    const id = nextId.current++;
    setStack((current) => pushStep(current, { id, label: step.label, change: step.change }));
  }, []);

  const clear = useCallback(() => setStack([]), []);

  const top = stack.length > 0 ? stack[stack.length - 1] : null;

  const undo = useCallback(async () => {
    if (!top || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    // Removed by id: other edits may have added steps while this one was saving.
    const remove = () => setStack((current) => current.filter((step) => step.id !== top.id));
    try {
      await mutateAsync({ change: top.change });
      remove();
      toast.show(top.label, "success", { title: "Undone" });
    } catch (error) {
      if (adminErrorCode(error) === "undo_stale") {
        // It will never succeed now, so don't offer it again.
        remove();
        toast.show(adminErrorMessage(error, "There was an error saving your changes."), "info");
      } else {
        toast.show(adminErrorMessage(error, "There was an error saving your changes."), "error");
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [top, mutateAsync, toast]);

  const api = useMemo<UndoApi>(
    () => ({ push, undo, canUndo: top !== null, running, nextLabel: top?.label ?? null, clear }),
    [push, undo, top, running, clear],
  );

  return <UndoContext.Provider value={api}>{children}</UndoContext.Provider>;
}
