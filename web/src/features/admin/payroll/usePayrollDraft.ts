import { useCallback, useMemo, useState } from "react";
import {
  applyRowAction,
  compareDraftRows,
  planActualsSave,
  rowsEqual,
  type ActualOnlyRow,
  type ActualsSavePlan,
  type DraftRow,
  type RowAction,
} from "../../../lib/payroll";
import type { ISODate } from "../../../lib/types";

/**
 * Unsaved edits, kept apart from the saved rows so a refetch (window focus, another save)
 * never wipes them: edited rows by key, rows added here, and saved rows removed here.
 */
interface Overlay {
  edits: ReadonlyMap<string, DraftRow>;
  added: readonly ActualOnlyRow[];
  removed: ReadonlyMap<string, ActualOnlyRow>;
}

const EMPTY: Overlay = { edits: new Map(), added: [], removed: new Map() };

/** An edit laid over the latest saved row: the user's values, the server's shift and record. */
function rebase(edit: DraftRow, base: DraftRow): DraftRow {
  if (edit.kind === "scheduled" && base.kind === "scheduled") return { ...edit, shift: base.shift, saved: base.saved };
  if (edit.kind === "actual-only" && base.kind === "actual-only") {
    return { ...edit, saved: base.saved, orphan: base.orphan, origin: base.origin, date: base.date };
  }
  return base;
}

export interface PayrollDraft {
  /** The rows as edited, sorted. */
  rows: DraftRow[];
  pristineByKey: ReadonlyMap<string, DraftRow>;
  plan: ActualsSavePlan;
  dirty: boolean;
  apply(key: string, action: RowAction): void;
  /** Back to the last-saved row; an added row that was never saved goes away (P6). */
  reset(key: string): void;
  /** Drops actual-only work; saved work is deleted on save. */
  remove(key: string): void;
  add(row: ActualOnlyRow): void;
  clear(): void;
}

export function usePayrollDraft(pristine: readonly DraftRow[], today: ISODate): PayrollDraft {
  const [overlay, setOverlay] = useState<Overlay>(EMPTY);
  const pristineByKey = useMemo(() => new Map(pristine.map((row) => [row.key, row])), [pristine]);

  const rows = useMemo(() => {
    const merged = pristine
      .filter((row) => !overlay.removed.has(row.key))
      .map((row) => {
        const edit = overlay.edits.get(row.key);
        return edit ? rebase(edit, row) : row;
      });
    return [...merged, ...overlay.added].sort(compareDraftRows);
  }, [pristine, overlay]);

  // A removal only counts while the saved row still exists.
  const plan = useMemo(() => {
    const removed = [...overlay.removed.values()].filter((row) => pristineByKey.has(row.key));
    return planActualsSave(rows, removed);
  }, [rows, overlay.removed, pristineByKey]);

  const apply = useCallback(
    (key: string, action: RowAction) => {
      setOverlay((current) => {
        const addedIndex = current.added.findIndex((row) => row.key === key);
        if (addedIndex >= 0) {
          const row = current.added[addedIndex];
          const next = applyRowAction(row, action, today);
          if (next === row || next.kind !== "actual-only") return current;
          return { ...current, added: current.added.map((item, i) => (i === addedIndex ? next : item)) };
        }
        const base = pristineByKey.get(key);
        if (!base || current.removed.has(key)) return current;
        const edit = current.edits.get(key);
        const row = edit ? rebase(edit, base) : base;
        const next = applyRowAction(row, action, today);
        if (next === row) return current;
        const edits = new Map(current.edits);
        if (rowsEqual(next, base)) edits.delete(key);
        else edits.set(key, next);
        return { ...current, edits };
      });
    },
    [pristineByKey, today],
  );

  const reset = useCallback((key: string) => {
    setOverlay((current) => {
      if (current.added.some((row) => row.key === key)) {
        return { ...current, added: current.added.filter((row) => row.key !== key) };
      }
      if (!current.edits.has(key)) return current;
      const edits = new Map(current.edits);
      edits.delete(key);
      return { ...current, edits };
    });
  }, []);

  const remove = useCallback(
    (key: string) => {
      setOverlay((current) => {
        if (current.added.some((row) => row.key === key)) {
          return { ...current, added: current.added.filter((row) => row.key !== key) };
        }
        const base = pristineByKey.get(key);
        if (!base || base.kind !== "actual-only") return current;
        const edits = new Map(current.edits);
        edits.delete(key);
        const removed = new Map(current.removed);
        removed.set(key, base);
        return { edits, added: current.added, removed };
      });
    },
    [pristineByKey],
  );

  const add = useCallback((row: ActualOnlyRow) => {
    setOverlay((current) => ({ ...current, added: [...current.added, row] }));
  }, []);

  const clear = useCallback(() => setOverlay(EMPTY), []);

  return { rows, pristineByKey, plan, dirty: plan.changeCount > 0, apply, reset, remove, add, clear };
}
