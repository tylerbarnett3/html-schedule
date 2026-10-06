import { describe, expect, it } from "vitest";
import { DEFAULT_EMPLOYEE_COLOR } from "../../lib/types";
import {
  CARD_INK,
  contrastRatio,
  customCardColors,
  employeeCardPaint,
  employeeColor,
  employeeFill,
  LIGHT_CARD_TEXT,
  MIN_TEXT_CONTRAST,
  themedPaletteColor,
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

/** The contrast of a custom color's solid card text, against the limits it is decided with. */
function textContrast(hex: string): number {
  const { background, ink } = customCardColors(hex);
  return contrastRatio(background, ink ? CARD_INK : LIGHT_CARD_TEXT);
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

describe("customCardColors", () => {
  it.each(SEEDED_COLORS)("gives %s card text at least 4.5:1", (hex) => {
    expect(textContrast(hex)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("keeps the color and light text when light text reads well", () => {
    expect(customCardColors("#4A5568")).toEqual({ background: "#4A5568", ink: false });
    expect(customCardColors("#2B6CB0")).toEqual({ background: "#2B6CB0", ink: false });
  });

  it("keeps the color and takes the ink on light and mid-tone colors", () => {
    expect(customCardColors("#fde68a")).toEqual({ background: "#fde68a", ink: true });
    expect(customCardColors("#b2f5ea")).toEqual({ background: "#b2f5ea", ink: true });
    // Grace's color in the mock: light text 2.70, the ink 5.03.
    expect(customCardColors("#E07A5F")).toEqual({ background: "#E07A5F", ink: true });
  });

  it("darkens a color just enough for light text only when neither text reads well", () => {
    // Light text 3.91, the ink 3.48 on this pink.
    const { background, ink } = customCardColors("#D53F8C");
    expect(ink).toBe(false);
    expect(background).not.toBe("#D53F8C");
    expect(contrastRatio(background, LIGHT_CARD_TEXT)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(background, LIGHT_CARD_TEXT)).toBeLessThan(4.8);
  });

  it("works on any valid employee color", () => {
    for (let gray = 0; gray <= 255; gray += 5) {
      const channel = gray.toString(16).padStart(2, "0");
      expect(textContrast(`#${channel}${channel}${channel}`)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
    expect(textContrast(employeeColor("not a color"))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(textContrast(employeeColor("#f0f"))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it("decides against a light text and an ink that keep 4.5:1 between them", () => {
    expect(contrastRatio(LIGHT_CARD_TEXT, CARD_INK)).toBeGreaterThan(MIN_TEXT_CONTRAST);
  });
});

describe("palette colors", () => {
  it("show as the theme's color of that name, in any letter case", () => {
    expect(themedPaletteColor("#2B6CB0")).toBe("var(--employee-sage)");
    expect(themedPaletteColor("#2b6cb0")).toBe("var(--employee-sage)");
    expect(themedPaletteColor("#22543D")).toBe("var(--employee-bark)");
    expect(themedPaletteColor("#2B6CB1")).toBeNull();
  });

  it("give shift cards the theme's color as --employee, and leave the rest to DayCard.css", () => {
    expect(employeeCardPaint("#0f766e")).toEqual({
      className: "day-card-shift",
      style: { "--employee": "var(--employee-mauve)" },
      darkened: false,
    });
    // An unusable color falls back to the default, Terracotta.
    expect(employeeCardPaint("not a color").style).toEqual({ "--employee": "var(--employee-terracotta)" });
    expect(employeeCardPaint(null).style).toEqual({ "--employee": "var(--employee-terracotta)" });
  });

  it("fill dots and swatches", () => {
    expect(employeeFill("#B83280")).toBe("var(--employee-brick)");
    expect(employeeFill(undefined)).toBe("var(--employee-terracotta)");
  });
});

describe("custom colors", () => {
  it("give shift cards the color as picked, and its solid fill and text", () => {
    expect(employeeCardPaint(" #2B6CB1 ")).toEqual({
      className: "day-card-shift day-card-custom",
      style: { "--employee": "#2B6CB1", "--custom-solid": "#2B6CB1" },
      darkened: false,
    });
    expect(employeeCardPaint("#E07A5F")).toEqual({
      className: "day-card-shift day-card-custom day-card-custom-ink",
      style: { "--employee": "#E07A5F", "--custom-solid": "#E07A5F" },
      darkened: false,
    });
  });

  it("keep the picked color as --employee when the solid fill is darkened", () => {
    const paint = employeeCardPaint("#D53F8C");
    expect(paint.className).toBe("day-card-shift day-card-custom");
    expect(paint.darkened).toBe(true);
    expect(paint.style).toEqual({ "--employee": "#D53F8C", "--custom-solid": customCardColors("#D53F8C").background });
  });

  it("fill dots and swatches as stored", () => {
    expect(employeeFill(" #9F7AEA ")).toBe("#9F7AEA");
    expect(employeeFill("#f0f")).toBe("#f0f");
  });
});
