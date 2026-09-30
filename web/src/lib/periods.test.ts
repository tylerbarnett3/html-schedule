import { describe, expect, it } from "vitest";
import {
  DAY_PERIODS,
  formatPeriod,
  isDayPeriod,
  EVENING_START_MINUTES,
  normalizePeriod,
  periodCoversShiftStart,
  PERIOD_OPTION_LABELS,
  periodsConflict,
  periodSortValue,
} from "./periods";
import type { DayPeriod } from "./types";

describe("normalizePeriod", () => {
  it.each([
    ["morning", "morning"],
    ["evening", "evening"],
    ["full-day", "full-day"],
    [undefined, "full-day"],
    ["Morning", "full-day"],
    ["toString", "full-day"],
    ["constructor", "full-day"],
    ["__proto__", "full-day"],
    ["", "full-day"],
    [null, "full-day"],
  ])("%j -> %s", (input, expected) => {
    expect(normalizePeriod(input)).toBe(expected);
  });

  it("recognizes only the three periods", () => {
    expect(isDayPeriod("evening")).toBe(true);
    expect(isDayPeriod("toString")).toBe(false);
    expect(isDayPeriod(1)).toBe(false);
  });
});

describe("periodsConflict", () => {
  it.each<[DayPeriod, DayPeriod, boolean]>([
    ["full-day", "full-day", true],
    ["full-day", "morning", true],
    ["full-day", "evening", true],
    ["morning", "full-day", true],
    ["morning", "morning", true],
    ["morning", "evening", false],
    ["evening", "morning", false],
    ["evening", "evening", true],
    ["evening", "full-day", true],
  ])("(%s, %s) -> %s", (a, b, expected) => {
    expect(periodsConflict(a, b)).toBe(expected);
  });
});

describe("labels and order", () => {
  it("formats periods", () => {
    expect(formatPeriod("full-day")).toBe("Full Day");
    expect(formatPeriod("morning")).toBe("Morning");
    expect(formatPeriod("evening")).toBe("Evening");
  });

  it("has the old select labels", () => {
    expect(DAY_PERIODS.map((p) => PERIOD_OPTION_LABELS[p])).toEqual([
      "Full Day",
      "Morning (Open - 5pm)",
      "Evening (5pm - Close)",
    ]);
  });

  it("sorts full day, morning, evening", () => {
    expect(periodSortValue("full-day")).toBe(0);
    expect(periodSortValue("morning")).toBe(1);
    expect(periodSortValue("evening")).toBe(2);
    const sorted = (["evening", "full-day", "morning"] as DayPeriod[]).sort(
      (a, b) => periodSortValue(a) - periodSortValue(b),
    );
    expect(sorted).toEqual(["full-day", "morning", "evening"]);
  });
});

describe("periodCoversShiftStart", () => {
  it.each<[DayPeriod, string | null, boolean]>([
    // spec-calendar-shifts §8.2
    ["full-day", "23:00", true],
    ["full-day", null, true],
    ["morning", "16:59", true],
    ["morning", "17:00:00", false],
    ["morning", null, false],
    ["evening", "17:00", true],
    ["evening", "16:59:59", false],
    // spec-requests §5 (timeOffCoversShiftStart)
    ["full-day", "23:00:00", true],
    ["morning", "16:59:00", true],
    ["morning", "17:00:00", false],
    ["morning", "00:00", true],
    ["evening", "12:00:00", false],
    ["morning", "", false],
    ["evening", "", false],
    ["full-day", "", true],
  ])("(%s, %j) -> %s", (period, start, expected) => {
    expect(periodCoversShiftStart(period, start)).toBe(expected);
  });

  it("splits the day at 5pm", () => {
    expect(EVENING_START_MINUTES).toBe(1020);
  });
});
