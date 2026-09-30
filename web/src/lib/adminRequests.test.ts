import { describe, expect, it } from "vitest";
import {
  approvedOnText,
  approvedWindowStart,
  approveToast,
  compareRequestItems,
  denyConfirm,
  denyToast,
  groupNotApprovedMessage,
  groupPending,
  pendingRequestCount,
  removeApprovedConfirm,
  removeApprovedToast,
  requestedOnText,
  requestItemDetail,
  reviewTargetItem,
  splitRequests,
  toRequestItems,
  type AdminAvailability,
  type AdminTimeOff,
  type RequestEntry,
  type RequestItem,
} from "./adminRequests";
import { buildShiftDeletionMessage, getApprovalConflicts } from "./scheduleEditing";
import type { Employee, Shift } from "./types";

// RQ §5 fixtures.
const e1: Employee = { id: "e1", name: "Nora Patel", color: "#2B6CB0", display_order: 0, archived: false };
const e2: Employee = { id: "e2", name: "Taylor Brooks", color: "#2F855A", display_order: 1, archived: false };
const e3: Employee = { id: "e3", name: "avery lane", color: "#C05621", display_order: 2, archived: false };
const employees = [e1, e2, e3];

const TODAY = "2026-09-29";
const REQUESTED = "2026-09-20T12:00:00+00:00";
const noClosed: ReadonlySet<string> = new Set();

function timeOff(row: Partial<AdminTimeOff> & Pick<AdminTimeOff, "id" | "employee_id" | "off_date">): AdminTimeOff {
  return {
    period: "full-day",
    status: "pending",
    source: "request",
    requested_at: REQUESTED,
    reviewed_at: null,
    ...row,
  };
}

function availability(
  row: Partial<AdminAvailability> & Pick<AdminAvailability, "id" | "employee_id" | "available_date">,
): AdminAvailability {
  return { period: "full-day", status: "pending", requested_at: REQUESTED, reviewed_at: null, ...row };
}

function items(
  input: { timeOff?: AdminTimeOff[]; availability?: AdminAvailability[] },
  options: { closedDays?: ReadonlySet<string>; people?: Employee[]; today?: string } = {},
): RequestItem[] {
  return toRequestItems({
    timeOff: input.timeOff ?? [],
    availability: input.availability ?? [],
    employees: options.people ?? employees,
    closedDays: options.closedDays ?? noClosed,
    today: options.today ?? TODAY,
  });
}

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

