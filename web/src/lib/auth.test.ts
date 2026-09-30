import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));

const { emailToLogin, loginToEmail } = await import("./auth");

describe("loginToEmail and emailToLogin", () => {
  it("turns a username into its login email and back", () => {
    expect(loginToEmail(" Lexi_S ")).toBe("lexi_s@schedule.madpotter.invalid");
    expect(emailToLogin("lexi_s@schedule.madpotter.invalid")).toBe("lexi_s");
  });

  it("leaves other emails as they are", () => {
    expect(loginToEmail("Admin@Example.com")).toBe("admin@example.com");
    expect(emailToLogin("admin@example.com")).toBe("admin@example.com");
  });
});
