import { describe, expect, it } from "vitest";
import {
  availabilityCardLabel,
  buildCalendarDays,
  calendarCellCount,
  groupByDate,
  pendingCardColor,
  timeOffCardLabel,
  toClosedDaySet,
  type CalendarDay,
  type CalendarInput,
  type DayCard,
} from "./calendar";
import type { Availability, Employee, Shift, TimeOff } from "./types";

const D = "2026-10-05";
const YELLOW = "#FDB913";
const PURPLE = "#9333EA";

function employee(id: string, name: string, display_order: number, archived = false): Employee {
  return { id, name, color: "#336699", display_order, archived };
}

const avery = employee("e-avery", "Avery", 1);
const jordan = employee("e-jordan", "Jordan", 2);
const mia = employee("e-mia", "Mia", 3);
const sam = employee("e-sam", "Sam", 4);
const taylor = employee("e-taylor", "Taylor", 5);
const employees = [avery, jordan, mia, sam, taylor];

let nextId = 0;
const id = (prefix: string) => `${prefix}-${String((nextId += 1)).padStart(3, "0")}`;

function shift(employeeId: string, start_time: string, end_time: string, extra: Partial<Shift> = {}): Shift {
  return { id: id("shift"), employee_id: employeeId, shift_date: D, start_time, end_time, ...extra };
}

function timeOff(employeeId: string, extra: Partial<TimeOff> = {}): TimeOff {
  return {
    id: id("off"),
    employee_id: employeeId,
    off_date: D,
    period: "full-day",
    status: "pending",
    source: "request",
    requested_at: "2026-09-01T10:00:00+00:00",
    ...extra,
  };
}

function availability(employeeId: string, extra: Partial<Availability> = {}): Availability {
  return {
    id: id("avail"),
    employee_id: employeeId,
    available_date: D,
    period: "full-day",
    status: "approved",
    requested_at: "2026-09-01T10:00:00+00:00",
    ...extra,
  };
}

function input(overrides: Partial<CalendarInput> = {}): CalendarInput {
  return {
    range: { start: D, end: D },
    today: "2026-09-28",
    employees,
    shifts: [],
    timeOff: [],
    availability: [],
    closedDays: new Set(),
    selectedEmployeeIds: new Set(employees.map((e) => e.id)),
    showTimeOff: true,
    showAvailability: true,
    meId: null,
    ...overrides,
  };
}

function onlyDay(days: CalendarDay[]): CalendarDay {
  expect(days).toHaveLength(1);
  return days[0];
}

const rowIds = (cards: DayCard[]) => cards.map((c) => c.row.id);

function pendingColors(cards: DayCard[]): string[] {
  return cards.flatMap((c) => (c.kind === "pending-time-off" ? [c.color] : []));
}

