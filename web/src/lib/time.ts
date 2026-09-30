// Shift times, formatted straight from the 'HH:MM:SS' strings Postgres returns. No Date
// objects are involved, so daylight saving and the device's time zone can't shift them.

import { isISODate, toDayNumber } from "./dates";
import type { ISODate, PgTime, Shift } from "./types";

const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const DAY_SECONDS = 24 * 60 * 60;

/** Seconds since midnight, or null when the value isn't a time. '24:00' is 86400. */
function toSeconds(t: PgTime | null | undefined): number | null {
  const match = t ? TIME_PATTERN.exec(t) : null;
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (minute > 59 || second > 59) return null;
  const total = hour * 3600 + minute * 60 + second;
  return total > DAY_SECONDS ? null : total;
}

/** '09:00:00' -> '9:00 AM', '24:00:00' -> '12:00 AM', missing or malformed -> '—'. */
export function formatTime12Hour(t: PgTime | null | undefined): string {
  const seconds = toSeconds(t);
  if (seconds === null) return "—";
  const hour = Math.floor(seconds / 3600) % 24;
  const minute = Math.floor((seconds % 3600) / 60);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** True when the shift ends after midnight (end earlier than start). */
export function isOvernight(start: PgTime, end: PgTime): boolean {
  const startSeconds = toSeconds(start);
  const endSeconds = toSeconds(end);
  return startSeconds !== null && endSeconds !== null && endSeconds < startSeconds;
}

/** '10:00 PM - 2:00 AM' */
export function formatShiftTime(shift: Pick<Shift, "start_time" | "end_time">): string {
  return `${formatTime12Hour(shift.start_time)} - ${formatTime12Hour(shift.end_time)}`;
}

/** Orders times of day; accepts 'HH:MM' and 'HH:MM:SS' together. Malformed values sort last. */
export function compareTimes(a: PgTime, b: PgTime): number {
  const aSeconds = toSeconds(a);
  const bSeconds = toSeconds(b);
  if (aSeconds !== null && bSeconds !== null) return aSeconds - bSeconds;
  if (aSeconds !== null) return -1;
  if (bSeconds !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Minute math for conflicts, durations and <input type="time">. Always compare times
// as minutes: Postgres sends 'HH:MM:SS' while time inputs give 'HH:MM'.

const DAY_MINUTES = 24 * 60;

/** Start and end in minutes; end is after start (overnight shifts end past 1440). */
export interface Interval {
  start: number;
  end: number;
}

/** Minutes since midnight (seconds dropped); '24:00' is 1440. Null when it isn't a time. */
export function timeToMinutes(t: PgTime | null | undefined): number | null {
  const seconds = toSeconds(t);
  return seconds === null ? null : Math.floor(seconds / 60);
}

/** 'HH:MM' for <input type="time"> and for writes; '24:00:00' becomes '00:00'. */
export function toClock(t: PgTime | null | undefined): string | null {
  const minutes = timeToMinutes(t);
  if (minutes === null) return null;
  const ofDay = minutes % DAY_MINUTES;
  const hour = String(Math.floor(ofDay / 60)).padStart(2, "0");
  const minute = String(ofDay % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

/** A shift's minutes within its own day. An end at or before the start runs past midnight. */
export function shiftInterval(
  start: PgTime | null | undefined,
  end: PgTime | null | undefined,
): Interval | null {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  if (startMinutes === null || endMinutes === null) return null;
  return {
    start: startMinutes,
    end: endMinutes <= startMinutes ? endMinutes + DAY_MINUTES : endMinutes,
  };
}

/**
 * The same interval on one timeline across days (minutes since 1970-01-01), so an
 * overnight shift can be compared with the next morning's shifts.
 */
export function absoluteShiftInterval(
  date: ISODate,
  start: PgTime | null | undefined,
  end: PgTime | null | undefined,
): Interval | null {
  const interval = shiftInterval(start, end);
  if (!interval || !isISODate(date)) return null;
  const offset = toDayNumber(date) * DAY_MINUTES;
  return { start: interval.start + offset, end: interval.end + offset };
}

/** Touching intervals (one ends as the other starts) don't overlap. */
export function intervalsOverlap(a: Interval | null, b: Interval | null): boolean {
  return a !== null && b !== null && a.start < b.end && b.start < a.end;
}

/** Minutes worked; null when either time is missing or malformed. */
export function shiftDurationMinutes(
  start: PgTime | null | undefined,
  end: PgTime | null | undefined,
): number | null {
  const interval = shiftInterval(start, end);
  return interval ? interval.end - interval.start : null;
}
