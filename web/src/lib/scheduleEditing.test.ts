import { describe, expect, it } from "vitest";
import type { DayCard } from "./calendar";
import { addDays } from "./dates";
import {
  ADD_ITEM_TITLES,
  ADD_ITEM_TYPE_LABELS,
  addItemSaveLabel,
  addPickerDay,
  buildDuplicateDayOffMessage,
  buildPendingBlockMessage,
  buildShiftConflictMessage,
  buildShiftDeletionMessage,
  canDragCard,
  cardAction,
  checkCardDrop,
  closeDaysConfirm,
  closedDaysText,
  editFormFor,
  findShiftConflict,
  getApprovalConflicts,
  getDayOffConflicts,
  getDuplicateDayOffConflicts,
  getPendingRequestBlocks,
  getShiftSubmissionConflicts,
  MAX_MESSAGE_LINES,
  payrollHoursMessage,
  planAddSave,
  planEditSave,
  QUICK_SHIFTS,
  removedShiftsText,
  uniqueShiftIds,
  withoutClosedDates,
  withPayrollKeptNote,
  type CoveredShift,
  type EditForm,
  type EditTarget,
  type ShiftConflictEntry,
} from "./scheduleEditing";
import { formatShiftTime } from "./time";
import type { Availability, DayPeriod, Employee, Shift, TimeOff } from "./types";

// ---------------------------------------------------------------------------
// Fixture (spec-calendar-shifts §8.1)

const employees: Employee[] = [
  { id: "a", name: "Avery Lane", color: "#7F6C50", display_order: 0, archived: false },
  { id: "j", name: "Jordan Price", color: "#2F855A", display_order: 1, archived: false },
  { id: "m", name: "Mia Chen", color: "#2B6CB0", display_order: 2, archived: false },
  { id: "n", name: "Nora Patel", color: "#C05621", display_order: 5, archived: false },
  { id: "g", name: "Grace Kim", color: "#D53F8C", display_order: 7, archived: false },
];

function shift(id: string, employee_id: string, shift_date: string, start_time: string, end_time: string): Shift {
  return { id, employee_id, shift_date, start_time, end_time };
}

function timeOff(
  id: string,
  employee_id: string,
  off_date: string,
  period: DayPeriod,
  status: TimeOff["status"],
  source: TimeOff["source"],
): TimeOff {
  return { id, employee_id, off_date, period, status, source, requested_at: "2026-09-20T12:00:00+00:00" };
}

const s1 = shift("s1", "a", "2026-09-30", "09:00:00", "15:00:00");
const s2 = shift("s2", "j", "2026-09-30", "12:00:00", "18:00:00");
const s3 = shift("s3", "a", "2026-10-01", "22:00:00", "02:00:00");
const s4 = shift("s4", "j", "2026-10-01", "17:30:00", "21:00:00");
const shifts = [s1, s2, s3, s4];

const t1 = timeOff("t1", "g", "2026-10-13", "evening", "approved", "request");
const t2 = timeOff("t2", "m", "2026-10-07", "full-day", "approved", "assigned");
const t3 = timeOff("t3", "n", "2026-10-11", "morning", "pending", "request");
const t4 = timeOff("t4", "a", "2026-10-20", "morning", "approved", "request");
const timeOffRows = [t1, t2, t3, t4];

const closedDays: ReadonlySet<string> = new Set(["2026-10-09"]);
const ctx = { closedDays, shifts, timeOff: timeOffRows, employees };

const CONFLICT_HEADER = "This shift cannot be saved because it conflicts with existing schedule items:\n\n";
const S1_LINE = "  - Avery Lane: 9:00 AM - 3:00 PM";
const S2_LINE = "  - Jordan Price: 12:00 PM - 6:00 PM";
const S3_LINE = "  - Avery Lane: 10:00 PM - 2:00 AM";
const S4_LINE = "  - Jordan Price: 5:30 PM - 9:00 PM";
const ADD_DAY_OFF_MORNING_0930 =
  `Adding this day off will DELETE existing shifts that conflict:\n\nSep 30, 2026\n${S1_LINE}\n${S2_LINE}\n\nContinue?`;
const ADD_DAY_OFF_S1 =
  `Adding this day off will DELETE existing shifts that conflict:\n\nSep 30, 2026\n${S1_LINE}\n\nContinue?`;
const NORA_PENDING_BLOCK = "Approve or deny Nora Patel's pending Morning request on Oct 11, 2026 first.";
const DUPLICATE_HEADER = "cannot be added because it overlaps existing day off:\n\n";
const GRACE_DUPLICATE = `This Full Day day off ${DUPLICATE_HEADER}Grace Kim already has Evening off on Oct 13, 2026.`;
const PLAIN_MOVE = { kind: "move", deleteShiftIds: [], confirmMessage: null };

function check(employeeId: string, date: string, startTime: string, endTime: string) {
  return { employeeId, date, startTime, endTime };
}

// ---------------------------------------------------------------------------

describe("labels and shortcuts", () => {
  it("names each add type", () => {
    expect(ADD_ITEM_TYPE_LABELS).toEqual({ shift: "Shift", "day-off": "Day Off", hours: "Hours" });
    expect(ADD_ITEM_TITLES).toEqual({ shift: "Add Shift", "day-off": "Add Day Off", hours: "Set Hours" });
  });

  it("labels the save button by type, and for Hours by the choice", () => {
    expect(addItemSaveLabel("shift", "custom")).toBe("Add Shift");
    expect(addItemSaveLabel("shift", "closed")).toBe("Add Shift");
    expect(addItemSaveLabel("day-off", "standard")).toBe("Add Day Off");
    expect(addItemSaveLabel("hours", "standard")).toBe("Set Standard Hours");
    expect(addItemSaveLabel("hours", "custom")).toBe("Set Custom Hours");
    expect(addItemSaveLabel("hours", "closed")).toBe("Mark Closed");
  });

  it("has the old quick shifts, in order", () => {
    expect(QUICK_SHIFTS.map((q) => formatShiftTime({ start_time: q.start, end_time: q.end }))).toEqual([
      "9:30 AM - 5:00 PM",
      "10:30 AM - 5:00 PM",
      "12:00 PM - 4:00 PM",
      "12:45 PM - 6:00 PM",
      "4:50 PM - 9:00 PM",
    ]);
    expect(QUICK_SHIFTS[0]).toEqual({ start: "09:30", end: "17:00" });
    expect(MAX_MESSAGE_LINES).toBe(8);
  });
});

