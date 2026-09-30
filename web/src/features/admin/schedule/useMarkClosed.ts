import { useCallback } from "react";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import { fetchCloseDayCounts, useCloseDays } from "../../../data/adminSchedule";
import { undoableCloseChange } from "../../../lib/scheduleChange";
import { closeDaysConfirm, closedDaysText } from "../../../lib/scheduleEditing";
import type { ISODate } from "../../../lib/types";
import { useUndo } from "../undo/useUndo";
import { alreadyClosedText, closeDaysLabel } from "./scheduleText";

export interface MarkClosedHooks {
  /** False once the dialog that asked has gone; nothing more is asked or written then. */
  isMounted(): boolean;
  /** The dialog's busy state: off while the confirm is open, so focus can come back to its button. */
  setWorking(busy: boolean): void;
}

export type MarkClosed = (dates: ISODate[], hooks: MarkClosedHooks) => Promise<"done" | "cancelled">;

/**
 * Closing days, shared by "+ Add" (Hours → Closed) and the Day Hours dialog: the same
 * confirm (with the counts of shifts and time off it deletes, read fresh), the same undo step
 * and the same toasts. Custom hours on the days are cleared too, and Undo restores them.
 * "done" means the days are closed (or all were already); errors propagate to the caller.
 */
export function useMarkClosed(): MarkClosed {
  const confirm = useConfirm();
  const toast = useToast();
  const { push } = useUndo();
  const { mutateAsync: closeDays } = useCloseDays();

  return useCallback(
    async (dates, { isMounted, setWorking }) => {
      const ask = closeDaysConfirm(dates, await fetchCloseDayCounts(dates));
      if (!isMounted()) return "cancelled";
      if (ask) {
        // Not busy while asking, so focus can come back to the button afterwards.
        setWorking(false);
        const ok = await confirm({ ...ask, confirmLabel: "Mark Closed", cancelLabel: "Cancel", tone: "danger" });
        if (!ok || !isMounted()) return "cancelled";
        setWorking(true);
      }
      const change = await closeDays({ dates });
      const closedCount = change.inserted.closed_days.length;
      // Days that were closed already can be picked; what the close clears off them can't be
      // undone (and when every day was closed already, there is nothing to undo, so no step
      // is added).
      push({ label: closeDaysLabel(closedCount), change: undoableCloseChange(change) });
      if (closedCount > 0) {
        toast.show(closedDaysText(closedCount), "success", { title: "Closed for Business" });
      } else {
        toast.show(alreadyClosedText(dates.length), "info");
      }
      return "done";
    },
    [confirm, toast, push, closeDays],
  );
}
