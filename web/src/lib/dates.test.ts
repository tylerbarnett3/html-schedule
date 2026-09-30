import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  applyRangeEdit,
  compareISODate,
  daysInclusive,
  defaultRange,
  formatChipDate,
  formatDateList,
  formatDayLabel,
  formatLongDate,
  formatMonthDay,
  formatMonthLabel,
  formatNumericDate,
  formatRangeLabel,
  formatShortDate,
  fromDayNumber,
  isISODate,
  MAX_RANGE_DAYS,
  monthGrid,
  monthOf,
  nextMonth,
  prevMonth,
  rangeDates,
  shiftRange,
  timestampToBusinessDate,
  toDayNumber,
  todayInZone,
  WEEKDAY_LONG,
  weekdayHeaders,
  weekdayOf,
} from "./dates";
import type { DateRange } from "./types";

const range = (start: string, end: string): DateRange => ({ start, end });

describe("day arithmetic", () => {
  it("adds days across daylight saving changes", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("adds days across leap days and years", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-09-28", 34)).toBe("2026-11-01");
    expect(addDays("2026-02-20", 34)).toBe("2026-03-26");
    expect(addDays("2027-06-01", 365)).toBe("2028-05-31");
  });

  it("round-trips day numbers", () => {
    expect(fromDayNumber(toDayNumber("2026-10-05"))).toBe("2026-10-05");
    expect(toDayNumber("1970-01-01")).toBe(0);
  });

  it("finds the weekday", () => {
    expect(weekdayOf("2026-09-28")).toBe(1);
    expect(weekdayOf("2026-03-08")).toBe(0);
    expect(weekdayOf("2026-11-01")).toBe(0);
    expect(weekdayOf("2026-10-01")).toBe(4);
    expect(weekdayOf("2026-12-25")).toBe(5);
  });

  it("compares dates", () => {
    expect(compareISODate("2026-10-04", "2026-10-05")).toBeLessThan(0);
    expect(compareISODate("2026-10-05", "2026-10-05")).toBe(0);
    expect(compareISODate("2027-01-01", "2026-12-31")).toBeGreaterThan(0);
  });
});

describe("todayInZone", () => {
  it.each([
    ["2026-09-29T01:30:00Z", "2026-09-28"],
    ["2026-09-29T04:00:00Z", "2026-09-29"],
    ["2026-03-08T04:59:59Z", "2026-03-07"],
    ["2026-03-08T05:00:00Z", "2026-03-08"],
    ["2026-11-01T03:59:59Z", "2026-10-31"],
    ["2026-11-01T04:30:00Z", "2026-11-01"],
  ])("at %s New York's date is %s", (instant, expected) => {
    expect(todayInZone("America/New_York", new Date(instant))).toBe(expected);
  });
});

describe("isISODate", () => {
  it("accepts only real dates from 1900 on", () => {
    expect(isISODate("2026-10-05")).toBe(true);
    expect(isISODate("2028-02-29")).toBe(true);
    expect(isISODate("2026-02-30")).toBe(false);
    expect(isISODate("2026-02-29")).toBe(false);
    expect(isISODate("0026-01-01")).toBe(false);
    expect(isISODate("2026-10-5")).toBe(false);
    expect(isISODate("")).toBe(false);
    expect(isISODate(null)).toBe(false);
  });
});

describe("formatShortDate and formatDateList", () => {
  it("formats one date", () => {
    expect(formatShortDate("2026-10-05")).toBe("Oct 5, 2026");
    expect(formatDateList(["2026-10-05"])).toBe("Oct 5, 2026");
  });

  it("joins several dates", () => {
    expect(formatDateList(["2026-03-08", "2026-11-01"])).toBe("Mar 8, 2026, Nov 1, 2026");
    expect(formatDateList(["2026-12-31", "2027-01-01"])).toBe("Dec 31, 2026, Jan 1, 2027");
  });

  it("handles empty lists and leap days", () => {
    expect(formatDateList([])).toBe("");
    expect(formatDateList(["2028-02-29"])).toBe("Feb 29, 2028");
  });
});

