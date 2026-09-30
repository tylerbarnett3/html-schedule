import { describe, expect, it } from "vitest";
import {
  checkRateDrafts,
  diffRates,
  emptyRateDraft,
  findRateOverlap,
  formatRate,
  parseNewEmployeeRate,
  periodsOverlap,
  rateAppliesOn,
  rateErrorMessage,
  rateForDate,
  rateSummary,
  roundToCents,
  sortRates,
  startNewRate,
  toRateDrafts,
  type EmployeeRate,
  type RateDraft,
  type RatePeriod,
} from "./rates";

const R = { start: "2026-09-29", end: "2026-11-02" };

function period(rate: number, start_date: string | null, end_date: string | null): RatePeriod {
  return { rate, start_date, end_date };
}

function draft(rate: string, start = "", end = "", id: string | null = null, key = `k-${rate}-${start}-${end}`): RateDraft {
  return { key, id, rate, start, end };
}

function keys(): () => string {
  let n = 0;
  return () => `key-${(n += 1)}`;
}

describe("rateSummary", () => {
  it("reads the rates that apply to the dates on screen (EM §10)", () => {
    expect(rateSummary([], R)).toBe("No rate set");
    expect(rateSummary([period(15, null, null)], R)).toBe("$15.00/hr");
    expect(rateSummary([period(16, "2026-10-15", null), period(15, null, "2026-10-14")], R)).toBe(
      "$15.00-$16.00/hr",
    );
    expect(rateSummary([period(15, null, "2026-10-01"), period(15, "2026-10-02", null)], R)).toBe("$15.00/hr");
    expect(rateSummary([period(18, "2026-11-02", null)], R)).toBe("$18.00/hr");
    expect(rateSummary([period(18, null, "2026-09-29")], R)).toBe("$18.00/hr");
    expect(
      rateSummary([period(10, null, "2026-10-05"), period(12, "2026-10-06", "2026-10-20"), period(11, "2026-10-21", null)], R),
    ).toBe("$10.00-$12.00/hr");
  });

  it("says so when no period covers the dates, instead of showing the first rate (E3)", () => {
    expect(rateSummary([period(14, null, "2025-01-01"), period(12, null, "2024-01-01")], R)).toBe(
      "No rate for these dates",
    );
    expect(rateSummary([period(20, "2027-01-01", null)], R)).toBe("No rate for these dates");
    expect(rateSummary([period(16.5, "2025-01-01", "2025-12-31")], R)).toBe("No rate for these dates");
    // The day before the range and the day after it don't count.
    expect(rateSummary([period(9, null, "2026-09-28"), period(9, "2026-11-03", null)], R)).toBe(
      "No rate for these dates",
    );
  });
});

describe("formatRate", () => {
  it("shows dollars and cents per hour", () => {
    expect(formatRate(11)).toBe("$11.00/hr");
    expect(formatRate(13.25)).toBe("$13.25/hr");
  });
});

describe("rateForDate", () => {
  const split = [period(16, "2026-10-15", null), period(15, null, "2026-10-14")];

  it("finds the period that covers the date, both ends included", () => {
    expect(rateForDate(split, "2026-10-14")).toBe(15);
    expect(rateForDate(split, "2026-10-15")).toBe(16);
  });

  it("has no fallback outside every period", () => {
    expect(rateForDate([period(16, "2026-10-15", null)], "2026-10-01")).toBeNull();
    expect(rateForDate([], "2026-10-01")).toBeNull();
  });

  it("rateAppliesOn treats missing ends as unbounded", () => {
    expect(rateAppliesOn(period(1, null, null), "1999-01-01")).toBe(true);
    expect(rateAppliesOn(period(1, "2026-01-01", "2026-01-01"), "2026-01-01")).toBe(true);
    expect(rateAppliesOn(period(1, "2026-01-01", "2026-01-01"), "2026-01-02")).toBe(false);
  });
});

