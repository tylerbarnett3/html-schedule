import { describe, expect, it } from "vitest";
import { NO_HOURS, type Hours, type HoursData, type HoursSet, type Weekday } from "./hours";
import {
  buildSchedulePdfTables,
  PDF_CLOSED_CELL,
  PDF_EMPTY_CELL,
  PDF_LAYOUT,
  pdfCellText,
  pdfFilename,
  pdfFirstStartY,
  pdfHoursKey,
  pdfKeyLines,
  pdfPageFooter,
  pdfTimeOffText,
  pdfWeekHeader,
  pdfWeeks,
  type SchedulePdfInput,
} from "./schedulePdf";
import type { DayPeriod, Employee, ISODate, RequestStatus, Shift, TimeOff } from "./types";

function shift(id: string, employee_id: string, shift_date: ISODate, start_time: string, end_time: string): Shift {
  return { id, employee_id, shift_date, start_time, end_time };
}

function timeOff(
  id: string,
  employee_id: string,
  off_date: ISODate,
  period: DayPeriod,
  status: RequestStatus = "approved",
  source: TimeOff["source"] = "request",
): TimeOff {
  return { id, employee_id, off_date, period, status, source, requested_at: "2026-09-01T12:00:00+00:00" };
}

function employee(id: string, name: string, display_order: number, archived = false): Employee {
  return { id, name, color: "#2B6CB0", display_order, archived };
}

const times = (start_time: string, end_time: string) => ({ start_time, end_time });
const off = (period: DayPeriod) => ({ period });

const hours = (open: string, close: string): Hours => ({ open, close });

/** A weekly set from Monday-first hours, as Postgres returns them ('HH:MM:SS'). */
function hoursSet(startsOn: ISODate | null, mondayFirst: readonly [string, string][]): HoursSet {
  const at = (weekday: Weekday): Hours => {
    const [open, close] = mondayFirst[(weekday + 6) % 7] ?? ["", ""];
    return hours(open, close);
  };
  return { startsOn, days: { 0: at(0), 1: at(1), 2: at(2), 3: at(3), 4: at(4), 5: at(5), 6: at(6) } };
}

const WEEKDAY_11_9: [string, string] = ["11:00:00", "21:00:00"];
const SATURDAY_10_6: [string, string] = ["10:00:00", "18:00:00"];
const SUNDAY_12_5: [string, string] = ["12:00:00", "17:00:00"];

// Like the local seed on 2026-09-30: the first set, one from seed-60 (in effect today) and an
// upcoming change from seed+21.
const FIRST = hoursSet(null, [
  ...Array.from({ length: 5 }, (): [string, string] => ["10:00:00", "20:00:00"]),
  SATURDAY_10_6,
  SUNDAY_12_5,
]);
const AUG = hoursSet("2026-08-01", [
  ...Array.from({ length: 5 }, () => WEEKDAY_11_9),
  SATURDAY_10_6,
  SUNDAY_12_5,
]);
const OCT21 = hoursSet("2026-10-21", [
  WEEKDAY_11_9,
  ["11:00:00", "19:00:00"],
  WEEKDAY_11_9,
  WEEKDAY_11_9,
  ["11:00:00", "22:00:00"],
  ["10:00:00", "22:00:00"],
  SUNDAY_12_5,
]);

const SEEDED_RANGE = { start: "2026-09-30", end: "2026-11-03" };
const SEEDED_CLOSED: ReadonlySet<ISODate> = new Set(["2026-10-09", "2026-10-30"]);
const SEEDED_HOURS: HoursData = {
  sets: [FIRST, AUG, OCT21],
  custom: new Map<ISODate, Hours>([
    ["2026-10-03", hours("10:00:00", "18:00:00")], // +3, a Saturday: equal to its standard
    ["2026-10-04", hours("12:00:00", "16:00:00")], // +4
    // A stray row on a closed date (only a direct write could make one): CLOSED wins.
    ["2026-10-09", hours("09:00:00", "13:00:00")],
    ["2026-10-11", hours("10:00:00", "15:00:00")], // +11
    ["2026-10-23", hours("11:00:00", "21:00:00")], // +23, a Friday: the old standard, not the new 11-10
  ]),
};

