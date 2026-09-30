import { describe, expect, it } from "vitest";
import {
  addHoursChange,
  checkHoursTimes,
  dayHeaderText,
  dayHoursState,
  editedCurrentHours,
  emptyHoursDraft,
  formatHoursRange,
  HOURS_CHOICE_LABELS,
  HOURS_CHOICES,
  HOURS_MESSAGES,
  hoursChangeLabel,
  hoursDraftSubtitle,
  hoursDraftTitle,
  hoursKeyParagraphs,
  hoursKeySentence,
  hoursLines,
  hoursSetOn,
  isEarlierDraft,
  NO_HOURS,
  planDayHoursSave,
  planWeeklyHoursSave,
  sameHours,
  sidebarHours,
  specialHoursOn,
  startEditsToday,
  standardHoursOn,
  toCustomHoursMap,
  toHoursDrafts,
  toHoursSets,
  WEEKDAYS_MONDAY_FIRST,
  type DayHoursState,
  type Hours,
  type HoursData,
  type HoursDraft,
  type HoursSet,
  type Weekday,
  type WeeklyHoursEntry,
} from "./hours";
import type { ISODate } from "./types";

// Times as Postgres sends them ('HH:MM:SS').
const h = (open: string, close: string): Hours => ({ open: `${open}:00`, close: `${close}:00` });

/** Days Sunday first, as [open, close] in 'HH:MM'. */
function hoursSet(startsOn: ISODate | null, days: readonly (readonly [string, string])[]): HoursSet {
  const at = (w: Weekday) => h(days[w][0], days[w][1]);
  return { startsOn, days: { 0: at(0), 1: at(1), 2: at(2), 3: at(3), 4: at(4), 5: at(5), 6: at(6) } };
}

const SUN = ["12:00", "17:00"] as const;
const FIRST = hoursSet(null, [
  SUN,
  ["10:00", "20:00"],
  ["10:00", "20:00"],
  ["10:00", "20:00"],
  ["10:00", "20:00"],
  ["10:00", "20:00"],
  ["10:00", "18:00"],
]);
const OCT = hoursSet("2026-10-01", [
  SUN,
  ["11:00", "21:00"],
  ["11:00", "21:00"],
  ["11:00", "21:00"],
  ["11:00", "21:00"],
  ["11:00", "21:00"],
  ["10:00", "18:00"],
]);
const NOV = hoursSet("2026-11-01", [
  SUN,
  ["11:00", "21:00"],
  ["11:00", "19:00"],
  ["11:00", "21:00"],
  ["11:00", "21:00"],
  ["11:00", "22:00"],
  ["10:00", "22:00"],
]);
const SETS = [FIRST, OCT, NOV];

const OCT_SENTENCE = "Monday-Friday: 11:00 AM - 9:00 PM | Saturday: 10:00 AM - 6:00 PM | Sunday: 12:00 PM - 5:00 PM";
const FIRST_SENTENCE =
  "Monday-Friday: 10:00 AM - 8:00 PM | Saturday: 10:00 AM - 6:00 PM | Sunday: 12:00 PM - 5:00 PM";
const NOV_SENTENCE =
  "Monday, Wednesday-Thursday: 11:00 AM - 9:00 PM | Tuesday: 11:00 AM - 7:00 PM | Friday: 11:00 AM - 10:00 PM | " +
  "Saturday: 10:00 AM - 10:00 PM | Sunday: 12:00 PM - 5:00 PM";

function rowsOf(set: HoursSet): WeeklyHoursEntry[] {
  return WEEKDAYS_MONDAY_FIRST.map((weekday) => ({
    starts_on: set.startsOn,
    weekday,
    open_time: set.days[weekday].open,
    close_time: set.days[weekday].close,
  }));
}

function data(custom: Record<ISODate, Hours> = {}, sets: readonly HoursSet[] = SETS): HoursData {
  return { sets, custom: new Map(Object.entries(custom)) };
}

const NONE: ReadonlySet<ISODate> = new Set();