describe("months", () => {
  it("builds month grids with the right leading blanks", () => {
    expect(monthGrid("2026-02")).toMatchObject({ leadingBlanks: 0 });
    expect(monthGrid("2026-02").days).toHaveLength(28);

    const march = monthGrid("2026-03");
    expect(march.leadingBlanks).toBe(0);
    expect(march.days).toHaveLength(31);
    expect(march.days.filter((d) => d === "2026-03-08")).toHaveLength(1);
    expect(march.days[0]).toBe("2026-03-01");
    expect(march.days[30]).toBe("2026-03-31");

    const october = monthGrid("2026-10");
    expect(october.leadingBlanks).toBe(4);
    expect(october.days).toHaveLength(31);

    const leapFebruary = monthGrid("2028-02");
    expect(leapFebruary.leadingBlanks).toBe(2);
    expect(leapFebruary.days).toHaveLength(29);
  });

  it("steps months without getting stuck on the 31st", () => {
    expect(prevMonth("2026-10")).toBe("2026-09");
    expect(prevMonth("2026-01")).toBe("2025-12");
    expect(nextMonth("2026-12")).toBe("2027-01");
    expect(addMonths("2026-09", 12)).toBe("2027-09");
    expect(addMonths("2026-09", -21)).toBe("2024-12");
    expect(monthOf("2026-10-31")).toBe("2026-10");
    expect(prevMonth(monthOf("2026-10-31"))).toBe("2026-09");
    expect(prevMonth(monthOf("2026-03-31"))).toBe("2026-02");
  });

  it("labels months", () => {
    expect(formatMonthLabel("2026-10")).toBe("October 2026");
    expect(formatMonthLabel("2027-01")).toBe("January 2027");
  });
});