describe("pdfWeeks", () => {
  it("cuts a 35-day range into 5 chunks of 7 from the start date", () => {
    const weeks = pdfWeeks({ start: "2026-09-29", end: "2026-11-02" });
    expect(weeks.map((w) => w.length)).toEqual([7, 7, 7, 7, 7]);
    expect(weeks[0]).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(weeks[4]?.at(-1)).toBe("2026-11-02");
  });

  it("leaves a shorter last chunk", () => {
    const weeks = pdfWeeks({ start: "2026-09-13", end: "2026-09-22" });
    expect(weeks.map((w) => w.length)).toEqual([7, 3]);
    expect(weeks[1]).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
  });

  it("counts every day across a daylight-saving change (the old page lost Mar 31)", () => {
    const weeks = pdfWeeks({ start: "2026-03-01", end: "2026-03-31" });
    expect(weeks.map((w) => w.length)).toEqual([7, 7, 7, 7, 3]);
    expect(weeks.flat()).toHaveLength(31);
    expect(weeks[4]?.at(-1)).toBe("2026-03-31");
    // November's change too.
    expect(pdfWeeks({ start: "2026-11-01", end: "2026-11-07" }).flat()).toHaveLength(7);
  });

  it("handles a one-day range", () => {
    expect(pdfWeeks({ start: "2026-10-05", end: "2026-10-05" })).toEqual([["2026-10-05"]]);
  });

  it("is empty when the range is backwards", () => {
    expect(pdfWeeks({ start: "2026-10-05", end: "2026-10-04" })).toEqual([]);
  });
});

describe("pdfWeekHeader", () => {
  it("labels the week and each day", () => {
    const week = pdfWeeks({ start: "2026-09-29", end: "2026-10-05" })[0] ?? [];
    expect(pdfWeekHeader(week)).toEqual([
      "Week of\nSep 29 - Oct 5",
      "Tue\n9/29",
      "Wed\n9/30",
      "Thu\n10/1",
      "Fri\n10/2",
      "Sat\n10/3",
      "Sun\n10/4",
      "Mon\n10/5",
    ]);
  });

  it("labels a short week by its own first and last day", () => {
    expect(pdfWeekHeader(["2026-09-20", "2026-09-21", "2026-09-22"])).toEqual([
      "Week of\nSep 20 - Sep 22",
      "Sun\n9/20",
      "Mon\n9/21",
      "Tue\n9/22",
    ]);
  });

  it("crosses a year", () => {
    const header = pdfWeekHeader(pdfWeeks({ start: "2026-12-29", end: "2027-01-04" })[0] ?? []);
    expect(header[0]).toBe("Week of\nDec 29 - Jan 4");
    expect(header.at(-1)).toBe("Mon\n1/4");
  });

  it("is empty for an empty week", () => {
    expect(pdfWeekHeader([])).toEqual([]);
    expect(pdfWeekHeader([], () => hours("09:00", "17:00"))).toEqual([]);
  });

  it("adds a third line to the days hoursFor gives hours", () => {
    const week = pdfWeeks({ start: "2026-10-25", end: "2026-10-31" })[0] ?? [];
    const hoursFor = (d: ISODate) => (d === "2026-10-31" ? hours("09:00:00", "17:00:00") : null);
    expect(pdfWeekHeader(week, hoursFor)).toEqual([
      "Week of\nOct 25 - Oct 31",
      "Sun\n10/25",
      "Mon\n10/26",
      "Tue\n10/27",
      "Wed\n10/28",
      "Thu\n10/29",
      "Fri\n10/30",
      "Sat\n10/31\n(9:00 AM - 5:00 PM)",
    ]);
    // Without hoursFor, or when it gives nothing, the header is the plain two lines.
    const plain = pdfWeekHeader(week);
    expect(plain.at(-1)).toBe("Sat\n10/31");
    expect(pdfWeekHeader(week, () => null)).toEqual(plain);
  });

  it("prints 'HH:MM' hours and times past noon in the shift time style", () => {
    expect(pdfWeekHeader(["2026-10-31"], () => hours("12:30", "23:59"))).toEqual([
      "Week of\nOct 31 - Oct 31",
      "Sat\n10/31\n(12:30 PM - 11:59 PM)",
    ]);
  });
});