describe("periodsOverlap", () => {
  it("is inclusive at both ends and open where a date is missing", () => {
    expect(periodsOverlap(period(1, null, null), period(1, null, null))).toBe(true);
    expect(periodsOverlap(period(1, null, "2026-01-01"), period(1, "2026-01-01", null))).toBe(true);
    expect(periodsOverlap(period(1, null, "2025-12-31"), period(1, "2026-01-01", null))).toBe(false);
    expect(periodsOverlap(period(1, "2026-01-01", "2026-06-30"), period(1, "2026-03-01", "2026-03-31"))).toBe(true);
    expect(periodsOverlap(period(1, "2026-01-01", "2026-01-01"), period(1, "2026-01-02", null))).toBe(false);
  });

  it("findRateOverlap reports the first overlapping pair", () => {
    const a = period(10, null, "2025-12-31");
    const b = period(11, "2026-01-01", "2026-06-30");
    const c = period(12, "2026-06-30", null);
    expect(findRateOverlap([a, b, c])).toEqual([1, 2]);
    expect(findRateOverlap([a, b])).toBeNull();
  });
});

describe("checkRateDrafts", () => {
  it("accepts an empty list and an open-ended rate", () => {
    expect(checkRateDrafts([])).toEqual({ ok: true, rates: [] });
    expect(checkRateDrafts([draft("15")])).toEqual({
      ok: true,
      rates: [{ id: null, rate: 15, start_date: null, end_date: null }],
    });
  });

  it("drops untouched empty rows (E2)", () => {
    expect(checkRateDrafts([draft("")])).toEqual({ ok: true, rates: [] });
    expect(checkRateDrafts([draft(" ", " ", "")])).toEqual({ ok: true, rates: [] });
  });

  it("refuses a missing or non-positive rate on any other row", () => {
    expect(checkRateDrafts([draft("0", "2026-01-01")])).toEqual({ ok: false, error: { kind: "invalid-rate", index: 0 } });
    expect(checkRateDrafts([draft("15"), draft("", "2026-01-01")])).toEqual({
      ok: false,
      error: { kind: "invalid-rate", index: 1 },
    });
    expect(checkRateDrafts([draft("-3")])).toEqual({ ok: false, error: { kind: "invalid-rate", index: 0 } });
    expect(checkRateDrafts([draft("0.004")])).toEqual({ ok: false, error: { kind: "invalid-rate", index: 0 } });
  });

  it("numbers the rate period by its place in the list, empty rows included", () => {
    const result = checkRateDrafts([draft(""), draft("15", "", "2025-12-31"), draft("abc", "2026-01-01")]);
    expect(result).toEqual({ ok: false, error: { kind: "invalid-rate", index: 2 } });
    if (!result.ok) expect(rateErrorMessage(result.error)).toBe("Hourly rate must be greater than 0 for Rate Period 3.");
  });

  it("checks end before start, allowing one-day periods", () => {
    expect(checkRateDrafts([draft("15", "2026-02-01", "2026-01-31")])).toEqual({
      ok: false,
      error: { kind: "end-before-start", index: 0 },
    });
    expect(checkRateDrafts([draft("15", "2026-01-31", "2026-01-31")])).toEqual({
      ok: true,
      rates: [{ id: null, rate: 15, start_date: "2026-01-31", end_date: "2026-01-31" }],
    });
  });

  it("checks overlaps last, both ends inclusive", () => {
    expect(checkRateDrafts([draft("15", "", "", null, "a"), draft("15", "", "", null, "b")])).toEqual({
      ok: false,
      error: { kind: "overlap", first: 0, second: 1 },
    });
    expect(checkRateDrafts([draft("15", "", "2026-01-31"), draft("16", "2026-01-31", "")])).toEqual({
      ok: false,
      error: { kind: "overlap", first: 0, second: 1 },
    });
    expect(checkRateDrafts([draft("15", "", "2026-01-30"), draft("16", "2026-01-31", "")]).ok).toBe(true);
  });

  it("reports end-before-start ahead of an overlap", () => {
    const result = checkRateDrafts([
      draft("15", "", "", null, "a"),
      draft("16", "", "", null, "b"),
      draft("17", "2026-05-01", "2026-04-01"),
    ]);
    expect(result).toEqual({ ok: false, error: { kind: "end-before-start", index: 2 } });
  });

  it("rounds rates to cents (E8) and keeps ids", () => {
    expect(checkRateDrafts([draft("12.345", "", "", "r1")])).toEqual({
      ok: true,
      rates: [{ id: "r1", rate: 12.35, start_date: null, end_date: null }],
    });
  });

  it("refuses dates that aren't real", () => {
    expect(checkRateDrafts([draft("15", "0200-01-01")])).toEqual({ ok: false, error: { kind: "invalid-date", index: 0 } });
  });

  it("uses the old messages", () => {
    expect(rateErrorMessage({ kind: "invalid-rate", index: 0 })).toBe(
      "Hourly rate must be greater than 0 for Rate Period 1.",
    );
    expect(rateErrorMessage({ kind: "end-before-start", index: 0 })).toBe(
      "End date must be after start date for all rate periods",
    );
    expect(rateErrorMessage({ kind: "overlap", first: 0, second: 1 })).toBe(
      "Rate periods cannot overlap. Please adjust the dates.",
    );
  });
});

