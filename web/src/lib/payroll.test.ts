import { describe, expect, it } from "vitest";
import {
  actualStatusLabel,
  addWorkError,
  applyRowAction,
  buildPristineRows,
  canResetRow,
  canUseLoggedHours,
  compareDraftRows,
  dayTab,
  dayTabKeyTarget,
  defaultPayPeriod,
  deriveActualStatus,
  findInvalidRow,
  formatActualDifference,
  formatActualHours,
  formatDollars,
  formatDuration,
  formatPayrollDecimalHours,
  isFutureWorkDate,
  laborCosts,
  lastSavedText,
  missingRateNote,
  newActualOnlyRow,
  nudgeClock,
  overlapConfirmMessage,
  overlapWarnings,
  parsePeriodStartInput,
  payPeriodFrom,
  payPeriodFromParams,
  payrollClipboardText,
  payrollLines,
  planActualsSave,
  progressLabel,
  rowDifferenceText,
  rowsEqual,
  rowStatusLabel,
  sameClock,
  scheduledLine,
  stepPayPeriod,
  summarize,
  summaryStats,
  type ActualOnlyRow,
  type DraftRow,
  type RowAction,
  type ScheduledRow,
  type ShiftActual,
} from "./payroll";
import { shiftDurationMinutes, timeToMinutes } from "./time";
import type { DateRange, Employee, Shift } from "./types";

// ---------------------------------------------------------------------------
// Fixtures (payroll spec §12)

const e1: Employee = { id: "e1", name: "Avery Lane", color: "#7F6C50", display_order: 0, archived: false };
const e2: Employee = { id: "e2", name: "bea Cruz", color: "#2B6CB0", display_order: 1, archived: false };
const e3: Employee = { id: "e3", name: "Cal Diaz", color: "#2F855A", display_order: 2, archived: true };
const e4: Employee = { id: "e4", name: "Dana Eng", color: "#C05621", display_order: 3, archived: true };
const employees = [e1, e2, e3, e4];
const names = new Map(employees.map((e) => [e.id, e.name]));
const nameOf = (id: string) => names.get(id) ?? "Unknown";

const P: DateRange = { start: "2026-09-15", end: "2026-09-28" };
const TODAY = "2026-09-27";
const SAVED_AT = "2026-09-29T14:00:18Z";

function shift(id: string, employee: string, date: string, start: string, end: string): Shift {
  return { id, employee_id: employee, shift_date: date, start_time: start, end_time: end };
}

function actual(
  id: string,
  fields: Partial<ShiftActual> & Pick<ShiftActual, "employee_id" | "work_date" | "status">,
): ShiftActual {
  return { id, shift_id: null, start_time: null, end_time: null, note: "", actualized_at: SAVED_AT, ...fields };
}

const s1 = shift("s1", "e1", "2026-09-15", "09:00:00", "17:00:00");
const s2 = shift("s2", "e2", "2026-09-15", "10:00:00", "18:00:00");
const s3 = shift("s3", "e1", "2026-09-16", "11:00:00", "17:00:00");
const s4 = shift("s4", "e2", "2026-09-16", "12:00:00", "18:00:00");
const s5 = shift("s5", "e1", "2026-09-28", "09:00:00", "17:00:00");
const shifts = [s1, s2, s3, s4, s5];

const as1 = actual("as1", {
  shift_id: "s1",
  employee_id: "e1",
  work_date: "2026-09-15",
  start_time: "09:00:00",
  end_time: "17:00:00",
  status: "confirmed",
});
const as2 = actual("as2", { shift_id: "s2", employee_id: "e2", work_date: "2026-09-15", status: "not-worked" });
const as3 = actual("as3", {
  shift_id: "s3",
  employee_id: "e1",
  work_date: "2026-09-16",
  start_time: "11:00:00",
  end_time: "17:15:00",
  status: "adjusted",
  note: "late",
});
const u1 = actual("u1", {
  employee_id: "e1",
  work_date: "2026-09-17",
  start_time: "10:00:00",
  end_time: "12:00:00",
  status: "unscheduled",
});
const actuals = [as1, as2, as3, u1];

const pristine = buildPristineRows({ period: P, shifts, actuals });

// Avery $16 throughout; Bea $15.50 through Sep 15, then $16.50.
const RATES = [
  { id: "r1", employee_id: "e1", rate: 16, start_date: null, end_date: null },
  { id: "r2", employee_id: "e2", rate: 15.5, start_date: null, end_date: "2026-09-15" },
  { id: "r3", employee_id: "e2", rate: 16.5, start_date: "2026-09-16", end_date: null },
];

function row(key: string): DraftRow {
  const found = pristine.find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
}

function scheduled(key: string): ScheduledRow {
  const found = row(key);
  if (found.kind !== "scheduled") throw new Error(`${key} is not scheduled`);
  return found;
}

function actualOnly(key: string): ActualOnlyRow {
  const found = row(key);
  if (found.kind !== "actual-only") throw new Error(`${key} is not actual-only`);
  return found;
}

function apply(start: DraftRow, ...actions: RowAction[]): DraftRow {
  return actions.reduce((current, action) => applyRowAction(current, action, TODAY), start);
}

// ---------------------------------------------------------------------------
// Time (payroll call sites use the lib/time helpers with `?? 0`)

