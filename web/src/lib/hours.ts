// Business hours (migration 005): the weekly open and close times, kept as a history of sets,
// and different hours for single dates. Everything here is pure: the calendar headers, the
// sidebar, the PDF key and the hours dialogs all read the same rules.
//
// A set is in effect from its start date until the next set starts. The first set has no
// start date and also covers every earlier day. Times are compared as minutes, never as
// strings: Postgres sends 'HH:MM:SS' while time inputs give 'HH:MM'.

import {
  addDays,
  compareISODate,
  formatDayLabel,
  formatMonthDay,
  formatNumericDate,
  formatShortDate,
  isISODate,
  WEEKDAY_LONG,
  weekdayOf,
} from "./dates";
import { formatShiftTime, formatTime12Hour, timeToMinutes, toClock } from "./time";
import type { DateRange, ISODate, PgTime } from "./types";

/** 0 = Sunday … 6 = Saturday (weekdayOf and Postgres dow). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** The order every hours list uses. */
export const WEEKDAYS_MONDAY_FIRST: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
// The order the database payload uses.
const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export interface Hours {
  open: PgTime;
  close: PgTime;
}

/** A weekly_hours row as read; generated row types satisfy it (extra columns are fine). */
export interface WeeklyHoursEntry {
  starts_on: ISODate | null;
  weekday: number;
  open_time: PgTime;
  close_time: PgTime;
}
/** A custom_hours row as read. */
export interface CustomHoursEntry {
  hours_date: ISODate;
  open_time: PgTime;
  close_time: PgTime;
}

/** One weekly set: in effect from startsOn (null = the first set, also every earlier day) until the next set starts. */
export interface HoursSet {
  startsOn: ISODate | null;
  days: Readonly<Record<Weekday, Hours>>;
}
/** Everything the calendar, dialogs and PDF need. */
export interface HoursData {
  sets: readonly HoursSet[];
  custom: ReadonlyMap<ISODate, Hours>;
}
export const NO_HOURS: HoursData = { sets: [], custom: new Map<ISODate, Hours>() };

