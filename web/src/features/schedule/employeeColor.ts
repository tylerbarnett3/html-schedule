import type { CSSProperties } from "react";
import { paletteColorName } from "../../lib/employeePalette";
import { DEFAULT_EMPLOYEE_COLOR } from "../../lib/types";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The employee's color when it is a usable hex value, else the default (Terracotta's stored hex). */
export function employeeColor(color: string | null | undefined): string {
  const trimmed = color?.trim() ?? "";
  return HEX_COLOR.test(trimmed) ? trimmed : DEFAULT_EMPLOYEE_COLOR;
}

/**
 * The color shown for a palette color, e.g. var(--employee-sage) for #2B6CB0: roles.css defines
 * the 16 (colors.test.ts checks them). Null for a custom color.
 */
export function themedPaletteColor(color: string): string | null {
  const name = paletteColorName(color);
  return name === null ? null : `var(--employee-${name.toLowerCase()})`;
}

/** An employee's dot or swatch: a palette color as the theme shows it, a custom color as stored. */
export function employeeFill(color: string | null | undefined): string {
  const hex = employeeColor(color);
  return themedPaletteColor(hex) ?? hex;
}

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(toRgb(a)), relativeLuminance(toRgb(b))].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// The two text colors a custom color's solid card can take come from the theme: the light card
// text (--color-chip-text) and the card ink (--color-card-ink). This file doesn't read the
// theme, so it decides against limits the theme keeps instead (colors.test.ts checks them):
// its light text is at least as light as LIGHT_CARD_TEXT, and its ink at least as dark as
// CARD_INK. Text that keeps 4.5:1 against the limit keeps it on the page too.

/** The darkest light card text the theme may use (Earth's paper, #fbf8f2, is a little lighter). */
export const LIGHT_CARD_TEXT = "#faf4ed";
/**
 * The lightest card ink the theme may use (Earth's ink, #201a13, is darker), dark enough for
 * mid-tone colors such as #E07A5F (5.03:1).
 */
export const CARD_INK = "#282539";
/** WCAG AA for normal-size text; card names and labels are 10-14px. */
export const MIN_TEXT_CONTRAST = 4.5;

export interface CustomCardColors {
  /** The color as picked, or darkened when neither text color keeps 4.5:1 on it. */
  background: string;
  /** True for the dark card ink, false for the light card text. */
  ink: boolean;
}

/**
 * A custom color's solid card: the color as picked with light text when that reads well (as on
 * the old page), with the dark ink when that reads well instead, and for mid-tone colors where
 * neither does, the color darkened just enough for light text. Expects a value from
 * employeeColor().
 */
export function customCardColors(hex: string): CustomCardColors {
  if (contrastRatio(hex, LIGHT_CARD_TEXT) >= MIN_TEXT_CONTRAST) return { background: hex, ink: false };
  if (contrastRatio(hex, CARD_INK) >= MIN_TEXT_CONTRAST) return { background: hex, ink: true };

  const rgb = toRgb(hex);
  for (let scale = 0.99; scale > 0; scale -= 0.01) {
    const darker = toHex(rgb.map((channel) => Math.round(channel * scale)) as Rgb);
    if (contrastRatio(darker, LIGHT_CARD_TEXT) >= MIN_TEXT_CONTRAST) return { background: darker, ink: false };
  }
  return { background: "#000000", ink: false };
}

export interface EmployeeCardPaint {
  /** day-card-shift, plus day-card-custom (and day-card-custom-ink) for a custom color. */
  className: string;
  /**
   * --employee: a palette color's role (--employee-sage, ...), or a custom color as picked; for
   * a custom color also --custom-solid, its solid fill (see customCardColors).
   */
  style: CSSProperties;
  /** A custom color's solid fill is darker than picked, so its text keeps 4.5:1. */
  darkened: boolean;
}

/**
 * How a shift card (and the color picker's preview of one) gets its employee's color.
 * DayCard.css draws the rest from --employee: solid, flat, with light text, and for a custom
 * color the fill and text chosen here.
 */
export function employeeCardPaint(color: string | null | undefined): EmployeeCardPaint {
  const hex = employeeColor(color);
  const themed = themedPaletteColor(hex);
  if (themed !== null) {
    return { className: "day-card-shift", style: { "--employee": themed } as CSSProperties, darkened: false };
  }
  const { background, ink } = customCardColors(hex);
  return {
    className: ink ? "day-card-shift day-card-custom day-card-custom-ink" : "day-card-shift day-card-custom",
    style: { "--employee": hex, "--custom-solid": background } as CSSProperties,
    darkened: background !== hex,
  };
}