describe("cardAction and canDragCard", () => {
  const avery = employees[0];
  const approvedAvailability: Availability = {
    id: "v1",
    employee_id: "a",
    available_date: "2026-10-05",
    period: "full-day",
    status: "approved",
    requested_at: "2026-09-20T12:00:00+00:00",
  };
  const pendingAvailability: Availability = { ...approvedAvailability, id: "v2", status: "pending" };
  const shiftCard: DayCard = { kind: "shift", row: s1, employee: avery, label: "" };
  const reviewedCard: DayCard = { kind: "reviewed", row: { ...s1, id: "actual-1" }, employee: avery, label: "" };
  const assignedCard: DayCard = { kind: "time-off", row: t2, employee: avery, label: "DAY OFF" };
  const requestCard: DayCard = { kind: "time-off", row: t4, employee: avery, label: "MORNING OFF" };
  const pendingCard: DayCard = {
    kind: "pending-time-off",
    row: t3,
    employee: avery,
    label: "",
    color: "#FDB913",
    canCancel: false,
  };
  const pendingAvailabilityCard: DayCard = {
    kind: "availability",
    row: pendingAvailability,
    employee: avery,
    label: "",
    pending: true,
    canCancel: false,
  };
  const availabilityCard: DayCard = {
    kind: "availability",
    row: approvedAvailability,
    employee: avery,
    label: "",
    pending: false,
    canCancel: false,
  };

  it("edits shifts and days off, reviews pending requests", () => {
    expect(cardAction(shiftCard)).toEqual({ kind: "edit", target: { kind: "shift", row: s1 } });
    expect(cardAction(assignedCard)).toEqual({ kind: "edit", target: { kind: "day-off", row: t2 } });
    expect(cardAction(requestCard)).toEqual({ kind: "edit", target: { kind: "day-off", row: t4 } });
    expect(cardAction(pendingCard)).toEqual({ kind: "review", target: { kind: "time-off", row: t3 } });
    expect(cardAction(pendingAvailabilityCard)).toEqual({
      kind: "review",
      target: { kind: "availability", row: pendingAvailability },
    });
    expect(cardAction(availabilityCard)).toBeNull();
  });

  it("leaves reviewed shifts to Payroll", () => {
    expect(cardAction(reviewedCard)).toBeNull();
    expect(canDragCard(reviewedCard)).toBe(false);
  });

  it("drags shifts and assigned days off only", () => {
    expect(canDragCard(shiftCard)).toBe(true);
    expect(canDragCard(assignedCard)).toBe(true);
    expect(canDragCard(requestCard)).toBe(false);
    expect(canDragCard(pendingCard)).toBe(false);
    expect(canDragCard(pendingAvailabilityCard)).toBe(false);
    expect(canDragCard(availabilityCard)).toBe(false);
  });
});

describe("findShiftConflict", () => {
  const find = (c: Parameters<typeof findShiftConflict>[0], extraShifts: Shift[] = []) =>
    findShiftConflict(c, [...extraShifts, ...shifts], timeOffRows);

  it("finds overlapping shifts of the same employee", () => {
    expect(find(check("a", "2026-09-30", "10:00", "19:00"))).toEqual({ type: "shift", shift: s1 });
    expect(find(check("a", "2026-09-30", "15:00", "18:00"))).toBeNull(); // touching
    expect(find(check("a", "2026-09-30", "14:59", "18:00"))).toEqual({ type: "shift", shift: s1 });
    expect(find({ ...check("a", "2026-09-30", "14:59", "18:00"), ignoreShiftId: "s1" })).toBeNull();
    expect(find(check("a", "2026-09-30", "09:00", "10:00"))).toEqual({ type: "shift", shift: s1 });
  });

  it("is blocked by approved time off whose period covers the start", () => {
    expect(find(check("g", "2026-10-13", "17:00", "21:00"))).toEqual({
      type: "time-off",
      timeOff: t1,
      reason: "approved evening time off",
    });
    expect(find(check("g", "2026-10-13", "16:59", "21:00"))).toBeNull();
    expect(find(check("j", "2026-10-13", "17:00", "21:00"))).toBeNull(); // someone else's time off
    expect(find(check("m", "2026-10-07", "10:00", "14:00"))).toEqual({
      type: "time-off",
      timeOff: t2,
      reason: "approved full-day time off",
    }); // assigned days off block too
    expect(find({ ...check("m", "2026-10-07", "10:00", "14:00"), ignoreTimeOffId: "t2" })).toBeNull();
    expect(find(check("n", "2026-10-11", "10:00", "14:00"))).toBeNull(); // pending doesn't block
    expect(find(check("a", "2026-10-20", "16:59", "20:00"))).toEqual({
      type: "time-off",
      timeOff: t4,
      reason: "approved morning time off",
    });
    expect(find(check("a", "2026-10-20", "17:00", "20:00"))).toBeNull();
  });

  it("checks time off before shifts", () => {
    const early = shift("s9", "a", "2026-10-20", "08:00", "10:00");
    expect(find(check("a", "2026-10-20", "09:00", "12:00"), [early])).toMatchObject({ type: "time-off", timeOff: t4 });
  });

  it("a full day blocks even a malformed start", () => {
    expect(find(check("m", "2026-10-07", "", ""))).toMatchObject({ type: "time-off", timeOff: t2 });
    expect(find(check("a", "2026-09-30", "", "17:00"))).toBeNull();
  });

  it("compares overnight shifts across days", () => {
    expect(find(check("a", "2026-10-01", "23:00", "01:00"))).toEqual({ type: "shift", shift: s3 });
    expect(find(check("a", "2026-10-01", "21:00", "22:30"))).toEqual({ type: "shift", shift: s3 });
    expect(find(check("a", "2026-10-01", "01:00", "03:00"))).toBeNull();
    // The previous evening's shift runs until 2:00 AM.
    expect(find(check("a", "2026-10-02", "01:00", "03:00"))).toEqual({ type: "shift", shift: s3 });
    expect(find(check("a", "2026-10-02", "02:00", "03:00"))).toBeNull();
    // A new overnight shift spills into the next day's evening shift.
    expect(find(check("j", "2026-09-30", "23:00", "18:00"))).toEqual({ type: "shift", shift: s4 });
  });

  it("returns the earliest overlapping shift", () => {
    const later = shift("s10", "a", "2026-10-02", "09:00", "12:00");
    expect(find(check("a", "2026-10-02", "00:00", "23:00"), [later])).toEqual({ type: "shift", shift: s3 });
    const twin = shift("s0", "a", "2026-10-02", "09:00", "12:00");
    expect(find(check("a", "2026-10-02", "10:00", "11:00"), [later, twin])).toEqual({ type: "shift", shift: twin });
  });
});