describe("card order within a day", () => {
  it("puts pending time off first, then shifts, then approved time off", () => {
    const a = shift(avery.id, "12:00:00", "18:00:00");
    const b = shift(jordan.id, "09:00:00", "15:00:00");
    const c = shift(mia.id, "22:00:00", "02:00:00");
    const p1 = timeOff(sam.id, { requested_at: "2026-09-02T10:00:00+00:00" });
    const p2 = timeOff(taylor.id, { requested_at: "2026-09-01T10:00:00+00:00" });
    const x = timeOff(avery.id, { status: "approved", source: "assigned", requested_at: "2026-09-05T00:00:00+00:00" });
    const y = timeOff(jordan.id, { status: "approved", source: "request", requested_at: "2026-09-03T00:00:00+00:00" });

    const day = onlyDay(buildCalendarDays(input({ shifts: [a, b, c], timeOff: [x, p1, y, p2] })));

    expect(rowIds(day.cards)).toEqual([p2.id, p1.id, b.id, a.id, c.id, y.id, x.id]);
    expect(day.cards.map((card) => card.kind)).toEqual([
      "pending-time-off",
      "pending-time-off",
      "shift",
      "shift",
      "shift",
      "time-off",
      "time-off",
    ]);
  });

  it("breaks shift ties by end time, then employee order, name and id", () => {
    const zed = employee("e-zed", "Zed", 0);
    const amy = employee("e-amy", "Amy", 1);
    const bob = employee("e-bob", "Bob", 1);
    const endsEarly = shift(amy.id, "09:00:00", "15:00:00");
    const bobShift = shift(bob.id, "09:00:00", "17:00:00");
    const amyShift = shift(amy.id, "09:00", "17:00:00");
    const zedShift = shift(zed.id, "09:00:00", "17:00:00");
    const amyLater = shift(amy.id, "09:00:00", "17:00:00", { id: "shift-zzz" });

    const day = onlyDay(
      buildCalendarDays(
        input({
          employees: [zed, amy, bob],
          selectedEmployeeIds: new Set([zed.id, amy.id, bob.id]),
          shifts: [amyLater, bobShift, zedShift, amyShift, endsEarly],
        }),
      ),
    );

    expect(rowIds(day.cards)).toEqual([endsEarly.id, zedShift.id, amyShift.id, amyLater.id, bobShift.id]);
  });

  it("breaks approved time-off ties by employee order", () => {
    // Imported days off all share the export timestamp.
    const stamp = "2026-09-28T15:34:17.123456+00:00";
    const miaOff = timeOff(mia.id, { status: "approved", source: "assigned", requested_at: stamp });
    const averyOff = timeOff(avery.id, { status: "approved", source: "assigned", requested_at: stamp });
    const day = onlyDay(buildCalendarDays(input({ timeOff: [miaOff, averyOff] })));
    expect(rowIds(day.cards)).toEqual([averyOff.id, miaOff.id]);
  });

  it("orders pending requests by the full timestamp, across offsets and microseconds", () => {
    const later = timeOff(avery.id, { requested_at: "2026-09-01T10:00:00.123999+00:00" });
    const earlier = timeOff(jordan.id, { requested_at: "2026-09-01T10:00:00.123456+00:00" });
    const earliest = timeOff(mia.id, { requested_at: "2026-09-01T05:30:00-04:00" }); // 09:30 UTC
    const day = onlyDay(buildCalendarDays(input({ timeOff: [later, earlier, earliest] })));
    expect(rowIds(day.cards)).toEqual([earliest.id, earlier.id, later.id]);
  });

  it("sorts availability by name, then period", () => {
    const miaEvening = availability(mia.id, { period: "evening" });
    const averyEvening = availability(avery.id, { period: "evening" });
    const miaFull = availability(mia.id, { period: "full-day" });
    const miaMorning = availability(mia.id, { period: "morning" });
    const shiftRow = shift(taylor.id, "09:00:00", "17:00:00");

    const day = onlyDay(
      buildCalendarDays(input({ shifts: [shiftRow], availability: [miaEvening, averyEvening, miaFull, miaMorning] })),
    );

    expect(rowIds(day.cards)).toEqual([shiftRow.id, averyEvening.id, miaFull.id, miaMorning.id, miaEvening.id]);
  });
});

describe("pending card colors", () => {
  const stamps = [1, 2, 3, 4, 5].map((n) => `2026-09-0${n}T10:00:00+00:00`);
  const fivePending = () => employees.map((e, i) => timeOff(e.id, { requested_at: stamps[i] }));

  it("turns the 4th and later requests purple", () => {
    const day = onlyDay(buildCalendarDays(input({ timeOff: fivePending() })));
    expect(pendingColors(day.cards)).toEqual([YELLOW, YELLOW, YELLOW, PURPLE, PURPLE]);
  });

  it("keeps a quiet day yellow", () => {
    const day = onlyDay(buildCalendarDays(input({ timeOff: fivePending().slice(0, 3) })));
    expect(pendingColors(day.cards)).toEqual([YELLOW, YELLOW, YELLOW]);
  });

  it("ranks over everyone's pending requests, whatever the filter", () => {
    const rows = fivePending();
    const day = onlyDay(
      buildCalendarDays(
        input({ timeOff: rows, selectedEmployeeIds: new Set([jordan.id, mia.id, sam.id, taylor.id]) }),
      ),
    );
    expect(rowIds(day.cards)).toEqual(rows.slice(1).map((r) => r.id));
    expect(pendingColors(day.cards)).toEqual([YELLOW, YELLOW, PURPLE, PURPLE]);
  });

  it("doesn't count approved time off", () => {
    const rows = [
      timeOff(avery.id, { status: "approved", requested_at: stamps[0] }),
      timeOff(jordan.id, { status: "approved", source: "assigned", requested_at: stamps[1] }),
      timeOff(mia.id, { requested_at: stamps[2] }),
      timeOff(sam.id, { requested_at: stamps[3] }),
      timeOff(taylor.id, { requested_at: stamps[4] }),
    ];
    const day = onlyDay(buildCalendarDays(input({ timeOff: rows })));
    expect(pendingColors(day.cards)).toEqual([YELLOW, YELLOW, YELLOW]);
  });

  it("follows the rank and total rule", () => {
    expect(pendingCardColor(3, 4)).toBe(PURPLE);
    expect(pendingCardColor(4, 5)).toBe(PURPLE);
    expect(pendingCardColor(2, 5)).toBe(YELLOW);
    expect(pendingCardColor(0, 1)).toBe(YELLOW);
    expect(pendingCardColor(3, 3)).toBe(YELLOW);
  });
});

