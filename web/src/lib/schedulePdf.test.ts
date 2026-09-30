import { describe, expect, it } from "vitest";
import {
  buildSchedulePdfTables,
  PDF_CLOSED_CELL,
  PDF_EMPTY_CELL,
  PDF_LAYOUT,
  pdfCellText,
  pdfFilename,
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
const off = (period: DayPeriod, status: RequestStatus = "approved") => ({ period, status });

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
    expect(pdfTimeOffText(off("full-day", "pending"))).toBe("PENDING");
    expect(pdfTimeOffText(off("morning"))).toBe("MORNING OFF");
    expect(pdfTimeOffText(off("evening"))).toBe("EVENING OFF");
    expect(pdfTimeOffText(off("morning", "pending"))).toBe("PENDING - MORNING");
    expect(pdfTimeOffText(off("evening", "pending"))).toBe("PENDING - EVENING");
  });

  it("treats an unknown period as a full day", () => {
    expect(pdfTimeOffText({ period: "lunch" as DayPeriod, status: "approved" })).toBe("OFF");
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
    expect(
      pdfCellText({ closed: false, shifts: [], timeOff: [off("evening", "pending"), off("full-day")] }),
    ).toBe("OFF, PENDING - EVENING");
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

  it("counts time off, pending included, as something to print for an archived employee", () => {
    const tables = buildSchedulePdfTables(input({ timeOff: [timeOff("t1", "b", "2026-10-07", "morning", "pending")] }));
    expect(tables[1]?.body.find((row) => row[0] === "Blake Archived")?.[2]).toBe("PENDING - MORNING");
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
      ["Avery Lane", "—", "—", "—", "—", "—", "—", "PENDING - EVENING"],
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
  });
});