describe("pdfCellText", () => {
  it("prints CLOSED on a closed date, whatever else is there", () => {
    expect(pdfCellText({ closed: true, shifts: [times("09:00", "15:00")], timeOff: [] })).toBe("CLOSED");
    expect(PDF_CLOSED_CELL).toBe("CLOSED");
  });

  it("prints an em dash for an empty day", () => {
    expect(pdfCellText({ closed: false, shifts: [], timeOff: [] })).toBe("—");
    expect(PDF_EMPTY_CELL).toBe("—");
  });

  it("prints a shift's times", () => {
    expect(pdfCellText({ closed: false, shifts: [times("09:00:00", "15:00:00")], timeOff: [] })).toBe(
      "9:00 AM - 3:00 PM",
    );
  });

  it("orders shifts by start time, not load order", () => {
    expect(
      pdfCellText({
        closed: false,
        shifts: [times("22:00:00", "02:00:00"), times("09:00:00", "15:00:00")],
        timeOff: [],
      }),
    ).toBe("9:00 AM - 3:00 PM, 10:00 PM - 2:00 AM");
  });

  it("breaks a start-time tie by end time", () => {
    expect(
      pdfCellText({ closed: false, shifts: [times("12:00", "18:00"), times("12:00", "14:00")], timeOff: [] }),
    ).toBe("12:00 PM - 2:00 PM, 12:00 PM - 6:00 PM");
  });

  it("compares 'HH:MM' and 'HH:MM:SS' as times", () => {
    expect(
      pdfCellText({ closed: false, shifts: [times("10:00:00", "12:00:00"), times("09:30", "10:00")], timeOff: [] }),
    ).toBe("9:30 AM - 10:00 AM, 10:00 AM - 12:00 PM");
  });

  it("prints midnight as 12:00 AM", () => {
    expect(pdfCellText({ closed: false, shifts: [times("18:00", "24:00")], timeOff: [] })).toBe(
      "6:00 PM - 12:00 AM",
    );
  });
});

describe("pdfTimeOffText and mixed cells", () => {
  it("keeps the part of the day (D3)", () => {
    expect(pdfTimeOffText(off("full-day"))).toBe("OFF");
    expect(pdfTimeOffText(off("morning"))).toBe("MORNING OFF");
    expect(pdfTimeOffText(off("evening"))).toBe("EVENING OFF");
  });

  it("treats an unknown period as a full day", () => {
    expect(pdfTimeOffText({ period: "lunch" as DayPeriod })).toBe("OFF");
  });

  it("lists shifts before time off", () => {
    expect(pdfCellText({ closed: false, shifts: [times("09:00", "13:00")], timeOff: [off("evening")] })).toBe(
      "9:00 AM - 1:00 PM, EVENING OFF",
    );
  });

  it("orders time off full day, morning, evening", () => {
    expect(pdfCellText({ closed: false, shifts: [], timeOff: [off("evening"), off("morning")] })).toBe(
      "MORNING OFF, EVENING OFF",
    );
    expect(pdfCellText({ closed: false, shifts: [], timeOff: [off("evening"), off("full-day")] })).toBe(
      "OFF, EVENING OFF",
    );
  });

  it("doesn't reorder the caller's arrays", () => {
    const shifts = [times("12:00", "18:00"), times("09:00", "10:00")];
    const rows = [off("evening"), off("morning")];
    pdfCellText({ closed: false, shifts, timeOff: rows });
    expect(shifts[0]?.start_time).toBe("12:00");
    expect(rows[0]?.period).toBe("evening");
  });
});

