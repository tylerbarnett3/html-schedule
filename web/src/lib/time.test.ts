import { describe, expect, it } from "vitest";
import { toDayNumber } from "./dates";
import {
  absoluteShiftInterval,
  compareTimes,
  formatShiftTime,
  formatTime12Hour,
  intervalsOverlap,
  isOvernight,
  shiftDurationMinutes,
  shiftInterval,
  timeToMinutes,
  toClock,
} from "./time";

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

describe("timeToMinutes", () => {
  it.each([
    ["09:30", 570],
    ["09:30:00", 570],
    ["09:00", 540],
    ["09:00:00", 540],
    ["00:00", 0],
    ["24:00", 1440],
    ["24:00:00", 1440],
    ["16:59:59", 1019],
    ["09:15:00.5", 555],
  ])("%s -> %i", (input, expected) => {
    expect(timeToMinutes(input)).toBe(expected);
  });

  it.each([null, undefined, "", "9:30", "25:00", "24:30", "bad", "12:60"])("%j -> null", (input) => {
    expect(timeToMinutes(input)).toBeNull();
  });
});

describe("toClock", () => {
  it.each([
    ["09:00:00", "09:00"],
    ["09:00", "09:00"],
    ["17:05:59", "17:05"],
    ["00:00:00", "00:00"],
    ["24:00:00", "00:00"],
  ])("%s -> %s", (input, expected) => {
    expect(toClock(input)).toBe(expected);
  });

  it.each([null, undefined, "", "9:00", "bad"])("%j -> null", (input) => {
    expect(toClock(input)).toBeNull();
  });
});

describe("shiftInterval", () => {
  it("runs past midnight when the end is at or before the start", () => {
    expect(shiftInterval("22:00", "02:00")).toEqual({ start: 1320, end: 1560 });
    expect(shiftInterval("09:00:00", "17:00")).toEqual({ start: 540, end: 1020 });
    expect(shiftInterval("09:00", "09:00")).toEqual({ start: 540, end: 1980 });
    expect(shiftInterval("18:00", "24:00")).toEqual({ start: 1080, end: 1440 });
    expect(shiftInterval("18:00", "00:00")).toEqual({ start: 1080, end: 1440 });
  });

  it("is null for malformed times", () => {
    expect(shiftInterval("x", "17:00")).toBeNull();
    expect(shiftInterval("09:00", null)).toBeNull();
    expect(shiftInterval(undefined, "17:00")).toBeNull();
  });
});

describe("absoluteShiftInterval", () => {
  it("places the shift on one timeline across days", () => {
    const day = (d: string) => toDayNumber(d) * 1440;
    expect(absoluteShiftInterval("2026-10-01", "22:00", "02:00")).toEqual({
      start: day("2026-10-01") + 1320,
      end: day("2026-10-02") + 120,
    });
    expect(absoluteShiftInterval("2026-10-02", "09:00:00", "17:00:00")).toEqual({
      start: day("2026-10-02") + 540,
      end: day("2026-10-02") + 1020,
    });
  });

  it("isn't affected by daylight saving", () => {
    // 2026-03-08 and 2026-11-01 are the New York change nights.
    const spring = absoluteShiftInterval("2026-03-07", "22:00", "06:00");
    const fall = absoluteShiftInterval("2026-10-31", "22:00", "06:00");
    expect(spring && spring.end - spring.start).toBe(480);
    expect(fall && fall.end - fall.start).toBe(480);
  });

  it("catches an overnight shift overlapping the next morning", () => {
    const overnight = absoluteShiftInterval("2026-10-01", "22:00", "02:00");
    expect(intervalsOverlap(overnight, absoluteShiftInterval("2026-10-02", "01:00", "03:00"))).toBe(true);
    expect(intervalsOverlap(overnight, absoluteShiftInterval("2026-10-02", "02:00", "03:00"))).toBe(false);
  });

  it("is null for a malformed date or time", () => {
    expect(absoluteShiftInterval("2026-02-30", "09:00", "17:00")).toBeNull();
    expect(absoluteShiftInterval("", "09:00", "17:00")).toBeNull();
    expect(absoluteShiftInterval("2026-10-01", "bad", "17:00")).toBeNull();
  });
});

describe("intervalsOverlap", () => {
  it("doesn't count touching intervals", () => {
    expect(intervalsOverlap({ start: 540, end: 900 }, { start: 900, end: 1080 })).toBe(false);
    expect(intervalsOverlap({ start: 540, end: 900 }, { start: 899, end: 1080 })).toBe(true);
    expect(intervalsOverlap({ start: 900, end: 1080 }, { start: 540, end: 900 })).toBe(false);
    expect(intervalsOverlap({ start: 600, end: 700 }, { start: 540, end: 900 })).toBe(true);
  });

  it("is false when either is null", () => {
    expect(intervalsOverlap(null, { start: 540, end: 900 })).toBe(false);
    expect(intervalsOverlap({ start: 540, end: 900 }, null)).toBe(false);
    expect(intervalsOverlap(null, null)).toBe(false);
  });
});

describe("shiftDurationMinutes", () => {
  it.each([
    ["09:00:00", "15:00:00", 360],
    ["22:00:00", "02:00:00", 240],
    ["18:00:00", "00:00:00", 360],
    ["18:00:00", "24:00:00", 360],
    ["09:15", "11:20", 125],
    ["09:00", "17:00", 480],
    ["09:00:00", "17:00:00", 480],
    ["09:00", "17:30", 510],
    ["22:00", "02:00", 240],
    ["23:45", "00:15", 30],
    ["18:00", "24:00", 360],
    ["18:00", "00:00", 360],
    // Old rule for equal times; the database refuses them.
    ["09:00", "09:00", 1440],
    ["00:00", "00:00", 1440],
  ])("(%s, %s) -> %i", (start, end, expected) => {
    expect(shiftDurationMinutes(start, end)).toBe(expected);
  });

  it.each([
    ["9am", "17:00"],
    ["09:00", ""],
    [null, "10:00"],
    ["bad", "10:00"],
  ])("(%j, %j) -> null", (start, end) => {
    expect(shiftDurationMinutes(start, end)).toBeNull();
  });
});