describe("what a day shows", () => {
  it("shows nothing on a closed day", () => {
    const day = onlyDay(
      buildCalendarDays(
        input({
          shifts: [shift(avery.id, "09:00:00", "17:00:00")],
          timeOff: [timeOff(jordan.id)],
          availability: [availability(mia.id)],
          closedDays: new Set([D]),
        }),
      ),
    );
    expect(day).toEqual({ date: D, closed: true, isToday: false, cards: [] });
  });

  it("shows no cards with an empty employee filter but keeps closed days", () => {
    const days = buildCalendarDays(
      input({
        range: { start: "2026-10-04", end: D },
        shifts: [shift(avery.id, "09:00:00", "17:00:00")],
        availability: [availability(mia.id)],
        closedDays: new Set(["2026-10-04"]),
        selectedEmployeeIds: new Set(),
      }),
    );
    expect(days.map((d) => [d.date, d.closed, d.cards.length])).toEqual([
      ["2026-10-04", true, 0],
      [D, false, 0],
    ]);
  });

  it("hides time off when Show Time Off is off", () => {
    const day = onlyDay(
      buildCalendarDays(
        input({
          shifts: [shift(avery.id, "09:00:00", "17:00:00")],
          timeOff: [timeOff(jordan.id), timeOff(mia.id, { status: "approved", source: "assigned" })],
          availability: [availability(sam.id)],
          showTimeOff: false,
        }),
      ),
    );
    expect(day.cards.map((c) => c.kind)).toEqual(["shift", "availability"]);
  });

  it("hides availability when Show Availability is off", () => {
    const day = onlyDay(
      buildCalendarDays(
        input({
          shifts: [shift(avery.id, "09:00:00", "17:00:00")],
          timeOff: [timeOff(jordan.id)],
          availability: [availability(sam.id), availability(mia.id, { status: "pending" })],
          showAvailability: false,
        }),
      ),
    );
    expect(day.cards.map((c) => c.kind)).toEqual(["pending-time-off", "shift"]);
  });

  it("shows only selected employees, archived ones included", () => {
    const archived = employee("e-old", "Old Timer", 9, true);
    const kept = shift(archived.id, "09:00:00", "17:00:00");
    const day = onlyDay(
      buildCalendarDays(
        input({
          employees: [...employees, archived],
          shifts: [kept, shift(avery.id, "10:00:00", "16:00:00")],
          selectedEmployeeIds: new Set([archived.id]),
        }),
      ),
    );
    expect(rowIds(day.cards)).toEqual([kept.id]);
  });

  it("skips rows for unknown employees and rows outside the range", () => {
    const day = onlyDay(
      buildCalendarDays(
        input({
          shifts: [
            shift("e-missing", "09:00:00", "17:00:00"),
            shift(avery.id, "22:00:00", "02:00:00", { shift_date: "2026-10-04" }),
          ],
          selectedEmployeeIds: new Set(["e-missing", avery.id]),
        }),
      ),
    );
    expect(day.cards).toEqual([]);
  });

  it("lets me cancel only my own pending requests", () => {
    const myPending = timeOff(avery.id, { period: "morning" });
    const theirPending = timeOff(jordan.id, { period: "evening" });
    const myApproved = timeOff(avery.id, { period: "evening", status: "approved" });
    const myPendingAvailability = availability(avery.id, { status: "pending" });
    const myApprovedAvailability = availability(avery.id, { status: "approved", available_date: D, period: "evening" });
    const theirPendingAvailability = availability(jordan.id, { status: "pending" });

    const cards = onlyDay(
      buildCalendarDays(
        input({
          meId: avery.id,
          timeOff: [myPending, theirPending, myApproved],
          availability: [myPendingAvailability, myApprovedAvailability, theirPendingAvailability],
        }),
      ),
    ).cards;

    const cancellable = cards.filter((c) => "canCancel" in c && c.canCancel).map((c) => c.row.id);
    expect(cancellable).toEqual([myPending.id, myPendingAvailability.id]);
    const approvedCard = cards.find((c) => c.row.id === myApproved.id);
    expect(approvedCard?.kind).toBe("time-off");
    expect(approvedCard && "canCancel" in approvedCard).toBe(false);

    const signedOut = onlyDay(buildCalendarDays(input({ timeOff: [myPending], availability: [myPendingAvailability] })));
    expect(signedOut.cards.some((c) => "canCancel" in c && c.canCancel)).toBe(false);
  });

  it("builds labels for every card kind", () => {
    const cards = onlyDay(
      buildCalendarDays(
        input({
          shifts: [shift(avery.id, "22:00:00", "02:00:00")],
          timeOff: [
            timeOff(jordan.id, { period: "evening" }),
            timeOff(mia.id, { status: "approved", source: "assigned", period: "morning" }),
          ],
          availability: [availability(sam.id, { status: "pending", period: "morning" })],
        }),
      ),
    ).cards;
    expect(cards.map((c) => c.label)).toEqual([
      "PENDING TIME OFF - EVENING",
      "10:00 PM - 2:00 AM",
      "MORNING OFF",
      "PENDING AVAILABILITY - MORNING",
    ]);
    expect(cards.map((c) => c.employee.name)).toEqual(["Jordan", "Avery", "Mia", "Sam"]);
    const availabilityCard = cards[3];
    expect(availabilityCard.kind === "availability" && availabilityCard.pending).toBe(true);
  });
});