describe("parseNewEmployeeRate", () => {
  it("allows blank, refuses zero and below, and rounds to cents", () => {
    expect(parseNewEmployeeRate("")).toEqual({ ok: true, rate: null });
    expect(parseNewEmployeeRate("   ")).toEqual({ ok: true, rate: null });
    const refused = { ok: false, message: "Hourly rate must be greater than 0 or left empty" };
    expect(parseNewEmployeeRate("0")).toEqual(refused);
    expect(parseNewEmployeeRate("-3")).toEqual(refused);
    expect(parseNewEmployeeRate("abc")).toEqual(refused);
    expect(parseNewEmployeeRate("15")).toEqual({ ok: true, rate: 15 });
    expect(parseNewEmployeeRate("12.345")).toEqual({ ok: true, rate: 12.35 });
  });
});

describe("roundToCents", () => {
  it("rounds half up like Postgres numeric", () => {
    expect(roundToCents(12.345)).toBe(12.35);
    expect(roundToCents(1.005)).toBe(1.01);
    expect(roundToCents(16.5)).toBe(16.5);
    expect(roundToCents(0.004)).toBe(0);
  });
});

describe("diffRates", () => {
  const existing: EmployeeRate[] = [
    { id: "r1", employee_id: "e", rate: 15, start_date: null, end_date: "2026-01-31" },
    { id: "r2", employee_id: "e", rate: 16, start_date: "2026-02-01", end_date: null },
  ];

  it("splits a save into deletes, updates and inserts", () => {
    const result = diffRates(existing, [
      { id: "r1", rate: 15, start_date: null, end_date: "2026-03-31" },
      { id: null, rate: 17, start_date: "2026-04-01", end_date: null },
    ]);
    expect(result).toEqual({
      toDelete: ["r2"],
      toUpdate: [{ id: "r1", rate: 15, start_date: null, end_date: "2026-03-31" }],
      toInsert: [{ rate: 17, start_date: "2026-04-01", end_date: null }],
    });
  });

  it("leaves unchanged rows out of the updates", () => {
    const same = existing.map(({ id, rate, start_date, end_date }) => ({ id, rate, start_date, end_date }));
    expect(diffRates(existing, same)).toEqual({ toDelete: [], toUpdate: [], toInsert: [] });
  });
});