describe("range math", () => {
  it("counts calendar days, ignoring daylight saving", () => {
    expect(daysInclusive(range("2026-03-01", "2026-03-31"))).toBe(31);
    expect(daysInclusive(range("2026-03-08", "2026-03-09"))).toBe(2);
    expect(daysInclusive(range("2026-02-20", "2026-03-26"))).toBe(35);
    expect(daysInclusive(range("2026-10-31", "2026-11-01"))).toBe(2);
    expect(daysInclusive(range("2026-11-01", "2026-11-01"))).toBe(1);
    expect(daysInclusive(range("2028-02-28", "2028-03-01"))).toBe(3);
    expect(daysInclusive(range("2026-12-31", "2027-01-01"))).toBe(2);
    expect(daysInclusive(range("2026-10-05", "2026-10-04"))).toBe(0);
  });

  it("defaults to 35 days starting today", () => {
    expect(defaultRange("2026-09-28")).toEqual(range("2026-09-28", "2026-11-01"));
    expect(daysInclusive(defaultRange("2026-09-28"))).toBe(35);
    expect(defaultRange("2026-02-20")).toEqual(range("2026-02-20", "2026-03-26"));
    expect(daysInclusive(defaultRange("2026-02-20"))).toBe(35);
  });

  it("pages by the range length", () => {
    expect(shiftRange(range("2026-09-28", "2026-11-01"), 1)).toEqual(range("2026-11-02", "2026-12-06"));
    expect(shiftRange(range("2026-02-20", "2026-03-26"), 1)).toEqual(range("2026-03-27", "2026-04-30"));
    expect(shiftRange(range("2026-03-27", "2026-04-30"), -1)).toEqual(range("2026-02-20", "2026-03-26"));
    expect(shiftRange(range("2026-03-08", "2026-03-08"), 1)).toEqual(range("2026-03-09", "2026-03-09"));
    expect(shiftRange(range("2026-10-25", "2026-11-07"), -1)).toEqual(range("2026-10-11", "2026-10-24"));
  });

  it("lists every date in a range", () => {
    expect(rangeDates(range("2026-03-06", "2026-03-10"))).toEqual([
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(rangeDates(range("2026-02-20", "2026-03-26"))).toHaveLength(35);
    expect(rangeDates(range("2026-10-05", "2026-10-05"))).toEqual(["2026-10-05"]);
    expect(rangeDates(range("2026-10-05", "2026-10-04"))).toEqual([]);
  });
});

describe("applyRangeEdit", () => {
  const current = range("2026-09-28", "2026-11-01"); // 35 days

  it("applies a new start or end inside the range", () => {
    expect(applyRangeEdit("start", "2026-10-01", current)).toEqual({
      range: range("2026-10-01", "2026-11-01"),
      capped: false,
    });
    expect(applyRangeEdit("end", "2026-10-31", current)).toEqual({
      range: range("2026-09-28", "2026-10-31"),
      capped: false,
    });
  });

  it("allows a single-day range", () => {
    expect(applyRangeEdit("end", "2026-09-28", current)?.range).toEqual(range("2026-09-28", "2026-09-28"));
    expect(applyRangeEdit("start", "2026-11-01", current)?.range).toEqual(range("2026-11-01", "2026-11-01"));
  });

  it("drags the end along when start moves past it, keeping the length", () => {
    expect(applyRangeEdit("start", "2026-11-02", current)).toEqual({
      range: range("2026-11-02", "2026-12-06"),
      capped: false,
    });
    // 35 days across the spring-forward night.
    expect(applyRangeEdit("start", "2026-03-01", range("2026-01-25", "2026-02-28"))?.range).toEqual(
      range("2026-03-01", "2026-04-04"),
    );
  });

  it("drags the start along when end moves before it, keeping the length", () => {
    expect(applyRangeEdit("end", "2026-09-27", current)).toEqual({
      range: range("2026-08-24", "2026-09-27"),
      capped: false,
    });
    expect(applyRangeEdit("end", "2026-04-04", range("2026-04-05", "2026-05-09"))?.range).toEqual(
      range("2026-03-01", "2026-04-04"),
    );
  });

  it.each(["", "2", "0002-09-28", "0020-09-28", "0202-09-28", "1999-12-31", "2026-02-30", "2026-13-01", "20270-09-28", "abc"])(
    "ignores the unfinished value %j",
    (value) => {
      expect(applyRangeEdit("start", value, current)).toBeNull();
      expect(applyRangeEdit("end", value, current)).toBeNull();
    },
  );

  it("waits for the whole year while typing into Start", () => {
    const typed = ["0002-09-28", "0020-09-28", "0202-09-28"].map((v) => applyRangeEdit("start", v, current));
    expect(typed).toEqual([null, null, null]);
    expect(applyRangeEdit("start", "2027-09-28", current)?.range).toEqual(range("2027-09-28", "2027-11-01"));
  });

  it("caps long ranges at 180 days by pulling in the end", () => {
    expect(MAX_RANGE_DAYS).toBe(180);
    expect(applyRangeEdit("end", "2027-03-26", current)).toEqual({
      range: range("2026-09-28", "2027-03-26"),
      capped: false,
    });
    expect(applyRangeEdit("end", "2027-03-27", current)).toEqual({
      range: range("2026-09-28", "2027-03-26"),
      capped: true,
    });
    expect(applyRangeEdit("end", "2027-11-01", current)).toEqual({
      range: range("2026-09-28", "2027-03-26"),
      capped: true,
    });
    const earlierStart = applyRangeEdit("start", "2026-01-01", current);
    expect(earlierStart).toEqual({ range: range("2026-01-01", "2026-06-29"), capped: true });
    expect(earlierStart && daysInclusive(earlierStart.range)).toBe(180);
  });

  it("returns the same range object when nothing changes", () => {
    expect(applyRangeEdit("start", "2026-09-28", current)?.range).toBe(current);
    expect(applyRangeEdit("end", "2026-11-01", current)?.range).toBe(current);
  });
});

describe("calendar labels", () => {
  it("rotates weekday headers to start on the range's first weekday", () => {
    expect(weekdayHeaders("2026-09-28")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayHeaders("2026-03-08")[0]).toBe("Sun");
    expect(weekdayHeaders("2026-10-01")[0]).toBe("Thu");
    expect(weekdayHeaders("2026-10-01")).toHaveLength(7);
  });

  it("names weekdays in full, Sunday first", () => {
    expect(WEEKDAY_LONG[weekdayOf("2026-10-31")]).toBe("Saturday");
    expect(WEEKDAY_LONG[weekdayOf("2026-11-01")]).toBe("Sunday");
    expect(WEEKDAY_LONG).toEqual(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  });

  it("formats day headers", () => {
    expect(formatDayLabel("2026-10-05", "desktop")).toBe("5 Oct");
    expect(formatDayLabel("2026-10-05", "mobile")).toBe("Monday, Oct 5");
    expect(formatDayLabel("2026-03-08", "mobile")).toBe("Sunday, Mar 8");
    expect(formatDayLabel("2026-11-01", "desktop")).toBe("1 Nov");
  });

  it("formats the period heading", () => {
    expect(formatRangeLabel(range("2026-09-28", "2026-11-01"))).toEqual({ text: "Sep 28 - Nov 1", days: 35 });
    expect(formatRangeLabel(range("2026-02-20", "2026-03-26"))).toEqual({ text: "Feb 20 - Mar 26", days: 35 });
  });
});

describe("admin date labels", () => {
  it("formats numeric dates with a two-digit year", () => {
    expect(formatNumericDate("2026-08-01")).toBe("8/1/26");
    expect(formatNumericDate("2026-12-31")).toBe("12/31/26");
    expect(formatNumericDate("2009-01-05")).toBe("1/5/09");
    expect(formatNumericDate("2100-03-04")).toBe("3/4/00");
  });

  it("formats month and day", () => {
    expect(formatMonthDay("2026-10-05")).toBe("Oct 5");
    expect(formatMonthDay("2026-12-31")).toBe("Dec 31");
  });

  it("formats chip dates", () => {
    expect(formatChipDate("2026-09-30")).toBe("Wed, Sep 30");
    expect(formatChipDate("2026-10-05")).toBe("Mon, Oct 5");
    expect(formatChipDate("2026-10-11")).toBe("Sun, Oct 11");
    expect(formatChipDate("2027-01-01")).toBe("Fri, Jan 1");
  });

  it("formats long dates", () => {
    expect(formatLongDate("2026-10-11")).toBe("Sunday, October 11, 2026");
    expect(formatLongDate("2026-10-20")).toBe("Tuesday, October 20, 2026");
    expect(formatLongDate("2028-02-29")).toBe("Tuesday, February 29, 2028");
  });
});

describe("timestampToBusinessDate", () => {
  it.each([
    ["2026-09-29T14:03:12.123456+00:00", "2026-09-29"],
    ["2026-09-30T02:30:00+00:00", "2026-09-29"],
    ["2026-09-29T03:30:00Z", "2026-09-28"],
    ["2026-09-29T04:00:00Z", "2026-09-29"],
    ["2026-09-29 14:03:12.5+00", "2026-09-29"],
    ["2026-09-30T00:30:00-04:00", "2026-09-30"],
    ["2026-09-30T09:00:00+0900", "2026-09-29"],
    ["2026-11-01T05:30:00+00:00", "2026-11-01"],
  ])("%s -> %s in New York", (ts, expected) => {
    expect(timestampToBusinessDate(ts)).toBe(expected);
  });

  it("uses another zone when given", () => {
    expect(timestampToBusinessDate("2026-09-29T20:00:00Z", "Asia/Tokyo")).toBe("2026-09-30");
  });

  it.each([null, undefined, "", "garbage", "2026-09-29", "2026-09-29T14:03:12", "2026-02-30T12:00:00Z"])(
    "%j -> null",
    (ts) => {
      expect(timestampToBusinessDate(ts)).toBeNull();
    },
  );
});
