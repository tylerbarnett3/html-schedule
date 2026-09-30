import { describe, expect, it } from "vitest";
import type { Json } from "./database.types";
import {
  emptyChange,
  isEmptyChange,
  parseScheduleChange,
  reopenChange,
  toChangeJson,
  undoableCloseChange,
  type ScheduleChange,
} from "./scheduleChange";

const shift = {
  id: "5a1f0000-0000-4000-8000-000000000001",
  employee_id: "00000000-0000-4000-8000-000000000001",
  shift_date: "2026-10-05",
  start_time: "09:30:00",
  end_time: "17:00:00",
  created_at: "2026-09-28T12:00:00.123456+00:00",
  updated_at: "2026-09-29T14:03:12.123456+00:00",
  wix_id: null,
};

const timeOff = {
  id: "7f0f0000-0000-4000-8000-000000000002",
  employee_id: "00000000-0000-4000-8000-000000000002",
  off_date: "2026-10-06",
  period: "morning",
  status: "approved",
  source: "request",
  requested_at: "2026-09-20T10:00:00+00:00",
  requested_by: "00000000-0000-4000-8000-00000000b002",
  reviewed_at: null,
  created_at: "2026-09-20T10:00:00+00:00",
  updated_at: "2026-09-29T15:00:00.5+00:00",
  wix_id: "wix-1",
};

// What admin_update_day_off plus a covered shift deletion sends back.
const sample: Json = {
  made_at: "2026-09-29T15:05:00+00:00",
  inserted: { shifts: [shift], time_off: [], closed_days: ["2026-10-09"] },
  updated: {
    shifts: [],
    time_off: [{ before: timeOff, after: { ...timeOff, off_date: "2026-10-07", updated_at: "2026-09-29T15:05:00+00:00" } }],
  },
  deleted: {
    shifts: [{ ...shift, id: "5a1f0000-0000-4000-8000-000000000003" }],
    time_off: [timeOff],
    closed_days: ["2026-10-30"],
    actual_links: [{ actual_id: "ac000000-0000-4000-8000-000000000001", shift_id: "5a1f0000-0000-4000-8000-000000000003" }],
  },
};

function emptyWire(): { [key: string]: Json } {
  return JSON.parse(JSON.stringify(toChangeJson(emptyChange()))) as { [key: string]: Json };
}

function withoutKey(value: Json, path: readonly string[]): Json {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  let target = copy as Record<string, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  delete target[path[path.length - 1]];
  return copy as Json;
}

function replaced(value: Json, path: readonly string[], next: unknown): Json {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  let target = copy as Record<string, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path[path.length - 1]] = next;
  return copy as Json;
}

describe("parseScheduleChange", () => {
  it("reads a valid change and keeps rows exactly as sent", () => {
    const change = parseScheduleChange(sample);
    expect(change.inserted.shifts).toEqual([shift]);
    expect(change.inserted.closed_days).toEqual(["2026-10-09"]);
    expect(change.updated.time_off[0].before).toEqual(timeOff);
    expect(change.updated.time_off[0].after.off_date).toBe("2026-10-07");
    expect(change.deleted.time_off[0].wix_id).toBe("wix-1");
    expect(change.deleted.time_off[0].updated_at).toBe("2026-09-29T15:00:00.5+00:00");
    expect(change.deleted.actual_links).toEqual([
      { actual_id: "ac000000-0000-4000-8000-000000000001", shift_id: "5a1f0000-0000-4000-8000-000000000003" },
    ]);
  });

  it("reads the empty change", () => {
    const change = parseScheduleChange({ ...emptyWire(), made_at: "2026-09-29T15:05:00+00:00" });
    expect(isEmptyChange(change)).toBe(true);
    expect(change.made_at).toBe("2026-09-29T15:05:00+00:00");
  });

  it("rejects a change without the time it was made", () => {
    expect(() => parseScheduleChange(withoutKey(sample, ["made_at"]))).toThrow("Unexpected response from the server.");
    expect(() => parseScheduleChange(emptyWire())).toThrow("Unexpected response from the server.");
  });

  it.each([
    [["inserted"]],
    [["updated"]],
    [["deleted"]],
    [["inserted", "shifts"]],
    [["inserted", "closed_days"]],
    [["updated", "time_off"]],
    [["deleted", "actual_links"]],
  ])("rejects a change missing %j", (path) => {
    expect(() => parseScheduleChange(withoutKey(sample, path))).toThrow("Unexpected response from the server.");
  });

  it("rejects lists that aren't arrays", () => {
    expect(() => parseScheduleChange(replaced(sample, ["inserted", "shifts"], {}))).toThrow(
      "Unexpected response from the server.",
    );
    expect(() => parseScheduleChange(replaced(sample, ["deleted", "closed_days"], "2026-10-30"))).toThrow(
      "Unexpected response from the server.",
    );
    expect(() => parseScheduleChange(replaced(sample, ["updated", "shifts"], null))).toThrow(
      "Unexpected response from the server.",
    );
  });

  it("rejects rows without string ids and bad dates", () => {
    expect(() => parseScheduleChange(replaced(sample, ["inserted", "shifts"], [{ ...shift, id: 7 }]))).toThrow(
      "Unexpected response from the server.",
    );
    expect(() => parseScheduleChange(replaced(sample, ["deleted", "time_off"], [{ ...timeOff, id: null }]))).toThrow(
      "Unexpected response from the server.",
    );
    expect(() =>
      parseScheduleChange(replaced(sample, ["deleted", "actual_links"], [{ actual_id: "a", shift_id: null }])),
    ).toThrow("Unexpected response from the server.");
    expect(() =>
      parseScheduleChange(replaced(sample, ["updated", "time_off"], [{ before: timeOff, after: null }])),
    ).toThrow("Unexpected response from the server.");
    expect(() => parseScheduleChange(replaced(sample, ["inserted", "closed_days"], ["10/09/2026"]))).toThrow(
      "Unexpected response from the server.",
    );
  });

  it("rejects things that aren't a change at all", () => {
    for (const data of [null, "ok", 3, [], { approved_ids: [] }]) {
      expect(() => parseScheduleChange(data)).toThrow("Unexpected response from the server.");
    }
  });
});

