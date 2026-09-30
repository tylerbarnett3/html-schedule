import { describe, expect, it } from "vitest";
import type { Employee } from "../../../lib/types";
import {
  addDaysOffLabel,
  addShiftsLabel,
  alreadyClosedText,
  closeDaysLabel,
  dayOffMovedText,
  daysOffAddedText,
  failureTone,
  pendingRequestDetail,
  reopenLabel,
  scheduleError,
  shiftMovedText,
  shiftsAddedText,
  withRemovedShifts,
} from "./scheduleText";

const employees: Employee[] = [
  { id: "n", name: "Nora Patel", color: "#C05621", display_order: 5, archived: false },
  { id: "a", name: "Avery Lane", color: "#7F6C50", display_order: 0, archived: false },
];

// Supabase hands errors back as plain objects.
const dbError = (message: string, code: string, details = "") => ({ message, code, details, hint: "" });

describe("undo labels", () => {
  it("counts shifts, days off and closed days", () => {
    expect(addShiftsLabel(1)).toBe("Add 1 shift");
    expect(addShiftsLabel(4)).toBe("Add 4 shifts");
    expect(addDaysOffLabel(1)).toBe("Add 1 day off");
    expect(addDaysOffLabel(3)).toBe("Add 3 days off");
    expect(closeDaysLabel(1)).toBe("Close 1 day");
    expect(closeDaysLabel(2)).toBe("Close 2 days");
  });

  it("names the reopened day as Mon D", () => {
    expect(reopenLabel("2026-10-09")).toBe("Reopen Oct 9");
  });
});

describe("toast texts", () => {
  it("says how many shifts were added", () => {
    expect(shiftsAddedText(1)).toBe("1 shift added");
    expect(shiftsAddedText(4)).toBe("4 shifts added");
  });

  it("adds the removed shifts to day-off messages only when there were any", () => {
    expect(daysOffAddedText(1, 0)).toBe("1 day off added");
    expect(daysOffAddedText(2, 1)).toBe("2 days off added; 1 conflicting shift removed");
    expect(daysOffAddedText(1, 3)).toBe("1 day off added; 3 conflicting shifts removed");
    expect(withRemovedShifts("Day off updated", 0)).toBe("Day off updated");
    expect(withRemovedShifts("Day off updated", 2)).toBe("Day off updated; 2 conflicting shifts removed");
  });

  it("names the day a card moved to as 'Mon, Oct 5'", () => {
    expect(shiftMovedText("2026-10-05")).toBe("Shift moved to Mon, Oct 5");
    expect(dayOffMovedText("2026-10-05", 0)).toBe("Day off moved to Mon, Oct 5");
    expect(dayOffMovedText("2027-01-01", 1)).toBe("Day off moved to Fri, Jan 1; 1 conflicting shift removed");
  });

  it("says the days were already closed instead of '0 days marked closed'", () => {
    expect(alreadyClosedText(1)).toBe("That day is already closed.");
    expect(alreadyClosedText(3)).toBe("Those days are already closed.");
  });
});

describe("pendingRequestDetail", () => {
  it("reads the pending row from the error details", () => {
    expect(pendingRequestDetail('{"period":"morning","off_date":"2026-10-11","employee_id":"n"}')).toEqual({
      employee_id: "n",
      off_date: "2026-10-11",
      period: "morning",
    });
  });

  it("returns null for anything else", () => {
    expect(pendingRequestDetail("")).toBeNull();
    expect(pendingRequestDetail("2026-10-11")).toBeNull();
    expect(pendingRequestDetail("null")).toBeNull();
    expect(pendingRequestDetail('{"period":"night","off_date":"2026-10-11","employee_id":"n"}')).toBeNull();
    expect(pendingRequestDetail('{"period":"morning","off_date":"2026-02-30","employee_id":"n"}')).toBeNull();
    expect(pendingRequestDetail('{"period":"morning","off_date":"2026-10-11"}')).toBeNull();
  });
});

describe("scheduleError", () => {
  const adding = { adding: true, employees };
  const moving = { adding: false, employees };

  it("words closed_day for adding and for moving", () => {
    const error = dbError("closed_day", "P0001", "2026-10-09");
    expect(scheduleError(error, adding)).toEqual({
      code: "closed_day",
      message: "Reopen closed business days before adding shifts.",
      rule: true,
    });
    expect(scheduleError(error, moving).message).toBe("Reopen this business day before moving shifts here.");
  });

  it("names the pending request from the details", () => {
    const error = dbError("pending_request", "P0001", '{"period":"morning","off_date":"2026-10-11","employee_id":"n"}');
    expect(scheduleError(error, adding)).toEqual({
      code: "pending_request",
      message: "Approve or deny Nora Patel's pending Morning request on Oct 11, 2026 first.",
      rule: true,
    });
    expect(scheduleError(dbError("pending_request", "P0001", "garbage"), adding).message).toBe(
      "Couldn't save changes. Please try again.",
    );
  });

  it("maps the other schedule rules", () => {
    expect(scheduleError(dbError("day_off_overlap", "23P01"), moving).message).toBe(
      "That employee already has time off for that part of the day. Refresh and try again.",
    );
    expect(scheduleError(dbError("duplicate key value violates unique constraint", "23505"), adding).message).toBe(
      "That shift already exists.",
    );
    expect(scheduleError(dbError("new row violates check constraint", "23514"), adding).message).toBe(
      "Start and end times can't be the same.",
    );
  });

  it("uses the C8 message the caller gives for request_locked", () => {
    const locked = "This time off was requested by Avery Lane, so it can't be changed into a shift.";
    expect(scheduleError(dbError("request_locked", "P0001"), { ...moving, requestLocked: locked })).toEqual({
      code: "request_locked",
      message: locked,
      rule: true,
    });
  });

  it("falls back to the shared admin messages, then the calendar's own", () => {
    expect(scheduleError(new TypeError("Failed to fetch"), moving)).toEqual({
      code: "network",
      message: "Couldn't reach the schedule. Check your connection and try again.",
      rule: false,
    });
    expect(scheduleError(dbError("not_found", "P0002"), moving)).toEqual({
      code: "not_found",
      message: "This item was changed or removed. The page has been refreshed.",
      rule: false,
    });
    expect(scheduleError(dbError("JWT expired", "PGRST301"), moving).message).toBe(
      "Your sign-in has expired. Sign out, then sign in again.",
    );
    expect(scheduleError(dbError("something odd", "XX000"), moving)).toEqual({
      code: "unknown",
      message: "Couldn't save changes. Please try again.",
      rule: false,
    });
  });
});

describe("failureTone", () => {
  it("shows a row someone else changed or removed as info, like the other paths", () => {
    expect(failureTone(scheduleError(dbError("not_found", "P0002"), { adding: false, employees }))).toBe("info");
  });

  it("keeps real failures as errors", () => {
    expect(failureTone(scheduleError(new TypeError("Failed to fetch"), { adding: false, employees }))).toBe("error");
    expect(failureTone(scheduleError(dbError("something odd", "XX000"), { adding: false, employees }))).toBe("error");
    expect(failureTone(scheduleError(dbError("JWT expired", "PGRST301"), { adding: true, employees }))).toBe("error");
  });
});