function isWeekday(n: number): n is Weekday {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

function mapWeekdays<T>(value: (weekday: Weekday) => T): Record<Weekday, T> {
  return { 0: value(0), 1: value(1), 2: value(2), 3: value(3), 4: value(4), 5: value(5), 6: value(6) };
}

/** All seven days, or null when any is missing. */
function fullWeek<T>(days: ReadonlyMap<Weekday, T>): Record<Weekday, T> | null {
  const [sun, mon, tue, wed, thu, fri, sat] = WEEKDAYS.map((w) => days.get(w));
  if (
    sun === undefined ||
    mon === undefined ||
    tue === undefined ||
    wed === undefined ||
    thu === undefined ||
    fri === undefined ||
    sat === undefined
  ) {
    return null;
  }
  return { 0: sun, 1: mon, 2: tue, 3: wed, 4: thu, 5: fri, 6: sat };
}

/** The first set (null) sorts before every date. */
function compareStarts(a: ISODate | null, b: ISODate | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareISODate(a, b);
}

// ---------------------------------------------------------------------------
// Reading

/**
 * Groups rows by starts_on; the first set (null) first, then by date. A group missing a
 * weekday (can't happen through save_weekly_hours) is left out. Rows with a weekday outside
 * 0-6 are ignored.
 */
export function toHoursSets(rows: readonly WeeklyHoursEntry[]): HoursSet[] {
  const groups = new Map<ISODate | null, Map<Weekday, Hours>>();
  for (const row of rows) {
    if (!isWeekday(row.weekday)) continue;
    let days = groups.get(row.starts_on);
    if (!days) {
      days = new Map();
      groups.set(row.starts_on, days);
    }
    if (!days.has(row.weekday)) days.set(row.weekday, { open: row.open_time, close: row.close_time });
  }
  const sets: HoursSet[] = [];
  for (const [startsOn, days] of groups) {
    const week = fullWeek(days);
    if (week) sets.push({ startsOn, days: week });
  }
  return sets.sort((a, b) => compareStarts(a.startsOn, b.startsOn));
}

export function toCustomHoursMap(rows: readonly CustomHoursEntry[]): ReadonlyMap<ISODate, Hours> {
  return new Map(rows.map((row) => [row.hours_date, { open: row.open_time, close: row.close_time }]));
}

// ---------------------------------------------------------------------------
// Resolution

/** Same open and close, compared as minutes ('09:00' equals '09:00:00'). Malformed times never match. */
export function sameHours(a: Hours, b: Hours): boolean {
  const aOpen = timeToMinutes(a.open);
  const aClose = timeToMinutes(a.close);
  return aOpen !== null && aClose !== null && aOpen === timeToMinutes(b.open) && aClose === timeToMinutes(b.close);
}

/**
 * The set with the greatest startsOn <= date; else the first set (null); else the earliest set.
 * Null when there are no sets.
 */
export function hoursSetOn(sets: readonly HoursSet[], date: ISODate): HoursSet | null {
  let inEffect: HoursSet | null = null;
  let first: HoursSet | null = null;
  let earliest: HoursSet | null = null;
  for (const set of sets) {
    const start = set.startsOn;
    if (start === null) {
      first ??= set;
      continue;
    }
    if (compareISODate(start, date) <= 0 && (inEffect === null || compareStarts(start, inEffect.startsOn) > 0)) {
      inEffect = set;
    }
    if (earliest === null || compareStarts(start, earliest.startsOn) < 0) earliest = set;
  }
  return inEffect ?? first ?? earliest;
}

/** hoursSetOn(sets, date)?.days[weekdayOf(date)] ?? null. */
export function standardHoursOn(sets: readonly HoursSet[], date: ISODate): Hours | null {
  return hoursSetOn(sets, date)?.days[weekdayOf(date)] ?? null;
}

/**
 * The hours a header or PDF column shows: null when closed, when there is no custom row, or when
 * it equals the standard hours on that date. Checked when rendering, since a later weekly change
 * can make a stored row equal to (or different from) the standard.
 */
export function specialHoursOn(date: ISODate, hours: HoursData, closedDays: ReadonlySet<ISODate>): Hours | null {
  if (closedDays.has(date)) return null;
  const custom = hours.custom.get(date);
  if (!custom) return null;
  const standard = standardHoursOn(hours.sets, date);
  return standard && sameHours(custom, standard) ? null : custom;
}

export type DayHoursState = { kind: "closed" } | { kind: "custom"; hours: Hours } | { kind: "standard" };

/** Closed first; custom only when specialHoursOn would show it; otherwise standard. */
export function dayHoursState(date: ISODate, hours: HoursData, closedDays: ReadonlySet<ISODate>): DayHoursState {
  if (closedDays.has(date)) return { kind: "closed" };
  const special = specialHoursOn(date, hours, closedDays);
  return special ? { kind: "custom", hours: special } : { kind: "standard" };
}

// ---------------------------------------------------------------------------
// Text

/** '9:00 AM - 5:00 PM' (formatShiftTime's style: plain hyphen with spaces). */
export function formatHoursRange(hours: Hours): string {
  return formatShiftTime({ start_time: hours.open, end_time: hours.close });
}

/**
 * '31 Oct (9:00 AM - 5:00 PM)' / 'Saturday, Oct 31 (9:00 AM - 5:00 PM)'; exactly
 * formatDayLabel(date, variant) when hours is null.
 */
export function dayHeaderText(date: ISODate, variant: "desktop" | "mobile", hours: Hours | null): string {
  const label = formatDayLabel(date, variant);
  return hours ? `${label} (${formatHoursRange(hours)})` : label;
}

/** 'From Nov 1' when startsOn is in reference's year, else 'From Jan 4, 2027' (no colon). */
export function hoursChangeLabel(startsOn: ISODate, reference: ISODate): string {
  const sameYear = startsOn.slice(0, 4) === reference.slice(0, 4);
  return `From ${sameYear ? formatMonthDay(startsOn) : formatShortDate(startsOn)}`;
}

export interface HoursLine {
  weekday: Weekday;
  day: string;
  open: string;
  close: string;
  text: string;
}

/**
 * 7 lines, Monday first:
 * { weekday: 1, day: "Monday", open: "11:00 AM", close: "9:00 PM", text: "11:00 AM - 9:00 PM" }.
 */
export function hoursLines(set: HoursSet): HoursLine[] {
  return WEEKDAYS_MONDAY_FIRST.map((weekday) => {
    const hours = set.days[weekday];
    return {
      weekday,
      day: WEEKDAY_LONG[weekday],
      open: formatTime12Hour(hours.open),
      close: formatTime12Hour(hours.close),
      text: formatHoursRange(hours),
    };
  });
}

/**
 * The sidebar: current = hoursSetOn(sets, today); upcoming = the other sets with startsOn > today,
 * by date. Null when there are no sets.
 */
export function sidebarHours(
  sets: readonly HoursSet[],
  today: ISODate,
): { current: HoursSet; upcoming: HoursSet[] } | null {
  const current = hoursSetOn(sets, today);
  if (!current) return null;
  const upcoming = sets
    .filter((set) => set !== current && set.startsOn !== null && compareISODate(set.startsOn, today) > 0)
    .sort((a, b) => compareStarts(a.startsOn, b.startsOn));
  return { current, upcoming };
}

/** 'Monday' or 'Monday-Friday' for each run of consecutive days (Monday first, never wrapping). */
function dayRuns(positions: readonly number[]): string[] {
  const runs: string[] = [];
  let runStart = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const endsRun = i === positions.length - 1 || positions[i + 1] !== positions[i] + 1;
    if (!endsRun) continue;
    const first = WEEKDAY_LONG[WEEKDAYS_MONDAY_FIRST[positions[runStart]]];
    const last = WEEKDAY_LONG[WEEKDAYS_MONDAY_FIRST[positions[i]]];
    runs.push(runStart === i ? first : `${first}-${last}`);
    runStart = i + 1;
  }
  return runs;
}

