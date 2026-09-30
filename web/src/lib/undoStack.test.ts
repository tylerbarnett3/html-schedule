import { describe, expect, it } from "vitest";
import { emptyChange, reopenChange } from "./scheduleChange";
import { dropTop, MAX_UNDO_STEPS, pushStep, type UndoStep } from "./undoStack";

function step(id: number): UndoStep {
  return { id, label: `Reopen step ${id}`, change: reopenChange(["2026-10-09"]) };
}

describe("pushStep", () => {
  it("adds the newest step on top", () => {
    const stack = pushStep(pushStep([], step(1)), step(2));
    expect(stack.map((s) => s.id)).toEqual([1, 2]);
  });

  it("keeps only the newest 20 steps", () => {
    let stack: UndoStep[] = [];
    for (let id = 1; id <= 25; id++) stack = pushStep(stack, step(id));
    expect(MAX_UNDO_STEPS).toBe(20);
    expect(stack).toHaveLength(20);
    expect(stack[0].id).toBe(6);
    expect(stack[19].id).toBe(25);
  });

  it("ignores a change that did nothing", () => {
    const stack = [step(1)];
    const next = pushStep(stack, { id: 2, label: "Close 0 days", change: emptyChange() });
    expect(next.map((s) => s.id)).toEqual([1]);
  });

  it("doesn't change the stack it was given", () => {
    const stack: readonly UndoStep[] = [step(1)];
    pushStep(stack, step(2));
    expect(stack).toHaveLength(1);
  });
});

describe("dropTop", () => {
  it("removes the newest step", () => {
    expect(dropTop([step(1), step(2)]).map((s) => s.id)).toEqual([1]);
    expect(dropTop([])).toEqual([]);
  });
});
