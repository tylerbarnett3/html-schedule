import { describe, expect, it } from "vitest";
import {
  hourLogDraft,
  hourLogDraftError,
  hourLogsByShift,
  hourLogUnchanged,
  loggableShiftDate,
  loggableShiftScheduled,
  loggableShiftStatus,
  overnightHint,
  overnightQuestion,
  parseLoggableShifts,
  payrollLoggedLine,
  type HourLog,
  type LoggableShift,
} from "./hourLogs";

// Shaped like my_loggable_shifts' rows as PostgREST sends them.
const unlogged = {
  shift_id: "s1",
  shift_date: "2026-09-29",
  start_time: "11:00:00",
  end_time: "21:00:00",
  logged_start: null,
  logged_end: null,
  logged_note: null,
  logged_at: null,
};
const logged = {
  shift_id: "s2",
  shift_date: "2026-09-28",
  start_time: "22:00:00",
  end_time: "02:00:00",
  logged_start: "22:05:00",
  logged_end: "02:30:00",
  logged_note: "Kiln ran late",
  logged_at: "2026-09-29T06:40:00+00:00",
};

const shiftA: LoggableShift = { shiftId: "s1", date: "2026-09-29", start: "11:00:00", end: "21:00:00", log: null };
const shiftB: LoggableShift = {
  shiftId: "s2",
  date: "2026-09-28",
  start: "22:00:00",
  end: "02:00:00",
  log: { start: "22:05:00", end: "02:30:00", note: "Kiln ran late" },
};

describe("parseLoggableShifts", () => {
  it("reads the rows in order, with the log when there is one", () => {
    expect(parseLoggableShifts([unlogged, logged])).toEqual([shiftA, shiftB]);
  });

  it("reads a log without a note as an empty note", () => {
    expect(parseLoggableShifts([{ ...logged, logged_note: null }])[0].log).toEqual({
      start: "22:05:00",
      end: "02:30:00",
      note: "",
    });
  });

  it("an empty list is fine", () => {
    expect(parseLoggableShifts([])).toEqual([]);
  });

  it("refuses anything else", () => {
    expect(() => parseLoggableShifts(null)).toThrow("Unexpected response");
    expect(() => parseLoggableShifts({ rows: [] })).toThrow("Unexpected response");
    expect(() => parseLoggableShifts([{ ...unlogged, shift_date: "Sep 29" }])).toThrow("Unexpected response");
    expect(() => parseLoggableShifts([{ ...unlogged, start_time: null }])).toThrow("Unexpected response");
    expect(() => parseLoggableShifts([{ ...unlogged, shift_id: 7 }])).toThrow("Unexpected response");
  });
});

describe("the employee's form", () => {
  it("starts from the scheduled times, or from what was logged", () => {
    expect(hourLogDraft(shiftA)).toEqual({ start: "11:00", end: "21:00", note: "" });
    expect(hourLogDraft(shiftB)).toEqual({ start: "22:05", end: "02:30", note: "Kiln ran late" });
  });

  it("needs both times, and different ones", () => {
    const missing = "Enter the time you started and the time you finished.";
    expect(hourLogDraftError({ start: "", end: "21:00", note: "" })).toBe(missing);
    expect(hourLogDraftError({ start: "11:00", end: "", note: "" })).toBe(missing);
    expect(hourLogDraftError({ start: "11:00", end: "11:00", note: "" })).toBe("Start and end can't be the same time.");
    expect(hourLogDraftError({ start: "11:00", end: "21:00", note: "" })).toBeNull();
    // Past midnight is allowed, as for shifts.
    expect(hourLogDraftError({ start: "22:00", end: "02:00", note: "" })).toBeNull();
  });

  it("keeps the note to 160 characters, not counting spaces around it", () => {
    expect(hourLogDraftError({ start: "11:00", end: "21:00", note: "x".repeat(161) })).toBe(
      "Keep the note to 160 characters.",
    );
    expect(hourLogDraftError({ start: "11:00", end: "21:00", note: ` ${"x".repeat(160)} ` })).toBeNull();
  });

  it("an unchanged log saves nothing; a shift not logged yet always saves", () => {
    expect(hourLogUnchanged(shiftB, { start: "22:05", end: "02:30", note: " Kiln ran late " })).toBe(true);
    expect(hourLogUnchanged(shiftB, { start: "22:05", end: "02:45", note: "Kiln ran late" })).toBe(false);
    expect(hourLogUnchanged(shiftB, { start: "22:05", end: "02:30", note: "" })).toBe(false);
    expect(hourLogUnchanged(shiftA, hourLogDraft(shiftA))).toBe(false);
  });
});