/** Between the day groups of the PDF key, with nothing after the last one. */
export const HOURS_KEY_SEPARATOR = " | ";

/**
 * 'Monday-Friday: 11:00 AM - 9:00 PM | Saturday: 10:00 AM - 6:00 PM | Sunday: 12:00 PM - 5:00 PM'
 * Days with the same hours form one group, ordered by its first day (Monday first).
 * Consecutive days in a group read as a range ('Saturday-Sunday' too); runs are joined with ', '.
 */
export function hoursKeySentence(set: HoursSet): string {
  const groups: { hours: Hours; positions: number[] }[] = [];
  WEEKDAYS_MONDAY_FIRST.forEach((weekday, position) => {
    const hours = set.days[weekday];
    const group = groups.find((g) => sameHours(g.hours, hours));
    if (group) group.positions.push(position);
    else groups.push({ hours, positions: [position] });
  });
  return groups
    .map((g) => `${dayRuns(g.positions).join(", ")}: ${formatHoursRange(g.hours)}`)
    .join(HOURS_KEY_SEPARATOR);
}

/**
 * The PDF key: [] when there are no sets. Else the sentence of the set in effect on
 * range.start, then 'From Nov 1: <sentence>' for each set starting in (range.start, range.end].
 * A paragraph whose sentence repeats the previous one is skipped.
 */