describe("getShiftSubmissionConflicts and buildShiftConflictMessage", () => {
  const conflictsFor = (employeeIds: string[], dates: string[], startTime: string, endTime: string) =>
    getShiftSubmissionConflicts({ employeeIds, dates, startTime, endTime, shifts, timeOff: timeOffRows, employees });

  it("lists one conflict per date and employee, dates first", () => {
    expect(conflictsFor(["a", "j", "g"], ["2026-09-30", "2026-10-13"], "10:00", "19:00")).toEqual([
      { employeeId: "a", employeeName: "Avery Lane", date: "2026-09-30", conflict: { type: "shift", shift: s1 } },
      { employeeId: "j", employeeName: "Jordan Price", date: "2026-09-30", conflict: { type: "shift", shift: s2 } },
    ]);
  });

  it("builds the old messages", () => {
    expect(buildShiftConflictMessage(conflictsFor(["a", "j", "g"], ["2026-09-30", "2026-10-13"], "10:00", "19:00"))).toBe(
      `${CONFLICT_HEADER}Sep 30, 2026\n${S1_LINE}\n${S2_LINE}`,
    );
    expect(buildShiftConflictMessage(conflictsFor(["g"], ["2026-10-13"], "17:00", "21:00"))).toBe(
      `${CONFLICT_HEADER}Grace Kim already has approved evening time off on Oct 13, 2026.`,
    );
    expect(buildShiftConflictMessage(conflictsFor(["a", "m"], ["2026-09-30", "2026-10-07"], "12:00", "16:00"))).toBe(
      `${CONFLICT_HEADER}Sep 30, 2026\n${S1_LINE}\n\nMia Chen already has approved full-day time off on Oct 7, 2026.`,
    );
  });

  it("says which shifts were reviewed in Payroll", () => {
    const reviewed = getShiftSubmissionConflicts({
      employeeIds: ["a"],
      dates: ["2026-09-30"],
      startTime: "10:00",
      endTime: "11:00",
      shifts: [{ ...s1, reviewed: true }],
      timeOff: [],
      employees,
    });
    expect(buildShiftConflictMessage(reviewed)).toBe(
      `${CONFLICT_HEADER}Sep 30, 2026\n${S1_LINE} (reviewed in Payroll)`,
    );
    const covered = getDayOffConflicts({
      employeeIds: ["a", "j"],
      dates: ["2026-09-30"],
      period: "morning",
      shifts: [{ ...s1, reviewed: true }, s2],
      employees,
    });
    expect(buildShiftDeletionMessage(covered, "add-day-off")).toContain(
      `Sep 30, 2026\n${S1_LINE} (reviewed in Payroll)\n${S2_LINE}\n\n`,
    );
  });

  it("counts the hours Payroll recorded as worked, but not a record of the shift being edited", () => {
    // Mia covered Jordan's shift: the calendar shows her card, not his.
    const covered = { ...s2, reviewed: true };
    const miaWorked = {
      id: "actual-1",
      employee_id: "m",
      shift_date: "2026-09-30",
      start_time: "12:00:00",
      end_time: "18:15:00",
      reviewed: true,
      reviewOf: "s2",
    };
    const check = (employeeIds: string[], ignoreShiftId: string | null = null) =>
      getShiftSubmissionConflicts({
        employeeIds,
        dates: ["2026-09-30"],
        startTime: "16:00",
        endTime: "20:00",
        ignoreShiftId,
        shifts: [covered],
        worked: [miaWorked],
        timeOff: [],
        employees,
      });
    expect(buildShiftConflictMessage(check(["m"]))).toBe(
      `${CONFLICT_HEADER}Sep 30, 2026\n  - Mia Chen: 12:00 PM - 6:15 PM (reviewed in Payroll)`,
    );
    expect(buildShiftConflictMessage(check(["j"]))).toBe(
      `${CONFLICT_HEADER}Sep 30, 2026\n${S2_LINE} (reviewed in Payroll)`,
    );
    expect(check(["m"], "s2")).toEqual([]);
  });

  it("lists a spilling shift under its own date, once", () => {
    expect(buildShiftConflictMessage(conflictsFor(["a"], ["2026-10-02"], "01:00", "03:00"))).toBe(
      `${CONFLICT_HEADER}Oct 1, 2026\n${S3_LINE}`,
    );
    const both = conflictsFor(["a"], ["2026-10-01", "2026-10-02"], "01:00", "23:00");
    expect(both).toHaveLength(2);
    expect(buildShiftConflictMessage(both)).toBe(`${CONFLICT_HEADER}Oct 1, 2026\n${S3_LINE}`);
  });

  it("names unknown employees 'Unknown'", () => {
    const [entry] = getShiftSubmissionConflicts({
      employeeIds: ["x"],
      dates: ["2026-09-30"],
      startTime: "10:00",
      endTime: "11:00",
      shifts: [shift("sx", "x", "2026-09-30", "09:00", "12:00")],
      timeOff: [],
      employees,
    });
    expect(entry?.employeeName).toBe("Unknown");
  });

  it("shows 8 lines, then counts the rest", () => {
    const dates = Array.from({ length: 9 }, (_, i) => addDays("2026-11-01", i));
    const shiftEntries: ShiftConflictEntry[] = dates.map((date, i) => ({
      employeeId: "a",
      employeeName: "Avery Lane",
      date,
      conflict: { type: "shift", shift: shift(`x${i}`, "a", date, "09:00", "12:00") },
    }));
    const timeOffEntry: ShiftConflictEntry = {
      employeeId: "m",
      employeeName: "Mia Chen",
      date: "2026-10-07",
      conflict: { type: "time-off", timeOff: t2, reason: "approved full-day time off" },
    };
    const ten = buildShiftConflictMessage([...shiftEntries, timeOffEntry]);
    expect(ten.split("\n\n")).toHaveLength(1 + 8 + 1);
    expect(ten).toContain("Nov 8, 2026\n  - Avery Lane: 9:00 AM - 12:00 PM\n\n2 more conflicts not shown.");
    expect(ten.endsWith("\n\n2 more conflicts not shown.")).toBe(true);
    const nine = buildShiftConflictMessage(shiftEntries);
    expect(nine.endsWith("\n\n1 more conflict not shown.")).toBe(true);
  });
});

