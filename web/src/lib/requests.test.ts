import { describe, expect, it } from "vitest";
import { todayInZone } from "./dates";
import {
  canGoNextMonth,
  canGoPrevMonth,
  hasAvailabilityConflict,
  hasTimeOffConflict,
  highVolumeDates,
  highVolumeWarning,
  isPickerDateDisabled,
  pickerBounds,
  requestResultMessage,
  toggleDate,
} from "./requests";
import type { TimeOff } from "./types";

const noClosed: ReadonlySet<string> = new Set();
const christmas: ReadonlySet<string> = new Set(["2026-12-25"]);

describe("hasTimeOffConflict", () => {
  const mine = [{ off_date: "2026-10-05", period: "morning" as const }];

  it("blocks overlapping parts of the day only", () => {
    expect(hasTimeOffConflict("2026-10-05", "evening", mine, noClosed)).toBe(false);
    expect(hasTimeOffConflict("2026-10-05", "morning", mine, noClosed)).toBe(true);
    expect(hasTimeOffConflict("2026-10-05", "full-day", mine, noClosed)).toBe(true);
    expect(hasTimeOffConflict("2026-10-06", "full-day", mine, noClosed)).toBe(false);
  });

  it("is blocked by days off my manager assigned", () => {
    const assigned: Pick<TimeOff, "off_date" | "period" | "status" | "source">[] = [
      { off_date: "2026-10-07", period: "full-day", status: "approved", source: "assigned" },
    ];
    expect(hasTimeOffConflict("2026-10-07", "morning", assigned, noClosed)).toBe(true);
    expect(hasTimeOffConflict("2026-10-07", "evening", assigned, noClosed)).toBe(true);
  });

  it("is blocked by approved requests", () => {
    const approved = [{ off_date: "2026-10-08", period: "evening" as const, status: "approved" as const }];
    expect(hasTimeOffConflict("2026-10-08", "evening", approved, noClosed)).toBe(true);
    expect(hasTimeOffConflict("2026-10-08", "morning", approved, noClosed)).toBe(false);
  });

  it("is blocked on closed days", () => {
    expect(hasTimeOffConflict("2026-12-25", "morning", [], christmas)).toBe(true);
  });
});

describe("hasAvailabilityConflict", () => {
  const mine = [
    { available_date: "2026-10-05", period: "evening" as const },
    { available_date: "2026-10-06", period: "full-day" as const },
  ];

  it("blocks overlapping availability", () => {
    expect(hasAvailabilityConflict("2026-10-05", "morning", mine, noClosed)).toBe(false);
    expect(hasAvailabilityConflict("2026-10-05", "evening", mine, noClosed)).toBe(true);
    expect(hasAvailabilityConflict("2026-10-05", "full-day", mine, noClosed)).toBe(true);
    expect(hasAvailabilityConflict("2026-10-06", "morning", mine, noClosed)).toBe(true);
    expect(hasAvailabilityConflict("2026-10-07", "morning", mine, noClosed)).toBe(false);
  });

  it("is blocked on closed days", () => {
    expect(hasAvailabilityConflict("2026-12-25", "full-day", [], christmas)).toBe(true);
  });
});

describe("picker dates", () => {
  const today = "2026-09-28";

  it("allows today through a year out", () => {
    expect(pickerBounds(today)).toEqual({ min: "2026-09-28", max: "2027-09-28" });
    expect(isPickerDateDisabled("2026-09-27", today, noClosed, false)).toBe(true);
    expect(isPickerDateDisabled("2026-09-28", today, noClosed, false)).toBe(false);
    expect(isPickerDateDisabled("2027-09-28", today, noClosed, false)).toBe(false);
    expect(isPickerDateDisabled("2027-09-29", today, noClosed, false)).toBe(true);
  });

  it("disables closed and conflicting dates", () => {
    expect(isPickerDateDisabled("2026-12-25", today, christmas, false)).toBe(true);
    expect(isPickerDateDisabled("2026-12-24", today, christmas, false)).toBe(false);
    expect(isPickerDateDisabled("2026-10-05", today, noClosed, true)).toBe(true);
  });

  it("uses New York's date around the spring-forward night", () => {
    const nyToday = todayInZone("America/New_York", new Date("2026-03-08T04:30:00Z"));
    expect(nyToday).toBe("2026-03-07");
    expect(isPickerDateDisabled("2026-03-07", nyToday, noClosed, false)).toBe(false);
    expect(isPickerDateDisabled("2026-03-06", nyToday, noClosed, false)).toBe(true);
  });
});

describe("month navigation", () => {
  const today = "2026-09-28";

  it("can't go before the current month", () => {
    expect(canGoPrevMonth("2026-09", today)).toBe(false);
    expect(canGoPrevMonth("2026-08", today)).toBe(false);
    expect(canGoPrevMonth("2026-10", today)).toBe(true);
    expect(canGoPrevMonth("2027-01", "2026-12-31")).toBe(true);
  });

  it("goes at most 12 months ahead", () => {
    expect(canGoNextMonth("2026-09", today)).toBe(true);
    expect(canGoNextMonth("2027-08", today)).toBe(true);
    expect(canGoNextMonth("2027-09", today)).toBe(false);
    expect(canGoNextMonth("2027-11", "2026-12-31")).toBe(true);
    expect(canGoNextMonth("2027-12", "2026-12-31")).toBe(false);
  });
});