describe("buildSchedulePdfTables", () => {
  const a = employee("a", "Avery Lane", 0);
  const b = employee("b", "Blake Archived", 1, true);
  const c = employee("c", "Casey Nguyen", 2);
  const range = { start: "2026-09-29", end: "2026-10-12" };

  function input(overrides: Partial<SchedulePdfInput> = {}): SchedulePdfInput {
    return {
      range,
      employees: [a, b, c],
      selectedEmployeeIds: new Set(["a", "b", "c"]),
      shifts: [],
      timeOff: [],
      closedDays: new Set(),
      ...overrides,
    };
  }

  it("makes one table per week with the week header", () => {
    const tables = buildSchedulePdfTables(input());
    expect(tables).toHaveLength(2);
    expect(tables[0]?.head[0]).toBe("Week of\nSep 29 - Oct 5");
    expect(tables[1]?.head[0]).toBe("Week of\nOct 6 - Oct 12");
  });

  it("follows the filter and display order; an archived employee with rows is kept", () => {
    const tables = buildSchedulePdfTables(
      input({
        selectedEmployeeIds: new Set(["a", "b"]),
        shifts: [shift("s1", "b", "2026-10-01", "09:00:00", "15:00:00")],
      }),
    );
    expect(tables[0]?.body.map((row) => row[0])).toEqual(["Avery Lane", "Blake Archived"]);
    expect(tables[0]?.body[1]?.[3]).toBe("9:00 AM - 3:00 PM");
    // Every week lists the same people, even where the archived employee has nothing.
    expect(tables[1]?.body.map((row) => row[0])).toEqual(["Avery Lane", "Blake Archived"]);
  });

  it("leaves out an archived employee with nothing in the range (D3)", () => {
    const tables = buildSchedulePdfTables(
      input({ shifts: [shift("s1", "b", "2026-10-13", "09:00:00", "15:00:00")] }),
    );
    expect(tables[0]?.body.map((row) => row[0])).toEqual(["Avery Lane", "Casey Nguyen"]);
  });

  it("counts approved time off as something to print for an archived employee", () => {
    const tables = buildSchedulePdfTables(input({ timeOff: [timeOff("t1", "b", "2026-10-07", "morning", "approved")] }));
    expect(tables[1]?.body.find((row) => row[0] === "Blake Archived")?.[2]).toBe("MORNING OFF");
  });

  it("leaves out pending requests, so they don't give an archived employee a row either", () => {
    const tables = buildSchedulePdfTables(
      input({
        timeOff: [
          timeOff("t1", "a", "2026-10-07", "full-day", "pending"),
          timeOff("t2", "b", "2026-10-08", "evening", "pending"),
        ],
      }),
    );
    expect(tables.flatMap((table) => table.body.flat()).join(" ")).not.toContain("PENDING");
    expect(tables[1]?.body.find((row) => row[0] === "Avery Lane")?.[2]).toBe("—");
    expect(tables.flatMap((table) => table.body.map((row) => row[0]))).not.toContain("Blake Archived");
  });

  it("doesn't count rows on a closed date for an archived employee", () => {
    const tables = buildSchedulePdfTables(
      input({
        closedDays: new Set(["2026-10-01"]),
        shifts: [shift("s1", "b", "2026-10-01", "09:00:00", "15:00:00")],
      }),
    );
    expect(tables[0]?.body.map((row) => row[0])).toEqual(["Avery Lane", "Casey Nguyen"]);
  });

  it("keeps an active employee with no rows", () => {
    const tables = buildSchedulePdfTables(input({ selectedEmployeeIds: new Set(["c"]) }));
    expect(tables[0]?.body).toEqual([["Casey Nguyen", "—", "—", "—", "—", "—", "—", "—"]]);
  });

  it("doesn't print an unselected employee's shifts", () => {
    const tables = buildSchedulePdfTables(
      input({
        selectedEmployeeIds: new Set(["a"]),
        shifts: [shift("s1", "c", "2026-09-29", "09:00:00", "15:00:00")],
      }),
    );
    expect(tables.flatMap((t) => t.body)).toEqual([
      ["Avery Lane", "—", "—", "—", "—", "—", "—", "—"],
      ["Avery Lane", "—", "—", "—", "—", "—", "—", "—"],
    ]);
  });

  it("ignores rows outside the range", () => {
    const tables = buildSchedulePdfTables(
      input({
        selectedEmployeeIds: new Set(["a"]),
        shifts: [
          shift("s1", "a", "2026-09-28", "09:00:00", "15:00:00"),
          shift("s2", "a", "2026-10-13", "09:00:00", "15:00:00"),
        ],
        timeOff: [timeOff("t1", "a", "2026-10-13", "full-day")],
      }),
    );
    expect(tables.flatMap((t) => t.body).flat().filter((cell) => cell !== "—" && cell !== "Avery Lane")).toEqual(
      [],
    );
  });

  it("prints CLOSED in every row on a closed date", () => {
    const tables = buildSchedulePdfTables(
      input({
        closedDays: new Set(["2026-10-02"]),
        shifts: [shift("s1", "a", "2026-10-02", "09:00:00", "15:00:00")],
      }),
    );
    expect(tables[0]?.body.map((row) => row[4])).toEqual(["CLOSED", "CLOSED"]);
  });

  it("puts each employee's rows on the right day, in time order, with time off", () => {
    const tables = buildSchedulePdfTables(
      input({
        selectedEmployeeIds: new Set(["a", "c"]),
        shifts: [
          shift("s2", "a", "2026-09-30", "17:00:00", "21:00:00"),
          shift("s1", "a", "2026-09-30", "09:00:00", "13:00:00"),
          shift("s3", "c", "2026-10-06", "22:00:00", "02:00:00"),
        ],
        timeOff: [
          timeOff("t1", "c", "2026-09-29", "full-day", "approved", "assigned"),
          timeOff("t2", "a", "2026-10-12", "evening", "pending"),
        ],
      }),
    );
    expect(tables[0]?.body).toEqual([
      ["Avery Lane", "—", "9:00 AM - 1:00 PM, 5:00 PM - 9:00 PM", "—", "—", "—", "—", "—"],
      ["Casey Nguyen", "OFF", "—", "—", "—", "—", "—", "—"],
    ]);
    expect(tables[1]?.body).toEqual([
      ["Avery Lane", "—", "—", "—", "—", "—", "—", "—"],
      ["Casey Nguyen", "10:00 PM - 2:00 AM", "—", "—", "—", "—", "—", "—"],
    ]);
  });

  it("makes empty tables when nobody is selected", () => {
    const tables = buildSchedulePdfTables(input({ selectedEmployeeIds: new Set() }));
    expect(tables).toHaveLength(2);
    expect(tables.every((t) => t.body.length === 0 && t.head.length === 8)).toBe(true);
  });

  it("gives every row week.length + 1 cells, a short last week included", () => {
    const tables = buildSchedulePdfTables(input({ range: { start: "2026-09-29", end: "2026-10-08" } }));
    expect(tables.map((t) => t.head.length)).toEqual([8, 4]);
    for (const table of tables) {
      for (const row of table.body) expect(row).toHaveLength(table.head.length);
    }
  });

  describe("business hours", () => {
    const seeded = (overrides: Partial<SchedulePdfInput> = {}) =>
      buildSchedulePdfTables(
        input({ range: SEEDED_RANGE, closedDays: SEEDED_CLOSED, hours: SEEDED_HOURS, ...overrides }),
      );

    it("marks the columns whose date has special hours (+4, +11 and the seeded Friday)", () => {
      const tables = seeded();
      expect(tables.map((t) => t.hoursColumns)).toEqual([[5], [5], [], [3], []]);
      expect(tables[0]?.head[5]).toBe("Sun\n10/4\n(12:00 PM - 4:00 PM)");
      expect(tables[1]?.head[5]).toBe("Sun\n10/11\n(10:00 AM - 3:00 PM)");
      expect(tables[3]?.head[3]).toBe("Fri\n10/23\n(11:00 AM - 9:00 PM)");
      // hoursColumns lists exactly the head cells with a third line.
      for (const table of tables) {
        const withThirdLine = table.head.flatMap((cell, i) => (cell.split("\n").length === 3 ? [i] : []));
        expect(table.hoursColumns).toEqual(withThirdLine);
      }
    });

    it("prints no hours for a custom row equal to the day's standard (+3)", () => {
      const tables = seeded();
      expect(tables[0]?.head[4]).toBe("Sat\n10/3");
    });

    it("never prints hours on a closed date, even with a stray custom row", () => {
      const tables = seeded();
      expect(tables[1]?.head[3]).toBe("Fri\n10/9");
      expect(tables[4]?.head[3]).toBe("Fri\n10/30");
      expect(tables[1]?.body.map((row) => row[3])).toEqual(["CLOSED", "CLOSED"]);
      expect(tables[1]?.hoursColumns).not.toContain(3);
    });

    it("compares against the set in effect on each date (the Friday row differs only after Oct 21)", () => {
      const tables = seeded({
        hours: { ...SEEDED_HOURS, custom: new Map([["2026-10-16", hours("11:00", "21:00")]]) },
      });
      // Oct 16 is a Friday under the Aug set (11-9): equal, so no line.
      expect(tables.flatMap((t) => t.hoursColumns)).toEqual([]);
    });

    it("prints every custom row on an open date when there are no weekly sets (H5)", () => {
      const tables = seeded({ hours: { sets: [], custom: SEEDED_HOURS.custom } });
      // With no standard to compare against, +3 counts as special too; the closed +9 still doesn't.
      expect(tables.map((t) => t.hoursColumns)).toEqual([[4, 5], [5], [], [3], []]);
      expect(tables[0]?.head[4]).toBe("Sat\n10/3\n(10:00 AM - 6:00 PM)");
    });

    it("has no third lines and empty hoursColumns without hours", () => {
      const tables = seeded({ hours: undefined });
      expect(tables.map((t) => t.hoursColumns)).toEqual([[], [], [], [], []]);
      expect(tables.flatMap((t) => t.head).every((cell) => cell.split("\n").length === 2)).toBe(true);
      expect(tables.map((t) => t.head)).toEqual(
        buildSchedulePdfTables(input({ range: SEEDED_RANGE, closedDays: SEEDED_CLOSED })).map((t) => t.head),
      );
    });

    it("leaves the body unchanged", () => {
      const shifts = [shift("s1", "a", "2026-10-04", "12:00:00", "16:00:00")];
      const withHours = seeded({ shifts });
      const without = seeded({ shifts, hours: undefined });
      expect(withHours.map((t) => t.body)).toEqual(without.map((t) => t.body));
    });
  });
});