describe("toRequestItems / splitRequests (RQ §5 tests 1-6)", () => {
  const fixture = {
    timeOff: [
      timeOff({ id: "t1", employee_id: "e1", off_date: "2026-10-11", period: "morning" }),
      timeOff({ id: "t2", employee_id: "e1", off_date: "2026-10-08", status: "approved", source: "assigned" }),
      timeOff({ id: "t3", employee_id: "e2", off_date: "2026-10-13", period: "evening", status: "approved" }),
    ],
    availability: [
      availability({ id: "a1", employee_id: "e2", available_date: "2026-10-05", period: "evening" }),
      availability({ id: "a2", employee_id: "e3", available_date: "2026-10-01", status: "approved" }),
    ],
  };

  it("1. splits pending and approved, dropping assigned days off", () => {
    const { pending, approved } = splitRequests(items(fixture));
    expect(ids(pending)).toEqual(["a1", "t1"]);
    expect(ids(approved)).toEqual(["a2", "t3"]);
    expect(ids(items(fixture))).not.toContain("t2");
  });

  it("maps the row fields", () => {
    const t1 = items(fixture).find((item) => item.id === "t1");
    expect(t1).toEqual({
      kind: "time-off",
      id: "t1",
      employeeId: "e1",
      employeeName: "Nora Patel",
      archived: false,
      date: "2026-10-11",
      period: "morning",
      status: "pending",
      requestedAt: REQUESTED,
      reviewedAt: null,
      closed: false,
      past: false,
    });
    const a2 = items(fixture).find((item) => item.id === "a2");
    expect(a2?.kind).toBe("availability");
    expect(a2?.date).toBe("2026-10-01");
  });

  it("2. puts time off before availability for the same employee and date, whatever the input order", () => {
    const off = timeOff({ id: "x-off", employee_id: "e1", off_date: "2026-10-05" });
    const avail = availability({ id: "a-avail", employee_id: "e1", available_date: "2026-10-05" });
    expect(ids(items({ timeOff: [off], availability: [avail] }))).toEqual(["x-off", "a-avail"]);
    expect(ids(items({ availability: [avail], timeOff: [off] }))).toEqual(["x-off", "a-avail"]);
  });

  it("3. sorts employees by name, ignoring case", () => {
    const rows = [
      timeOff({ id: "t-taylor", employee_id: "e2", off_date: "2026-10-05" }),
      timeOff({ id: "t-nora", employee_id: "e1", off_date: "2026-10-05" }),
      timeOff({ id: "t-avery", employee_id: "e3", off_date: "2026-10-05" }),
    ];
    expect(items({ timeOff: rows }).map((item) => item.employeeName)).toEqual([
      "avery lane",
      "Nora Patel",
      "Taylor Brooks",
    ]);
  });

  it("4. orders one employee's periods on a day: full day, morning, evening", () => {
    const t5 = timeOff({ id: "t5", employee_id: "e1", off_date: "2026-10-05", period: "evening" });
    const t4 = timeOff({ id: "t4", employee_id: "e1", off_date: "2026-10-05", period: "morning" });
    expect(ids(items({ timeOff: [t5, t4] }))).toEqual(["t4", "t5"]);
    const full = timeOff({ id: "t9", employee_id: "e1", off_date: "2026-10-05", period: "full-day" });
    expect(ids(items({ timeOff: [t5, t4, full] }))).toEqual(["t9", "t4", "t5"]);
  });

  it("then breaks ties by request time and id", () => {
    const later = timeOff({
      id: "a",
      employee_id: "e1",
      off_date: "2026-10-05",
      requested_at: "2026-09-21T12:00:00+00:00",
    });
    const earlier = timeOff({ id: "b", employee_id: "e1", off_date: "2026-10-05" });
    const sameAsEarlier = timeOff({ id: "c", employee_id: "e1", off_date: "2026-10-05" });
    expect(ids(items({ timeOff: [later, sameAsEarlier, earlier] }))).toEqual(["b", "c", "a"]);
  });

  it("5. names an employee missing from the list 'Unknown'", () => {
    const [item] = items({ timeOff: [timeOff({ id: "t", employee_id: "gone", off_date: "2026-10-05" })] });
    expect(item.employeeName).toBe("Unknown");
    expect(item.archived).toBe(false);
  });

  it("6. keeps archived employees' requests, marked archived", () => {
    const pat: Employee = { id: "p", name: "Pat O'Brien", color: "#744210", display_order: 9, archived: true };
    const [item] = items(
      { timeOff: [timeOff({ id: "t", employee_id: "p", off_date: "2026-10-14" })] },
      { people: [...employees, pat] },
    );
    expect(item.employeeName).toBe("Pat O'Brien");
    expect(item.archived).toBe(true);
  });

  it("flags requests on closed days (R6) and past dates (R2)", () => {
    const list = items(
      {
        timeOff: [
          timeOff({ id: "past", employee_id: "e2", off_date: "2026-09-27" }),
          timeOff({ id: "today", employee_id: "e2", off_date: TODAY }),
        ],
        availability: [availability({ id: "closed", employee_id: "e1", available_date: "2026-10-08" })],
      },
      { closedDays: new Set(["2026-10-08"]) },
    );
    expect(list.map((item) => [item.id, item.past, item.closed])).toEqual([
      ["past", true, false],
      ["today", false, false],
      ["closed", false, true],
    ]);
  });

  it("counts pending requests of both kinds", () => {
    expect(splitRequests(items(fixture)).pending.length).toBe(2);
    expect(pendingRequestCount(fixture)).toBe(2);
    expect(pendingRequestCount({ timeOff: [], availability: [] })).toBe(0);
  });

  it("compareRequestItems puts the earlier date first", () => {
    const [a, b] = items({
      timeOff: [
        timeOff({ id: "late", employee_id: "e3", off_date: "2026-10-06" }),
        timeOff({ id: "early", employee_id: "e2", off_date: "2026-10-05" }),
      ],
    });
    expect(compareRequestItems(a, b)).toBeLessThan(0);
    expect(compareRequestItems(b, a)).toBeGreaterThan(0);
    expect(compareRequestItems(a, a)).toBe(0);
  });
});

