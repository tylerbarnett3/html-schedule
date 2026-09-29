import { describe, expect, it } from "vitest";
import { DEFAULT_EMPLOYEE_COLOR } from "../../lib/types";
import {
  contrastRatio,
  DARK_CARD_TEXT,
  employeeColor,
  MIN_TEXT_CONTRAST,
  shiftCardColors,
} from "./employeeColor";

// Every color in supabase/seed.sql, plus the default.
const SEEDED_COLORS = [
  "#9F7AEA",
  "#319795",
  "#B7791F",
  "#D53F8C",
  "#2F855A",
  "#C05621",
  "#7F6C50",
  "#4A5568",
  "#2B6CB0",
  "#9C4221",
  DEFAULT_EMPLOYEE_COLOR,
];

function textContrast(hex: string): number {
  const { background, darkText } = shiftCardColors(hex);
  return contrastRatio(background, darkText ? DARK_CARD_TEXT : "#ffffff");
}

describe("contrastRatio", () => {
  it("matches the WCAG formula", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(contrastRatio("#ffffff", "#2B6CB0")).toBeCloseTo(5.42, 2);
    expect(contrastRatio("#2B6CB0", "#ffffff")).toBeCloseTo(5.42, 2);
  });

  it("reads 3-digit hex", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 5);
  });
});

describe("shiftCardColors", () => {
  it.each(SEEDED_COLORS)("gives %s card text at least 4.5:1", (hex) => {
    expect(textContrast(hex)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("keeps white text and the color when white reads well", () => {
    expect(shiftCardColors("#4A5568")).toEqual({ background: "#4A5568", darkText: false });
    expect(shiftCardColors("#2F855A")).toEqual({ background: "#2F855A", darkText: false });
  });

  it("switches to dark text on light colors", () => {
    expect(shiftCardColors("#9F7AEA")).toEqual({ background: "#9F7AEA", darkText: true });
    expect(shiftCardColors("#319795")).toEqual({ background: "#319795", darkText: true });
    expect(shiftCardColors("#fde68a")).toEqual({ background: "#fde68a", darkText: true });
  });

  it("darkens a mid-tone color just enough for white text", () => {
    // Neither white (4.27) nor dark text (4.03) reaches 4.5 on this pink.
    const { background, darkText } = shiftCardColors("#D53F8C");
    expect(darkText).toBe(false);
    expect(background).not.toBe("#D53F8C");
    expect(contrastRatio(background, "#ffffff")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(background, "#ffffff")).toBeLessThan(4.8);
  });

  it("works on any valid employee color", () => {
    for (let gray = 0; gray <= 255; gray += 5) {
      const channel = gray.toString(16).padStart(2, "0");
      expect(textContrast(`#${channel}${channel}${channel}`)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
    expect(textContrast(employeeColor("not a color"))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(textContrast(employeeColor("#f0f"))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});
