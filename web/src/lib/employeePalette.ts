// Distinct employee colors (decision U3). This file has no imports on purpose:
// scripts/assign-colors.mjs loads it straight into Node, which strips the types but
// can't resolve TypeScript imports.

export interface PaletteColor {
  name: string;
  hex: string;
}

/**
 * The 16 employee colors, in the order new employees get them. The hex is what an employee's
 * record stores: the original palette's color, kept as the entry's identity so stored colors
 * still match. The color shown comes from the theme instead: roles.css defines each one as
 * --employee-<name in lowercase> (employeeColor.ts), which shift cards, dots and swatches use.
 */
export const EMPLOYEE_PALETTE: readonly PaletteColor[] = [
  { name: "Terracotta", hex: "#7F6C50" },
  { name: "Sage", hex: "#2B6CB0" },
  { name: "Moss", hex: "#147C44" },
  { name: "Mustard", hex: "#B84A1E" },
  { name: "Brick", hex: "#B83280" },
  { name: "Mauve", hex: "#0F766E" },
  { name: "Fern", hex: "#4A5568" },
  { name: "Mahogany", hex: "#744210" },
  { name: "Mulberry", hex: "#553C9A" },
  { name: "Juniper", hex: "#975A16" },
  { name: "Stone", hex: "#2C5282" },
  { name: "Spruce", hex: "#5A6B2E" },
  { name: "Cinnamon", hex: "#702459" },
  { name: "Lichen", hex: "#086F83" },
  { name: "Aubergine", hex: "#4338CA" },
  { name: "Bark", hex: "#22543D" },
];

/** The palette position of a stored color (any letter case), or -1. */
export function paletteIndex(color: string): number {
  const wanted = color.trim().toUpperCase();
  return EMPLOYEE_PALETTE.findIndex((entry) => entry.hex === wanted);
}

/** "Sage" for "#2b6cb0"; null for colors outside the palette. */
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