describe("reviewTargetItem", () => {
  const context = { employees, closedDays: new Set(["2026-10-08"]), today: TODAY };

  it("turns a pending calendar card into a drawer item", () => {
    const row = {
      id: "t1",
      employee_id: "e1",
      off_date: "2026-10-11",
      period: "morning" as const,
      status: "pending" as const,
      source: "request" as const,
      requested_at: REQUESTED,
    };
    expect(reviewTargetItem({ kind: "time-off", row }, context)).toMatchObject({
      kind: "time-off",
      id: "t1",
      employeeName: "Nora Patel",
      date: "2026-10-11",
      period: "morning",
      requestedAt: REQUESTED,
      reviewedAt: null,
      closed: false,
    });
    const avail = {
      id: "a1",
      employee_id: "e2",
      available_date: "2026-10-08",
      period: "evening" as const,
      status: "pending" as const,
      requested_at: REQUESTED,
    };
    expect(reviewTargetItem({ kind: "availability", row: avail }, context)).toMatchObject({
      kind: "availability",
      employeeName: "Taylor Brooks",
      closed: true,
    });
  });

  it("returns null for a day off the admin assigned", () => {
    const row = {
      id: "t2",
      employee_id: "e1",
      off_date: "2026-10-11",
      period: "full-day" as const,
      status: "approved" as const,
      source: "assigned" as const,
      requested_at: REQUESTED,
    };
    expect(reviewTargetItem({ kind: "time-off", row }, context)).toBeNull();
  });
});

describe("groupPending (R4)", () => {
  const eli: Employee = { id: "eli", name: "Eli Morgan", color: "#553C9A", display_order: 5, archived: false };
  const people = [...employees, eli];
  const together = "2026-09-27T15:15:46.295238+00:00";
  const eliDays = ["2026-10-21", "2026-10-22", "2026-10-23"].map((date, i) =>
    timeOff({ id: `eli-${i + 1}`, employee_id: "eli", off_date: date, requested_at: together }),
  );

  const shape = (entries: readonly RequestEntry[]) =>
    entries.map((entry) => (entry.type === "single" ? entry.item.id : ids(entry.group.items)));

  it("makes Eli's three days one group", () => {
    const pending = splitRequests(items({ timeOff: eliDays }, { people })).pending;
    const entries = groupPending(pending);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.type).toBe("group");
    if (entry.type !== "group") return;
    expect(entry.group).toMatchObject({
      kind: "time-off",
      employeeId: "eli",
      employeeName: "Eli Morgan",
      archived: false,
      requestedAt: together,
    });
    expect(ids(entry.group.items)).toEqual(["eli-1", "eli-2", "eli-3"]);
  });

  it("leaves days on closed dates out of the group", () => {
    const pending = items({ timeOff: eliDays }, { people, closedDays: new Set(["2026-10-22"]) });
    expect(shape(groupPending(pending))).toEqual([["eli-1", "eli-3"], "eli-2"]);
  });

  it("needs two open days to make a group", () => {
    const pending = items({ timeOff: eliDays }, { people, closedDays: new Set(["2026-10-22", "2026-10-23"]) });
    expect(shape(groupPending(pending))).toEqual(["eli-1", "eli-2", "eli-3"]);
  });

  it("keeps separate submissions, kinds and employees apart, in list order", () => {
    const pending = items(
      {
        timeOff: [
          ...eliDays.slice(0, 2),
          timeOff({
            id: "eli-later",
            employee_id: "eli",
            off_date: "2026-10-20",
            requested_at: "2026-09-28T10:00:00+00:00",
          }),
          timeOff({ id: "nora", employee_id: "e1", off_date: "2026-10-21", requested_at: together }),
        ],
        availability: [
          availability({ id: "eli-avail", employee_id: "eli", available_date: "2026-10-21", requested_at: together }),
        ],
      },
      { people },
    );
    expect(shape(groupPending(pending))).toEqual(["eli-later", ["eli-1", "eli-2"], "eli-avail", "nora"]);
  });

  it("returns nothing for no requests", () => {
    expect(groupPending([])).toEqual([]);
  });
});

describe("approvedWindowStart (R1)", () => {
  it("is 30 days before today", () => {
    expect(approvedWindowStart("2026-09-29")).toBe("2026-08-30");
    expect(approvedWindowStart("2026-01-15")).toBe("2025-12-16");
    expect(approvedWindowStart("2028-03-01")).toBe("2028-01-31");
  });
});