describe("pdfHoursKey", () => {
  it("is empty without hours or without weekly sets", () => {
    expect(pdfHoursKey({ range: SEEDED_RANGE })).toEqual([]);
    expect(pdfHoursKey({ range: SEEDED_RANGE, hours: NO_HOURS })).toEqual([]);
    expect(pdfHoursKey({ range: SEEDED_RANGE, hours: { sets: [], custom: SEEDED_HOURS.custom } })).toEqual([]);
  });

  it("gives the current sentence, then a 'From' paragraph for a change within the range", () => {
    expect(pdfHoursKey({ range: SEEDED_RANGE, hours: SEEDED_HOURS })).toEqual([
      "Monday-Friday: 11:00 AM - 9:00 PM | Saturday: 10:00 AM - 6:00 PM | Sunday: 12:00 PM - 5:00 PM",
      "From Oct 21: Monday, Wednesday-Thursday: 11:00 AM - 9:00 PM | Tuesday: 11:00 AM - 7:00 PM | " +
        "Friday: 11:00 AM - 10:00 PM | Saturday: 10:00 AM - 10:00 PM | Sunday: 12:00 PM - 5:00 PM",
    ]);
  });

  it("uses the set in effect on the range's first day", () => {
    expect(pdfHoursKey({ range: { start: "2026-07-01", end: "2026-07-31" }, hours: SEEDED_HOURS })).toEqual([
      "Monday-Friday: 10:00 AM - 8:00 PM | Saturday: 10:00 AM - 6:00 PM | Sunday: 12:00 PM - 5:00 PM",
    ]);
    expect(pdfHoursKey({ range: { start: "2026-10-21", end: "2026-11-24" }, hours: SEEDED_HOURS })).toHaveLength(1);
  });
});

