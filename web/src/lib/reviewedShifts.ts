// How payroll reviews show on the schedule. A shift reviewed in Payroll shows what was
// recorded for it (the actual times, for whoever worked them) instead of what was scheduled;
// one that wasn't worked shows nothing; unscheduled work shows as a shift of its own. Only the
// display changes: the scheduled shift stays as it was, for Payroll to compare against.

import type { Tables } from "./supabase";
import type { Shift } from "./types";

/**
 * A row of reviewed_shifts (20261005000001_reviewed_shifts.sql): a payroll record without its
 * note. The times are null only for a shift that wasn't worked; shift_id is null for
 * unscheduled work and for a record whose shift was deleted since.
 */
export type ShiftReview = Pick<
  Tables<"shift_actuals">,
  "id" | "shift_id" | "employee_id" | "work_date" | "start_time" | "end_time" | "status"
>;

export interface ScheduleShifts {
  /** Shifts no payroll record covers, as scheduled: the ones the admin calendar can edit. */
  scheduled: Shift[];
  /** What payroll recorded as worked, shaped like shifts. Each id is the payroll record's. */
  reviewed: Shift[];
}

/** Splits the schedule into the shifts still as scheduled and the reviewed ones, as recorded. */
export function applyReviews(shifts: readonly Shift[], reviews: readonly ShiftReview[]): ScheduleShifts {
  const reviewedShiftIds = new Set<string>();
  const reviewed: Shift[] = [];
  for (const review of reviews) {
    if (review.shift_id !== null) reviewedShiftIds.add(review.shift_id);
    if (review.status === "not-worked" || review.start_time === null || review.end_time === null) continue;
    reviewed.push({
      id: review.id,
      employee_id: review.employee_id,
      shift_date: review.work_date,
      start_time: review.start_time,
      end_time: review.end_time,
    });
  }
  return { scheduled: shifts.filter((shift) => !reviewedShiftIds.has(shift.id)), reviewed };
}

/** Every shift as the schedule shows it, for the PDF and the employee stats. */
export function shiftsAsShown(shifts: readonly Shift[], reviews: readonly ShiftReview[]): Shift[] {
  const { scheduled, reviewed } = applyReviews(shifts, reviews);
  return [...scheduled, ...reviewed];
}
