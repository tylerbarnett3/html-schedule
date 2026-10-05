import { describe, expect, it } from "vitest";
import { applyReviews, shiftsAsShown, type ShiftReview } from "./reviewedShifts";
import type { Shift } from "./types";

const D = "2026-09-28";

function shift(id: string, employee_id = "e-avery"): Shift {
  return { id, employee_id, shift_date: D, start_time: "09:00:00", end_time: "17:00:00" };
}

function review(id: string, extra: Partial<ShiftReview> = {}): ShiftReview {
  return {
    id,
    shift_id: null,
    employee_id: "e-avery",
    work_date: D,
    start_time: "09:00:00",
    end_time: "17:00:00",
    status: "confirmed",
    ...extra,
  };
}

describe("applyReviews", () => {
  it("swaps each reviewed shift for what payroll recorded", () => {
    const shifts = [shift("s1"), shift("s2"), shift("s3"), shift("s4")];
    const { scheduled, reviewed } = applyReviews(shifts, [
      review("a1", { shift_id: "s1" }),
      review("a2", { shift_id: "s2", status: "adjusted", employee_id: "e-mia", start_time: "10:00:00" }),
      review("a3", { shift_id: "s3", status: "not-worked", start_time: null, end_time: null }),
    ]);
    expect(scheduled.map((s) => s.id)).toEqual(["s4"]);
    expect(reviewed).toEqual([
      { id: "a1", employee_id: "e-avery", shift_date: D, start_time: "09:00:00", end_time: "17:00:00" },
      { id: "a2", employee_id: "e-mia", shift_date: D, start_time: "10:00:00", end_time: "17:00:00" },
    ]);
  });

  it("adds unscheduled work and records whose shift is gone, dated by the record", () => {
    const { scheduled, reviewed } = applyReviews(
      [shift("s1")],
      [
        review("a1", { status: "unscheduled", work_date: "2026-09-29" }),
        review("a2", { status: "adjusted", start_time: "12:00:00" }),
      ],
    );
    expect(scheduled.map((s) => s.id)).toEqual(["s1"]);
    expect(reviewed.map((s) => [s.id, s.shift_date, s.start_time])).toEqual([
      ["a1", "2026-09-29", "09:00:00"],
      ["a2", D, "12:00:00"],
    ]);
  });

  it("hides a shift whose record has moved to another date", () => {
    const { scheduled, reviewed } = applyReviews(
      [shift("s1")],
      [review("a1", { shift_id: "s1", work_date: "2026-09-30" })],
    );
    expect(scheduled).toEqual([]);
    expect(reviewed.map((s) => s.shift_date)).toEqual(["2026-09-30"]);
  });
});

describe("shiftsAsShown", () => {
  it("lists the scheduled shifts left and the reviewed ones", () => {
    const shown = shiftsAsShown(
      [shift("s1"), shift("s2"), shift("s3")],
      [
        review("a1", { shift_id: "s1", start_time: "08:00:00" }),
        review("a2", { shift_id: "s2", status: "not-worked", start_time: null, end_time: null }),
      ],
    );
    expect(shown.map((s) => [s.id, s.start_time])).toEqual([
      ["s3", "09:00:00"],
      ["a1", "08:00:00"],
    ]);
  });
});
