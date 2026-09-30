// Distinct employee colors (decision U3). This file has no imports on purpose:
// scripts/assign-colors.mjs loads it straight into Node, which strips the types but
// can't resolve TypeScript imports.

export interface PaletteColor {
  name: string;
  hex: string;
}

/**
 * Every color keeps 4.5:1 contrast with white, so shift cards show it unchanged. Each has
 * at least 5:1 on its own, because the cards' white sheen (--chip-sheen) lightens the
 * background behind the name a little. That is why Green and Orange are a shade darker
 * than the U3 table's #2F855A and #C05621, which fell to about 4.2:1 under the sheen.
 */
export const EMPLOYEE_PALETTE: readonly PaletteColor[] = [
  { name: "Clay", hex: "#7F6C50" },
  { name: "Blue", hex: "#2B6CB0" },
  { name: "Green", hex: "#147C44" },
  { name: "Orange", hex: "#B84A1E" },
  { name: "Pink", hex: "#B83280" },
  { name: "Teal", hex: "#0F766E" },
  { name: "Slate", hex: "#4A5568" },
  { name: "Brown", hex: "#744210" },
  { name: "Purple", hex: "#553C9A" },
  { name: "Ochre", hex: "#975A16" },
  { name: "Navy", hex: "#2C5282" },
  { name: "Olive", hex: "#5A6B2E" },
  { name: "Plum", hex: "#702459" },
  { name: "Cyan", hex: "#086F83" },
  { name: "Indigo", hex: "#4338CA" },
  { name: "Forest", hex: "#22543D" },
];

/** The palette position of a stored color (any letter case), or -1. */
export function paletteIndex(color: string): number {
  const wanted = color.trim().toUpperCase();
  return EMPLOYEE_PALETTE.findIndex((entry) => entry.hex === wanted);
}

/** "Blue" for "#2b6cb0"; null for colors outside the palette. */
export function paletteColorName(color: string): string | null {
  const index = paletteIndex(color);
  return index === -1 ? null : EMPLOYEE_PALETTE[index].name;
}

// The first of the least-used colors, so unused colors go first, in palette order.
function leastUsed(counts: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i] < counts[best]) best = i;
  }
  return best;
}

function paletteCounts(colors: readonly string[]): number[] {
  const counts = EMPLOYEE_PALETTE.map(() => 0);
  for (const color of colors) {
    const index = paletteIndex(color);
    if (index !== -1) counts[index] += 1;
  }
  return counts;
}

/**
 * The color for a new employee (E7): the first palette color no active employee uses,
 * or, when all are taken, the one used least.
 */
export function pickNewEmployeeColor(activeColors: readonly string[]): string {
  return EMPLOYEE_PALETTE[leastUsed(paletteCounts(activeColors))].hex;
}

/**
 * One color per active employee, in the order given (display order). The first employee
 * using a palette color keeps it, stored exactly as it is. Everyone else (duplicates and
 * colors outside the palette) gets the next unused palette color; past 16 employees the
 * palette repeats, least-used first.
 */
export function assignDistinctColors(
  active: readonly { id: string; color: string }[],
): { id: string; color: string }[] {
  const counts = EMPLOYEE_PALETTE.map(() => 0);
  const kept = active.map((employee) => {
    const index = paletteIndex(employee.color);
    if (index === -1 || counts[index] > 0) return null;
    counts[index] = 1;
    return employee.color;
  });
  return active.map((employee, i) => {
    const color = kept[i];
    if (color !== null) return { id: employee.id, color };
    const index = leastUsed(counts);
    counts[index] += 1;
    return { id: employee.id, color: EMPLOYEE_PALETTE[index].hex };
  });
}