describe("sortRates and toRateDrafts", () => {
  it("puts a missing start first, then by start date", () => {
    const sorted = sortRates([period(1, "2026-02-01", null), period(2, null, "2025-12-31"), period(3, "2026-01-01", "2026-01-31")]);
    expect(sorted.map((r) => r.rate)).toEqual([2, 3, 1]);
  });

  it("breaks start ties by end date, open end last", () => {
    const sorted = sortRates([period(1, "2026-01-01", null), period(2, "2026-01-01", "2026-01-10")]);
    expect(sorted.map((r) => r.rate)).toEqual([2, 1]);
  });

  it("turns saved rates into sorted input values", () => {
    const rates: EmployeeRate[] = [
      { id: "b", employee_id: "e", rate: 16.5, start_date: "2026-08-31", end_date: null },
      { id: "a", employee_id: "e", rate: 15.5, start_date: null, end_date: "2026-08-30" },
    ];
    expect(toRateDrafts(rates, keys())).toEqual([
      { key: "key-1", id: "a", rate: "15.50", start: "", end: "2026-08-30" },
      { key: "key-2", id: "b", rate: "16.50", start: "2026-08-31", end: "" },
    ]);
    expect(emptyRateDraft("x")).toEqual({ key: "x", id: null, rate: "", start: "", end: "" });
  });
});

describe("startNewRate (E9)", () => {
  it("ends the open-ended rate the day before and adds the new one", () => {
    const result = startNewRate([draft("15", "", "", "r1", "old")], "2026-10-15", "16", keys());
    expect(result).toEqual({
      ok: true,
      drafts: [
        { key: "old", id: "r1", rate: "15", start: "", end: "2026-10-14" },
        { key: "key-1", id: null, rate: "16.00", start: "2026-10-15", end: "" },
      ],
    });
    if (result.ok) expect(checkRateDrafts(result.drafts).ok).toBe(true);
  });

  it("works on the rate that starts last when earlier periods have ended", () => {
    const drafts = [draft("15.50", "", "2026-08-30", "r1", "a"), draft("16.50", "2026-08-31", "", "r2", "b")];
    const result = startNewRate(drafts, "2027-01-01", "17.25", keys());
    expect(result.ok && result.drafts.map((d) => [d.rate, d.start, d.end])).toEqual([
      ["15.50", "", "2026-08-30"],
      ["16.50", "2026-08-31", "2026-12-31"],
      ["17.25", "2027-01-01", ""],
    ]);
  });

  it("refuses a start on or before the open period's start", () => {
    const drafts = [draft("16.50", "2026-08-31", "", "r2")];
    const refused = {
      ok: false,
      message: "The current rate starts on Aug 31, 2026. Pick a later date for the new rate.",
    };
    expect(startNewRate(drafts, "2026-08-31", "17", keys())).toEqual(refused);
    expect(startNewRate(drafts, "2026-08-01", "17", keys())).toEqual(refused);
    expect(startNewRate(drafts, "2026-09-01", "17", keys()).ok).toBe(true);
  });

  it("adds an open-ended rate when there is none yet", () => {
    expect(startNewRate([], "2026-10-15", "12.345", keys())).toEqual({
      ok: true,
      drafts: [{ key: "key-1", id: null, rate: "12.35", start: "2026-10-15", end: "" }],
    });
  });

  it("refuses a bad rate or date, and a new rate that would overlap a closed period", () => {
    expect(startNewRate([], "2026-10-15", "0", keys())).toEqual({
      ok: false,
      message: "Enter an hourly rate greater than 0.",
    });
    expect(startNewRate([], "", "15", keys())).toEqual({ ok: false, message: "Choose the date the new rate starts." });
    expect(startNewRate([draft("15", "", "2026-12-31")], "2026-10-15", "16", keys())).toEqual({
      ok: false,
      message: "The new rate would overlap Rate Period 1. Change that period's dates first.",
    });
  });

  it("does not change the drafts it was given", () => {
    const drafts = [draft("15", "", "", "r1", "old")];
    startNewRate(drafts, "2026-10-15", "16", keys());
    expect(drafts[0].end).toBe("");
  });
});