describe("shifts a day off removes", () => {
  const dayOff = (period: DayPeriod, employeeIds = ["a", "j"]) =>
    getDayOffConflicts({ employeeIds, dates: ["2026-09-30", "2026-10-01"], period, shifts, employees });
  const ids = (conflicts: CoveredShift[]) => conflicts.map((c) => c.shift.id);

  it("covers shifts by start time and period", () => {
    expect(dayOff("morning")).toEqual([
      { employeeId: "a", employeeName: "Avery Lane", date: "2026-09-30", shift: s1 },
      { employeeId: "j", employeeName: "Jordan Price", date: "2026-09-30", shift: s2 },
    ]);
    expect(ids(dayOff("evening"))).toEqual(["s3", "s4"]);
    expect(ids(dayOff("full-day"))).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("orders by date, employee list order, then start time", () => {
    expect(ids(dayOff("full-day", ["j", "a"]))).toEqual(["s1", "s2", "s3", "s4"]);
    const late = shift("s5", "a", "2026-09-30", "08:00", "08:30");
    const conflicts = getDayOffConflicts({
      employeeIds: ["j", "a"],
      dates: ["2026-10-01", "2026-09-30"],
      period: "full-day",
      shifts: [s4, s3, s2, s1, late],
      employees,
    });
    expect(ids(conflicts)).toEqual(["s5", "s1", "s2", "s3", "s4"]);
    expect(uniqueShiftIds(conflicts)).toEqual(["s5", "s1", "s2", "s3", "s4"]);
  });

  it("skips the ignored shift", () => {
    const conflicts = getDayOffConflicts({
      employeeIds: ["a"],
      dates: ["2026-09-30"],
      period: "morning",
      shifts,
      employees,
      ignoreShiftId: "s1",
    });
    expect(conflicts).toEqual([]);
  });

  it("builds the deletion confirms", () => {
    expect(buildShiftDeletionMessage(dayOff("morning"), "add-day-off")).toBe(ADD_DAY_OFF_MORNING_0930);
    expect(buildShiftDeletionMessage(dayOff("full-day"), "approve")).toBe(
      "Approving this time off will DELETE existing shifts that conflict:\n\n" +
        `Sep 30, 2026\n${S1_LINE}\n${S2_LINE}\n\nOct 1, 2026\n${S3_LINE}\n${S4_LINE}\n\nContinue?`,
    );
  });

  it("adds the payroll line when asked", () => {
    const expected =
      `Adding this day off will DELETE existing shifts that conflict:\n\nSep 30, 2026\n${S1_LINE}\n${S2_LINE}` +
      "\n\nPayroll hours recorded on these shifts are kept.\n\nContinue?";
    expect(buildShiftDeletionMessage(dayOff("morning"), "add-day-off", { payrollKept: true })).toBe(expected);
    expect(buildShiftDeletionMessage(dayOff("morning"), "add-day-off", { payrollKept: false })).toBe(
      ADD_DAY_OFF_MORNING_0930,
    );
    expect(withPayrollKeptNote(ADD_DAY_OFF_MORNING_0930)).toBe(expected);
  });

  it("shows 8 date blocks, then counts the hidden shifts", () => {
    const blocks = (sizes: number[]): CoveredShift[] =>
      sizes.flatMap((size, day) =>
        Array.from({ length: size }, (_, k) => {
          const date = addDays("2026-11-01", day);
          return {
            employeeId: "a",
            employeeName: "Avery Lane",
            date,
            shift: shift(`d${day}-${k}`, "a", date, `0${k + 1}:00`, `0${k + 2}:00`),
          };
        }),
      );
    const ten = buildShiftDeletionMessage(blocks([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]), "add-day-off");
    expect(ten.split("\n\n")).toHaveLength(1 + 8 + 1 + 1);
    expect(ten).toContain("Nov 8, 2026\n  - Avery Lane: 1:00 AM - 2:00 AM\n\n3 more conflicting shifts not shown.");
    expect(ten.endsWith("\n\n3 more conflicting shifts not shown.\n\nContinue?")).toBe(true);
    const nine = buildShiftDeletionMessage(blocks([1, 1, 1, 1, 1, 1, 1, 1, 1]), "approve");
    expect(nine.endsWith("\n\n1 more conflicting shift not shown.\n\nContinue?")).toBe(true);
  });
});

describe("getApprovalConflicts (approving requests)", () => {
  it("finds the pending request's covered shifts", () => {
    const covered = shift("s7", "n", "2026-10-11", "10:00", "14:00");
    const evening = shift("s8", "n", "2026-10-11", "17:00", "21:00");
    expect(getApprovalConflicts([t3], [...shifts, covered], employees)).toEqual([
      { employeeId: "n", employeeName: "Nora Patel", date: "2026-10-11", shift: covered },
    ]);
    expect(getApprovalConflicts([t3], [...shifts, evening], employees)).toEqual([]);
  });

  // spec-requests §5 findTimeOffConflicts and shiftDeletionConfirmMessage
  const nora: Employee = { id: "e1", name: "Nora Patel", color: "#C05621", display_order: 0, archived: false };
  const taylor: Employee = { id: "e2", name: "Taylor Brooks", color: "#2B6CB0", display_order: 1, archived: false };
  const request = { employee_id: "e1", off_date: "2026-10-11", period: "morning" } as const;
  const r1 = shift("s1", "e1", "2026-10-11", "09:00:00", "13:00:00");
  const r2 = shift("s2", "e1", "2026-10-11", "16:59:00", "20:00:00");
  const r3 = shift("s3", "e1", "2026-10-11", "17:00:00", "21:00:00");
  const r4 = shift("s4", "e2", "2026-10-11", "09:00:00", "12:00:00");
  const r5 = shift("s5", "e1", "2026-10-10", "22:00:00", "02:00:00");

  it("sorts by start time, whatever the input order", () => {
    const ids = (rows: Shift[]) => getApprovalConflicts([request], rows, [nora, taylor]).map((c) => c.shift.id);
    expect(ids([r1, r2, r3, r4, r5])).toEqual(["s1", "s2"]);
    expect(ids([r5, r4, r3, r2, r1])).toEqual(["s1", "s2"]);
  });

  it("builds the approval confirm", () => {
    expect(buildShiftDeletionMessage(getApprovalConflicts([request], [r2, r1, r3], [nora, taylor]), "approve")).toBe(
      "Approving this time off will DELETE existing shifts that conflict:\n\nOct 11, 2026\n" +
        "  - Nora Patel: 9:00 AM - 1:00 PM\n  - Nora Patel: 4:59 PM - 8:00 PM\n\nContinue?",
    );
  });

  it("counts shifts past 8 dates", () => {
    const requests = Array.from({ length: 10 }, (_, i) => ({ ...request, off_date: addDays("2026-10-11", i) }));
    const rows = requests.map((r, i) => shift(`q${i}`, "e1", r.off_date, "09:00", "13:00"));
    const ten = buildShiftDeletionMessage(getApprovalConflicts(requests, rows, [nora]), "approve");
    expect(ten.endsWith("\n\n2 more conflicting shifts not shown.\n\nContinue?")).toBe(true);
    const nine = buildShiftDeletionMessage(getApprovalConflicts(requests.slice(0, 9), rows, [nora]), "approve");
    expect(nine.endsWith("\n\n1 more conflicting shift not shown.\n\nContinue?")).toBe(true);
  });

  it("shows overnight shifts plainly", () => {
    const overnight = shift("s6", "e1", "2026-10-11", "22:00", "02:00");
    const message = buildShiftDeletionMessage(
      getApprovalConflicts([{ ...request, period: "evening" }], [overnight], [nora]),
      "approve",
    );
    expect(message).toContain("  - Nora Patel: 10:00 PM - 2:00 AM");
  });

  it("lists a group's shifts by date and each shift once", () => {
    const group = [
      { ...request, off_date: "2026-10-13", period: "full-day" as const },
      { ...request, off_date: "2026-10-12", period: "full-day" as const },
      { ...request, off_date: "2026-10-12", period: "morning" as const },
    ];
    const a = shift("g1", "e1", "2026-10-13", "09:00", "12:00");
    const b = shift("g2", "e1", "2026-10-12", "09:00", "12:00");
    expect(getApprovalConflicts(group, [a, b], [nora]).map((c) => c.shift.id)).toEqual(["g2", "g1"]);
  });
});

describe("overlapping days off", () => {
  const duplicates = (employeeIds: string[], dates: string[], period: DayPeriod, ignoreTimeOffId?: string) =>
    getDuplicateDayOffConflicts({ employeeIds, dates, period, timeOff: timeOffRows, employees, ignoreTimeOffId });

  it("finds approved time off of either source", () => {
    expect(duplicates(["m", "g"], ["2026-10-07", "2026-10-13"], "evening")).toEqual([t2, t1]);
    expect(duplicates(["m", "g"], ["2026-10-07", "2026-10-13"], "morning")).toEqual([t2]);
    expect(duplicates(["n"], ["2026-10-11"], "morning")).toEqual([]); // pending isn't a duplicate
    expect(duplicates(["m", "g"], ["2026-10-07", "2026-10-13"], "evening", "t2")).toEqual([t1]);
  });

  it("builds the old message", () => {
    expect(buildDuplicateDayOffMessage([t2, t1], "evening", employees)).toBe(
      "This Evening day off cannot be added because it overlaps existing day off:\n\n" +
        "Mia Chen already has Full Day off on Oct 7, 2026.\nGrace Kim already has Evening off on Oct 13, 2026.",
    );
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...t2, id: `d${i}`, off_date: addDays("2026-11-01", i) }));
    const message = buildDuplicateDayOffMessage(nine, "full-day", employees);
    expect(message.split("\n")).toHaveLength(2 + 8 + 1);
    expect(message.endsWith("Mia Chen already has Full Day off on Nov 8, 2026.\n1 more duplicate not shown.")).toBe(true);
  });

  it("blocks on the same employee's overlapping pending requests", () => {
    const blocks = (period: DayPeriod) =>
      getPendingRequestBlocks({ employeeIds: ["n"], dates: ["2026-10-11"], period, timeOff: timeOffRows });
    expect(blocks("morning")).toEqual([t3]);
    expect(blocks("full-day")).toEqual([t3]);
    expect(blocks("evening")).toEqual([]);
    const noraMorning = { employeeIds: ["n"], dates: ["2026-10-11"], period: "morning", timeOff: timeOffRows } as const;
    expect(getPendingRequestBlocks({ ...noraMorning, ignoreTimeOffId: "t3" })).toEqual([]);
    expect(getPendingRequestBlocks({ ...noraMorning, employeeIds: ["m"] })).toEqual([]);
  });

  it("builds the pending block message", () => {
    expect(buildPendingBlockMessage([t3], employees)).toBe(NORA_PENDING_BLOCK);
    // The details of a pending_request error carry only these fields.
    expect(buildPendingBlockMessage([{ employee_id: "n", off_date: "2026-10-11", period: "morning" }], employees)).toBe(
      NORA_PENDING_BLOCK,
    );
    const many = Array.from({ length: 9 }, (_, i) => ({ ...t3, id: `p${i}`, off_date: addDays("2026-10-11", i) }));
    const lines = buildPendingBlockMessage(many, employees).split("\n");
    expect(lines).toHaveLength(9);
    expect(lines[1]).toBe("Approve or deny Nora Patel's pending Morning request on Oct 12, 2026 first.");
    expect(lines[8]).toBe("1 more not shown.");
  });
});

