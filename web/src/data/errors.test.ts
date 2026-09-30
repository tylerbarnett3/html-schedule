import { describe, expect, it } from "vitest";
import { adminErrorCode, adminErrorMessage, errorFields, type AdminErrorCode } from "./errors";

// Shaped like the PostgrestError objects supabase-js returns.
function pgError(message: string, code: string, details = "") {
  return { message, code, details, hint: "" };
}

describe("adminErrorCode", () => {
  it.each<[string, string, AdminErrorCode]>([
    ["not_admin", "42501", "not_admin"],
    ["closed_day", "P0001", "closed_day"],
    ["pending_request", "P0001", "pending_request"],
    ["day_off_overlap", "23P01", "day_off_overlap"],
    ["request_locked", "P0001", "request_locked"],
    ["not_editable", "P0001", "not_editable"],
    ["not_found", "P0002", "not_found"],
    ["request_not_pending", "P0002", "request_not_pending"],
    ["undo_stale", "P0001", "undo_stale"],
    ["duplicate_name", "23505", "duplicate_name"],
    ["invalid_input", "22023", "invalid_input"],
    ["hours_in_effect", "P0001", "hours_in_effect"],
  ])("reads the %s token before its SQLSTATE", (message, code, expected) => {
    expect(adminErrorCode(pgError(message, code))).toBe(expected);
  });

  it("falls back to the SQLSTATE for constraint errors", () => {
    expect(
      adminErrorCode(pgError('duplicate key value violates unique constraint "shifts_unique_slot"', "23505")),
    ).toBe("duplicate");
    expect(
      adminErrorCode(pgError('new row for relation "shifts" violates check constraint "shifts_check"', "23514")),
    ).toBe("check_failed");
    expect(
      adminErrorCode(
        pgError('conflicting key value violates exclusion constraint "employee_rates_no_overlap"', "23P01"),
      ),
    ).toBe("overlap");
    expect(adminErrorCode(pgError('new row violates row-level security policy for table "shifts"', "42501"))).toBe(
      "not_admin",
    );
  });

  it("recognizes network failures in every browser's wording", () => {
    expect(adminErrorCode(new TypeError("Failed to fetch"))).toBe("network");
    expect(adminErrorCode(pgError("TypeError: Failed to fetch", ""))).toBe("network");
    expect(adminErrorCode(new TypeError("NetworkError when attempting to fetch resource."))).toBe("network");
    expect(adminErrorCode(new TypeError("Load failed"))).toBe("network");
  });

  it("recognizes an expired sign-in", () => {
    expect(adminErrorCode(pgError("JWT expired", "PGRST301"))).toBe("auth_expired");
    expect(adminErrorCode(pgError("No suitable key or wrong key type", "PGRST301"))).toBe("auth_expired");
    expect(adminErrorCode(pgError("JWT expired", "PGRST303"))).toBe("auth_expired");
  });

  it("gives unknown for anything else", () => {
    expect(adminErrorCode(pgError("something broke", "XX000"))).toBe("unknown");
    expect(adminErrorCode(new Error("Unexpected response from the server."))).toBe("unknown");
    expect(adminErrorCode(null)).toBe("unknown");
    expect(adminErrorCode("closed_day")).toBe("unknown");
  });
});

describe("adminErrorMessage", () => {
  const fallback = "Couldn't save changes. Please try again.";

  it("uses the shared wording", () => {
    expect(adminErrorMessage(new TypeError("Failed to fetch"), fallback)).toBe(
      "Couldn't reach the schedule. Check your connection and try again.",
    );
    expect(adminErrorMessage(pgError("JWT expired", "PGRST301"), fallback)).toBe(
      "Your sign-in has expired. Sign out, then sign in again.",
    );
    expect(adminErrorMessage(pgError("not_admin", "42501"), fallback)).toBe("Only an admin can make this change.");
    expect(adminErrorMessage(pgError("not_found", "P0002"), fallback)).toBe(
      "This item was changed or removed. The page has been refreshed.",
    );
    expect(adminErrorMessage(pgError("request_not_pending", "P0002"), fallback)).toBe(
      "This request was already reviewed or removed.",
    );
    expect(adminErrorMessage(pgError("undo_stale", "P0001"), fallback)).toBe(
      "This change can't be undone because the schedule changed since.",
    );
  });

  it("leaves the rest to the caller", () => {
    expect(adminErrorMessage(pgError("closed_day", "P0001", "2026-10-09"), fallback)).toBe(fallback);
    expect(adminErrorMessage(pgError("hours_in_effect", "P0001", "2026-08-01"), fallback)).toBe(fallback);
    expect(adminErrorMessage(pgError("duplicate key", "23505"), fallback)).toBe(fallback);
    expect(adminErrorMessage(undefined, fallback)).toBe(fallback);
  });
});

describe("errorFields", () => {
  it("reads message, code and details, or empty strings", () => {
    expect(errorFields(pgError("pending_request", "P0001", '{"period": "morning"}'))).toEqual({
      message: "pending_request",
      code: "P0001",
      details: '{"period": "morning"}',
    });
    expect(errorFields(new Error("boom"))).toEqual({ message: "boom", code: "", details: "" });
    expect(errorFields(42)).toEqual({ message: "", code: "", details: "" });
  });
});
