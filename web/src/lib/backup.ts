// The toolbar's "Export Backup" file (T1): every schedule table, rows exactly as stored.
// The admins table is left out on purpose.

import type { Tables } from "./supabase";
import { BUSINESS_TIME_ZONE } from "./types";

export const BACKUP_FORMAT = "mad-potter-schedule-backup";
export const BACKUP_VERSION = 1;

/** In the order they appear in the file. */
export const BACKUP_TABLES = [
  "employees",
  "employee_rates",
  "shifts",
  "time_off",
  "availability",
  "shift_actuals",
  "closed_days",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];
export type BackupTables = { [T in BackupTable]: Tables<T>[] };

export interface BackupFile extends BackupTables {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** When the export started, as an ISO 8601 UTC timestamp. */
  exportedAt: string;
}

export function buildBackupFile(tables: BackupTables, exportedAt: Date): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    employees: tables.employees,
    employee_rates: tables.employee_rates,
    shifts: tables.shifts,
    time_off: tables.time_off,
    availability: tables.availability,
    shift_actuals: tables.shift_actuals,
    closed_days: tables.closed_days,
  };
}

/** Pretty-printed, like the old export, so a person can read or diff it. */
export function backupJson(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * 'schedule-backup-2026-09-29-100509.json': the business time zone's wall clock, 24-hour.
 * h23 (not hour12: false) so midnight is 00, never 24.
 */
export function backupFilename(now: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return `schedule-backup-${date}-${part("hour")}${part("minute")}${part("second")}.json`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The success toast: "Backup downloaded" / "14 employees, 812 shifts." */
export function backupToast(file: Pick<BackupFile, "employees" | "shifts">): { title: string; message: string } {
  return {
    title: "Backup downloaded",
    message: `${count(file.employees.length, "employee")}, ${count(file.shifts.length, "shift")}.`,
  };
}