describe("pdfKeyLines", () => {
  // One unit per character stands in for jsPDF's text width.
  const width = (text: string) => text.length;
  // A change with a different time every day: 7 groups, too long for one line.
  const SEVEN = hoursSet("2026-10-21", [
    WEEKDAY_11_9,
    ["11:00:00", "19:00:00"],
    ["10:00:00", "21:00:00"],
    ["11:00:00", "20:00:00"],
    ["11:00:00", "22:00:00"],
    ["10:00:00", "22:00:00"],
    SUNDAY_12_5,
  ]);
  const [current = "", change = ""] = pdfHoursKey({
    range: SEEDED_RANGE,
    hours: { sets: [FIRST, AUG, SEVEN], custom: new Map() },
  });

  it("is empty without paragraphs", () => {
    expect(pdfKeyLines([], 269, width)).toEqual([]);
  });

  it("keeps a paragraph that fits on one line, and starts each paragraph on a new line", () => {
    expect(pdfKeyLines([current, current], 269, width)).toEqual([current, current]);
  });

  it("breaks only between groups, keeping the 'From' label with the first", () => {
    expect(change).toBe(
      "From Oct 21: Monday: 11:00 AM - 9:00 PM | Tuesday: 11:00 AM - 7:00 PM | Wednesday: 10:00 AM - 9:00 PM | " +
        "Thursday: 11:00 AM - 8:00 PM | Friday: 11:00 AM - 10:00 PM | Saturday: 10:00 AM - 10:00 PM | " +
        "Sunday: 12:00 PM - 5:00 PM",
    );
    // At 95 a word wrap would end the first line in "Wednesday: 10:00 AM -".
    const lines = pdfKeyLines([current, change], 95, width);
    expect(lines).toEqual([
      current,
      "From Oct 21: Monday: 11:00 AM - 9:00 PM | Tuesday: 11:00 AM - 7:00 PM",
      "Wednesday: 10:00 AM - 9:00 PM | Thursday: 11:00 AM - 8:00 PM | Friday: 11:00 AM - 10:00 PM",
      "Saturday: 10:00 AM - 10:00 PM | Sunday: 12:00 PM - 5:00 PM",
    ]);
    for (const line of lines) {
      expect(width(line)).toBeLessThanOrEqual(95);
      // No separator is left at a break, and nothing follows the last group.
      expect(line).toMatch(/^[A-Z].* PM$/);
    }
  });

  it("fills a line exactly to the width", () => {
    const [first] = pdfKeyLines([change], 101, width);
    expect(first).toBe(
      "From Oct 21: Monday: 11:00 AM - 9:00 PM | Tuesday: 11:00 AM - 7:00 PM | Wednesday: 10:00 AM - 9:00 PM",
    );
    expect(first?.length).toBe(101);
  });

  it("breaks a group wider than a line at its spaces, leaving out the separator at a break", () => {
    const lines = pdfKeyLines([current], 20, width);
    expect(lines).toEqual([
      "Monday-Friday: 11:00",
      "AM - 9:00 PM",
      "Saturday: 10:00 AM -",
      "6:00 PM | Sunday:",
      "12:00 PM - 5:00 PM",
    ]);
  });
});