describe("toChangeJson", () => {
  it("round-trips through parseScheduleChange unchanged", () => {
    const change = parseScheduleChange(sample);
    const json = toChangeJson(change);
    expect(json).toEqual(sample);
    expect(parseScheduleChange(JSON.parse(JSON.stringify(json)) as Json)).toEqual(change);
  });
});

describe("isEmptyChange and reopenChange", () => {
  it("sees any list with an entry as a change", () => {
    expect(isEmptyChange(emptyChange())).toBe(true);
    const change: ScheduleChange = emptyChange();
    change.deleted.actual_links.push({ actual_id: "a", shift_id: "s" });
    expect(isEmptyChange(change)).toBe(false);
  });

  it("builds a reopen change that undo closes again", () => {
    const dates = ["2026-10-09", "2026-10-30"];
    const change = reopenChange(dates);
    expect(change.deleted.closed_days).toEqual(dates);
    expect(change.deleted.closed_days).not.toBe(dates);
    expect(isEmptyChange(change)).toBe(false);
    expect(isEmptyChange(reopenChange([]))).toBe(true);
    expect(toChangeJson(change)).toEqual({
      made_at: null,
      inserted: { shifts: [], time_off: [], closed_days: [] },
      updated: { shifts: [], time_off: [] },
      deleted: { shifts: [], time_off: [], closed_days: dates, actual_links: [] },
    });
  });
});

describe("undoableCloseChange", () => {
  const closing = (): ScheduleChange => {
    const change = emptyChange();
    change.made_at = "2026-09-29T15:05:00+00:00";
    change.inserted.closed_days = ["2026-10-05"];
    const kept = { ...shift, id: "5a1f0000-0000-4000-8000-00000000000a" };
    const cleared = { ...shift, id: "5a1f0000-0000-4000-8000-00000000000b", shift_date: "2026-10-06" };
    change.deleted.shifts = [kept, cleared];
    const dayOff = parseScheduleChange(sample).deleted.time_off[0];
    change.deleted.time_off = [
      { ...dayOff, off_date: "2026-10-05" },
      { ...dayOff, id: "7f0f0000-0000-4000-8000-00000000000c", off_date: "2026-10-06" },
    ];
    change.deleted.actual_links = [
      { actual_id: "ac000000-0000-4000-8000-00000000000a", shift_id: kept.id },
      { actual_id: "ac000000-0000-4000-8000-00000000000b", shift_id: cleared.id },
    ];
    return change;
  };

  it("keeps only what came off the days it newly closed", () => {
    const change = undoableCloseChange(closing());
    expect(change.made_at).toBe("2026-09-29T15:05:00+00:00");
    expect(change.inserted.closed_days).toEqual(["2026-10-05"]);
    expect(change.deleted.shifts.map((s) => s.id)).toEqual(["5a1f0000-0000-4000-8000-00000000000a"]);
    expect(change.deleted.time_off.map((t) => t.off_date)).toEqual(["2026-10-05"]);
    expect(change.deleted.actual_links.map((l) => l.actual_id)).toEqual(["ac000000-0000-4000-8000-00000000000a"]);
  });

  it("leaves nothing to undo when every day was closed already", () => {
    const change = closing();
    change.inserted.closed_days = [];
    expect(isEmptyChange(undoableCloseChange(change))).toBe(true);
  });
});
