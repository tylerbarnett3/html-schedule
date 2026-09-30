import { describe, expect, it } from "vitest";
import type { Hours } from "../../../lib/hours";
import { emptyChange, type CustomHoursRow, type ScheduleChange } from "../../../lib/scheduleChange";
import type { Employee } from "../../../lib/types";
import {
  addDaysOffLabel,
  addHoursHint,
  addShiftsLabel,
  alreadyClosedText,
  alreadyStandardText,
  closeDaysLabel,
  customHoursLabel,
  customHoursText,
  dayHoursHint,
  dayOffMovedText,
  daysOffAddedText,
  failureTone,
  HOURS_UPDATED_TITLE,
  hoursErrorMessage,
  hoursSaveText,
  pendingRequestDetail,
  REOPENED_TITLE,
  reopenLabel,
  sameHoursText,
  scheduleError,
  shiftMovedText,
  shiftsAddedText,
  standardHoursLabel,
  standardHoursText,
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

describe("business hours texts", () => {
  const nineToFive: Hours = { open: "09:00:00", close: "17:00:00" };
  const threeDays = ["2026-10-31", "2026-11-01", "2026-11-02"];

  it("titles the hours toasts", () => {
    expect(HOURS_UPDATED_TITLE).toBe("Hours Updated");
  });

  it("labels the undo steps by date, or by the number of unique dates", () => {
    expect(customHoursLabel(["2026-10-31"])).toBe("Set custom hours for Oct 31");
    expect(customHoursLabel(["2026-10-31", "2026-10-31"])).toBe("Set custom hours for Oct 31");
    expect(customHoursLabel(threeDays)).toBe("Set custom hours for 3 days");
    expect(customHoursLabel([...threeDays, "2026-11-01"])).toBe("Set custom hours for 3 days");
    expect(standardHoursLabel(["2027-01-04"])).toBe("Set standard hours for Jan 4");
    expect(standardHoursLabel(["2026-10-31", "2026-11-01"])).toBe("Set standard hours for 2 days");
  });

  it("says what was set: 'Sat, Oct 31: 9:00 AM - 5:00 PM'", () => {
    expect(customHoursText(["2026-10-31"], nineToFive)).toBe("Sat, Oct 31: 9:00 AM - 5:00 PM");
    expect(customHoursText(["2026-11-23"], { open: "09:00", close: "13:00" })).toBe("Mon, Nov 23: 9:00 AM - 1:00 PM");
    expect(customHoursText(threeDays, nineToFive)).toBe("3 days: 9:00 AM - 5:00 PM");
    expect(customHoursText(["2026-10-31", "2026-10-31"], nineToFive)).toBe("Sat, Oct 31: 9:00 AM - 5:00 PM");
    expect(standardHoursText(["2026-10-31"])).toBe("Sat, Oct 31: standard hours");
    expect(standardHoursText(threeDays)).toBe("3 days: standard hours");
  });

  describe("hoursSaveText (words by what the change did)", () => {
    const row = (date: string, open: string, close: string): CustomHoursRow => ({
      hours_date: date,
      open_time: open,
      close_time: close,
      created_at: "2026-09-30T12:00:00+00:00",
      updated_at: "2026-09-30T12:00:00+00:00",
    });
    const change = (edit: (c: ScheduleChange) => void): ScheduleChange => {
      const c = emptyChange();
      edit(c);
      return c;
    };
    const nineToFiveClock: Hours = { open: "09:00", close: "17:00" };
    const updatedText = (label: string, message: string) => ({ label, title: "Hours Updated", message });
    const reopenText = (label: string, message: string) => ({ label, title: "Business Day Reopened", message });

    it("titles a reopen", () => {
      expect(REOPENED_TITLE).toBe("Business Day Reopened");
    });

    it("says custom hours when custom hours were stored or changed", () => {
      const inserted = change((c) => c.inserted.custom_hours.push(row("2026-10-31", "09:00:00", "17:00:00")));
      expect(hoursSaveText(["2026-10-31"], inserted, nineToFiveClock)).toEqual(
        updatedText("Set custom hours for Oct 31", "Sat, Oct 31: 9:00 AM - 5:00 PM"),
      );
      const updated = change((c) =>
        c.updated.custom_hours.push({
          before: row("2026-10-31", "12:00:00", "16:00:00"),
          after: row("2026-10-31", "09:00:00", "17:00:00"),
        }),
      );
      expect(hoursSaveText(["2026-10-31"], updated, nineToFiveClock)).toEqual(
        updatedText("Set custom hours for Oct 31", "Sat, Oct 31: 9:00 AM - 5:00 PM"),
      );
    });

    it("says custom hours for a closed day reopened with them", () => {
      const reopened = change((c) => {
        c.deleted.closed_days.push("2026-11-24");
        c.inserted.custom_hours.push(row("2026-11-24", "09:00:00", "13:00:00"));
      });
      expect(hoursSaveText(["2026-11-24"], reopened, { open: "09:00", close: "13:00" })).toEqual(
        updatedText("Set custom hours for Nov 24", "Tue, Nov 24: 9:00 AM - 1:00 PM"),
      );
    });

    it("says custom hours for several days when any got them, counting unique dates", () => {
      const mixed = change((c) => {
        c.deleted.closed_days.push("2026-11-24");
        c.deleted.custom_hours.push(row("2026-11-25", "12:00:00", "16:00:00"));
        c.inserted.custom_hours.push(row("2026-11-23", "09:00:00", "17:00:00"));
      });
      expect(hoursSaveText(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-24"], mixed, nineToFiveClock)).toEqual(
        updatedText("Set custom hours for 3 days", "3 days: 9:00 AM - 5:00 PM"),
      );
    });

    it("says standard hours when custom hours equal to standard cleared a day's custom hours", () => {
      const cleared = change((c) => c.deleted.custom_hours.push(row("2026-12-02", "12:00:00", "16:00:00")));
      expect(hoursSaveText(["2026-12-02"], cleared, { open: "11:00", close: "21:00" })).toEqual(
        updatedText("Set standard hours for Dec 2", "Wed, Dec 2: standard hours"),
      );
      expect(hoursSaveText(["2026-12-02"], cleared, null)).toEqual(
        updatedText("Set standard hours for Dec 2", "Wed, Dec 2: standard hours"),
      );
    });

    it("says reopen when one closed day went back to standard hours, whichever choice did it", () => {
      const reopened = change((c) => c.deleted.closed_days.push("2026-12-01"));
      const expected = reopenText("Reopen Dec 1", "Dec 1, 2026");
      expect(hoursSaveText(["2026-12-01"], reopened, null)).toEqual(expected);
      expect(hoursSaveText(["2026-12-01"], reopened, { open: "11:00", close: "19:00" })).toEqual(expected);
      expect(hoursSaveText(["2026-12-01", "2026-12-01"], reopened, null)).toEqual(expected);
    });

    it("says standard hours for several days, even when some were closed", () => {
      const several = change((c) => {
        c.deleted.closed_days.push("2026-12-01");
        c.deleted.custom_hours.push(row("2026-12-02", "12:00:00", "16:00:00"));
      });
      for (const hours of [null, { open: "11:00", close: "21:00" }]) {
        expect(hoursSaveText(["2026-12-01", "2026-12-02"], several, hours)).toEqual(
          updatedText("Set standard hours for 2 days", "2 days: standard hours"),
        );
      }
      const allClosed = change((c) => c.deleted.closed_days.push("2026-12-01", "2026-12-02"));
      expect(hoursSaveText(["2026-12-01", "2026-12-02"], allClosed, null)).toEqual(
        updatedText("Set standard hours for 2 days", "2 days: standard hours"),
      );
    });
  });

  it("explains a save that changed nothing, for one day or several", () => {
    expect(sameHoursText(1)).toBe("That day already has those hours.");
    expect(sameHoursText(3)).toBe("Those days already have those hours.");
    expect(alreadyStandardText(1)).toBe("That day already has standard hours.");
    expect(alreadyStandardText(2)).toBe("Those days already have standard hours.");
  });

  it("maps a failed hours write", () => {
    expect(hoursErrorMessage(dbError("new row violates check constraint", "23514"))).toBe(
      "Close time must be after open time.",
    );
    expect(hoursErrorMessage(dbError("not_admin", "42501"))).toBe("Only an admin can make this change.");
    expect(hoursErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach the schedule. Check your connection and try again.",
    );
    expect(hoursErrorMessage(dbError("invalid_input", "22023"))).toBe("Couldn't save the hours. Please try again.");
    expect(hoursErrorMessage(dbError("something odd", "XX000"))).toBe("Couldn't save the hours. Please try again.");
  });

  it("hints what the Day Hours choice does", () => {
    const closed = { kind: "closed" } as const;
    const standard = { kind: "standard" } as const;
    const custom = { kind: "custom", hours: nineToFive } as const;
    const tenToSix: Hours = { open: "10:00:00", close: "18:00:00" };

    expect(dayHoursHint("closed", closed, tenToSix)).toBe("This day is closed.");
    for (const state of [standard, custom]) {
      expect(dayHoursHint("closed", state, tenToSix)).toBe(
        "Closing deletes this day's shifts and time off. Payroll records and availability are kept.",
      );
    }
    for (const choice of ["standard", "custom"] as const) {
      expect(dayHoursHint(choice, standard, tenToSix)).toBe("Standard hours for this day: 10:00 AM - 6:00 PM.");
      expect(dayHoursHint(choice, custom, tenToSix)).toBe("Standard hours for this day: 10:00 AM - 6:00 PM.");
      expect(dayHoursHint(choice, closed, tenToSix)).toBe(
        "Reopens the day. Standard hours for this day: 10:00 AM - 6:00 PM.",
      );
      expect(dayHoursHint(choice, standard, null)).toBe("No standard hours are set yet.");
      expect(dayHoursHint(choice, closed, null)).toBe("Reopens the day. No standard hours are set yet.");
    }
  });

  it("hints what Add → Hours does for each choice", () => {
    expect(addHoursHint("standard")).toBe("Pick the days to put back on standard hours. Closed days are reopened.");
    expect(addHoursHint("custom")).toBe("Pick the days that get these hours. Closed days are reopened.");
    expect(addHoursHint("closed")).toBe(
      "Pick the days to close. Their shifts and time off are deleted; payroll records and availability are kept.",
    );
  });
});
