import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  BACKUP_VERSION,
  backupFilename,
  backupJson,
  backupToast,
  buildBackupFile,
  type BackupTables,
} from "./backup";

function emptyTables(): BackupTables {
  return {
    employees: [],
    employee_rates: [],
    shifts: [],
    time_off: [],
    availability: [],
    shift_actuals: [],
    closed_days: [],
  };
}

describe("backupFilename", () => {
  it("uses New York wall-clock time in summer (EDT)", () => {
    expect(backupFilename(new Date("2026-09-29T14:05:09Z"))).toBe("schedule-backup-2026-09-29-100509.json");
  });

  it("uses New York wall-clock time in winter (EST), even when UTC is a day ahead", () => {
    expect(backupFilename(new Date("2026-01-15T03:04:05Z"))).toBe("schedule-backup-2026-01-14-220405.json");
  });

  it("writes midnight as 00, not 24", () => {
    expect(backupFilename(new Date("2026-09-29T04:00:00Z"))).toBe("schedule-backup-2026-09-29-000000.json");
  });

  it("takes another time zone", () => {
    expect(backupFilename(new Date("2026-09-29T14:05:09Z"), "Asia/Tokyo")).toBe(
      "schedule-backup-2026-09-29-230509.json",
    );
  });
});

describe("buildBackupFile", () => {
  it("wraps the tables with the format header, in a fixed key order", () => {
    const tables = emptyTables();
    tables.closed_days = [{ closed_date: "2026-10-09", created_at: "2026-09-01T12:00:00+00:00" }];
    const file = buildBackupFile(tables, new Date("2026-09-29T14:05:09.123Z"));
    expect(Object.keys(file)).toEqual(["format", "version", "exportedAt", ...BACKUP_TABLES]);
    expect(file.format).toBe("mad-potter-schedule-backup");
    expect(file.format).toBe(BACKUP_FORMAT);
    expect(file.version).toBe(1);
    expect(file.version).toBe(BACKUP_VERSION);
    expect(file.exportedAt).toBe("2026-09-29T14:05:09.123Z");
    expect(file.closed_days).toBe(tables.closed_days);
  });

  it("lists the seven tables and never admins", () => {
    expect(BACKUP_TABLES).toEqual([
      "employees",
      "employee_rates",
      "shifts",
      "time_off",
      "availability",
      "shift_actuals",
      "closed_days",
    ]);
    expect(BACKUP_TABLES).not.toContain("admins");
  });

  it("serializes to readable JSON that parses back to the same file", () => {
    const file = buildBackupFile(emptyTables(), new Date("2026-09-29T14:05:09Z"));
    const json = backupJson(file);
    expect(json.startsWith('{\n  "format": "mad-potter-schedule-backup",\n  "version": 1,')).toBe(true);
    expect(JSON.parse(json)).toEqual(file);
  });
});

describe("backupToast", () => {
  it("counts employees and shifts", () => {
    const rows = <T>(n: number, row: T): T[] => Array.from({ length: n }, () => row);
    expect(backupToast({ employees: rows(14, emptyEmployee()), shifts: rows(812, emptyShift()) })).toEqual({
      title: "Backup downloaded",
      message: "14 employees, 812 shifts.",
    });
    expect(backupToast({ employees: rows(1, emptyEmployee()), shifts: [] })).toEqual({
      title: "Backup downloaded",
      message: "1 employee, 0 shifts.",
    });
  });
});

function emptyEmployee(): BackupTables["employees"][number] {
  return {
    id: "e1",
    name: "Avery Lane",
    color: "#2B6CB0",
    display_order: 0,
    archived: false,
    user_id: null,
    wix_id: null,
    created_at: "2026-09-01T12:00:00+00:00",
    updated_at: "2026-09-01T12:00:00+00:00",
  };
}

function emptyShift(): BackupTables["shifts"][number] {
  return {
    id: "s1",
    employee_id: "e1",
    shift_date: "2026-10-01",
    start_time: "09:00:00",
    end_time: "15:00:00",
    wix_id: null,
    created_at: "2026-09-01T12:00:00+00:00",
    updated_at: "2026-09-01T12:00:00+00:00",
  };
}