describe("time helpers used by payroll", () => {
  it.each([
    ["09:00", 540],
    ["09:00:00", 540],
    ["24:00", 1440],
    ["00:00", 0],
    ["", null],
    [null, null],
    ["bad", null],
    ["25:00", null],
  ] as const)("timeToMinutes(%s) -> %s", (input, expected) => {
    expect(timeToMinutes(input)).toBe(expected);
  });

  it.each([
    ["09:00", "17:00", 480],
    ["09:00:00", "17:00:00", 480],
    ["09:00", "17:30", 510],
    ["22:00", "02:00", 240],
    ["23:45", "00:15", 30],
    ["18:00", "24:00", 360],
    ["18:00", "00:00", 360],
    ["09:00", "09:00", 1440],
    ["00:00", "00:00", 1440],
    ["09:00", "", null],
    [null, "10:00", null],
    ["bad", "10:00", null],
  ] as const)("shiftDurationMinutes(%s, %s) -> %s", (start, end, expected) => {
    expect(shiftDurationMinutes(start, end)).toBe(expected);
  });

  it.each([
    ["00:00", -15, "23:45"],
    ["23:50", 15, "00:05"],
    ["09:07", 15, "09:22"],
    ["09:00", -15, "08:45"],
    [null, 15, null],
    ["", 15, null],
  ] as const)("nudgeClock(%s, %s) -> %s", (input, delta, expected) => {
    expect(nudgeClock(input, delta)).toBe(expected);
  });

  it("sameClock compares minutes", () => {
    expect(sameClock("12:00:00", "12:00")).toBe(true);
    expect(sameClock("12:00", "12:15")).toBe(false);
    expect(sameClock(null, "")).toBe(true);
    expect(sameClock(null, "09:00")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Formatting

describe("formatPayrollDecimalHours", () => {
  it.each([
    [0, "0"],
    [1, "0.02"],
    [2, "0.03"],
    [3, "0.05"],
    [9, "0.15"],
    [15, "0.25"],
    [20, "0.33"],
    [21, "0.35"],
    [25, "0.42"],
    [40, "0.67"],
    [45, "0.75"],
    [50, "0.83"],
    [57, "0.95"],
    [59, "0.98"],
    [60, "1"],
    [61, "1.02"],
    [63, "1.05"],
    [90, "1.5"],
    [100, "1.67"],
    [440, "7.33"],
    [520, "8.67"],
    [535, "8.92"],
    [720, "12"],
    [1440, "24"],
    [2550, "42.5"],
    [4815, "80.25"],
  ])("%s min -> %s", (minutes, expected) => {
    expect(formatPayrollDecimalHours(minutes)).toBe(expected);
  });
});

describe("formatActualHours", () => {
  it.each([
    [0, "0 hr"],
    [1, "0.0 hr"],
    [3, "0.1 hr"],
    [9, "0.1 hr"],
    [15, "0.3 hr"],
    [20, "0.3 hr"],
    [45, "0.8 hr"],
    [59, "1.0 hr"],
    [90, "1.5 hr"],
    [100, "1.7 hr"],
    [375, "6.3 hr"],
    [975, "16.3 hr"],
    [1680, "28 hr"],
  ])("%s min -> %s", (minutes, expected) => {
    expect(formatActualHours(minutes)).toBe(expected);
  });
});

describe("formatActualDifference", () => {
  it.each([
    [0, "No time difference"],
    [1, "+1 min"],
    [-1, "−1 min"],
    [59, "+59 min"],
    [-59, "−59 min"],
    [60, "+1 hr"],
    [-60, "−1 hr"],
    [61, "+1 hr 1 min"],
    [90, "+1 hr 30 min"],
    [125, "+2 hr 5 min"],
    [-345, "−5 hr 45 min"],
    [-1440, "−24 hr"],
  ])("%s -> %s", (minutes, expected) => {
    expect(formatActualDifference(minutes)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it("writes hours and minutes", () => {
    expect(formatDuration(375)).toBe("6h 15m");
    expect(formatDuration(480)).toBe("8h");
    expect(formatDuration(15)).toBe("15m");
    expect(formatDuration(1330)).toBe("22h 10m");
    expect(formatDuration(0)).toBe("0m");
  });
});

describe("status labels", () => {
  it.each([
    ["confirmed", "As scheduled"],
    ["adjusted", "Adjusted"],
    ["not-worked", "Vacated"],
    ["unscheduled", "Unscheduled"],
    [null, "Needs review"],
  ] as const)("actualStatusLabel(%s) -> %s", (status, expected) => {
    expect(actualStatusLabel(status)).toBe(expected);
  });

  it("a future row that hasn't been reviewed is Upcoming", () => {
    expect(rowStatusLabel(row("shift:s5"), TODAY)).toBe("Upcoming");
    expect(rowStatusLabel(row("shift:s4"), TODAY)).toBe("Needs review");
    expect(rowStatusLabel(row("shift:s2"), TODAY)).toBe("Vacated");
  });
});

// ---------------------------------------------------------------------------
// Pay period

describe("pay period", () => {
  it.each([
    ["2026-09-29", "2026-09-15", "2026-09-28"],
    ["2026-11-03", "2026-10-20", "2026-11-02"],
    ["2027-01-05", "2026-12-22", "2027-01-04"],
    ["2028-03-01", "2028-02-16", "2028-02-29"],
  ])("defaultPayPeriod(%s) is %s to %s, with the last day selected", (today, start, end) => {
    expect(defaultPayPeriod(today)).toEqual({ period: { start, end }, selected: end });
  });

  it("steps by 14 days", () => {
    expect(stepPayPeriod(P, 1)).toEqual({ start: "2026-09-29", end: "2026-10-12" });
    expect(stepPayPeriod(P, -1)).toEqual({ start: "2026-09-01", end: "2026-09-14" });
  });

  it("payPeriodFrom runs 14 days", () => {
    expect(payPeriodFrom("2026-10-01")).toEqual({ start: "2026-10-01", end: "2026-10-14" });
  });

  it.each([
    ["0202-01-01", null],
    ["2026-02-30", null],
    ["", null],
    ["1999-12-31", null],
    ["2026-10-01", "2026-10-01"],
  ])("parsePeriodStartInput(%s) -> %s", (value, expected) => {
    expect(parsePeriodStartInput(value)).toBe(expected);
  });

  it("isFutureWorkDate: today isn't future", () => {
    expect(isFutureWorkDate("2026-09-29", "2026-09-29")).toBe(false);
    expect(isFutureWorkDate("2026-09-30", "2026-09-29")).toBe(true);
  });

  it("reads ?start=&day=, falling back to the defaults", () => {
    const today = "2026-09-29";
    expect(payPeriodFromParams({ start: null, day: null }, today)).toEqual({ period: P, selected: "2026-09-28" });
    expect(payPeriodFromParams({ start: "2026-10-01", day: "2026-10-05" }, today)).toEqual({
      period: { start: "2026-10-01", end: "2026-10-14" },
      selected: "2026-10-05",
    });
    // Day outside the period, or unreadable: the period's last day.
    expect(payPeriodFromParams({ start: "2026-10-01", day: "2026-09-20" }, today).selected).toBe("2026-10-14");
    expect(payPeriodFromParams({ start: "2026-10-01", day: "soon" }, today).selected).toBe("2026-10-14");
    // Bad start: the default period, keeping a day that is inside it.
    expect(payPeriodFromParams({ start: "0202-01-01", day: "2026-09-20" }, today)).toEqual({
      period: P,
      selected: "2026-09-20",
    });
  });
});

// ---------------------------------------------------------------------------
// Payroll output

describe("payrollLines and payrollClipboardText", () => {
  const outputActuals = [
    actual("a1", {
      shift_id: "s1",
      employee_id: "e1",
      work_date: "2026-09-15",
      start_time: "09:00:00",
      end_time: "17:00:00",
      status: "confirmed",
    }),
    actual("a2", {
      shift_id: "s2",
      employee_id: "e1",
      work_date: "2026-09-16",
      start_time: "22:00:00",
      end_time: "02:00:00",
      status: "adjusted",
    }),
    actual("a3", { shift_id: "s3", employee_id: "e2", work_date: "2026-09-16", status: "not-worked" }),
    actual("a4", {
      employee_id: "e3",
      work_date: "2026-09-20",
      start_time: "10:00",
      end_time: "12:20",
      status: "unscheduled",
    }),
    actual("a5", {
      employee_id: "e2",
      work_date: "2026-09-29",
      start_time: "09:00",
      end_time: "10:00",
      status: "unscheduled",
    }),
    actual("a6", { shift_id: "s6", employee_id: "e4", work_date: "2026-09-18", status: "not-worked" }),
    actual("a7", {
      employee_id: "e2",
      work_date: "2026-09-28",
      start_time: "09:00",
      end_time: "09:20",
      status: "unscheduled",
    }),
  ];

  it("lists active employees and archived ones with hours, by name", () => {
    expect(payrollClipboardText(payrollLines(employees, outputActuals, P))).toBe(
      "- Avery Lane - 12 hours\n- bea Cruz - 0.33 hours\n- Cal Diaz - 2.33 hours",
    );
  });

  it("is empty with no active employees and nothing worked", () => {
    expect(payrollClipboardText(payrollLines([e3, e4], [], P))).toBe("");
  });

  it("lists an archived employee who worked even with no active employees", () => {
    expect(payrollClipboardText(payrollLines([e3, e4], outputActuals, P))).toBe("- Cal Diaz - 2.33 hours");
  });

  it("orders two employees with the same name by id", () => {
    const samB: Employee = { ...e1, id: "b", name: "Sam" };
    const samA: Employee = { ...e1, id: "a", name: "Sam" };
    expect(payrollLines([samB, samA], [], P).map((line) => line.employee.id)).toEqual(["a", "b"]);
  });

  it("sums the minutes before rounding", () => {
    const thirds = ["2026-09-15", "2026-09-16", "2026-09-17"].map((date, i) =>
      actual(`t${i}`, {
        employee_id: "e1",
        work_date: date,
        start_time: "09:00",
        end_time: "09:20",
        status: "unscheduled",
      }),
    );
    expect(payrollClipboardText(payrollLines([e1], thirds, P))).toBe("- Avery Lane - 1 hours");
  });

  it("counts a record whose shift was deleted (an orphan)", () => {
    const orphan = actual("o1", {
      employee_id: "e2",
      work_date: "2026-09-21",
      start_time: "13:00:00",
      end_time: "19:00:00",
      status: "confirmed",
    });
    expect(payrollClipboardText(payrollLines([e1, e2], [orphan], P))).toBe(
      "- Avery Lane - 0 hours\n- bea Cruz - 6 hours",
    );
  });
});

// ---------------------------------------------------------------------------
// Pristine rows, summary, tabs

describe("buildPristineRows", () => {
  it("builds one row per shift plus records with no shift, sorted", () => {
    expect(pristine.map((r) => r.key)).toEqual([
      "shift:s1",
      "shift:s2",
      "shift:s3",
      "shift:s4",
      "actual:u1",
      "shift:s5",
    ]);
  });

  it("starts an unreviewed shift from the schedule", () => {
    expect(scheduled("shift:s4")).toMatchObject({
      status: null,
      employeeId: "e2",
      start: "12:00",
      end: "18:00",
      note: "",
      saved: null,
    });
  });

  it("shows a vacated shift with no employee or times", () => {
    expect(scheduled("shift:s2")).toMatchObject({ status: "not-worked", employeeId: null, start: null, end: null });
  });

  it("loads the saved values of a reviewed shift", () => {
    expect(scheduled("shift:s3")).toMatchObject({
      status: "adjusted",
      employeeId: "e1",
      start: "11:00",
      end: "17:15",
      note: "late",
    });
  });

  it("marks a record whose shift was deleted as an orphan", () => {
    const orphan = actual("o1", {
      employee_id: "e2",
      work_date: "2026-09-21",
      start_time: "13:00:00",
      end_time: "19:00:00",
      status: "confirmed",
    });
    const [only] = buildPristineRows({ period: P, shifts: [], actuals: [orphan] });
    expect(only).toMatchObject({
      kind: "actual-only",
      orphan: true,
      status: "confirmed",
      start: "13:00",
      end: "19:00",
    });
    expect(actualOnly("actual:u1").orphan).toBe(false);
  });

  it("leaves out rows outside the period", () => {
    const outside = shift("x", "e1", "2026-09-29", "09:00", "10:00");
    expect(buildPristineRows({ period: P, shifts: [outside], actuals: [] })).toEqual([]);
  });
});

describe("summarize, summaryStats and progressLabel", () => {
  it("adds up the saved rows up to today", () => {
    const summary = summarize(pristine, TODAY);
    expect(summaryStats(summary, laborCosts(pristine, RATES, TODAY), nameOf)).toEqual([
      { label: "Scheduled", value: "28 hr" },
      { label: "Actual reviewed", value: "16.3 hr" },
      { label: "Difference", value: "−5 hr 45 min" },
      { label: "Est. labor costs (scheduled)", value: "$447.00" },
      { label: "Est. labor costs (actual)", value: "$260.00" },
    ]);
    expect(progressLabel(summary)).toBe("4 of 5 shifts reviewed");
  });

  it("shows a dash for the difference and the actual cost when nothing is reviewed", () => {
    const rows = buildPristineRows({ period: P, shifts: [s4], actuals: [] });
    const summary = summarize(rows, TODAY);
    const stats = summaryStats(summary, laborCosts(rows, RATES, TODAY), nameOf);
    expect(stats[2]).toEqual({ label: "Difference", value: "—" });
    expect(stats[3]).toEqual({ label: "Est. labor costs (scheduled)", value: "$99.00" });
    expect(stats[4]).toEqual({ label: "Est. labor costs (actual)", value: "—" });
    expect(progressLabel(summary)).toBe("0 of 1 shift reviewed");
  });

  it("leaves the costs out for payroll staff, who can't see pay rates", () => {
    const stats = summaryStats(summarize(pristine, TODAY), null, nameOf, false);
    expect(stats.map((stat) => stat.label)).toEqual(["Scheduled", "Actual reviewed", "Difference"]);
  });

  it("shows dashes for both costs until the rates load", () => {
    const stats = summaryStats(summarize(pristine, TODAY), null, nameOf);
    expect(stats.slice(3)).toEqual([
      { label: "Est. labor costs (scheduled)", value: "—" },
      { label: "Est. labor costs (actual)", value: "—" },
    ]);
  });

  it("notes employees without a rate", () => {
    const withoutBea = RATES.filter((r) => r.employee_id !== "e2");
    const stats = summaryStats(summarize(pristine, TODAY), laborCosts(pristine, withoutBea, TODAY), nameOf);
    expect(stats[3]).toEqual({ label: "Est. labor costs (scheduled)", value: "$224.00", note: "No rate for bea Cruz" });
    // Bea's only reviewed shift was vacated, so the actual cost misses nothing.
    expect(stats[4]).toEqual({ label: "Est. labor costs (actual)", value: "$260.00" });
  });

  it("says when there's nothing to review", () => {
    expect(progressLabel(summarize([], TODAY))).toBe("No shifts scheduled this pay period");
  });

  it("counts orphans as reviewed actual hours", () => {
    const orphan = actual("o1", {
      employee_id: "e2",
      work_date: "2026-09-21",
      start_time: "13:00:00",
      end_time: "19:00:00",
      status: "confirmed",
    });
    const summary = summarize(buildPristineRows({ period: P, shifts: [], actuals: [orphan] }), TODAY);
    expect(summary).toMatchObject({ rowCount: 1, reviewedCount: 1, actualMinutes: 360, scheduledMinutes: 0 });
  });
});

describe("laborCosts", () => {
  it("prices each shift at the rate on its date, leaving out the future", () => {
    // s1 8h x $16 + s2 8h x $15.50 (before Bea's raise) + s3 6h x $16 + s4 6h x $16.50 (after).
    // s5 (Sep 28) is after TODAY. Actual: as1 8h and as3 6.25h for Avery, u1 2h, as2 vacated.
    expect(laborCosts(pristine, RATES, TODAY)).toEqual({
      scheduled: { dollars: 447, missingRateIds: [] },
      actual: { dollars: 260, missingRateIds: [] },
    });
  });

  it("charges the employee who actually worked, at their rate", () => {
    const covered = actual("c1", {
      shift_id: "s4",
      employee_id: "e1",
      work_date: "2026-09-16",
      start_time: "12:00:00",
      end_time: "18:00:00",
      status: "adjusted",
    });
    const rows = buildPristineRows({ period: P, shifts: [s4], actuals: [covered] });
    // Scheduled for Bea at $16.50; worked by Avery at $16.
    expect(laborCosts(rows, RATES, TODAY)).toEqual({
      scheduled: { dollars: 99, missingRateIds: [] },
      actual: { dollars: 96, missingRateIds: [] },
    });
  });

  it("counts overnight hours and rounds the total to cents", () => {
    const night = shift("n1", "e1", "2026-09-18", "22:00:00", "02:20:00");
    const rows = buildPristineRows({ period: P, shifts: [night], actuals: [] });
    // 4h 20m x $16 = $69.333…
    expect(laborCosts(rows, RATES, TODAY).scheduled.dollars).toBe(69.33);
  });

  it("rounds a total on a half cent up, without floating-point drift", () => {
    const rates = [
      { id: "a", employee_id: "e1", rate: 14.5, start_date: null, end_date: null },
      { id: "b", employee_id: "e2", rate: 15.5, start_date: null, end_date: null },
      { id: "c", employee_id: "e3", rate: 10.02, start_date: null, end_date: null },
    ];
    // 245 min x $14.50 + 260 min x $15.50 = $126.375 exactly (adding decimals gives 126.37499…).
    const pair = buildPristineRows({
      period: P,
      shifts: [
        shift("x1", "e1", "2026-09-18", "09:00:00", "13:05:00"),
        shift("x2", "e2", "2026-09-18", "09:00:00", "13:20:00"),
      ],
      actuals: [],
    });
    expect(laborCosts(pair, rates, TODAY).scheduled.dollars).toBe(126.38);
    // 55 min x $10.02 = $9.185.
    const short = shift("x3", "e3", "2026-09-18", "09:00:00", "09:55:00");
    const one = buildPristineRows({ period: P, shifts: [short], actuals: [] });
    expect(laborCosts(one, rates, TODAY).scheduled.dollars).toBe(9.19);
  });

  it("lists employees with hours but no rate on those dates", () => {
    const early = RATES.map((r) => (r.employee_id === "e1" ? { ...r, end_date: "2026-09-15" } : r));
    const costs = laborCosts(pristine, early, TODAY);
    // Avery's Sep 16 shift (s3) and Sep 16-17 actuals have no rate.
    expect(costs.scheduled).toEqual({ dollars: 351, missingRateIds: ["e1"] });
    expect(costs.actual).toEqual({ dollars: 128, missingRateIds: ["e1"] });
  });

  it("writes dollars and the missing-rate note", () => {
    expect(formatDollars(1234.5)).toBe("$1,234.50");
    expect(formatDollars(0)).toBe("$0.00");
    expect(missingRateNote([], nameOf)).toBeUndefined();
    expect(missingRateNote(["e2", "e1"], nameOf)).toBe("No rate for Avery Lane and bea Cruz");
    expect(missingRateNote(["e1", "e2", "e3"], nameOf)).toBe("No rate for 3 employees");
  });
});

describe("dayTab", () => {
  const closed = new Set(["2026-09-20", "2026-09-28"]);

  it.each([
    ["2026-09-15", "Tue", 15, "2/2", "Tuesday, September 15, 2 of 2 shifts reviewed"],
    ["2026-09-16", "Wed", 16, "1/2", "Wednesday, September 16, 1 of 2 shifts reviewed"],
    ["2026-09-17", "Thu", 17, "1/1", "Thursday, September 17, 1 of 1 shift reviewed"],
    ["2026-09-18", "Fri", 18, "—", "Friday, September 18, no shifts"],
    ["2026-09-20", "Sun", 20, "Closed", "Sunday, September 20, closed"],
    // Future wins over closed and over rows.
    ["2026-09-28", "Mon", 28, "Future", "Monday, September 28, future date"],
  ])("%s", (date, weekday, day, progressText, ariaLabel) => {
    expect(dayTab(date, pristine, TODAY, closed)).toEqual({ weekday, day, progressText, ariaLabel });
  });
});

describe("dayTabKeyTarget", () => {
  it.each([
    ["ArrowRight", 3, 4],
    ["ArrowLeft", 3, 2],
    ["ArrowRight", 13, 0],
    ["ArrowLeft", 0, 13],
    ["Home", 9, 0],
    ["End", 2, 13],
  ])("%s from tab %i goes to tab %i", (key, index, expected) => {
    expect(dayTabKeyTarget(key, index, 14)).toBe(expected);
  });

  it("ignores other keys", () => {
    expect(dayTabKeyTarget("Enter", 3, 14)).toBeNull();
    expect(dayTabKeyTarget("ArrowDown", 3, 14)).toBeNull();
    expect(dayTabKeyTarget("ArrowRight", 0, 0)).toBeNull();
  });

  it("moves one tab per press when each press starts from the tab the last one focused", () => {
    let focused = 6;
    for (let i = 0; i < 2; i++) focused = dayTabKeyTarget("ArrowLeft", focused, 14) ?? focused;
    expect(focused).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Row actions

describe("applyRowAction and deriveActualStatus", () => {
  const start = scheduled("shift:s4");

  it("confirm fills the schedule; confirming again clears the outcome only", () => {
    const confirmed = apply(start, { type: "confirm" });
    expect(confirmed).toMatchObject({ status: "confirmed", employeeId: "e2", start: "12:00", end: "18:00" });
    expect(apply(confirmed, { type: "confirm" })).toMatchObject({
      status: null,
      employeeId: "e2",
      start: "12:00",
      end: "18:00",
    });
  });

  it("vacate clears the employee and times; vacating again restores the schedule", () => {
    const vacated = apply(start, { type: "vacate" });
    expect(vacated).toMatchObject({ status: "not-worked", employeeId: null, start: null, end: null });
    expect(apply(vacated, { type: "vacate" })).toMatchObject({
      status: null,
      employeeId: "e2",
      start: "12:00",
      end: "18:00",
    });
  });

  it("vacate keeps the note", () => {
    const noted = apply(start, { type: "confirm" }, { type: "set-note", note: "Left early" }, { type: "vacate" });
    expect(noted).toMatchObject({ status: "not-worked", note: "Left early" });
  });

  it("changing the employee derives adjusted, and back derives confirmed", () => {
    const other = apply(start, { type: "set-employee", employeeId: "e1" });
    expect(other.status).toBe("adjusted");
    expect(apply(other, { type: "set-employee", employeeId: "e2" }).status).toBe("confirmed");
  });

  it("nudging away from and back to the schedule", () => {
    const later = apply(start, { type: "nudge", field: "end", delta: 15 });
    expect(later).toMatchObject({ end: "18:15", status: "adjusted" });
    expect(apply(later, { type: "nudge", field: "end", delta: -15 })).toMatchObject({
      end: "18:00",
      status: "confirmed",
    });
  });

  it("a cleared time or no employee is adjusted and can't be saved", () => {
    expect(apply(start, { type: "set-time", field: "start", value: "" }).status).toBe("adjusted");
    const nobody = apply(start, { type: "set-employee", employeeId: null });
    expect(nobody.status).toBe("adjusted");
    expect(findInvalidRow([nobody], nameOf)).toEqual({
      row: nobody,
      date: "2026-09-16",
      field: "employee",
      message: "Add an employee and both times for bea Cruz on Sep 16, 2026.",
    });
  });

  it("a note on an unreviewed row does nothing (P5)", () => {
    expect(applyRowAction(start, { type: "set-note", note: "Left early" }, TODAY)).toBe(start);
  });

  it("a note never changes the outcome", () => {
    const confirmed = apply(start, { type: "confirm" });
    expect(apply(confirmed, { type: "set-note", note: "Left early" })).toMatchObject({
      status: "confirmed",
      note: "Left early",
    });
    const vacated = apply(start, { type: "vacate" });
    expect(apply(vacated, { type: "set-note", note: "Sick" })).toMatchObject({ status: "not-worked", note: "Sick" });
  });

  it("vacated rows and blank times can't be nudged or edited", () => {
    const vacated = apply(start, { type: "vacate" });
    expect(applyRowAction(vacated, { type: "nudge", field: "start", delta: 15 }, TODAY)).toBe(vacated);
    expect(applyRowAction(vacated, { type: "set-employee", employeeId: "e1" }, TODAY)).toBe(vacated);
    const blank = apply(start, { type: "set-time", field: "start", value: "" });
    expect(applyRowAction(blank, { type: "nudge", field: "start", delta: 15 }, TODAY)).toBe(blank);
  });

  it("setting a time to the same minutes changes nothing", () => {
    const confirmed = apply(
      start,
      { type: "set-employee", employeeId: "e1" },
      { type: "set-employee", employeeId: "e2" },
    );
    expect(confirmed.status).toBe("confirmed");
    expect(applyRowAction(confirmed, { type: "set-time", field: "start", value: "12:00" }, TODAY)).toBe(confirmed);
    expect(applyRowAction(start, { type: "set-employee", employeeId: "e2" }, TODAY)).toBe(start);
  });

  it("does nothing on a future row", () => {
    const future = row("shift:s5");
    const actions: RowAction[] = [
      { type: "confirm" },
      { type: "vacate" },
      { type: "set-employee", employeeId: "e2" },
      { type: "set-time", field: "start", value: "10:00" },
      { type: "nudge", field: "end", delta: 15 },
      { type: "set-note", note: "x" },
    ];
    for (const action of actions) expect(applyRowAction(future, action, TODAY)).toBe(future);
  });

  it("actual-only rows stay unscheduled and have no outcome buttons", () => {
    const only = actualOnly("actual:u1");
    expect(apply(only, { type: "set-employee", employeeId: "e2" })).toMatchObject({
      status: "unscheduled",
      employeeId: "e2",
    });
    expect(applyRowAction(only, { type: "confirm" }, TODAY)).toBe(only);
    expect(applyRowAction(only, { type: "vacate" }, TODAY)).toBe(only);
    expect(deriveActualStatus(only)).toBe("unscheduled");
  });

  it("an orphan keeps its status until edited, then becomes unscheduled", () => {
    const orphan = actual("o1", {
      employee_id: "e2",
      work_date: "2026-09-21",
      start_time: "13:00:00",
      end_time: "19:00:00",
      status: "adjusted",
    });
    const [row0] = buildPristineRows({ period: P, shifts: [], actuals: [orphan] });
    const later = apply(row0, { type: "nudge", field: "end", delta: 15 });
    expect(later.status).toBe("unscheduled");
    expect(apply(later, { type: "nudge", field: "end", delta: -15 }).status).toBe("adjusted");
    expect(apply(row0, { type: "set-note", note: "moved" }).status).toBe("unscheduled");
  });

  it("a vacated orphan can only be removed", () => {
    const orphan = actual("o2", { employee_id: "e2", work_date: "2026-09-21", status: "not-worked" });
    const [row0] = buildPristineRows({ period: P, shifts: [], actuals: [orphan] });
    expect(row0).toMatchObject({ status: "not-worked", employeeId: null, orphan: true });
    expect(applyRowAction(row0, { type: "set-note", note: "x" }, TODAY)).toBe(row0);
    expect(applyRowAction(row0, { type: "set-employee", employeeId: "e1" }, TODAY)).toBe(row0);
    expect(applyRowAction(row0, { type: "set-time", field: "start", value: "09:00" }, TODAY)).toBe(row0);
  });
});

describe("use-logged (Use logged hours)", () => {
  const start = scheduled("shift:s4"); // e2, Sep 16, 12:00-18:00, not reviewed
  const late = { employeeId: "e2", start: "12:00", end: "18:10" };

  it("fills in the logged times: adjusted, or as scheduled when they match", () => {
    expect(apply(start, { type: "use-logged", ...late })).toMatchObject({
      status: "adjusted",
      employeeId: "e2",
      start: "12:00",
      end: "18:10",
    });
    expect(apply(start, { type: "use-logged", employeeId: "e2", start: "12:00", end: "18:00" })).toMatchObject({
      status: "confirmed",
    });
  });

  it("takes the employee who logged them", () => {
    expect(apply(start, { type: "use-logged", ...late, employeeId: "e1" })).toMatchObject({
      status: "adjusted",
      employeeId: "e1",
    });
  });

  it("undoes Vacated and keeps the note", () => {
    const vacated = apply(start, { type: "vacate" }, { type: "set-note", note: "Sick" });
    expect(apply(vacated, { type: "use-logged", ...late })).toMatchObject({
      status: "adjusted",
      employeeId: "e2",
      start: "12:00",
      end: "18:10",
      note: "Sick",
    });
  });

  it("is only offered when it would change something", () => {
    // Not reviewed yet: even hours that match the schedule set an outcome.
    expect(canUseLoggedHours(start, { employeeId: "e2", start: "12:00", end: "18:00" }, TODAY)).toBe(true);
    const used = apply(start, { type: "use-logged", ...late });
    expect(canUseLoggedHours(used, late, TODAY)).toBe(false);
    expect(applyRowAction(used, { type: "use-logged", ...late }, TODAY)).toBe(used);
    expect(canUseLoggedHours(used, { ...late, end: "18:15" }, TODAY)).toBe(true);
  });

  it("does nothing on a future day or on work off the schedule", () => {
    const future = scheduled("shift:s5");
    expect(canUseLoggedHours(future, { employeeId: "e1", start: "09:00", end: "17:10" }, TODAY)).toBe(false);
    const unscheduled = actualOnly("actual:u1");
    const action: RowAction = { type: "use-logged", employeeId: "e1", start: "10:00", end: "13:00" };
    expect(applyRowAction(unscheduled, action, TODAY)).toBe(unscheduled);
  });
});

describe("reset (canResetRow and rowsEqual)", () => {
  it("nothing to reset on an untouched row; something after an edit", () => {
    const s4 = scheduled("shift:s4");
    expect(canResetRow(s4, s4, TODAY)).toBe(false);
    const confirmed = apply(s4, { type: "confirm" });
    expect(canResetRow(confirmed, s4, TODAY)).toBe(true);
  });

  it("reset is the pristine row, so resetting equals pristine", () => {
    const s3 = scheduled("shift:s3");
    const edited = apply(s3, { type: "set-note", note: "very late" }, { type: "nudge", field: "end", delta: 15 });
    expect(rowsEqual(edited, s3)).toBe(false);
    expect(
      rowsEqual(apply(edited, { type: "set-note", note: "late" }, { type: "nudge", field: "end", delta: -15 }), s3),
    ).toBe(true);
  });

  it("saved actual-only rows can be reset only when changed", () => {
    const only = actualOnly("actual:u1");
    expect(canResetRow(only, only, TODAY)).toBe(false);
    expect(canResetRow(apply(only, { type: "nudge", field: "start", delta: 15 }), only, TODAY)).toBe(true);
  });

  it("an added row that was never saved can be reset (removed)", () => {
    const added = newActualOnlyRow({
      id: "n1",
      employeeId: "e1",
      date: "2026-09-17",
      start: "13:00",
      end: "15:00",
      note: "",
    });
    expect(canResetRow(added, undefined, TODAY)).toBe(true);
  });

  it("future rows can't be reset", () => {
    const future = row("shift:s5");
    expect(canResetRow({ ...future, status: "confirmed" }, future, TODAY)).toBe(false);
  });
});

describe("addWorkError", () => {
  const ok = { employeeId: "e1", date: "2026-09-20", start: "09:00", end: "17:00" };

  it("needs every detail", () => {
    expect(addWorkError({ ...ok, employeeId: null }, P, TODAY)).toEqual({
      title: "Missing shift details",
      message: "Choose an employee, date, start time, and end time.",
    });
    expect(addWorkError({ ...ok, end: "" }, P, TODAY)?.title).toBe("Missing shift details");
  });

  it("needs a date in the period", () => {
    expect(addWorkError({ ...ok, date: "2026-09-29" }, P, TODAY)).toEqual({
      title: "Date outside this pay period",
      message: "Choose a date shown in the current pay period.",
    });
  });

  it("refuses dates that haven't happened", () => {
    expect(addWorkError({ ...ok, date: "2026-09-21" }, P, "2026-09-20")).toEqual({
      title: "Date has not happened yet",
      message: "Work can only be added for today or an earlier date.",
    });
    expect(addWorkError({ ...ok, date: "2026-09-20" }, P, "2026-09-20")).toBeNull();
  });

  it("refuses the same start and end", () => {
    expect(addWorkError({ ...ok, start: "09:00", end: "09:00" }, P, TODAY)).toEqual({
      title: "Invalid times",
      message: "Start and end can't be the same time.",
    });
  });
});

// ---------------------------------------------------------------------------
// Save

describe("planActualsSave", () => {
  const empty = { deleteIds: [], scheduled: [], actualOnly: [], changeCount: 0 };

  function replace(rows: readonly DraftRow[], next: DraftRow): DraftRow[] {
    return rows.map((r) => (r.key === next.key ? next : r));
  }

  it("saves nothing for untouched rows", () => {
    expect(planActualsSave(pristine, [])).toEqual(empty);
  });

  it("writes a confirmed shift without a work date or timestamp (the server sets them)", () => {
    const rows = replace(pristine, apply(scheduled("shift:s4"), { type: "confirm" }));
    expect(planActualsSave(rows, [])).toEqual({
      ...empty,
      scheduled: [
        { shift_id: "s4", employee_id: "e2", status: "confirmed", start_time: "12:00", end_time: "18:00", note: "" },
      ],
      changeCount: 1,
    });
  });

  it("writes a vacated shift under the scheduled employee with no times", () => {
    const rows = replace(pristine, apply(scheduled("shift:s4"), { type: "vacate" }));
    expect(planActualsSave(rows, []).scheduled).toEqual([
      { shift_id: "s4", employee_id: "e2", status: "not-worked", start_time: null, end_time: null, note: "" },
    ]);
  });

  it("deletes the record of a shift whose outcome was cleared", () => {
    const rows = replace(pristine, apply(scheduled("shift:s2"), { type: "vacate" }));
    expect(planActualsSave(rows, [])).toEqual({ ...empty, deleteIds: ["as2"], changeCount: 1 });
  });

  it("compares saved times as minutes", () => {
    const s1 = scheduled("shift:s1");
    expect(s1.saved?.start_time).toBe("09:00:00");
    expect(s1.start).toBe("09:00");
    expect(planActualsSave([s1], [])).toEqual(empty);
  });

  it("trims notes, and a note that only differs by spaces isn't a change", () => {
    const rows = replace(pristine, apply(scheduled("shift:s3"), { type: "set-note", note: "  late  " }));
    expect(planActualsSave(rows, [])).toEqual(empty);
    const changed = replace(pristine, apply(scheduled("shift:s3"), { type: "set-note", note: "  very late  " }));
    expect(planActualsSave(changed, []).scheduled).toEqual([
      {
        shift_id: "s3",
        employee_id: "e1",
        status: "adjusted",
        start_time: "11:00",
        end_time: "17:15",
        note: "very late",
      },
    ]);
  });

  it("writes new actual-only work", () => {
    const added = newActualOnlyRow({
      id: "n1",
      employeeId: "e1",
      date: "2026-09-17",
      start: "13:00",
      end: "15:00",
      note: " cover ",
    });
    expect(planActualsSave([...pristine, added], [])).toEqual({
      ...empty,
      actualOnly: [
        { id: "n1", employee_id: "e1", work_date: "2026-09-17", start_time: "13:00", end_time: "15:00", note: "cover" },
      ],
      changeCount: 1,
    });
  });

  it("deletes removed saved rows and forgets removed unsaved ones", () => {
    const u1Row = actualOnly("actual:u1");
    const rest = pristine.filter((r) => r.key !== u1Row.key);
    expect(planActualsSave(rest, [u1Row])).toEqual({ ...empty, deleteIds: ["u1"], changeCount: 1 });
    const added = newActualOnlyRow({
      id: "n1",
      employeeId: "e1",
      date: "2026-09-17",
      start: "13:00",
      end: "15:00",
      note: "",
    });
    expect(planActualsSave(rest, [added])).toEqual(empty);
  });

  it("saves an edited orphan as unscheduled work, and leaves an untouched one alone", () => {
    const orphan = actual("o1", {
      employee_id: "e2",
      work_date: "2026-09-21",
      start_time: "13:00:00",
      end_time: "19:00:00",
      status: "confirmed",
    });
    const rows = buildPristineRows({ period: P, shifts: [], actuals: [orphan] });
    expect(planActualsSave(rows, [])).toEqual(empty);
    const edited = apply(rows[0], { type: "nudge", field: "start", delta: -15 });
    expect(planActualsSave([edited], []).actualOnly).toEqual([
      { id: "o1", employee_id: "e2", work_date: "2026-09-21", start_time: "12:45", end_time: "19:00", note: "" },
    ]);
  });

  it("counts every write", () => {
    let rows = replace(pristine, apply(scheduled("shift:s4"), { type: "confirm" }));
    rows = replace(rows, apply(scheduled("shift:s2"), { type: "vacate" }));
    const added = newActualOnlyRow({
      id: "n1",
      employeeId: "e1",
      date: "2026-09-17",
      start: "13:00",
      end: "15:00",
      note: "",
    });
    const plan = planActualsSave([...rows, added], []);
    expect(plan.changeCount).toBe(3);
    expect(plan.changeCount).toBe(plan.deleteIds.length + plan.scheduled.length + plan.actualOnly.length);
  });
});

describe("findInvalidRow", () => {
  it("ignores vacated rows and unreviewed rows", () => {
    const vacated = apply(scheduled("shift:s4"), { type: "vacate" });
    expect(findInvalidRow([vacated], nameOf)).toBeNull();
    const blankButUnreviewed: ScheduledRow = { ...scheduled("shift:s4"), employeeId: null, start: null };
    expect(findInvalidRow([blankButUnreviewed], nameOf)).toBeNull();
  });

  it("names the first missing time", () => {
    const noEnd = apply(scheduled("shift:s4"), { type: "set-time", field: "end", value: "" });
    expect(findInvalidRow([noEnd], nameOf)).toMatchObject({ field: "end", date: "2026-09-16" });
  });

  it("refuses the same start and end, with the date", () => {
    const same = apply(scheduled("shift:s1"), { type: "set-time", field: "end", value: "09:00" });
    expect(findInvalidRow([same], nameOf)).toMatchObject({
      field: "start",
      date: "2026-09-15",
      message: "Start and end can't be the same time for Avery Lane on Sep 15, 2026.",
    });
  });

  it("reports the earliest row first", () => {
    const later = apply(scheduled("shift:s4"), { type: "set-employee", employeeId: null });
    const earlier = apply(scheduled("shift:s1"), { type: "set-time", field: "start", value: "" });
    expect(findInvalidRow([later, earlier], nameOf)?.row.key).toBe("shift:s1");
  });
});

describe("overlapWarnings and overlapConfirmMessage", () => {
  function worked(key: string, employee: string, date: string, start: string, end: string): DraftRow {
    return newActualOnlyRow({ id: key, employeeId: employee, date, start, end, note: "" });
  }

  it("warns about one employee's overlapping rows on a day", () => {
    const confirmed = apply(
      scheduled("shift:s1"),
      { type: "set-time", field: "start", value: "09:30" },
      { type: "set-time", field: "end", value: "14:30" },
    );
    expect(overlapWarnings([confirmed, worked("x", "e1", "2026-09-15", "10:00", "12:00")], nameOf)).toEqual([
      "Avery Lane has overlapping actual shifts on Sep 15, 2026.",
    ]);
  });

  it("touching rows and different employees don't overlap", () => {
    expect(
      overlapWarnings(
        [worked("a", "e1", "2026-09-15", "09:00", "12:00"), worked("b", "e1", "2026-09-15", "12:00", "15:00")],
        nameOf,
      ),
    ).toEqual([]);
    expect(
      overlapWarnings(
        [worked("a", "e1", "2026-09-15", "09:00", "12:00"), worked("b", "e2", "2026-09-15", "10:00", "11:00")],
        nameOf,
      ),
    ).toEqual([]);
  });

  it("ignores vacated and unreviewed rows", () => {
    const vacated = apply(scheduled("shift:s4"), { type: "vacate" });
    const unreviewed = scheduled("shift:s4");
    const other = worked("b", "e2", "2026-09-16", "12:00", "18:00");
    expect(overlapWarnings([vacated, other], nameOf)).toEqual([]);
    expect(overlapWarnings([unreviewed, other], nameOf)).toEqual([]);
  });

  it("gives three overlapping rows one line", () => {
    const rows = [
      worked("a", "e1", "2026-09-15", "09:00", "12:00"),
      worked("b", "e1", "2026-09-15", "10:00", "13:00"),
      worked("c", "e1", "2026-09-15", "11:00", "14:00"),
    ];
    expect(overlapWarnings(rows, nameOf)).toHaveLength(1);
  });

  it("catches an overnight row on its own date", () => {
    const rows = [worked("a", "e1", "2026-09-15", "22:00", "02:00"), worked("b", "e1", "2026-09-15", "23:00", "23:30")];
    expect(overlapWarnings(rows, nameOf)).toEqual(["Avery Lane has overlapping actual shifts on Sep 15, 2026."]);
  });

  it("catches an overnight row running into the next morning, naming the earlier date", () => {
    const rows = [worked("b", "e1", "2026-09-16", "01:00", "03:00"), worked("a", "e1", "2026-09-15", "22:00", "02:00")];
    expect(overlapWarnings(rows, nameOf)).toEqual(["Avery Lane has overlapping actual shifts on Sep 15, 2026."]);
  });

  it("shows the first four warnings", () => {
    const warnings = ["one", "two", "three", "four", "five"];
    expect(overlapConfirmMessage(warnings)).toBe("one\ntwo\nthree\nfour\n\nSave these actuals anyway?");
  });
});

describe("row text", () => {
  function reviewed(base: ScheduledRow, fields: Partial<ScheduledRow>): ScheduledRow {
    return { ...base, ...fields };
  }

  it("rowDifferenceText", () => {
    const s4 = scheduled("shift:s4");
    expect(rowDifferenceText(s4, TODAY)).toBe("");
    expect(rowDifferenceText(apply(s4, { type: "vacate" }), TODAY)).toBe("0 actual hours recorded.");
    expect(rowDifferenceText(actualOnly("actual:u1"), TODAY)).toBe("Added to actual hours only.");
    expect(rowDifferenceText(apply(s4, { type: "confirm" }), TODAY)).toBe("No time difference");
    expect(rowDifferenceText(apply(s4, { type: "set-employee", employeeId: "e1" }), TODAY)).toBe(
      "Different employee · No time difference",
    );
    expect(rowDifferenceText(apply(s4, { type: "nudge", field: "end", delta: 15 }), TODAY)).toBe("+15 min");
    const tenToFour = scheduled("shift:s4");
    const overnight = reviewed(
      { ...tenToFour, shift: { ...tenToFour.shift, start_time: "10:00:00", end_time: "16:00:00" } },
      { status: "adjusted", start: "22:00", end: "02:00" },
    );
    expect(rowDifferenceText(overnight, TODAY)).toBe("−2 hr");
    expect(rowDifferenceText(row("shift:s5"), TODAY)).toBe("Available after this date begins.");
  });

  it("scheduledLine", () => {
    expect(scheduledLine(row("shift:s1"))).toBe("Scheduled · 9:00 AM – 5:00 PM (8h)");
    expect(scheduledLine(row("shift:s3"))).toBe("Scheduled · 11:00 AM – 5:00 PM (6h)");
    const overnight = scheduled("shift:s1");
    expect(
      scheduledLine({ ...overnight, shift: { ...overnight.shift, start_time: "22:00:00", end_time: "02:00:00" } }),
    ).toBe("Scheduled · 10:00 PM – 2:00 AM (4h)");
    expect(
      scheduledLine({ ...overnight, shift: { ...overnight.shift, start_time: "09:15:00", end_time: "17:00:00" } }),
    ).toBe("Scheduled · 9:15 AM – 5:00 PM (7h 45m)");
    expect(
      scheduledLine({ ...overnight, shift: { ...overnight.shift, start_time: "12:00:00", end_time: "12:45:00" } }),
    ).toBe("Scheduled · 12:00 PM – 12:45 PM (45m)");
    expect(scheduledLine(actualOnly("actual:u1"))).toBe("Not originally scheduled");
    const orphan = actual("o1", {
      employee_id: "e2",
      work_date: "2026-09-21",
      start_time: "13:00",
      end_time: "19:00",
      status: "confirmed",
    });
    expect(scheduledLine(buildPristineRows({ period: P, shifts: [], actuals: [orphan] })[0])).toBe(
      "Its scheduled shift was deleted",
    );
  });

  it("lastSavedText uses the business day", () => {
    expect(lastSavedText(null)).toBe("Not saved yet");
    expect(lastSavedText({ actualized_at: "2026-09-29T14:00:18Z" })).toBe("Last saved Sep 29");
    expect(lastSavedText({ actualized_at: "2026-09-29T03:30:00Z" })).toBe("Last saved Sep 28");
    expect(lastSavedText({ actualized_at: "2026-09-29T15:15:46.295238+00:00" })).toBe("Last saved Sep 29");
  });
});

describe("compareDraftRows", () => {
  it("orders by date, start, then scheduled before actual-only", () => {
    const ten = shift("ten", "e1", "2026-09-15", "10:00:00", "12:00:00");
    const nineThirty = shift("nine", "e2", "2026-09-15", "09:30:00", "12:00:00");
    const rows = buildPristineRows({ period: P, shifts: [ten, nineThirty], actuals: [] });
    const extra = newActualOnlyRow({
      id: "x",
      employeeId: "e1",
      date: "2026-09-15",
      start: "10:00",
      end: "12:00",
      note: "",
    });
    const sorted = [extra, rows[1], rows[0]].sort(compareDraftRows);
    expect(sorted.map((r) => r.key)).toEqual(["shift:nine", "shift:ten", "actual:x"]);
  });

  it("puts an earlier date first", () => {
    const early = newActualOnlyRow({
      id: "e",
      employeeId: "e1",
      date: "2026-09-15",
      start: "20:00",
      end: "21:00",
      note: "",
    });
    expect(compareDraftRows(early, row("shift:s3"))).toBeLessThan(0);
  });

  it("sorts actual-only rows on the values they were added with", () => {
    const added = newActualOnlyRow({
      id: "x",
      employeeId: "e1",
      date: "2026-09-15",
      start: "08:00",
      end: "09:00",
      note: "",
    });
    const edited = apply(added, { type: "set-time", field: "start", value: "11:00" });
    expect(compareDraftRows(edited, row("shift:s1"))).toBeLessThan(0);
  });
});
