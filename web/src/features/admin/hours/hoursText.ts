// Wording for the weekly business hours editor (§3.11), kept apart from the dialog so it
// can be unit-tested.

import { adminErrorCode, adminErrorMessage } from "../../../data/errors";
import { formatMonthDay, formatShortDate } from "../../../lib/dates";
import type { Weekday } from "../../../lib/hours";
import type { ISODate } from "../../../lib/types";

export const WEEKLY_HOURS_TITLE = "Business Hours";
export const WEEKLY_HOURS_SAVED = "Business hours saved.";
export const WEEKLY_INTRO_FIRST =
  "Enter the open and close time for each day. These hours also apply to every earlier day.";
export const WEEKLY_INTRO =
  "Edit the current hours to change them; Save asks whether they start today. To plan a change, add new hours starting on a later date.";
export const WEEKLY_EARLIER_HINT = "Earlier hours apply to past days. Change them only to correct a mistake.";
export const NEW_HOURS_TOGGLE = "New hours starting on…";
export const NEW_HOURS_INTRO = "Days before this date keep the hours they had.";
export const NEW_HOURS_PENDING = "Add the change or cancel it before saving.";

// Save, after the current hours were edited (ApplyHoursDialog).
export const APPLY_HOURS_TITLE = "Save Current Hours";
export const START_TODAY_TITLE = "Start Today";

/** 'You changed the current hours. Do they start today, or replace the hours since Sep 29, 2026?' */
export function applyHoursMessage(since: ISODate | null): string {
  const replaced = since === null ? "for every past day" : `since ${formatShortDate(since)}`;
  return `You changed the current hours. Do they start today, or replace the hours ${replaced}?`;
}

/** 'Days before Sep 30, 2026 keep the old hours.' */
export function startTodayText(today: ISODate): string {
  return `Days before ${formatShortDate(today)} keep the old hours.`;
}

/** 'Correct Since Sep 29', or 'Correct All Past Days' for the first set. */
export function correctHoursTitle(since: ISODate | null): string {
  return since === null ? "Correct All Past Days" : `Correct Since ${formatMonthDay(since)}`;
}

/** 'To fix a mistake: every day since Sep 29, 2026 gets the new hours.' */
export function correctHoursText(since: ISODate | null): string {
  const days = since === null ? "every past day" : `every day since ${formatShortDate(since)}`;
  return `To fix a mistake: ${days} gets the new hours.`;
}

const WEEKLY_SAVE_FALLBACK = "Couldn't save the business hours. Please try again.";

/** hours_in_effect | check_failed | anything else (adminErrorMessage with the weekly fallback). */
export function weeklyHoursErrorMessage(error: unknown): string {
  switch (adminErrorCode(error)) {
    case "hours_in_effect":
      return "That change has already started, so it can't be removed.";
    case "check_failed":
      return "Each close time must be after its open time.";
    default:
      return adminErrorMessage(error, WEEKLY_SAVE_FALLBACK);
  }
}

/** The visually hidden end of a Remove Change button's name: ' from Nov 1, 2026'. */
export function removeChangeSuffix(startsOn: ISODate | null): string {
  return startsOn === null ? "" : ` from ${formatShortDate(startsOn)}`;
}

/** The id of one time input in the weekly editor, so a failed check can point at it. */
export function hoursInputId(prefix: string, draftKey: string, weekday: Weekday, field: "open" | "close"): string {
  return `${prefix}-${draftKey}-${weekday}-${field}`;
}

let lastDraftKey = 0;

/** React keys for new changes in the weekly editor; they only need to be unique on the page. */
export function makeHoursDraftKey(): string {
  lastDraftKey += 1;
  return `new-${lastDraftKey}`;
}