describe("text helpers", () => {
  it("requestItemDetail", () => {
    expect(requestItemDetail({ date: "2026-10-05", period: "evening" })).toBe("Mon, Oct 5 - Evening");
    expect(requestItemDetail({ date: "2026-10-05", period: "full-day" })).toBe("Mon, Oct 5 - Full Day");
    expect(requestItemDetail({ date: "2026-10-11", period: "morning" })).toBe("Sun, Oct 11 - Morning");
    expect(requestItemDetail({ date: "2027-01-01", period: "morning" })).toBe("Fri, Jan 1 - Morning");
  });

  it("requestedOnText uses the business day in New York", () => {
    expect(requestedOnText("2026-09-29T14:03:12.123456+00:00")).toBe("Requested: Sep 29, 2026");
    expect(requestedOnText("2026-09-30T02:30:00+00:00")).toBe("Requested: Sep 29, 2026");
    expect(requestedOnText(null)).toBe("Requested: Unknown");
    expect(requestedOnText("garbage")).toBe("Requested: Unknown");
  });

  it("approvedOnText", () => {
    expect(approvedOnText("2026-09-30T14:00:00+00:00")).toBe("Approved Sep 30, 2026");
    expect(approvedOnText("2026-10-01T03:59:00+00:00")).toBe("Approved Sep 30, 2026");
    expect(approvedOnText(null)).toBeNull();
    expect(approvedOnText("garbage")).toBeNull();
  });
});

describe("approveToast", () => {
  it("time off, one day", () => {
    expect(approveToast("time-off", "Nora Patel", 1, 0)).toEqual({
      title: "Time Off Approved",
      message: "Day off approved for Nora Patel",
    });
    expect(approveToast("time-off", "Nora Patel", 1, 1).message).toBe(
      "Day off approved for Nora Patel; 1 conflicting shift removed",
    );
    expect(approveToast("time-off", "Nora Patel", 1, 2).message).toBe(
      "Day off approved for Nora Patel; 2 conflicting shifts removed",
    );
  });

  it("time off, three days", () => {
    expect(approveToast("time-off", "Eli Morgan", 3, 0)).toEqual({
      title: "Time Off Approved",
      message: "3 days approved for Eli Morgan",
    });
    expect(approveToast("time-off", "Eli Morgan", 3, 1).message).toBe(
      "3 days approved for Eli Morgan; 1 conflicting shift removed",
    );
  });

  it("availability", () => {
    expect(approveToast("availability", "Sam Rivera", 1, 0)).toEqual({
      title: "Availability Approved",
      message: "Availability approved for Sam Rivera",
    });
    expect(approveToast("availability", "Sam Rivera", 3, 0)).toEqual({
      title: "Availability Approved",
      message: "3 days of availability approved for Sam Rivera",
    });
  });
});

describe("groupNotApprovedMessage", () => {
  it("names the days that are still pending after a partly reviewed group", () => {
    expect(groupNotApprovedMessage(2, 1)).toBe(
      "Nothing was approved because 1 of the 2 days was already reviewed or removed. The other day is still pending.",
    );
    expect(groupNotApprovedMessage(5, 3)).toBe(
      "Nothing was approved because 2 of the 5 days were already reviewed or removed. The other 3 days are still pending.",
    );
    expect(groupNotApprovedMessage(3, 2)).toBe(
      "Nothing was approved because 1 of the 3 days was already reviewed or removed. The other 2 days are still pending.",
    );
  });

  it("uses the plain message when no day is left to review", () => {
    expect(groupNotApprovedMessage(3, 0)).toBe("This request was already reviewed or removed.");
  });

  it("stays general when the pending count is unknown or doesn't add up", () => {
    const general =
      "Nothing was approved because some of these days were already reviewed or removed. The list has been refreshed.";
    expect(groupNotApprovedMessage(2, null)).toBe(general);
    expect(groupNotApprovedMessage(2, 2)).toBe(general);
  });
});

describe("denyToast", () => {
  it("count 1 and count 3", () => {
    expect(denyToast("time-off", "Eli Morgan", 1)).toEqual({
      title: "Time Off Denied",
      message: "Request denied and removed for Eli Morgan",
    });
    expect(denyToast("time-off", "Eli Morgan", 3)).toEqual({
      title: "Time Off Denied",
      message: "3 requests denied and removed for Eli Morgan",
    });
    expect(denyToast("availability", "Sam Rivera", 1)).toEqual({
      title: "Availability Denied",
      message: "Request denied and removed for Sam Rivera",
    });
    expect(denyToast("availability", "Sam Rivera", 3)).toEqual({
      title: "Availability Denied",
      message: "3 requests denied and removed for Sam Rivera",
    });
  });
});

