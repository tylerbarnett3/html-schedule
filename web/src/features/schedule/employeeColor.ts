import { DEFAULT_EMPLOYEE_COLOR } from "../../lib/types";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The employee's color when it is a usable hex value, else the default clay brown. */
export function employeeColor(color: string | null | undefined): string {
  const trimmed = color?.trim() ?? "";
  return HEX_COLOR.test(trimmed) ? trimmed : DEFAULT_EMPLOYEE_COLOR;
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

const WHITE = "#ffffff";
/** Same as --chip-pending-text; the .day-card-shift-light class uses it. */
export const DARK_CARD_TEXT = "#24190f";
/** WCAG AA for normal-size text; card names and labels are 10-14px. */
export const MIN_TEXT_CONTRAST = 4.5;

export interface ShiftCardColors {
  background: string;
  darkText: boolean;
}

/**
 * Colors for a shift card. White text as on the old page when it reads well on the
 * employee's color, dark text when that reads well instead, and for mid-tone colors where
 * neither does, the color darkened just enough for white text. Expects a value from
 * employeeColor().
 */
export function shiftCardColors(hex: string): ShiftCardColors {
  if (contrastRatio(hex, WHITE) >= MIN_TEXT_CONTRAST) return { background: hex, darkText: false };
  if (contrastRatio(hex, DARK_CARD_TEXT) >= MIN_TEXT_CONTRAST) return { background: hex, darkText: true };

  const rgb = toRgb(hex);
  for (let scale = 0.99; scale > 0; scale -= 0.01) {
    const darker = toHex(rgb.map((channel) => Math.round(channel * scale)) as Rgb);
    if (contrastRatio(darker, WHITE) >= MIN_TEXT_CONTRAST) return { background: darker, darkText: false };
  }
  return { background: "#000000", darkText: false };
}