describe("days in the range", () => {
  it("has one entry per date across daylight saving", () => {
    const days = buildCalendarDays(input({ range: { start: "2026-03-06", end: "2026-03-10" } }));
    expect(days.map((d) => d.date)).toEqual(["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
    expect(buildCalendarDays(input({ range: { start: "2026-02-20", end: "2026-03-26" } }))).toHaveLength(35);
  });

  it("marks today", () => {
    const days = buildCalendarDays(input({ range: { start: "2026-09-27", end: "2026-09-29" }, today: "2026-09-28" }));
    expect(days.map((d) => d.isToday)).toEqual([false, true, false]);
  });

  it("puts each row on its own date", () => {
    const monday = shift(avery.id, "09:00:00", "17:00:00", { shift_date: "2026-10-05" });
    const tuesday = shift(avery.id, "09:00:00", "17:00:00", { shift_date: "2026-10-06" });
    const days = buildCalendarDays(input({ range: { start: "2026-10-05", end: "2026-10-06" }, shifts: [tuesday, monday] }));
    expect(days.map((d) => rowIds(d.cards))).toEqual([[monday.id], [tuesday.id]]);
  });
});

describe("labels", () => {
  it("labels time off", () => {
    expect(timeOffCardLabel({ period: "full-day", status: "approved" })).toBe("DAY OFF");
    expect(timeOffCardLabel({ period: "morning", status: "approved" })).toBe("MORNING OFF");
    expect(timeOffCardLabel({ period: "evening", status: "approved" })).toBe("EVENING OFF");
    expect(timeOffCardLabel({ period: "evening", status: "pending" })).toBe("PENDING TIME OFF - EVENING");
    expect(timeOffCardLabel({ period: "full-day", status: "pending" })).toBe("PENDING TIME OFF - FULL DAY");
  });

  it("labels availability", () => {
    expect(availabilityCardLabel({ period: "full-day", status: "approved" })).toBe("AVAILABLE - FULL DAY");
    expect(availabilityCardLabel({ period: "morning", status: "pending" })).toBe("PENDING AVAILABILITY - MORNING");
  });
});

describe("grid helpers", () => {
  it("fills out whole weeks", () => {
    expect(calendarCellCount(35)).toBe(35);
    expect(calendarCellCount(34)).toBe(35);
    expect(calendarCellCount(1)).toBe(7);
    expect(calendarCellCount(8)).toBe(14);
    expect(calendarCellCount(0)).toBe(0);
  });

  it("groups rows by date", () => {
    const groups = groupByDate([{ d: "2026-10-05" }, { d: "2026-10-06" }, { d: "2026-10-05" }], (r) => r.d);
    expect(groups.get("2026-10-05")).toHaveLength(2);
    expect(groups.get("2026-10-06")).toHaveLength(1);
  });
});

describe("closed days", () => {
  it("dedupes and skips empty values", () => {
    expect(toClosedDaySet([{ closed_date: "2026-12-25" }, { closed_date: "2026-12-25" }]).size).toBe(1);
    expect(toClosedDaySet([]).size).toBe(0);
    expect(toClosedDaySet([{ closed_date: null }, { closed_date: "" }]).size).toBe(0);
  });

  it("trims timestamps to the date", () => {
    expect(toClosedDaySet([{ closed_date: "2026-12-25T00:00:00Z" }]).has("2026-12-25")).toBe(true);
  });

  it("matches exact dates only", () => {
    const closed = toClosedDaySet([{ closed_date: "2026-12-25" }, { closed_date: "2026-07-04" }]);
    expect(closed.has("2026-12-25")).toBe(true);
    expect(closed.has("2026-12-24")).toBe(false);
    expect(closed.has("2026-12-25T00:00:00")).toBe(false);
    expect([...closed].sort()).toEqual(["2026-07-04", "2026-12-25"]);
  });
});