describe("Add dialog picker", () => {
  it("marks closed days", () => {
    expect(addPickerDay("2026-10-09", closedDays, "shift")).toEqual({
      disabled: true,
      title: "Closed for business",
      marker: "closed",
    });
    expect(addPickerDay("2026-10-09", closedDays, "day-off")).toEqual({
      disabled: true,
      title: "Closed for business",
      marker: "closed",
    });
    expect(addPickerDay("2026-10-09", closedDays, "hours")).toEqual({
      disabled: false,
      title: "Closed for business",
      marker: "closed",
    });
    expect(addPickerDay("2020-01-01", closedDays, "day-off")).toEqual({ disabled: false });
    expect(addPickerDay("2020-01-01", closedDays, "hours")).toEqual({ disabled: false });
  });

  it("drops closed dates", () => {
    expect(withoutClosedDates(["2026-10-08", "2026-10-09"], closedDays)).toEqual(["2026-10-08"]);
  });
});

describe("planAddSave", () => {
  type AddInput = Parameters<typeof planAddSave>[0];
  const add = (overrides: Partial<AddInput>) =>
    planAddSave({
      type: "shift",
      dates: ["2026-10-02"],
      employeeIds: ["a"],
      startTime: "09:30",
      endTime: "17:00",
      period: "full-day",
      hoursChoice: "custom",
      openTime: "09:00",
      closeTime: "17:00",
      closedDays,
      shifts,
      timeOff: timeOffRows,
      employees,
      ...overrides,
    });

  it("is blocked by hours Payroll recorded as worked", () => {
    const worked = [
      {
        id: "actual-1",
        employee_id: "a",
        shift_date: "2026-10-02",
        start_time: "16:00:00",
        end_time: "18:00:00",
        reviewed: true,
      },
    ];
    expect(add({ worked })).toEqual({
      kind: "error",
      message: `${CONFLICT_HEADER}Oct 2, 2026\n  - Avery Lane: 4:00 PM - 6:00 PM (reviewed in Payroll)`,
    });
    expect(add({ worked, startTime: "18:00", endTime: "20:00" }).kind).toBe("add-shifts");
  });

  it("needs dates first", () => {
    expect(add({ dates: [] })).toEqual({ kind: "error", message: "Please select at least one date" });
    expect(add({ dates: [], employeeIds: [] })).toEqual({ kind: "error", message: "Please select at least one date" });
    for (const hoursChoice of ["standard", "custom", "closed"] as const) {
      expect(add({ type: "hours", hoursChoice, dates: [], employeeIds: [] })).toEqual({
        kind: "error",
        message: "Please select at least one date",
      });
    }
    // Nothing but real dates counts.
    expect(add({ type: "hours", hoursChoice: "closed", dates: ["", "10/09/2026"] })).toEqual({
      kind: "error",
      message: "Please select at least one date",
    });
  });

  it("closes days without employees or times", () => {
    const closing = { type: "hours", hoursChoice: "closed" } as const;
    expect(add({ ...closing, dates: ["2026-10-09", "2026-10-10"], employeeIds: [], startTime: "" })).toEqual({
      kind: "close-days",
      dates: ["2026-10-09", "2026-10-10"],
    });
    expect(add({ ...closing, dates: ["2026-10-10", "2026-10-09", "2026-10-10"] })).toEqual({
      kind: "close-days",
      dates: ["2026-10-09", "2026-10-10"],
    });
    // The custom times don't matter when closing.
    expect(add({ ...closing, dates: ["2026-10-10"], openTime: "", closeTime: "" })).toEqual({
      kind: "close-days",
      dates: ["2026-10-10"],
    });
    expect(closedDaysText(2)).toBe("2 days marked closed");
  });

  it("puts days back on standard hours, closed days included, without employees or times", () => {
    expect(
      add({
        type: "hours",
        hoursChoice: "standard",
        dates: ["2026-10-10", "2026-10-09", "2026-10-10"],
        employeeIds: [],
        openTime: "",
        closeTime: "",
      }),
    ).toEqual({ kind: "standard-hours", dates: ["2026-10-09", "2026-10-10"] });
  });

  it("gives days custom hours as 'HH:MM', closed days included", () => {
    expect(
      add({
        type: "hours",
        hoursChoice: "custom",
        dates: ["2026-10-31", "2026-10-09", "2026-10-31"],
        employeeIds: [],
        openTime: "09:00:00",
        closeTime: "13:30",
      }),
    ).toEqual({ kind: "custom-hours", dates: ["2026-10-09", "2026-10-31"], open: "09:00", close: "13:30" });
    // The shift times and the shift checks play no part.
    expect(
      add({ type: "hours", dates: ["2026-09-30"], startTime: "", endTime: "", openTime: "10:00", closeTime: "19:00" }),
    ).toEqual({ kind: "custom-hours", dates: ["2026-09-30"], open: "10:00", close: "19:00" });
  });

  it("checks the custom times: both needed, close after open", () => {
    const custom = { type: "hours", hoursChoice: "custom", dates: ["2026-10-31"], employeeIds: [] } as const;
    const missing = { kind: "error", message: "Please fill in open and close times" };
    const order = { kind: "error", message: "Close time must be after open time." };
    expect(add({ ...custom, openTime: "", closeTime: "17:00" })).toEqual(missing);
    expect(add({ ...custom, openTime: "09:00", closeTime: "" })).toEqual(missing);
    expect(add({ ...custom, openTime: "9am", closeTime: "17:00" })).toEqual(missing);
    expect(add({ ...custom, openTime: "17:00", closeTime: "09:00" })).toEqual(order);
    expect(add({ ...custom, openTime: "09:00", closeTime: "09:00:00" })).toEqual(order);
  });

  it("checks employees, then closed dates, then times", () => {
    expect(add({ employeeIds: [] })).toEqual({ kind: "error", message: "Please select at least one employee" });
    expect(add({ type: "day-off", employeeIds: [] })).toEqual({
      kind: "error",
      message: "Please select at least one employee",
    });
    expect(add({ dates: ["2026-10-09"], startTime: "" })).toEqual({
      kind: "error",
      message: "Reopen closed business days before adding shifts.",
    });
    expect(add({ type: "day-off", dates: ["2026-10-02", "2026-10-09"] })).toEqual({
      kind: "error",
      message: "Reopen closed business days before adding shifts.",
    });
    expect(add({ startTime: "" })).toEqual({ kind: "error", message: "Please fill in start and end times" });
    expect(add({ endTime: "" })).toEqual({ kind: "error", message: "Please fill in start and end times" });
    expect(add({ startTime: "09:00", endTime: "09:00" })).toEqual({
      kind: "error",
      message: "Start and end times can't be the same.",
    });
    expect(add({ startTime: "09:00", endTime: "09:00:00" })).toEqual({
      kind: "error",
      message: "Start and end times can't be the same.",
    });
  });

  it("refuses conflicting shifts", () => {
    expect(add({ employeeIds: ["a", "j"], dates: ["2026-09-30"], startTime: "10:00", endTime: "19:00" })).toEqual({
      kind: "error",
      message: `${CONFLICT_HEADER}Sep 30, 2026\n${S1_LINE}\n${S2_LINE}`,
    });
    expect(add({ dates: ["2026-10-02"], startTime: "01:00", endTime: "03:00" })).toEqual({
      kind: "error",
      message: `${CONFLICT_HEADER}Oct 1, 2026\n${S3_LINE}`,
    });
  });

  it("adds shifts date by date, as 'HH:MM'", () => {
    expect(add({ dates: ["2026-10-03", "2026-10-02", "2026-10-03"], startTime: "09:30:00" })).toEqual({
      kind: "add-shifts",
      rows: [
        { employee_id: "a", shift_date: "2026-10-02", start_time: "09:30", end_time: "17:00" },
        { employee_id: "a", shift_date: "2026-10-03", start_time: "09:30", end_time: "17:00" },
      ],
    });
    const plan = add({ dates: ["2026-10-02", "2026-10-03"], employeeIds: ["j", "a"] });
    expect(plan.kind === "add-shifts" && plan.rows.map((r) => `${r.shift_date} ${r.employee_id}`)).toEqual([
      "2026-10-02 j",
      "2026-10-02 a",
      "2026-10-03 j",
      "2026-10-03 a",
    ]);
  });

  it("adds days off and confirms the shifts they delete", () => {
    expect(add({ type: "day-off", period: "morning", employeeIds: ["a", "j"], dates: ["2026-09-30"] })).toEqual({
      kind: "add-days-off",
      rows: [
        { employee_id: "a", off_date: "2026-09-30", period: "morning" },
        { employee_id: "j", off_date: "2026-09-30", period: "morning" },
      ],
      deleteShiftIds: ["s1", "s2"],
      confirmMessage: ADD_DAY_OFF_MORNING_0930,
    });
    expect(add({ type: "day-off", period: "evening", dates: ["2026-10-02"], startTime: "", endTime: "" })).toEqual({
      kind: "add-days-off",
      rows: [{ employee_id: "a", off_date: "2026-10-02", period: "evening" }],
      deleteShiftIds: [],
      confirmMessage: null,
    });
  });

  it("refuses overlapping days off and pending requests", () => {
    expect(add({ type: "day-off", period: "full-day", employeeIds: ["m"], dates: ["2026-10-07"] })).toEqual({
      kind: "error",
      message: `This Full Day day off ${DUPLICATE_HEADER}Mia Chen already has Full Day off on Oct 7, 2026.`,
    });
    expect(add({ type: "day-off", period: "morning", employeeIds: ["n"], dates: ["2026-10-11"] })).toEqual({
      kind: "error",
      message: NORA_PENDING_BLOCK,
    });
    expect(add({ type: "day-off", period: "evening", employeeIds: ["n"], dates: ["2026-10-11"] })).toMatchObject({
      kind: "add-days-off",
    });
  });
});