describe("toggleDate", () => {
  it("adds and removes dates, keeping them sorted", () => {
    expect(toggleDate(["2026-10-07"], "2026-10-05")).toEqual(["2026-10-05", "2026-10-07"]);
    expect(toggleDate(["2026-10-05", "2026-10-07"], "2026-10-05")).toEqual(["2026-10-07"]);
    expect(toggleDate([], "2026-10-05")).toEqual(["2026-10-05"]);
  });

  it("doesn't change the input", () => {
    const selected = ["2026-10-07"];
    toggleDate(selected, "2026-10-05");
    expect(selected).toEqual(["2026-10-07"]);
  });
});

describe("highVolumeDates", () => {
  type Row = Pick<TimeOff, "off_date" | "status" | "source">;
  const pending = (off_date = "2026-10-10"): Row => ({ off_date, status: "pending", source: "request" });
  const approvedRequest = (off_date = "2026-10-10"): Row => ({ off_date, status: "approved", source: "request" });
  const assigned = (off_date = "2026-10-10"): Row => ({ off_date, status: "approved", source: "assigned" });

  it("flags a date with 3 pending requests", () => {
    expect(highVolumeDates(["2026-10-10"], [pending(), pending(), pending()])).toEqual(["2026-10-10"]);
  });

  it("counts approved requests too", () => {
    expect(highVolumeDates(["2026-10-10"], [pending(), pending(), approvedRequest()])).toEqual(["2026-10-10"]);
  });

  it("doesn't count assigned days off", () => {
    expect(highVolumeDates(["2026-10-10"], [pending(), pending(), assigned(), assigned(), assigned()])).toEqual([]);
  });

  it("counts rows, not people", () => {
    // One employee's morning and evening requests plus someone else's.
    expect(highVolumeDates(["2026-10-10"], [pending(), pending(), pending()])).toEqual(["2026-10-10"]);
    expect(highVolumeDates(["2026-10-10"], [pending(), pending()])).toEqual([]);
  });

  it("returns only the busy selected dates", () => {
    const rows = [pending(), pending(), pending(), pending("2026-10-11"), pending("2026-10-12")];
    expect(highVolumeDates(["2026-10-10", "2026-10-11"], rows)).toEqual(["2026-10-10"]);
    expect(highVolumeDates(["2026-10-11"], [pending("2026-10-10"), pending("2026-10-10"), pending("2026-10-10")])).toEqual(
      [],
    );
  });
});

describe("highVolumeWarning", () => {
  it("uses the old single-date wording", () => {
    expect(highVolumeWarning(["2026-10-10"])).toBe(
      "Warning: Oct 10, 2026 already has 3 or more time-off requests. Your request may not be approved due to high volume.\n\nDo you want to submit anyway?",
    );
  });

  it("uses the old several-dates wording", () => {
    expect(highVolumeWarning(["2026-10-10", "2026-10-11"])).toBe(
      "Warning: The following dates already have 3 or more time-off requests:\nOct 10, 2026, Oct 11, 2026\n\nYour requests for these days may not be approved due to high volume.\n\nDo you want to submit anyway?",
    );
  });

  it("is null with no busy dates", () => {
    expect(highVolumeWarning([])).toBeNull();
  });
});

describe("requestResultMessage", () => {
  const some = ["2026-10-05"];
  const skippedTwo = ["2026-10-07", "2026-10-06"];

  it("reports time-off results", () => {
    expect(requestResultMessage("time-off", { submitted: some, skipped: skippedTwo })).toEqual({
      text: "Time-off request submitted. Skipped dates that are closed or already had a pending or approved request: Oct 6, 2026, Oct 7, 2026",
      closeDialog: true,
    });
    expect(requestResultMessage("time-off", { submitted: some, skipped: [] })).toEqual({
      text: "Time-off request submitted! Your manager will review it shortly.",
      closeDialog: true,
    });
    expect(requestResultMessage("time-off", { submitted: [], skipped: ["2026-10-06"] })).toEqual({
      text: "No new requests were submitted. These dates are closed or already had pending or approved requests: Oct 6, 2026",
      closeDialog: false,
    });
    expect(requestResultMessage("time-off", { submitted: [], skipped: [] })).toBeNull();
  });

  it("reports availability results", () => {
    expect(requestResultMessage("availability", { submitted: some, skipped: ["2026-10-06"] })).toEqual({
      text: "Availability submitted. Skipped dates that were closed or already had overlapping availability: Oct 6, 2026",
      closeDialog: true,
    });
    expect(requestResultMessage("availability", { submitted: some, skipped: [] })).toEqual({
      text: "Availability submitted!",
      closeDialog: true,
    });
    expect(requestResultMessage("availability", { submitted: [], skipped: ["2026-10-06"] })).toEqual({
      text: "No new availability was submitted. These dates were closed or already had overlapping availability: Oct 6, 2026",
      closeDialog: false,
    });
    expect(requestResultMessage("availability", { submitted: [], skipped: [] })).toEqual({
      text: "No availability was submitted.",
      closeDialog: false,
    });
  });
});