describe("pdfFirstStartY", () => {
  it("starts under the title, lower for each key line after the first", () => {
    expect(pdfFirstStartY(0)).toBe(25);
    expect(pdfFirstStartY(1)).toBe(25);
    expect(pdfFirstStartY(2)).toBeCloseTo(28.651, 6);
    expect(pdfFirstStartY(3)).toBeCloseTo(32.302, 6);
  });
});

describe("pdfFilename and pdfPageFooter", () => {
  it("names the file by the range, with years (T5)", () => {
    expect(pdfFilename({ start: "2026-09-29", end: "2026-11-02" })).toBe("schedule-2026-09-29-to-2026-11-02.pdf");
    expect(pdfFilename({ start: "2026-12-28", end: "2027-01-31" })).toBe("schedule-2026-12-28-to-2027-01-31.pdf");
    expect(pdfFilename({ start: "2026-05-01", end: "2026-05-01" })).toBe("schedule-2026-05-01-to-2026-05-01.pdf");
  });

  it("numbers pages", () => {
    expect(pdfPageFooter(1, 5)).toBe("Page 1 of 5");
  });
});

describe("PDF_LAYOUT", () => {
  it("keeps the old page geometry with D3's tighter padding", () => {
    expect(PDF_LAYOUT.columnWidth).toBeCloseTo(33.625);
    expect(PDF_LAYOUT.cellPadding).toEqual({ top: 3, right: 2, bottom: 3, left: 2 });
    expect(PDF_LAYOUT.headPadding).toBe(3);
    expect(PDF_LAYOUT.margin.left + PDF_LAYOUT.margin.right + PDF_LAYOUT.columnWidth * 8).toBe(297);
    expect(PDF_LAYOUT.firstStartY).toBe(25);
  });

  it("places the hours key centered under the title, as wide as the table", () => {
    expect(PDF_LAYOUT.key).toEqual({ x: 148, y: 21, fontSize: 9, lineHeight: 3.651, maxWidth: 269 });
    expect(PDF_LAYOUT.key.maxWidth).toBe(PDF_LAYOUT.columnWidth * 8);
    // 9pt × 1.15 (jsPDF's lineHeightFactor) in mm.
    expect(PDF_LAYOUT.key.lineHeight).toBeCloseTo((9 * 1.15 * 25.4) / 72, 3);
  });

  it("prints a header's hours line at 8pt with the body's side padding", () => {
    expect(PDF_LAYOUT.hoursHead).toEqual({ fontSize: 8, cellPadding: { top: 3, right: 2, bottom: 3, left: 2 } });
  });
});
