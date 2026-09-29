import { describe, expect, it } from "vitest";
import { compareTimes, formatShiftTime, formatTime12Hour, isOvernight } from "./time";

describe("formatTime12Hour", () => {
  it.each([
    ["09:00:00", "9:00 AM"],
    ["00:00:00", "12:00 AM"],
    ["00:30", "12:30 AM"],
    ["12:00:00", "12:00 PM"],
    ["12:30:00", "12:30 PM"],
    ["13:05", "1:05 PM"],
    ["23:59:59", "11:59 PM"],
    ["17:05", "5:05 PM"],
    ["24:00:00", "12:00 AM"],
    ["24:00", "12:00 AM"],
    ["09:15:00.5", "9:15 AM"],
  ])("%s -> %s", (input, expected) => {
    expect(formatTime12Hour(input)).toBe(expected);
  });

  it.each([null, undefined, "", "9", "9:00", "ab:cd", "25:00", "24:30", "12:60", "12:00:60"])(
    "shows a dash for %j",
    (input) => {
      expect(formatTime12Hour(input)).toBe("—");
    },
  );
});

describe("isOvernight", () => {
  it("is true when the shift ends after midnight", () => {
    expect(isOvernight("22:00:00", "02:00:00")).toBe(true);
    expect(isOvernight("23:00:00", "00:00:00")).toBe(true);
    expect(isOvernight("09:00", "08:59:59")).toBe(true);
  });

  it("is false for same-day shifts", () => {
    expect(isOvernight("09:00:00", "17:00:00")).toBe(false);
    expect(isOvernight("00:00:00", "08:00:00")).toBe(false);
    expect(isOvernight("18:00:00", "24:00:00")).toBe(false);
    expect(isOvernight("bad", "08:00:00")).toBe(false);
  });
});

describe("formatShiftTime", () => {
  it("shows overnight shifts plainly", () => {
    expect(formatShiftTime({ start_time: "22:00:00", end_time: "02:00:00" })).toBe("10:00 PM - 2:00 AM");
  });

  it("isn't affected by daylight saving", () => {
    // Shift dates 2026-03-07 (spring-forward night), 2026-03-08 and 2026-11-01 in New York.
    expect(formatShiftTime({ start_time: "22:00:00", end_time: "06:00:00" })).toBe("10:00 PM - 6:00 AM");
    expect(formatShiftTime({ start_time: "01:30:00", end_time: "03:30:00" })).toBe("1:30 AM - 3:30 AM");
    expect(formatShiftTime({ start_time: "01:00:00", end_time: "01:30:00" })).toBe("1:00 AM - 1:30 AM");
  });

  it("formats midnight ends", () => {
    expect(formatShiftTime({ start_time: "18:00:00", end_time: "24:00:00" })).toBe("6:00 PM - 12:00 AM");
  });
});

describe("compareTimes", () => {
  it("orders by time of day, treating both formats alike", () => {
    expect(compareTimes("09:00", "12:00:00")).toBeLessThan(0);
    expect(compareTimes("22:00:00", "18:00:00")).toBeGreaterThan(0);
    expect(compareTimes("09:00", "09:00:00")).toBe(0);
    expect(compareTimes("bad", "23:00:00")).toBeGreaterThan(0);
  });
});