describe("planEditSave", () => {
  const shiftTarget = (row: Shift): EditTarget => ({ kind: "shift", row });
  const dayOffTarget = (row: TimeOff): EditTarget => ({ kind: "day-off", row });
  const form = (target: EditTarget, overrides: Partial<EditForm>): EditForm => ({ ...editFormFor(target), ...overrides });
  const plan = (target: EditTarget, overrides: Partial<EditForm>) => planEditSave(target, form(target, overrides), ctx);

  it("fills the form from the row", () => {
    expect(editFormFor(shiftTarget(s3))).toEqual({
      type: "shift",
      employeeId: "a",
      date: "2026-10-01",
      startTime: "22:00",
      endTime: "02:00",
      period: "full-day",
    });
    expect(editFormFor(dayOffTarget(t1))).toEqual({
      type: "day-off",
      employeeId: "g",
      date: "2026-10-13",
      startTime: "09:00",
      endTime: "17:00",
      period: "evening",
    });
  });

  it("does nothing for an unchanged form", () => {
    expect(planEditSave(shiftTarget(s1), editFormFor(shiftTarget(s1)), ctx)).toEqual({ kind: "noop" });
    expect(plan(shiftTarget(s1), { startTime: "09:00:00", endTime: "15:00" })).toEqual({ kind: "noop" });
    expect(planEditSave(dayOffTarget(t2), editFormFor(dayOffTarget(t2)), ctx)).toEqual({ kind: "noop" });
    expect(planEditSave(dayOffTarget(t1), editFormFor(dayOffTarget(t1)), ctx)).toEqual({ kind: "noop" });
  });

  it("updates a shift", () => {
    expect(plan(shiftTarget(s1), { startTime: "10:00", endTime: "16:00" })).toEqual({
      kind: "write",
      write: { op: "update-shift", id: "s1", employeeId: "a", date: "2026-09-30", startTime: "10:00", endTime: "16:00" },
      confirmMessage: null,
    });
  });

  it("validates in order", () => {
    const missing = { kind: "error", message: "Please fill in employee and date" };
    expect(plan(shiftTarget(s1), { employeeId: "" })).toEqual(missing);
    expect(plan(shiftTarget(s1), { date: "" })).toEqual(missing);
    expect(plan(shiftTarget(s1), { date: "2026-02-30" })).toEqual(missing);
    expect(plan(shiftTarget(s1), { startTime: "" })).toEqual({
      kind: "error",
      message: "Please fill in start and end times",
    });
    expect(plan(shiftTarget(s1), { startTime: "15:00", endTime: "15:00" })).toEqual({
      kind: "error",
      message: "Start and end times can't be the same.",
    });
    expect(plan(shiftTarget(s1), { date: "2026-10-09" })).toEqual({
      kind: "error",
      message: "Reopen this business day before moving shifts here.",
    });
    expect(plan(shiftTarget(s1), { employeeId: "j", startTime: "13:00", endTime: "14:00" })).toEqual({
      kind: "error",
      message: `${CONFLICT_HEADER}Sep 30, 2026\n${S2_LINE}`,
    });
  });

  it("changes a shift into a day off", () => {
    expect(plan(shiftTarget(s2), { type: "day-off" })).toEqual({
      kind: "write",
      write: {
        op: "convert-to-day-off",
        shiftId: "s2",
        employeeId: "j",
        date: "2026-09-30",
        period: "full-day",
        deleteShiftIds: [],
      },
      confirmMessage: null,
    });
    expect(plan(shiftTarget(s3), { type: "day-off", date: "2026-09-30" })).toEqual({
      kind: "write",
      write: {
        op: "convert-to-day-off",
        shiftId: "s3",
        employeeId: "a",
        date: "2026-09-30",
        period: "full-day",
        deleteShiftIds: ["s1"],
      },
      confirmMessage: ADD_DAY_OFF_S1,
    });
    expect(plan(shiftTarget(s3), { type: "day-off", date: "2026-09-30", period: "evening" })).toMatchObject({
      write: { period: "evening", deleteShiftIds: [] },
      confirmMessage: null,
    });
    expect(plan(shiftTarget(s1), { type: "day-off", employeeId: "n", date: "2026-10-11", period: "morning" })).toEqual({
      kind: "error",
      message: NORA_PENDING_BLOCK,
    });
  });

  it("keeps an employee's request with them and a day off", () => {
    expect(plan(dayOffTarget(t1), { employeeId: "a" })).toEqual({
      kind: "error",
      message: "This time off was requested by Grace Kim, so it can't be moved to another employee.",
    });
    expect(plan(dayOffTarget(t1), { type: "shift" })).toEqual({
      kind: "error",
      message: "This time off was requested by Grace Kim, so it can't be changed into a shift.",
    });
    expect(plan(dayOffTarget(t1), { date: "2026-10-14" })).toEqual({
      kind: "write",
      write: { op: "update-day-off", id: "t1", employeeId: "g", date: "2026-10-14", period: "evening", deleteShiftIds: [] },
      confirmMessage: null,
    });
    expect(plan(dayOffTarget(t4), { date: "2026-09-30" })).toEqual({
      kind: "write",
      write: {
        op: "update-day-off",
        id: "t4",
        employeeId: "a",
        date: "2026-09-30",
        period: "morning",
        deleteShiftIds: ["s1"],
      },
      confirmMessage: ADD_DAY_OFF_S1,
    });
  });

  it("updates an assigned day off", () => {
    expect(plan(dayOffTarget(t2), { period: "morning" })).toEqual({
      kind: "write",
      write: { op: "update-day-off", id: "t2", employeeId: "m", date: "2026-10-07", period: "morning", deleteShiftIds: [] },
      confirmMessage: null,
    });
    expect(plan(dayOffTarget(t2), { employeeId: "n", date: "2026-10-11", period: "morning" })).toEqual({
      kind: "error",
      message: NORA_PENDING_BLOCK,
    });
    expect(plan(dayOffTarget(t2), { employeeId: "g", date: "2026-10-13" })).toEqual({
      kind: "error",
      message: GRACE_DUPLICATE,
    });
    expect(plan(dayOffTarget(t2), { employeeId: "a", date: "2026-09-30", period: "morning" })).toEqual({
      kind: "write",
      write: {
        op: "update-day-off",
        id: "t2",
        employeeId: "a",
        date: "2026-09-30",
        period: "morning",
        deleteShiftIds: ["s1"],
      },
      confirmMessage: ADD_DAY_OFF_S1,
    });
    expect(plan(dayOffTarget(t2), { date: "2026-10-09" })).toEqual({
      kind: "error",
      message: "Reopen this business day before moving shifts here.",
    });
  });

  it("changes an assigned day off into a shift", () => {
    expect(plan(dayOffTarget(t2), { type: "shift", startTime: "10:00", endTime: "14:00" })).toEqual({
      kind: "write",
      write: {
        op: "convert-to-shift",
        timeOffId: "t2",
        employeeId: "m",
        date: "2026-10-07",
        startTime: "10:00",
        endTime: "14:00",
      },
      confirmMessage: null,
    });
    expect(plan(dayOffTarget(t2), { type: "shift", startTime: "", endTime: "" })).toEqual({
      kind: "error",
      message: "Please fill in start and end times",
    });
    expect(plan(dayOffTarget(t2), { type: "shift", employeeId: "a", date: "2026-09-30" })).toEqual({
      kind: "error",
      message: `${CONFLICT_HEADER}Sep 30, 2026\n${S1_LINE}`,
    });
  });
});

