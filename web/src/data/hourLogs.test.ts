import { describe, expect, it, vi } from "vitest";

// The real client needs the Supabase URL and key; nothing here calls it.
vi.mock("../lib/supabase", () => ({ supabase: {} }));

const { hourLogErrorMessage, hourLogFailure } = await import("./hourLogs");

// Shaped like the PostgrestError objects supabase-js returns.
function pgError(message: string, code: string) {
  return { message, code, details: "", hint: "" };
}

describe("hourLogFailure", () => {
  it("tells apart the shifts that left the list", () => {
    expect(hourLogFailure(pgError("already_reviewed", "P0001"))).toBe("reviewed");
    expect(hourLogFailure(pgError("shift_not_over", "P0001"))).toBe("not-over");
    expect(hourLogFailure(pgError("not_found", "P0002"))).toBe("gone");
    expect(hourLogFailure(pgError("invalid_input", "22023"))).toBe("other");
    expect(hourLogFailure(new TypeError("Failed to fetch"))).toBe("other");
  });
});

describe("hourLogErrorMessage", () => {
  it("explains each refusal", () => {
    expect(hourLogErrorMessage(pgError("already_reviewed", "P0001"), "save")).toBe(
      "Your manager has already reviewed this shift in payroll, so its hours can't be changed.",
    );
    expect(hourLogErrorMessage(pgError("not_found", "P0002"), "remove")).toBe(
      "This shift was changed or removed from your schedule. The list has been refreshed.",
    );
    expect(hourLogErrorMessage(pgError("shift_not_over", "P0001"), "save")).toBe(
      "This shift hasn't ended yet. Log your hours after it ends.",
    );
    expect(hourLogErrorMessage(pgError("not_linked", "42501"), "save")).toBe(
      "Your login can't log hours. Ask your manager.",
    );
    expect(hourLogErrorMessage(pgError("employee_archived", "42501"), "save")).toBe(
      "Your login can't log hours. Ask your manager.",
    );
    expect(hourLogErrorMessage(pgError("invalid_input", "22023"), "save")).toBe("Check the times and try again.");
  });

  it("covers the connection and the sign-in", () => {
    expect(hourLogErrorMessage(new TypeError("Failed to fetch"), "save")).toBe(
      "Couldn't reach the schedule. Check your connection and try again.",
    );
    expect(hourLogErrorMessage(pgError("JWT expired", "PGRST303"), "remove")).toBe(
      "Your sign-in has expired. Sign out, then sign in again.",
    );
  });

  it("falls back by action", () => {
    expect(hourLogErrorMessage(pgError("boom", "XX000"), "save")).toBe("There was an error saving your hours.");
    expect(hourLogErrorMessage(null, "remove")).toBe("There was an error removing your hours.");
  });
});