describe("weekday order", () => {
  it("lists Monday first", () => {
    expect(WEEKDAYS_MONDAY_FIRST).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("uses Postgres dow numbering in the test dates", () => {
    expect(standardHoursOn([FIRST], "2026-09-28")).toEqual(h("10:00", "20:00")); // a Monday
    expect(standardHoursOn([FIRST], "2026-10-31")).toEqual(h("10:00", "18:00")); // a Saturday
    expect(standardHoursOn([FIRST], "2026-11-01")).toEqual(h("12:00", "17:00")); // a Sunday
  });
});

describe("toHoursSets", () => {
  it("groups rows into sets: the first set first, then by date", () => {
    const rows = [...rowsOf(NOV), ...rowsOf(FIRST), ...rowsOf(OCT)].reverse();
    expect(toHoursSets(rows)).toEqual([FIRST, OCT, NOV]);
  });

  it("leaves out a set missing a weekday and ignores weekdays outside 0-6", () => {
    const partial = rowsOf(NOV).filter((row) => row.weekday !== 3);
    const stray = { ...rowsOf(OCT)[0], weekday: 7 };
    const fraction = { ...rowsOf(OCT)[0], weekday: 1.5 };
    expect(toHoursSets([...rowsOf(OCT), ...partial, stray, fraction])).toEqual([OCT]);
    expect(toHoursSets([])).toEqual([]);
  });

  it("accepts generated rows with extra columns", () => {
    const rows = rowsOf(OCT).map((row, i) => ({ ...row, id: `id-${i}`, created_at: "x", updated_at: "y" }));
    expect(toHoursSets(rows)).toEqual([OCT]);
  });
});

describe("toCustomHoursMap", () => {
  it("keys the hours by date", () => {
    const map = toCustomHoursMap([
      { hours_date: "2026-10-31", open_time: "09:00:00", close_time: "17:00:00" },
      { hours_date: "2026-11-06", open_time: "11:00:00", close_time: "21:00:00" },
    ]);
    expect([...map.keys()]).toEqual(["2026-10-31", "2026-11-06"]);
    expect(map.get("2026-10-31")).toEqual({ open: "09:00:00", close: "17:00:00" });
    expect(map.has("2026-10-30")).toBe(false);
  });
});

describe("sameHours", () => {
  it("compares as minutes across formats", () => {
    expect(sameHours({ open: "09:00", close: "17:00" }, h("09:00", "17:00"))).toBe(true);
    expect(sameHours(h("09:00", "17:00"), h("09:00", "17:30"))).toBe(false);
    expect(sameHours(h("09:00", "17:00"), h("09:30", "17:00"))).toBe(false);
  });

  it("never matches malformed times", () => {
    expect(sameHours({ open: "", close: "" }, { open: "", close: "" })).toBe(false);
    expect(sameHours({ open: "nine", close: "17:00" }, { open: "nine", close: "17:00" })).toBe(false);
    expect(sameHours(h("09:00", "17:00"), { open: "09:00", close: "" })).toBe(false);
  });
});

describe("hoursSetOn and standardHoursOn", () => {
  it("picks the set in effect on a date", () => {
    expect(hoursSetOn(SETS, "2026-09-30")).toBe(FIRST);
    expect(hoursSetOn(SETS, "2026-10-01")).toBe(OCT);
    expect(hoursSetOn(SETS, "2026-10-31")).toBe(OCT);
    expect(hoursSetOn(SETS, "2026-11-01")).toBe(NOV);
    expect(hoursSetOn(SETS, "1999-01-01")).toBe(FIRST);
    expect(hoursSetOn(SETS, "2030-01-01")).toBe(NOV);
  });

  it("doesn't depend on the order of the sets", () => {
    expect(hoursSetOn([NOV, FIRST, OCT], "2026-10-15")).toBe(OCT);
    expect(hoursSetOn([NOV, OCT, FIRST], "2026-09-15")).toBe(FIRST);
  });

  it("falls back to the earliest set, and to null without sets", () => {
    expect(hoursSetOn([], "2026-10-01")).toBeNull();
    expect(hoursSetOn([OCT], "2026-09-01")).toBe(OCT);
    expect(hoursSetOn([NOV, OCT], "2026-09-01")).toBe(OCT);
  });

  it("gives the day's standard hours", () => {
    expect(standardHoursOn(SETS, "2026-10-31")).toEqual(h("10:00", "18:00"));
    expect(standardHoursOn(SETS, "2026-11-06")).toEqual(h("11:00", "22:00"));
    expect(standardHoursOn(SETS, "2026-10-30")).toEqual(h("11:00", "21:00"));
    expect(standardHoursOn([], "2026-10-30")).toBeNull();
  });
});

describe("specialHoursOn", () => {
  it("returns custom hours that differ from the standard", () => {
    expect(specialHoursOn("2026-10-31", data({ "2026-10-31": h("09:00", "17:00") }), NONE)).toEqual(
      h("09:00", "17:00"),
    );
    // Equal to the old Friday standard, different from the November one (11-22).
    expect(specialHoursOn("2026-11-06", data({ "2026-11-06": h("11:00", "21:00") }), NONE)).toEqual(
      h("11:00", "21:00"),
    );
  });

  it("is null for custom hours equal to the standard, across formats", () => {
    const hours = data({ "2026-10-30": { open: "11:00", close: "21:00" } });
    expect(specialHoursOn("2026-10-30", hours, NONE)).toBeNull();
  });

  it("is null on a closed day and on a day without a custom row", () => {
    const hours = data({ "2026-10-31": h("09:00", "17:00") });
    expect(specialHoursOn("2026-10-31", hours, new Set(["2026-10-31"]))).toBeNull();
    expect(specialHoursOn("2026-10-30", hours, NONE)).toBeNull();
    expect(specialHoursOn("2026-10-31", NO_HOURS, NONE)).toBeNull();
  });

  it("shows custom hours when no weekly hours exist", () => {
    const hours = data({ "2026-10-31": h("10:00", "18:00") }, []);
    expect(specialHoursOn("2026-10-31", hours, NONE)).toEqual(h("10:00", "18:00"));
  });
});

describe("dayHoursState", () => {
  const hours = data({ "2026-10-31": h("09:00", "17:00"), "2026-10-30": h("11:00", "21:00") });

  it("is closed first, even with custom hours", () => {
    expect(dayHoursState("2026-10-31", hours, new Set(["2026-10-31"]))).toEqual({ kind: "closed" });
  });

  it("is custom only for special hours", () => {
    expect(dayHoursState("2026-10-31", hours, NONE)).toEqual({ kind: "custom", hours: h("09:00", "17:00") });
  });

  it("is standard without a custom row, and for a stored row equal to the standard", () => {
    expect(dayHoursState("2026-10-29", hours, NONE)).toEqual({ kind: "standard" });
    expect(dayHoursState("2026-10-30", hours, NONE)).toEqual({ kind: "standard" });
  });
});

describe("hours text", () => {
  it("formats a range in the shift time style", () => {
    expect(formatHoursRange(h("09:00", "17:00"))).toBe("9:00 AM - 5:00 PM");
    expect(formatHoursRange({ open: "12:00", close: "23:30" })).toBe("12:00 PM - 11:30 PM");
  });

  it("adds hours to the day header", () => {
    expect(dayHeaderText("2026-10-31", "desktop", h("09:00", "17:00"))).toBe("31 Oct (9:00 AM - 5:00 PM)");
    expect(dayHeaderText("2026-10-31", "mobile", h("09:00", "17:00"))).toBe("Saturday, Oct 31 (9:00 AM - 5:00 PM)");
    expect(dayHeaderText("2026-10-31", "desktop", null)).toBe("31 Oct");
    expect(dayHeaderText("2026-10-31", "mobile", null)).toBe("Saturday, Oct 31");
  });

  it("labels a change, with the year only when it differs", () => {
    expect(hoursChangeLabel("2026-11-01", "2026-09-30")).toBe("From Nov 1");
    expect(hoursChangeLabel("2027-01-04", "2026-12-20")).toBe("From Jan 4, 2027");
  });

  it("lists a set's 7 days, Monday first", () => {
    const lines = hoursLines(OCT);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toEqual({ weekday: 1, day: "Monday", open: "11:00 AM", close: "9:00 PM", text: "11:00 AM - 9:00 PM" });
    expect(lines.map((line) => line.day)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    expect(lines[6]).toEqual({ weekday: 0, day: "Sunday", open: "12:00 PM", close: "5:00 PM", text: "12:00 PM - 5:00 PM" });
  });
});

describe("sidebarHours", () => {
  it("gives the current set and the upcoming changes", () => {
    expect(sidebarHours(SETS, "2026-09-30")).toEqual({ current: FIRST, upcoming: [OCT, NOV] });
    expect(sidebarHours(SETS, "2026-10-15")).toEqual({ current: OCT, upcoming: [NOV] });
    expect(sidebarHours([NOV, OCT, FIRST], "2026-10-01")).toEqual({ current: OCT, upcoming: [NOV] });
    expect(sidebarHours(SETS, "2026-11-01")).toEqual({ current: NOV, upcoming: [] });
  });

  it("is null without sets", () => {
    expect(sidebarHours([], "2026-09-30")).toBeNull();
  });
});

describe("hoursKeySentence", () => {
  const A = ["09:00", "17:00"] as const;
  const B = ["10:00", "18:00"] as const;

  it("groups identical weekdays into ranges", () => {
    expect(hoursKeySentence(OCT)).toBe(OCT_SENTENCE);
    expect(hoursKeySentence(NOV)).toBe(NOV_SENTENCE);
  });

  it("reads all seven days as one range", () => {
    expect(hoursKeySentence(hoursSet(null, [A, A, A, A, A, A, A]))).toBe("Monday-Sunday: 9:00 AM - 5:00 PM");
  });

  it("never wraps Sunday round to Monday", () => {
    expect(hoursKeySentence(hoursSet(null, [A, A, B, B, B, B, B]))).toBe(
      "Monday, Sunday: 9:00 AM - 5:00 PM | Tuesday-Saturday: 10:00 AM - 6:00 PM",
    );
  });

  it("reads a run of two as a range", () => {
    expect(hoursKeySentence(hoursSet(null, [B, A, A, A, A, A, B]))).toBe(
      "Monday-Friday: 9:00 AM - 5:00 PM | Saturday-Sunday: 10:00 AM - 6:00 PM",
    );
  });

  it("joins days that aren't next to each other", () => {
    expect(hoursKeySentence(hoursSet(null, [B, A, B, A, B, A, B]))).toBe(
      "Monday, Wednesday, Friday: 9:00 AM - 5:00 PM | Tuesday, Thursday, Saturday-Sunday: 10:00 AM - 6:00 PM",
    );
  });

  it("matches times across formats", () => {
    const set: HoursSet = { ...OCT, days: { ...OCT.days, 3: { open: "11:00", close: "21:00" } } };
    expect(hoursKeySentence(set)).toBe(OCT_SENTENCE);
  });
});

describe("hoursKeyParagraphs", () => {
  it("starts with the set in effect and adds each change in the range", () => {
    expect(hoursKeyParagraphs(SETS, { start: "2026-09-30", end: "2026-11-03" })).toEqual([
      FIRST_SENTENCE,
      `From Oct 1: ${OCT_SENTENCE}`,
      `From Nov 1: ${NOV_SENTENCE}`,
    ]);
  });

  it("treats a set starting on the first day as the base", () => {
    expect(hoursKeyParagraphs(SETS, { start: "2026-10-01", end: "2026-11-03" })).toEqual([
      OCT_SENTENCE,
      `From Nov 1: ${NOV_SENTENCE}`,
    ]);
  });

  it("includes a change on the last day and none after it", () => {
    expect(hoursKeyParagraphs(SETS, { start: "2026-10-05", end: "2026-10-20" })).toEqual([OCT_SENTENCE]);
    expect(hoursKeyParagraphs(SETS, { start: "2026-10-05", end: "2026-11-01" })).toEqual([
      OCT_SENTENCE,
      `From Nov 1: ${NOV_SENTENCE}`,
    ]);
    expect(hoursKeyParagraphs([NOV, OCT, FIRST], { start: "2026-10-05", end: "2026-10-31" })).toEqual([OCT_SENTENCE]);
  });

  it("is empty without sets", () => {
    expect(hoursKeyParagraphs([], { start: "2026-09-30", end: "2026-11-03" })).toEqual([]);
  });

  it("skips a change that reads the same as the one before", () => {
    const same = { ...OCT, startsOn: "2026-10-15" };
    expect(hoursKeyParagraphs([FIRST, OCT, same, NOV], { start: "2026-10-05", end: "2026-11-03" })).toEqual([
      OCT_SENTENCE,
      `From Nov 1: ${NOV_SENTENCE}`,
    ]);
  });

  it("adds the year to a change in another year", () => {
    const A = ["09:00", "17:00"] as const;
    const jan = hoursSet("2027-01-04", [SUN, A, A, A, A, A, A]);
    expect(hoursKeyParagraphs([...SETS, jan], { start: "2026-12-20", end: "2027-01-20" })).toEqual([
      NOV_SENTENCE,
      "From Jan 4, 2027: Monday-Saturday: 9:00 AM - 5:00 PM | Sunday: 12:00 PM - 5:00 PM",
    ]);
  });
});

describe("per-date choices", () => {
  it("lists the three choices", () => {
    expect(HOURS_CHOICES).toEqual(["standard", "custom", "closed"]);
    expect(HOURS_CHOICES.map((choice) => HOURS_CHOICE_LABELS[choice])).toEqual([
      "Standard hours",
      "Custom hours",
      "Closed",
    ]);
    expect(HOURS_MESSAGES).toEqual({
      missing: "Please fill in open and close times",
      order: "Close time must be after open time.",
    });
  });
});

describe("checkHoursTimes", () => {
  it("asks for both times", () => {
    const missing = { ok: false, message: "Please fill in open and close times" };
    expect(checkHoursTimes("", "17:00")).toEqual(missing);
    expect(checkHoursTimes("09:00", "")).toEqual(missing);
    expect(checkHoursTimes("  ", "17:00")).toEqual(missing);
    expect(checkHoursTimes("9am", "17:00")).toEqual(missing);
    expect(checkHoursTimes("09:00", "24:00")).toEqual(missing);
  });

  it("needs the close after the open", () => {
    const order = { ok: false, message: "Close time must be after open time." };
    expect(checkHoursTimes("17:00", "09:00")).toEqual(order);
    expect(checkHoursTimes("09:00", "09:00")).toEqual(order);
    expect(checkHoursTimes("09:00:00", "09:00")).toEqual(order);
  });

  it("gives 'HH:MM' clock values", () => {
    expect(checkHoursTimes("09:00:00", "17:00")).toEqual({ ok: true, open: "09:00", close: "17:00" });
    expect(checkHoursTimes("00:00", "23:59")).toEqual({ ok: true, open: "00:00", close: "23:59" });
  });
});

describe("planDayHoursSave", () => {
  const STANDARD = h("10:00", "18:00");
  const custom: DayHoursState = { kind: "custom", hours: h("09:00", "17:00") };
  const standard: DayHoursState = { kind: "standard" };
  const closed: DayHoursState = { kind: "closed" };
  const plan = (state: DayHoursState, choice: "standard" | "custom" | "closed", open = "", close = "") =>
    planDayHoursSave({ state, standard: STANDARD, choice, open, close });

  it("closes unless the day is closed already", () => {
    expect(plan(standard, "closed")).toEqual({ kind: "close" });
    expect(plan(custom, "closed")).toEqual({ kind: "close" });
    expect(plan(closed, "closed")).toEqual({ kind: "noop" });
  });

  it("puts the day back on standard hours unless it is already", () => {
    expect(plan(custom, "standard")).toEqual({ kind: "standard" });
    expect(plan(closed, "standard")).toEqual({ kind: "standard" });
    expect(plan(standard, "standard")).toEqual({ kind: "noop" });
  });

  it("checks the custom times first", () => {
    expect(plan(standard, "custom", "", "17:00")).toEqual({ kind: "error", message: HOURS_MESSAGES.missing });
    expect(plan(custom, "custom", "17:00", "09:00")).toEqual({ kind: "error", message: HOURS_MESSAGES.order });
    expect(plan(closed, "custom", "09:00", "09:00")).toEqual({ kind: "error", message: HOURS_MESSAGES.order });
  });

  it("plans custom hours equal to the standard as standard", () => {
    expect(plan(standard, "custom", "10:00", "18:00")).toEqual({ kind: "noop" });
    expect(plan(custom, "custom", "10:00", "18:00")).toEqual({ kind: "standard" });
    expect(plan(closed, "custom", "10:00", "18:00")).toEqual({ kind: "standard" });
  });

  it("skips custom hours the day already has", () => {
    expect(plan(custom, "custom", "09:00", "17:00")).toEqual({ kind: "noop" });
  });

  it("sets custom hours", () => {
    expect(plan(standard, "custom", "09:00", "13:00")).toEqual({ kind: "custom", open: "09:00", close: "13:00" });
    expect(plan(custom, "custom", "09:00", "16:00")).toEqual({ kind: "custom", open: "09:00", close: "16:00" });
    expect(plan(closed, "custom", "09:00:00", "17:00")).toEqual({ kind: "custom", open: "09:00", close: "17:00" });
  });

  it("sets custom hours when no standard hours exist", () => {
    expect(planDayHoursSave({ state: standard, standard: null, choice: "custom", open: "10:00", close: "18:00" })).toEqual({
      kind: "custom",
      open: "10:00",
      close: "18:00",
    });
  });
});

// ---------------------------------------------------------------------------
// Weekly editor

/** The draft of a set, as the time inputs hold it ('HH:MM'). */
function draftOf(set: HoursSet): HoursDraft {
  const day = (w: Weekday) => ({ open: set.days[w].open.slice(0, 5), close: set.days[w].close.slice(0, 5) });
  return {
    key: set.startsOn ?? "first",
    startsOn: set.startsOn,
    saved: true,
    days: { 0: day(0), 1: day(1), 2: day(2), 3: day(3), 4: day(4), 5: day(5), 6: day(6) },
  };
}

function withDay(draft: HoursDraft, weekday: Weekday, open: string, close: string): HoursDraft {
  return { ...draft, days: { ...draft.days, [weekday]: { open, close } } };
}

const keys = (): (() => string) => {
  let n = 0;
  return () => `new-${(n += 1)}`;
};

describe("toHoursDrafts", () => {
  it("puts the current set first, then upcoming sets, then earlier sets newest first", () => {
    expect(toHoursDrafts(SETS, "2026-10-15")).toEqual([draftOf(OCT), draftOf(NOV), draftOf(FIRST)]);
    expect(toHoursDrafts(SETS, "2026-11-15")).toEqual([draftOf(NOV), draftOf(OCT), draftOf(FIRST)]);
    expect(toHoursDrafts(SETS, "2026-09-30")).toEqual([draftOf(FIRST), draftOf(OCT), draftOf(NOV)]);
    expect(toHoursDrafts([NOV, FIRST, OCT], "2026-11-01")).toEqual([draftOf(NOV), draftOf(OCT), draftOf(FIRST)]);
  });

  it("uses 'HH:MM' times and keys by start date", () => {
    const [first] = toHoursDrafts([FIRST], "2026-10-15");
    expect(first.key).toBe("first");
    expect(first.saved).toBe(true);
    expect(first.days[1]).toEqual({ open: "10:00", close: "20:00" });
    expect(toHoursDrafts(SETS, "2026-10-15")[0].key).toBe("2026-10-01");
  });

  it("is empty without sets", () => {
    expect(toHoursDrafts([], "2026-10-15")).toEqual([]);
  });
});

describe("emptyHoursDraft", () => {
  it("is a blank first set", () => {
    const draft = emptyHoursDraft();
    expect(draft).toMatchObject({ key: "first", startsOn: null, saved: false });
    expect(Object.values(draft.days)).toEqual(Array(7).fill({ open: "", close: "" }));
  });
});

describe("isEarlierDraft", () => {
  it("marks sets that start before the current one", () => {
    const drafts = toHoursDrafts(SETS, "2026-10-15"); // OCT, NOV, FIRST
    expect(drafts.map((_, i) => isEarlierDraft(drafts, i))).toEqual([false, false, true]);
    const later = toHoursDrafts(SETS, "2026-11-15"); // NOV, OCT, FIRST
    expect(later.map((_, i) => isEarlierDraft(later, i))).toEqual([false, true, true]);
  });

  it("marks none when the current set is the first set", () => {
    const drafts = toHoursDrafts(SETS, "2026-09-30"); // FIRST, OCT, NOV
    expect(drafts.map((_, i) => isEarlierDraft(drafts, i))).toEqual([false, false, false]);
  });

  it("is false outside the list", () => {
    const drafts = toHoursDrafts(SETS, "2026-10-15");
    expect(isEarlierDraft(drafts, -1)).toBe(false);
    expect(isEarlierDraft(drafts, 3)).toBe(false);
    expect(isEarlierDraft([], 0)).toBe(false);
  });
});

describe("hoursDraftTitle and hoursDraftSubtitle", () => {
  it("titles each set", () => {
    const drafts = toHoursDrafts(SETS, "2026-10-15"); // OCT, NOV, FIRST
    expect(drafts.map((_, i) => hoursDraftTitle(drafts, i))).toEqual([
      "Current hours",
      "From Nov 1, 2026",
      "Until 9/30/26",
    ]);
    expect(hoursDraftTitle([draftOf(FIRST)], 0)).toBe("Current hours");
    expect(hoursDraftTitle(drafts, 3)).toBe("");
  });

  it("titles an earlier dated set by the dates it covered", () => {
    const later = toHoursDrafts(SETS, "2026-11-15"); // NOV, OCT, FIRST
    expect(later.map((_, i) => hoursDraftTitle(later, i))).toEqual([
      "Current hours",
      "10/1/26 - 10/31/26",
      "Until 9/30/26",
    ]);
  });

  it("gives only the current set a subtitle, its start", () => {
    const drafts = toHoursDrafts(SETS, "2026-10-15"); // OCT, NOV, FIRST
    expect(drafts.map((_, i) => hoursDraftSubtitle(drafts, i))).toEqual([
      "Since Oct 1, 2026",
      null,
      null,
    ]);
    const later = toHoursDrafts(SETS, "2026-11-15"); // NOV, OCT, FIRST
    expect(later.map((_, i) => hoursDraftSubtitle(later, i))).toEqual([
      "Since Nov 1, 2026",
      null,
      null,
    ]);
  });

  it("gives no subtitle to the first set when it is current", () => {
    const drafts = toHoursDrafts(SETS, "2026-09-30"); // FIRST, OCT, NOV
    expect(drafts.map((_, i) => hoursDraftSubtitle(drafts, i))).toEqual([null, null, null]);
    expect(hoursDraftSubtitle(drafts, 5)).toBeNull();
  });
});

describe("addHoursChange", () => {
  const drafts = toHoursDrafts(SETS, "2026-10-15"); // OCT, NOV, FIRST

  it("needs a date", () => {
    expect(addHoursChange(drafts, "", keys())).toEqual({ ok: false, message: "Choose the date the new hours start." });
    expect(addHoursChange(drafts, "2026-02-30", keys())).toEqual({
      ok: false,
      message: "Choose the date the new hours start.",
    });
  });

  it("needs a date after the current set's start", () => {
    const message = "The current hours start on Oct 1, 2026. Pick a later date for the change.";
    expect(addHoursChange(drafts, "2026-10-01", keys())).toEqual({ ok: false, message });
    expect(addHoursChange(drafts, "2026-09-15", keys())).toEqual({ ok: false, message });
  });

  it("refuses a date that already has a set", () => {
    expect(addHoursChange(drafts, "2026-11-01", keys())).toEqual({
      ok: false,
      message: "Hours already start on Nov 1, 2026. Edit that set above.",
    });
  });

  it("accepts a past date, right after the current set, prefilled from it", () => {
    const result = addHoursChange(drafts, "2026-10-05", keys());
    if (!result.ok) throw new Error(result.message);
    expect(result.added).toEqual({ ...draftOf(OCT), key: "new-1", startsOn: "2026-10-05", saved: false });
    expect(result.drafts.map((d) => d.startsOn)).toEqual(["2026-10-01", "2026-10-05", "2026-11-01", null]);
    expect(result.drafts[1]).toBe(result.added);
    expect(result.added.days[1]).not.toBe(drafts[0].days[1]);
  });

  it("goes between the current set and a later change, prefilled from the current set", () => {
    const result = addHoursChange(drafts, "2026-10-20", keys());
    if (!result.ok) throw new Error(result.message);
    expect(result.drafts.map((d) => d.startsOn)).toEqual(["2026-10-01", "2026-10-20", "2026-11-01", null]);
    expect(result.added.days).toEqual(draftOf(OCT).days);
  });

  it("goes after a later change and before the earlier sets, prefilled from that change", () => {
    const result = addHoursChange(drafts, "2026-11-10", keys());
    if (!result.ok) throw new Error(result.message);
    expect(result.drafts.map((d) => d.startsOn)).toEqual(["2026-10-01", "2026-11-01", "2026-11-10", null]);
    expect(result.added.days).toEqual(draftOf(NOV).days);
  });

  it("copies blank and edited times too", () => {
    const edited = [withDay(drafts[0], 2, "", "15:00"), ...drafts.slice(1)];
    const result = addHoursChange(edited, "2026-10-20", keys());
    if (!result.ok) throw new Error(result.message);
    expect(result.added.days[2]).toEqual({ open: "", close: "15:00" });
  });

  it("has no lower limit when the current set is the first set", () => {
    const result = addHoursChange([draftOf(FIRST)], "2020-01-01", keys());
    if (!result.ok) throw new Error(result.message);
    expect(result.drafts.map((d) => d.startsOn)).toEqual([null, "2020-01-01"]);
    expect(result.added.days).toEqual(draftOf(FIRST).days);
  });

  it("doesn't change the drafts it was given", () => {
    const before = JSON.stringify(drafts);
    addHoursChange(drafts, "2026-10-20", keys());
    expect(JSON.stringify(drafts)).toBe(before);
  });
});

describe("planWeeklyHoursSave", () => {
  const today = "2026-10-15";
  const drafts = toHoursDrafts(SETS, today); // OCT, NOV, FIRST
  const days = (set: HoursSet) =>
    ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({
      weekday,
      open_time: draftOf(set).days[weekday].open,
      close_time: draftOf(set).days[weekday].close,
    }));

  it("does nothing when nothing changed", () => {
    expect(planWeeklyHoursSave(drafts, SETS, today)).toEqual({ kind: "noop" });
  });

  it("sends a corrected current set", () => {
    const edited = [withDay(drafts[0], 0, "12:00", "16:00"), ...drafts.slice(1)];
    const plan = planWeeklyHoursSave(edited, SETS, today);
    expect(plan).toEqual({
      kind: "save",
      payload: {
        sets: [
          {
            starts_on: "2026-10-01",
            days: [{ weekday: 0, open_time: "12:00", close_time: "16:00" }, ...days(OCT).slice(1)],
          },
        ],
        remove: [],
      },
    });
  });

  it("sends a corrected earlier set", () => {
    const edited = [drafts[0], drafts[1], withDay(drafts[2], 1, "09:00", "20:00")];
    const plan = planWeeklyHoursSave(edited, SETS, today);
    if (plan.kind !== "save") throw new Error(plan.kind);
    expect(plan.payload.sets.map((set) => set.starts_on)).toEqual([null]);
    expect(plan.payload.sets[0].days[1]).toEqual({ weekday: 1, open_time: "09:00", close_time: "20:00" });
    expect(plan.payload.remove).toEqual([]);
  });

  it("sends a new change", () => {
    const added = addHoursChange(drafts, "2026-10-05", keys());
    if (!added.ok) throw new Error(added.message);
    expect(planWeeklyHoursSave(added.drafts, SETS, today)).toEqual({
      kind: "save",
      payload: { sets: [{ starts_on: "2026-10-05", days: days(OCT) }], remove: [] },
    });
  });

  it("removes an upcoming set the admin took out", () => {
    expect(planWeeklyHoursSave([drafts[0], drafts[2]], SETS, today)).toEqual({
      kind: "save",
      payload: { sets: [], remove: ["2026-11-01"] },
    });
  });

  it("never removes a set that has started", () => {
    expect(planWeeklyHoursSave([drafts[0], drafts[1]], SETS, today)).toEqual({ kind: "noop" });
    const nov = toHoursDrafts(SETS, "2026-11-01");
    expect(planWeeklyHoursSave([nov[0]], SETS, "2026-11-01")).toEqual({ kind: "noop" });
  });

  it("lists removals by date", () => {
    const dec = { ...NOV, startsOn: "2026-12-01" };
    const sets = [FIRST, OCT, dec, NOV];
    expect(planWeeklyHoursSave([drafts[0], drafts[2]], sets, today)).toEqual({
      kind: "save",
      payload: { sets: [], remove: ["2026-11-01", "2026-12-01"] },
    });
  });

  it("names the set and field of a blank time", () => {
    expect(planWeeklyHoursSave([drafts[0], withDay(drafts[1], 1, "", "21:00"), drafts[2]], SETS, today)).toEqual({
      kind: "error",
      message: "From Nov 1, 2026: Enter both times for Monday.",
      draftKey: "2026-11-01",
      weekday: 1,
      field: "open",
    });
    expect(planWeeklyHoursSave([drafts[0], drafts[1], withDay(drafts[2], 1, "10:00", "")], SETS, today)).toEqual({
      kind: "error",
      message: "Until 9/30/26: Enter both times for Monday.",
      draftKey: "first",
      weekday: 1,
      field: "close",
    });
  });

  it("needs each close after its open", () => {
    expect(planWeeklyHoursSave([withDay(drafts[0], 1, "21:00", "11:00"), ...drafts.slice(1)], SETS, today)).toEqual({
      kind: "error",
      message: "Monday's close time must be after its open time.",
      draftKey: "2026-10-01",
      weekday: 1,
      field: "close",
    });
    const same = planWeeklyHoursSave([withDay(drafts[0], 0, "11:00", "11:00"), ...drafts.slice(1)], SETS, today);
    expect(same).toMatchObject({ kind: "error", message: "Sunday's close time must be after its open time." });
  });

  it("checks drafts in order, each Monday first", () => {
    const edited = [withDay(withDay(drafts[0], 0, "", ""), 6, "", ""), withDay(drafts[1], 1, "", ""), drafts[2]];
    expect(planWeeklyHoursSave(edited, SETS, today)).toMatchObject({
      message: "Enter both times for Saturday.",
      draftKey: "2026-10-01",
      weekday: 6,
    });
  });

  it("saves the first set the first time", () => {
    const first = emptyHoursDraft();
    const filled = ([0, 1, 2, 3, 4, 5, 6] as const).reduce((draft, w) => withDay(draft, w, "09:00", "17:00"), first);
    expect(planWeeklyHoursSave([filled], [], today)).toEqual({
      kind: "save",
      payload: {
        sets: [
          {
            starts_on: null,
            days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open_time: "09:00", close_time: "17:00" })),
          },
        ],
        remove: [],
      },
    });
    expect(planWeeklyHoursSave([first], [], today)).toMatchObject({
      kind: "error",
      message: "Enter both times for Monday.",
      draftKey: "first",
      field: "open",
    });
  });

  it("compares with the saved times as minutes", () => {
    const seconds = { ...OCT, days: { ...OCT.days, 1: { open: "11:00:00", close: "21:00:00" } } };
    expect(planWeeklyHoursSave(drafts, [FIRST, seconds, NOV], today)).toEqual({ kind: "noop" });
  });

  it("sends sets in draft order", () => {
    const edited = drafts.map((draft) => withDay(draft, 0, "12:00", "16:00"));
    const plan = planWeeklyHoursSave(edited, SETS, today);
    if (plan.kind !== "save") throw new Error(plan.kind);
    expect(plan.payload.sets.map((set) => set.starts_on)).toEqual(["2026-10-01", "2026-11-01", null]);
  });
});