describe("checkCardDrop", () => {
  const drop = (card: Parameters<typeof checkCardDrop>[0]["card"], targetDate: string, extra: TimeOff[] = []) =>
    checkCardDrop({ card, targetDate, closedDays, shifts, timeOff: [...timeOffRows, ...extra], employees });

  it("moves shifts", () => {
    expect(drop({ kind: "shift", row: s1 }, "2026-09-30")).toEqual({ kind: "noop" });
    expect(drop({ kind: "shift", row: s1 }, "2026-10-09")).toEqual({
      kind: "blocked",
      message: "Reopen this business day before moving shifts here.",
    });
    expect(drop({ kind: "shift", row: s1 }, "2026-10-01")).toEqual(PLAIN_MOVE);
    expect(drop({ kind: "shift", row: s2 }, "2026-10-01")).toEqual({
      kind: "blocked",
      message: `${CONFLICT_HEADER}Oct 1, 2026\n${S4_LINE}`,
    });
    expect(drop({ kind: "shift", row: s1 }, "2026-10-20")).toEqual({
      kind: "blocked",
      message: `${CONFLICT_HEADER}Avery Lane already has approved morning time off on Oct 20, 2026.`,
    });
  });

  it("moves days off", () => {
    expect(drop({ kind: "time-off", row: t2 }, "2026-10-08")).toEqual(PLAIN_MOVE);
    expect(drop({ kind: "time-off", row: t2 }, "2026-10-09")).toEqual({
      kind: "blocked",
      message: "Reopen this business day before moving shifts here.",
    });
    expect(drop({ kind: "time-off", row: t4 }, "2026-09-30")).toEqual({
      kind: "move",
      deleteShiftIds: ["s1"],
      confirmMessage: ADD_DAY_OFF_S1,
    });
  });

  it("blocks a day off on a pending request or another day off", () => {
    const noraOff = timeOff("t9", "n", "2026-10-10", "morning", "approved", "assigned");
    expect(drop({ kind: "time-off", row: noraOff }, "2026-10-11", [noraOff])).toEqual({
      kind: "blocked",
      message: NORA_PENDING_BLOCK,
    });
    const graceOff = timeOff("t8", "g", "2026-10-12", "full-day", "approved", "assigned");
    expect(drop({ kind: "time-off", row: graceOff }, "2026-10-13", [graceOff])).toEqual({
      kind: "blocked",
      message: GRACE_DUPLICATE,
    });
  });

  it("never moves a pending request", () => {
    expect(drop({ kind: "time-off", row: t3 }, "2026-10-12")).toEqual({ kind: "noop" });
  });
});