describe("denyConfirm", () => {
  it("one request", () => {
    expect(denyConfirm("time-off", "Eli Morgan", 1)).toEqual({
      title: "Deny request?",
      message: "Deny Eli Morgan's time-off request for this day? This will delete the request.",
      confirmLabel: "Deny",
      cancelLabel: "Keep request",
    });
    expect(denyConfirm("availability", "Sam Rivera", 1)).toEqual({
      title: "Deny request?",
      message: "Deny Sam Rivera's availability request for this day? This will delete the request.",
      confirmLabel: "Deny",
      cancelLabel: "Keep request",
    });
  });

  it("a group of 3", () => {
    expect(denyConfirm("time-off", "Eli Morgan", 3)).toEqual({
      title: "Deny requests?",
      message: "Deny Eli Morgan's 3 time-off requests? This will delete the requests.",
      confirmLabel: "Deny all",
      cancelLabel: "Keep requests",
    });
    expect(denyConfirm("availability", "Sam Rivera", 3)).toEqual({
      title: "Deny requests?",
      message: "Deny Sam Rivera's 3 availability requests? This will delete the requests.",
      confirmLabel: "Deny all",
      cancelLabel: "Keep requests",
    });
  });
});

describe("removing approved requests (R5)", () => {
  it("time off", () => {
    const item = {
      kind: "time-off" as const,
      employeeName: "Avery Lane",
      date: "2026-10-04",
      period: "full-day" as const,
    };
    expect(removeApprovedConfirm(item)).toEqual({
      title: "Remove approved time off?",
      message: "Avery Lane asked for this time off. Removing it deletes the approval, and they aren't notified.",
      confirmLabel: "Remove",
      cancelLabel: "Keep",
    });
    expect(removeApprovedToast(item)).toEqual({
      title: "Time Off Removed",
      message: "Avery Lane's full-day time off on Oct 4, 2026 was removed.",
    });
  });

  it("availability", () => {
    const item = {
      kind: "availability" as const,
      employeeName: "Jordan Price",
      date: "2026-10-05",
      period: "morning" as const,
    };
    expect(removeApprovedConfirm(item)).toEqual({
      title: "Remove approved availability?",
      message: "Jordan Price's morning availability on Oct 5, 2026 will be deleted.",
      confirmLabel: "Remove",
      cancelLabel: "Keep",
    });
    expect(removeApprovedToast(item)).toEqual({
      title: "Availability Removed",
      message: "Jordan Price's morning availability on Oct 5, 2026 was removed.",
    });
  });
});

// The approval confirm (RQ §5 findTimeOffConflicts and shiftDeletionConfirmMessage), now built
// from scheduleEditing's getApprovalConflicts and buildShiftDeletionMessage.
describe("approval conflicts", () => {
  const shift = (id: string, employee_id: string, shift_date: string, start_time: string, end_time: string): Shift => ({
    id,
    employee_id,
    shift_date,
    start_time,
    end_time,
  });
  const s1 = shift("s1", "e1", "2026-10-11", "09:00:00", "13:00:00");
  const s2 = shift("s2", "e1", "2026-10-11", "16:59:00", "20:00:00");
  const s3 = shift("s3", "e1", "2026-10-11", "17:00:00", "21:00:00");
  const s4 = shift("s4", "e2", "2026-10-11", "09:00:00", "13:00:00");
  const s5 = shift("s5", "e1", "2026-10-10", "22:00:00", "02:00:00");
  const request = { employee_id: "e1", off_date: "2026-10-11", period: "morning" as const };

  it("finds the shifts a morning request covers, by start time", () => {
    const covered = getApprovalConflicts([request], [s3, s2, s4, s5, s1], employees);
    expect(covered.map((c) => c.shift.id)).toEqual(["s1", "s2"]);
    expect(getApprovalConflicts([request], [s2, s1], employees).map((c) => c.shift.id)).toEqual(["s1", "s2"]);
  });

  it("builds the old confirm text", () => {
    const covered = getApprovalConflicts([request], [s2, s1], employees);
    expect(buildShiftDeletionMessage(covered, "approve")).toBe(
      "Approving this time off will DELETE existing shifts that conflict:\n\nOct 11, 2026\n  - Nora Patel: 9:00 AM - 1:00 PM\n  - Nora Patel: 4:59 PM - 8:00 PM\n\nContinue?",
    );
    expect(buildShiftDeletionMessage(covered, "approve", { payrollKept: true })).toBe(
      "Approving this time off will DELETE existing shifts that conflict:\n\nOct 11, 2026\n  - Nora Patel: 9:00 AM - 1:00 PM\n  - Nora Patel: 4:59 PM - 8:00 PM\n\nPayroll hours recorded on these shifts are kept.\n\nContinue?",
    );
  });

  it("covers every day of a group", () => {
    const group = [
      { employee_id: "e1", off_date: "2026-10-11", period: "full-day" as const },
      { employee_id: "e1", off_date: "2026-10-10", period: "full-day" as const },
    ];
    const covered = getApprovalConflicts(group, [s3, s5, s4, s1], employees);
    expect(covered.map((c) => c.shift.id)).toEqual(["s5", "s1", "s3"]);
  });
});