describe("editedCurrentHours and startEditsToday", () => {
  const today = "2026-10-15"; // OCT is current; NOV upcoming; FIRST earlier
  const drafts = toHoursDrafts(SETS, today);
  const edited = [withDay(drafts[0], 1, "11:00", "22:00"), ...drafts.slice(1)];
  let keys = 0;
  const makeKey = () => `new-${++keys}`;

  it("asks only when the current hours changed and started before today", () => {
    expect(editedCurrentHours(drafts, SETS, today)).toBeNull();
    expect(editedCurrentHours(edited, SETS, today)).toEqual({ since: "2026-10-01" });
    // Same times typed differently still count as unchanged.
    expect(editedCurrentHours([withDay(drafts[0], 1, "11:00:00", "21:00"), ...drafts.slice(1)], SETS, today)).toBeNull();
    // Editing an upcoming or earlier set never asks.
    expect(editedCurrentHours([drafts[0], withDay(drafts[1], 1, "09:00", "20:00"), drafts[2]], SETS, today)).toBeNull();
    // Current hours that start today: editing them only affects today on.
    const startsToday = toHoursDrafts(SETS, "2026-10-01");
    expect(editedCurrentHours([withDay(startsToday[0], 1, "11:00", "22:00"), ...startsToday.slice(1)], SETS, "2026-10-01")).toBeNull();
  });

  it("gives null for the first set", () => {
    const firstOnly = [FIRST];
    const first = toHoursDrafts(firstOnly, today);
    expect(editedCurrentHours([withDay(first[0], 0, "13:00", "18:00")], firstOnly, today)).toEqual({ since: null });
    expect(editedCurrentHours([emptyHoursDraft()], [], today)).toBeNull();
  });

  it("keeps the saved current hours and starts the edits today", () => {
    const moved = startEditsToday(edited, SETS, today, makeKey);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.drafts.map((d) => d.startsOn)).toEqual(["2026-10-01", today, "2026-11-01", null]);
    expect(moved.drafts[0]).toEqual(drafts[0]);
    expect(moved.drafts[1].days).toEqual(edited[0].days);
    expect(planWeeklyHoursSave(moved.drafts, SETS, today)).toEqual({
      kind: "save",
      payload: {
        sets: [
          {
            starts_on: today,
            days: [
              { weekday: 0, open_time: "12:00", close_time: "17:00" },
              { weekday: 1, open_time: "11:00", close_time: "22:00" },
              { weekday: 2, open_time: "11:00", close_time: "21:00" },
              { weekday: 3, open_time: "11:00", close_time: "21:00" },
              { weekday: 4, open_time: "11:00", close_time: "21:00" },
              { weekday: 5, open_time: "11:00", close_time: "21:00" },
              { weekday: 6, open_time: "10:00", close_time: "18:00" },
            ],
          },
        ],
        remove: [],
      },
    });
  });

  it("refuses when a set in the editor already starts today", () => {
    const added = addHoursChange(edited, today, makeKey);
    if (!added.ok) throw new Error(added.message);
    expect(startEditsToday(added.drafts, SETS, today, makeKey)).toEqual({
      ok: false,
      message: "Hours already start on Oct 15, 2026. Edit that set, or correct the current hours instead.",
    });
  });
});