describe("confirm and toast texts", () => {
  it("explains payroll hours", () => {
    expect(payrollHoursMessage("move", "2026-10-05")).toBe(
      "This shift has payroll hours recorded. They'll be kept and moved to Mon, Oct 5.",
    );
    expect(payrollHoursMessage("edit")).toBe(
      "This shift has payroll hours recorded. " +
        "They'll be kept as recorded; check them in Payroll if this change affects pay.",
    );
    expect(payrollHoursMessage("delete")).toBe(
      "This shift has payroll hours recorded. They'll be kept in Payroll as hours without a scheduled shift.",
    );
    expect(payrollHoursMessage("convert")).toBe(payrollHoursMessage("delete"));
    expect(payrollHoursMessage("move")).toBe(
      "This shift has payroll hours recorded. They'll be kept and moved with the shift.",
    );
  });

  it("confirms closing days only when something is deleted", () => {
    expect(closeDaysConfirm(["2026-10-09"], { shifts: 2, timeOff: 1 })).toEqual({
      title: "Close for business?",
      message:
        "Closing Oct 9, 2026 will delete 2 shifts and 1 time-off entry. Payroll records and availability are kept.",
    });
    expect(closeDaysConfirm(["2026-10-09"], { shifts: 0, timeOff: 0 })).toBeNull();
    expect(closeDaysConfirm(["2026-10-10", "2026-10-09"], { shifts: 1, timeOff: 0 })?.message).toBe(
      "Closing Oct 9, 2026, Oct 10, 2026 will delete 1 shift and 0 time-off entries. " +
        "Payroll records and availability are kept.",
    );
    const six = Array.from({ length: 6 }, (_, i) => addDays("2026-10-09", i));
    expect(closeDaysConfirm(six, { shifts: 0, timeOff: 3 })?.message).toBe(
      "Closing 6 days will delete 0 shifts and 3 time-off entries. Payroll records and availability are kept.",
    );
  });

  it("counts removed shifts and closed days", () => {
    expect(removedShiftsText(1)).toBe("1 conflicting shift removed");
    expect(removedShiftsText(2)).toBe("2 conflicting shifts removed");
    expect(closedDaysText(1)).toBe("1 day marked closed");
    expect(closedDaysText(3)).toBe("3 days marked closed");
  });
});