describe("past midnight", () => {
  it("says how long hours that run past midnight are", () => {
    expect(overnightHint({ start: "22:05", end: "02:30", note: "" })).toBe(
      "Finished after midnight, the next day: 4h 25m in all.",
    );
    expect(overnightHint({ start: "11:00", end: "09:10", note: "" })).toBe(
      "Finished after midnight, the next day: 22h 10m in all.",
    );
    expect(overnightHint({ start: "23:30", end: "00:15", note: "" })).toBe(
      "Finished after midnight, the next day: 45m in all.",
    );
    expect(overnightHint({ start: "11:00", end: "21:00", note: "" })).toBeNull();
    expect(overnightHint({ start: "11:00", end: "", note: "" })).toBeNull();
  });

  it("asks before saving past midnight on a shift that doesn't run that late (AM and PM mixed up)", () => {
    expect(overnightQuestion(shiftA, { start: "11:00", end: "09:10", note: "" })).toBe(
      "11:00 AM to 9:10 AM the next day is 22h 10m. Check AM and PM, or save it if you worked past midnight.",
    );
    expect(overnightQuestion(shiftA, { start: "11:00", end: "21:10", note: "" })).toBeNull();
    // An overnight shift logged overnight is expected.
    expect(overnightQuestion(shiftB, { start: "22:05", end: "02:30", note: "" })).toBeNull();
    expect(overnightQuestion(shiftA, { start: "", end: "09:10", note: "" })).toBeNull();
  });
});

describe("the list's text", () => {
  it("says the date, the scheduled hours and what was logged", () => {
    expect(loggableShiftDate(shiftA)).toBe("Tue, Sep 29");
    expect(loggableShiftScheduled(shiftA)).toBe("Scheduled 11:00 AM - 9:00 PM");
    expect(loggableShiftStatus(shiftA)).toBe("Not logged yet");
    expect(loggableShiftScheduled(shiftB)).toBe("Scheduled 10:00 PM - 2:00 AM");
    expect(loggableShiftStatus(shiftB)).toBe("Logged 10:05 PM - 2:30 AM");
  });
});

describe("payroll", () => {
  const shift = { start_time: "11:00:00", end_time: "21:00:00" };

  it("says what was logged and how its length differs from the schedule", () => {
    expect(payrollLoggedLine({ start_time: "11:00:00", end_time: "21:10:00" }, shift, null)).toBe(
      "Logged · 11:00 AM – 9:10 PM (+10 min)",
    );
    expect(payrollLoggedLine({ start_time: "12:30:00", end_time: "21:00:00" }, shift, null)).toBe(
      "Logged · 12:30 PM – 9:00 PM (−1 hr 30 min)",
    );
    expect(payrollLoggedLine({ start_time: "11:00:00", end_time: "21:00:00" }, shift, null)).toBe(
      "Logged · 11:00 AM – 9:00 PM (as scheduled)",
    );
    // Same length, other times.
    expect(payrollLoggedLine({ start_time: "12:00:00", end_time: "22:00:00" }, shift, null)).toBe(
      "Logged · 12:00 PM – 10:00 PM (No time difference)",
    );
  });

  it("counts past midnight, and names someone else who logged it", () => {
    const overnight = { start_time: "22:00", end_time: "02:00" };
    expect(payrollLoggedLine({ start_time: "22:05:00", end_time: "02:30:00" }, overnight, "Mia")).toBe(
      "Logged by Mia · 10:05 PM – 2:30 AM (+25 min)",
    );
  });

  it("finds logs by shift", () => {
    const log: HourLog = {
      shift_id: "s1",
      employee_id: "e1",
      start_time: "11:00:00",
      end_time: "21:10:00",
      note: "",
      updated_at: "2026-09-29T14:00:00+00:00",
    };
    const byShift = hourLogsByShift([log]);
    expect(byShift.get("s1")).toBe(log);
    expect(byShift.get("s2")).toBeUndefined();
  });
});
