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
    weekly_hours: [],
    custom_hours: [],
    hour_logs: [],
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

  it("writes the ten table keys in order, the business hours and logged hours after closed_days", () => {
    const file = buildBackupFile(emptyTables(), new Date("2026-09-29T14:05:09Z"));
    expect(Object.keys(file)).toEqual([
      "format",
      "version",
      "exportedAt",
      "employees",
      "employee_rates",
      "shifts",
      "time_off",
      "availability",
      "shift_actuals",
      "closed_days",
      "weekly_hours",
      "custom_hours",
      "hour_logs",
    ]);
  });

  it("lists the ten tables and never admins", () => {
    expect(BACKUP_TABLES).toEqual([
      "employees",
      "employee_rates",
      "shifts",
      "time_off",
      "availability",
      "shift_actuals",
      "closed_days",
      "weekly_hours",
      "custom_hours",
      "hour_logs",
    ]);
    expect(BACKUP_TABLES).toHaveLength(10);
    expect(BACKUP_TABLES).not.toContain("admins");
  });

  it("stays version 1 with the hours and logged hours tables (they only add keys)", () => {
    expect(BACKUP_VERSION).toBe(1);
    expect(buildBackupFile(emptyTables(), new Date("2026-09-29T14:05:09Z")).version).toBe(1);
  });

  it("serializes to readable JSON that parses back to the same file", () => {
    const file = buildBackupFile(emptyTables(), new Date("2026-09-29T14:05:09Z"));
    const json = backupJson(file);
    expect(json.startsWith('{\n  "format": "mad-potter-schedule-backup",\n  "version": 1,')).toBe(true);
    expect(JSON.parse(json)).toEqual(file);
  });

  it("keeps weekly hours, custom hours and logged hours rows exactly as stored through a JSON round trip", () => {
    const tables = emptyTables();
    tables.weekly_hours = [
      {
        id: "0b6c5f7e-2d7a-4c1e-9d55-1f0e0e7b9a01",
        starts_on: null,
        weekday: 1,
        open_time: "11:00:00",
        close_time: "21:00:00",
        created_at: "2026-09-01T12:00:00+00:00",
        updated_at: "2026-09-02T12:00:00+00:00",
      },
    ];
    tables.custom_hours = [
      {
        hours_date: "2026-10-31",
        open_time: "09:00:00",
        close_time: "17:00:00",
        created_at: "2026-09-03T12:00:00+00:00",
        updated_at: "2026-09-04T12:00:00+00:00",
      },
    ];
    tables.hour_logs = [
      {
        shift_id: "5d0c7a3e-8f4b-4c2a-a1e9-3b6f2d9c8e10",
        employee_id: "e0000000-0000-0000-0000-000000000008",
        start_time: "13:00:00",
        end_time: "19:10:00",
        note: "Stayed to unload the kiln",
        created_at: "2026-09-29T23:20:00+00:00",
        updated_at: "2026-09-29T23:25:00+00:00",
      },
    ];
    const file = buildBackupFile(tables, new Date("2026-09-29T14:05:09Z"));
    expect(file.hour_logs).toBe(tables.hour_logs);
    expect(file.weekly_hours).toBe(tables.weekly_hours);
    expect(file.custom_hours).toBe(tables.custom_hours);
    const parsed: unknown = JSON.parse(backupJson(file));
    expect(parsed).toEqual(file);
    expect(parsed).toMatchObject({
      weekly_hours: [{ starts_on: null, weekday: 1, open_time: "11:00:00", close_time: "21:00:00" }],
      custom_hours: [{ hours_date: "2026-10-31", open_time: "09:00:00", close_time: "17:00:00" }],
      hour_logs: [{ start_time: "13:00:00", end_time: "19:10:00", note: "Stayed to unload the kiln" }],
    });
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
