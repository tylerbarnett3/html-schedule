import { describe, expect, it } from "vitest";
import {
  activeEmployees,
  applyEmployeeOrder,
  changedOrders,
  employeeRangeStats,
  formatEmployeeStats,
  moveItem,
  nextDisplayOrder,
  NO_SHIFTS,
  reorderedIds,
  validateEmployeeName,
} from "./employees";
import type { Employee, Shift } from "./types";

const R = { start: "2026-09-29", end: "2026-11-02" };

function shift(id: string, employee_id: string, shift_date: string, start_time: string, end_time: string): Shift {
  return { id, employee_id, shift_date, start_time, end_time };
}

function employee(id: string, display_order: number, archived = false, name = id): Employee {
  return { id, name, color: "#7F6C50", display_order, archived };
}

describe("employeeRangeStats", () => {
  const leo = [shift("s1", "leo", "2026-10-06", "10:00:00", "18:00:00")];

  it("counts shifts and hours in the range", () => {
    const one = employeeRangeStats(leo, R).get("leo");
    expect(one).toEqual({ shiftCount: 1, minutes: 480 });
    expect(formatEmployeeStats(one ?? NO_SHIFTS)).toBe("1 shift, 8.0 hrs");

    const two = [...leo, shift("s2", "leo", "2026-10-20", "22:00:00", "02:00:00")];
    expect(formatEmployeeStats(employeeRangeStats(two, R).get("leo") ?? NO_SHIFTS)).toBe("2 shifts, 12.0 hrs");

    const three = [...two, shift("s3", "leo", "2026-10-21", "09:15:00", "11:20:00")];
    expect(employeeRangeStats(three, R).get("leo")).toEqual({ shiftCount: 3, minutes: 845 });
    expect(formatEmployeeStats({ shiftCount: 3, minutes: 605 })).toBe("3 shifts, 10.1 hrs");
  });

  it("includes the first day of the range and not the day after it", () => {
    const edges = [
      shift("a", "leo", "2026-09-29", "09:00", "15:00"),
      shift("b", "leo", "2026-11-02", "09:00", "15:00"),
      shift("c", "leo", "2026-11-03", "09:00", "15:00"),
      shift("d", "leo", "2026-09-28", "09:00", "15:00"),
    ];
    expect(employeeRangeStats(edges, R).get("leo")).toEqual({ shiftCount: 2, minutes: 720 });
  });

  it("keeps employees apart and gives nothing for employees without shifts", () => {
    const stats = employeeRangeStats([...leo, shift("s9", "mia", "2026-10-06", "09:00", "15:00")], R);
    expect(stats.get("leo")?.shiftCount).toBe(1);
    expect(formatEmployeeStats(stats.get("mia") ?? NO_SHIFTS)).toBe("1 shift, 6.0 hrs");
    expect(stats.get("nora")).toBeUndefined();
    expect(formatEmployeeStats(stats.get("nora") ?? NO_SHIFTS)).toBe("0 shifts, 0.0 hrs");
  });

  it("counts a shift ending at midnight as running to midnight", () => {
    const late = [shift("x", "leo", "2026-10-06", "18:00:00", "00:00:00")];
    expect(formatEmployeeStats(employeeRangeStats(late, R).get("leo") ?? NO_SHIFTS)).toBe("1 shift, 6.0 hrs");
  });
});

describe("moveItem", () => {
  it("follows the old drop rule", () => {
    expect(moveItem(["A", "B", "C", "D"], 0, 2)).toEqual(["B", "C", "A", "D"]);
    expect(moveItem(["A", "B", "C", "D"], 3, 1)).toEqual(["A", "D", "B", "C"]);
  });

  it("returns an equal copy when nothing moves", () => {
    const list = ["A", "B"];
    const same = moveItem(list, 1, 1);
    expect(same).toEqual(list);
    expect(same).not.toBe(list);
  });

  it("matches the old page's verified drags", () => {
    const first = moveItem(["Avery", "Jordan", "Mia", "Sam", "Taylor", "Nora"], 0, 2);
    expect(first).toEqual(["Jordan", "Mia", "Avery", "Sam", "Taylor", "Nora"]);
    expect(moveItem(first, 5, 1).slice(0, 4)).toEqual(["Jordan", "Nora", "Mia", "Avery"]);
  });
});

describe("display order", () => {
  it("nextDisplayOrder puts a new employee last", () => {
    expect(nextDisplayOrder([])).toBe(0);
    expect(nextDisplayOrder([{ display_order: 0 }, { display_order: 1 }, { display_order: 2 }])).toBe(3);
    expect(nextDisplayOrder([{ display_order: 0 }, { display_order: 0 }, { display_order: 5 }])).toBe(6);
  });

  it("changedOrders lists only rows that move", () => {
    const list = [
      { id: "a", display_order: 0 },
      { id: "b", display_order: 1 },
      { id: "c", display_order: 2 },
    ];
    expect(changedOrders(list, ["b", "a", "c"])).toEqual([
      { id: "a", display_order: 1 },
      { id: "b", display_order: 0 },
    ]);
  });

  it("reorderedIds moves among active employees and keeps the archived ones last (E11)", () => {
    const list = [employee("a", 0), employee("x", 1, true), employee("b", 2), employee("c", 3), employee("y", 4, true)];
    expect(reorderedIds(list, 0, 2)).toEqual(["b", "c", "a", "x", "y"]);
    expect(reorderedIds(list, 2, 0)).toEqual(["c", "a", "b", "x", "y"]);
  });

  it("applyEmployeeOrder sorts by the ids and renumbers", () => {
    const list = [employee("a", 0), employee("b", 1), employee("c", 2), employee("new", 0)];
    const ordered = applyEmployeeOrder(list, ["c", "a", "b"]);
    expect(ordered.map((e) => [e.id, e.display_order])).toEqual([
      ["c", 0],
      ["a", 1],
      ["b", 2],
      ["new", 3],
    ]);
    // Rows already in place are kept as they are.
    expect(applyEmployeeOrder(list.slice(0, 3), ["a", "b", "c"])[0]).toBe(list[0]);
  });

  it("activeEmployees keeps the order and drops archived employees", () => {
    const list = [employee("a", 0), employee("x", 1, true), employee("b", 2)];
    expect(activeEmployees(list).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("validateEmployeeName", () => {
  const others = [
    { id: "1", name: "Avery Lane" },
    { id: "2", name: "Jordan Price" },
  ];

  it("needs a name", () => {
    expect(validateEmployeeName("   ", others, null)).toBe("Please enter an employee name");
  });

  it("blocks duplicates, ignoring case and spaces at the ends (E4)", () => {
    expect(validateEmployeeName(" Avery lane ", others, null)).toBe("There's already an employee named Avery Lane.");
    expect(validateEmployeeName("JORDAN PRICE", others, "1")).toBe("There's already an employee named Jordan Price.");
  });

  it("lets an employee keep their own name", () => {
    expect(validateEmployeeName("avery lane", others, "1")).toBeNull();
    expect(validateEmployeeName("Mia Chen", others, null)).toBeNull();
  });
});