export function hoursKeyParagraphs(sets: readonly HoursSet[], range: DateRange): string[] {
  const base = hoursSetOn(sets, range.start);
  if (!base) return [];
  let previous = hoursKeySentence(base);
  const paragraphs = [previous];
  const changes = sets
    .flatMap((set) => (set.startsOn === null || set === base ? [] : [{ set, startsOn: set.startsOn }]))
    .filter(({ startsOn }) => compareISODate(startsOn, range.start) > 0 && compareISODate(startsOn, range.end) <= 0)
    .sort((a, b) => compareISODate(a.startsOn, b.startsOn));
  for (const { set, startsOn } of changes) {
    const sentence = hoursKeySentence(set);
    if (sentence === previous) continue;
    paragraphs.push(`${hoursChangeLabel(startsOn, range.start)}: ${sentence}`);
    previous = sentence;
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Per-date choices (Day Hours dialog and Add → Hours)

export type HoursChoice = "standard" | "custom" | "closed";
export const HOURS_CHOICES: readonly HoursChoice[] = ["standard", "custom", "closed"];
export const HOURS_CHOICE_LABELS: Readonly<Record<HoursChoice, string>> = {
  standard: "Standard hours",
  custom: "Custom hours",
  closed: "Closed",
};
export const HOURS_MESSAGES: { readonly missing: string; readonly order: string } = {
  missing: "Please fill in open and close times",
  order: "Close time must be after open time.",
};

const DAY_MINUTES = 24 * 60;

/** A time typed into a form, as minutes and as 'HH:MM'. */
interface FormTime {
  minutes: number;
  clock: string;
}

/** Null when blank or malformed. 24:00 counts as malformed: hours open and close on the same day. */
function formTime(value: string): FormTime | null {
  const text = value.trim();
  const minutes = timeToMinutes(text);
  const clock = toClock(text);
  return minutes !== null && clock !== null && minutes < DAY_MINUTES ? { minutes, clock } : null;
}

/**
 * Clock values ('HH:MM') for a custom-hours write, or the message.
 * Blank or malformed → missing; close <= open → order.
 */
export function checkHoursTimes(
  open: string,
  close: string,
): { ok: true; open: string; close: string } | { ok: false; message: string } {
  const openTime = formTime(open);
  const closeTime = formTime(close);
  if (!openTime || !closeTime) return { ok: false, message: HOURS_MESSAGES.missing };
  if (closeTime.minutes <= openTime.minutes) return { ok: false, message: HOURS_MESSAGES.order };
  return { ok: true, open: openTime.clock, close: closeTime.clock };
}

export type DayHoursPlan =
  | { kind: "error"; message: string }
  | { kind: "noop" }
  | { kind: "close" }
  | { kind: "standard" }
  | { kind: "custom"; open: string; close: string }; // 'HH:MM'

/**
 * What saving the Day Hours dialog does. Closed and Standard are no-ops when the day is
 * already that way. Custom hours equal to the day's standard hours are planned as Standard
 * (no custom row), and custom hours the day already has are a no-op.
 */
export function planDayHoursSave(input: {
  state: DayHoursState;
  standard: Hours | null;
  choice: HoursChoice;
  open: string;
  close: string;
}): DayHoursPlan {
  const { state, standard, choice } = input;
  if (choice === "closed") return state.kind === "closed" ? { kind: "noop" } : { kind: "close" };
  if (choice === "standard") return state.kind === "standard" ? { kind: "noop" } : { kind: "standard" };
  const checked = checkHoursTimes(input.open, input.close);
  if (!checked.ok) return { kind: "error", message: checked.message };
  const custom: Hours = { open: checked.open, close: checked.close };
  if (standard && sameHours(custom, standard)) {
    return state.kind === "standard" ? { kind: "noop" } : { kind: "standard" };
  }
  if (state.kind === "custom" && sameHours(state.hours, custom)) return { kind: "noop" };
  return { kind: "custom", open: checked.open, close: checked.close };
}

// ---------------------------------------------------------------------------
// Weekly editor

/** What the time inputs hold: 'HH:MM' or ''. */
export interface HoursDraftDay {
  open: string;
  close: string;
}
export interface HoursDraft {
  /** React key: saved sets use startsOn ?? "first"; new changes use makeKey(). */
  key: string;
  startsOn: ISODate | null;
  /** False for a change added in this editing session. */
  saved: boolean;
  days: Readonly<Record<Weekday, HoursDraftDay>>;
}

function toDraft(set: HoursSet): HoursDraft {
  return {
    key: set.startsOn ?? "first",
    startsOn: set.startsOn,
    saved: true,
    days: mapWeekdays((w) => ({ open: toClock(set.days[w].open) ?? "", close: toClock(set.days[w].close) ?? "" })),
  };
}

/**
 * Every set as a draft (times via toClock), in editor order:
 *   [hoursSetOn(sets, today),
 *    …sets starting after today (ascending),
 *    …earlier sets (newest first, the first set last)].
 * [] when there are no sets. Index 0 is always the current set; earlier sets can be corrected but not removed.
 */
export function toHoursDrafts(sets: readonly HoursSet[], today: ISODate): HoursDraft[] {
  const current = hoursSetOn(sets, today);
  if (!current) return [];
  const others = sets.filter((set) => set !== current);
  const isUpcoming = (set: HoursSet) => set.startsOn !== null && compareISODate(set.startsOn, today) > 0;
  const upcoming = others.filter(isUpcoming).sort((a, b) => compareStarts(a.startsOn, b.startsOn));
  const earlier = others.filter((set) => !isUpcoming(set)).sort((a, b) => compareStarts(b.startsOn, a.startsOn));
  return [current, ...upcoming, ...earlier].map(toDraft);
}

/** The first set, all times blank: key "first", startsOn null, saved false. */
export function emptyHoursDraft(): HoursDraft {
  return { key: "first", startsOn: null, saved: false, days: mapWeekdays(() => ({ open: "", close: "" })) };
}

/**
 * True for a draft after index 0 that starts before drafts[0] (the first set counts as earliest):
 * an earlier, past set. False when drafts[0] is the first set.
 */
export function isEarlierDraft(drafts: readonly HoursDraft[], index: number): boolean {
  if (index <= 0 || index >= drafts.length) return false;
  const currentStart = drafts[0].startsOn;
  if (currentStart === null) return false;
  return compareStarts(drafts[index].startsOn, currentStart) < 0;
}

/** The day before the next later set starts, for an earlier draft; null when none is later. */
function earlierDraftEnd(drafts: readonly HoursDraft[], index: number): ISODate | null {
  const start = drafts[index].startsOn;
  let next: ISODate | null = null;
  for (const other of drafts) {
    const otherStart = other.startsOn;
    if (otherStart === null || compareStarts(otherStart, start) <= 0) continue;
    if (next === null || compareISODate(otherStart, next) < 0) next = otherStart;
  }
  return next === null ? null : addDays(next, -1);
}

/**
 * index 0: 'Current hours'. An earlier draft (isEarlierDraft) is titled by the dates it covered:
 * the first set 'Until 7/31/26' (the day before the next set), any other '8/1/26 - 9/28/26'.
 * Any other draft: 'From Nov 1, 2026'.
 */
export function hoursDraftTitle(drafts: readonly HoursDraft[], index: number): string {
  if (index < 0 || index >= drafts.length) return "";
  if (index === 0) return "Current hours";
  const draft = drafts[index];
  const end = isEarlierDraft(drafts, index) ? earlierDraftEnd(drafts, index) : null;
  if (draft.startsOn === null) return end === null ? "First hours" : `Until ${formatNumericDate(end)}`;
  if (end !== null) return `${formatNumericDate(draft.startsOn)} - ${formatNumericDate(end)}`;
  return `From ${formatShortDate(draft.startsOn)}`;
}

/** index 0 with a date: 'Since Oct 1, 2026'. Otherwise null (earlier sets show their dates in the title). */
export function hoursDraftSubtitle(drafts: readonly HoursDraft[], index: number): string | null {
  if (index !== 0 || drafts.length === 0) return null;
  const start = drafts[0].startsOn;
  return start === null ? null : `Since ${formatShortDate(start)}`;
}

/**
 * "New hours starting on…" (like lib/rates.ts startNewRate): adds a draft prefilled from the
 * draft with the greatest startsOn <= start. It goes after index 0, among the non-earlier drafts
 * in date order, and before every earlier draft. Any date after the current set's start is
 * allowed, past dates included, so a change that already happened can be recorded. When the
 * current set is the first set, any date is allowed.
 */
export function addHoursChange(
  drafts: readonly HoursDraft[],
  start: string,
  makeKey: () => string,
): { ok: true; drafts: HoursDraft[]; added: HoursDraft } | { ok: false; message: string } {
  if (!isISODate(start)) return { ok: false, message: "Choose the date the new hours start." };
  const currentStart = drafts.at(0)?.startsOn ?? null;
  if (currentStart !== null && compareISODate(start, currentStart) <= 0) {
    return {
      ok: false,
      message: `The current hours start on ${formatShortDate(currentStart)}. Pick a later date for the change.`,
    };
  }
  if (drafts.some((draft) => draft.startsOn === start)) {
    return { ok: false, message: `Hours already start on ${formatShortDate(start)}. Edit that set above.` };
  }

  // The hours that would otherwise apply from `start` on (null counts as earliest).
  let source: HoursDraft | null = null;
  for (const draft of drafts) {
    if (compareStarts(draft.startsOn, start) > 0) continue;
    if (source === null || compareStarts(draft.startsOn, source.startsOn) > 0) source = draft;
  }
  const from = source;
  const added: HoursDraft = {
    key: makeKey(),
    startsOn: start,
    saved: false,
    days: mapWeekdays((w) => (from ? { ...from.days[w] } : { open: "", close: "" })),
  };

  // After the current set and every later draft that starts sooner; before the earlier sets.
  let at = Math.min(1, drafts.length);
  while (at < drafts.length && !isEarlierDraft(drafts, at)) {
    const other = drafts[at].startsOn;
    if (other === null || compareISODate(other, start) > 0) break;
    at += 1;
  }
  return { ok: true, drafts: [...drafts.slice(0, at), added, ...drafts.slice(at)], added };
}

/** A type alias (not an interface) so it is assignable to Json for supabase.rpc. */
export type WeeklyHoursPayload = {
  sets: { starts_on: ISODate | null; days: { weekday: Weekday; open_time: string; close_time: string }[] }[];
  remove: ISODate[];
};

export type WeeklyHoursPlan =
  | { kind: "error"; message: string; draftKey: string; weekday: Weekday; field: "open" | "close" }
  | { kind: "noop" }
  | { kind: "save"; payload: WeeklyHoursPayload };

/**
 * Checks every draft (in order, each Monday first), then sends only new or changed sets plus
 * the upcoming saved sets the admin removed. Sets start on or before today are never removed.
 */
export function planWeeklyHoursSave(
  drafts: readonly HoursDraft[],
  sets: readonly HoursSet[],
  today: ISODate,
): WeeklyHoursPlan {
  const payload: WeeklyHoursPayload = { sets: [], remove: [] };
  for (const [index, draft] of drafts.entries()) {
    const prefix = index === 0 ? "" : `${hoursDraftTitle(drafts, index)}: `;
    const times = new Map<Weekday, { open: FormTime; close: FormTime }>();
    for (const weekday of WEEKDAYS_MONDAY_FIRST) {
      const day = WEEKDAY_LONG[weekday];
      const open = formTime(draft.days[weekday].open);
      const close = formTime(draft.days[weekday].close);
      const fail = (message: string, field: "open" | "close"): WeeklyHoursPlan => ({
        kind: "error",
        message: `${prefix}${message}`,
        draftKey: draft.key,
        weekday,
        field,
      });
      if (!open || !close) return fail(`Enter both times for ${day}.`, open ? "close" : "open");
      if (close.minutes <= open.minutes) return fail(`${day}'s close time must be after its open time.`, "close");
      times.set(weekday, { open, close });
    }
    const week = fullWeek(times);
    if (!week) continue; // unreachable: every weekday was checked above

    const saved = sets.find((set) => set.startsOn === draft.startsOn);
    const changed =
      !saved ||
      WEEKDAYS.some(
        (w) =>
          timeToMinutes(saved.days[w].open) !== week[w].open.minutes ||
          timeToMinutes(saved.days[w].close) !== week[w].close.minutes,
      );
    if (!changed) continue;
    payload.sets.push({
      starts_on: draft.startsOn,
      days: WEEKDAYS.map((weekday) => ({
        weekday,
        open_time: week[weekday].open.clock,
        close_time: week[weekday].close.clock,
      })),
    });
  }

  const kept = new Set(drafts.map((draft) => draft.startsOn));
  for (const set of [...sets].sort((a, b) => compareStarts(a.startsOn, b.startsOn))) {
    if (set.startsOn !== null && compareISODate(set.startsOn, today) > 0 && !kept.has(set.startsOn)) {
      payload.remove.push(set.startsOn);
    }
  }

  return payload.sets.length === 0 && payload.remove.length === 0 ? { kind: "noop" } : { kind: "save", payload };
}

/**
 * Whether Save should ask how edited current hours apply: they differ from what is saved and
 * were already in effect before today. `since` is when they started (null for the first set,
 * which covers every earlier day). Null when there is nothing to ask: unchanged, not saved yet,
 * or starting today (then editing them only affects today on).
 */
export function editedCurrentHours(
  drafts: readonly HoursDraft[],
  sets: readonly HoursSet[],
  today: ISODate,
): { since: ISODate | null } | null {
  const current = drafts[0];
  if (!current || !current.saved) return null;
  if (current.startsOn !== null && compareISODate(current.startsOn, today) >= 0) return null;
  const saved = sets.find((set) => set.startsOn === current.startsOn);
  if (!saved) return null;
  const changed = WEEKDAYS.some((w) => {
    const day = current.days[w];
    return (
      formTime(day.open)?.minutes !== timeToMinutes(saved.days[w].open) ||
      formTime(day.close)?.minutes !== timeToMinutes(saved.days[w].close)
    );
  });
  return changed ? { since: current.startsOn } : null;
}

/**
 * "Start today" for edited current hours: the current set keeps its saved hours (so past days
 * keep them) and the edits become a new set starting today. Plan the result with
 * planWeeklyHoursSave. Fails when a set in the editor already starts today.
 */
export function startEditsToday(
  drafts: readonly HoursDraft[],
  sets: readonly HoursSet[],
  today: ISODate,
  makeKey: () => string,
): { ok: true; drafts: HoursDraft[] } | { ok: false; message: string } {
  const current = drafts[0];
  const saved = current ? sets.find((set) => set.startsOn === current.startsOn) : undefined;
  if (!current || !saved) return { ok: false, message: "The current hours changed. Close the editor and try again." };
  if (drafts.some((draft) => draft.startsOn === today)) {
    return {
      ok: false,
      message: `Hours already start on ${formatShortDate(today)}. Edit that set, or correct the current hours instead.`,
    };
  }
  const added: HoursDraft = { key: makeKey(), startsOn: today, saved: false, days: current.days };
  return { ok: true, drafts: [toDraft(saved), added, ...drafts.slice(1)] };
}
