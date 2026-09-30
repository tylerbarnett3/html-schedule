import { describe, expect, it } from "vitest";
import {
  applyHoursMessage,
  correctHoursText,
  correctHoursTitle,
  hoursInputId,
  makeHoursDraftKey,
  removeChangeSuffix,
  startTodayText,
  weeklyHoursErrorMessage,
} from "./hoursText";

// Shaped like the PostgrestError objects supabase-js returns.
function pgError(message: string, code: string, details = "") {
  return { message, code, details, hint: "" };
}

describe("weeklyHoursErrorMessage", () => {
  it("explains a removal of a change that has already started", () => {
    expect(weeklyHoursErrorMessage(pgError("hours_in_effect", "P0001", "2026-10-01"))).toBe(
      "That change has already started, so it can't be removed.",
    );
  });

  it("explains a check constraint failure as a close time before its open time", () => {
    expect(
      weeklyHoursErrorMessage(
        pgError(
          'new row for relation "weekly_hours" violates check constraint "weekly_hours_close_after_open"',
          "23514",
        ),
      ),
    ).toBe("Each close time must be after its open time.");
  });

  it("uses the shared admin wording, then the weekly fallback, for anything else", () => {
    expect(weeklyHoursErrorMessage(pgError("not_admin", "42501"))).toBe("Only an admin can make this change.");
    expect(weeklyHoursErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach the schedule. Check your connection and try again.",
    );
    expect(weeklyHoursErrorMessage(pgError("invalid_input", "22023"))).toBe(
      "Couldn't save the business hours. Please try again.",
    );
    expect(weeklyHoursErrorMessage(null)).toBe("Couldn't save the business hours. Please try again.");
  });
});

describe("removeChangeSuffix", () => {
  it("names the change by its start date", () => {
    expect(removeChangeSuffix("2026-11-01")).toBe(" from Nov 1, 2026");
    expect(removeChangeSuffix(null)).toBe("");
  });
});

describe("hoursInputId", () => {
  it("is unique per draft, weekday and field", () => {
    expect(hoursInputId("p", "first", 1, "open")).toBe("p-first-1-open");
    expect(hoursInputId("p", "2026-11-01", 0, "close")).toBe("p-2026-11-01-0-close");
  });
});

describe("makeHoursDraftKey", () => {
  it("never repeats and never clashes with saved keys", () => {
    const a = makeHoursDraftKey();
    const b = makeHoursDraftKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^new-\d+$/);
  });
});

describe("the Save Current Hours question", () => {
  it("names when the current hours started", () => {
    expect(applyHoursMessage("2026-09-29")).toBe(
      "You changed the current hours. Do they start today, or replace the hours since Sep 29, 2026?",
    );
    expect(correctHoursTitle("2026-09-29")).toBe("Correct Since Sep 29");
    expect(correctHoursText("2026-09-29")).toBe("To fix a mistake: every day since Sep 29, 2026 gets the new hours.");
    expect(startTodayText("2026-09-30")).toBe("Days before Sep 30, 2026 keep the old hours.");
  });

  it("speaks of every past day for the first set", () => {
    expect(applyHoursMessage(null)).toBe(
      "You changed the current hours. Do they start today, or replace the hours for every past day?",
    );
    expect(correctHoursTitle(null)).toBe("Correct All Past Days");
    expect(correctHoursText(null)).toBe("To fix a mistake: every past day gets the new hours.");
  });
});
