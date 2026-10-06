import { describe, expect, it } from "vitest";
import { employeeCardPaint } from "../features/schedule/employeeColor";
import {
  assignDistinctColors,
  EMPLOYEE_PALETTE,
  paletteColorName,
  paletteIndex,
  pickNewEmployeeColor,
} from "./employeePalette";

// The stored hexes of the first four palette colors.
const TERRACOTTA = "#7F6C50";
const SAGE = "#2B6CB0";
const MOSS = "#147C44";
const MUSTARD = "#B84A1E";

describe("EMPLOYEE_PALETTE", () => {
  it("has the 16 colors in order, each stored as its own hex", () => {
    expect(EMPLOYEE_PALETTE.map((c) => c.name)).toEqual([
      "Terracotta",
      "Sage",
      "Moss",
      "Mustard",
      "Brick",
      "Mauve",
      "Fern",
      "Mahogany",
      "Mulberry",
      "Juniper",
      "Stone",
      "Spruce",
      "Cinnamon",
      "Lichen",
      "Aubergine",
      "Bark",
    ]);
    expect(new Set(EMPLOYEE_PALETTE.map((c) => c.hex)).size).toBe(16);
    for (const { hex } of EMPLOYEE_PALETTE) expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("keeps the hexes employees' records already store", () => {
    // Changing one would turn every employee who has it into a custom color.
    expect(EMPLOYEE_PALETTE.map((c) => c.hex)).toEqual([
      "#7F6C50",
      "#2B6CB0",
      "#147C44",
      "#B84A1E",
      "#B83280",
      "#0F766E",
      "#4A5568",
      "#744210",
      "#553C9A",
      "#975A16",
      "#2C5282",
      "#5A6B2E",
      "#702459",
      "#086F83",
      "#4338CA",
      "#22543D",
    ]);
  });

  it.each(EMPLOYEE_PALETTE.map((c) => [c.name, c.hex]))("%s shows as the theme's color of that name on shift cards", (name, hex) => {
    expect(employeeCardPaint(hex)).toEqual({
      className: "day-card-shift",
      style: { "--employee": `var(--employee-${name.toLowerCase()})` },
      darkened: false,
    });
  });

  it("finds colors in any letter case", () => {
    expect(paletteIndex("#2b6cb0")).toBe(1);
    expect(paletteColorName(" #2b6cb0 ")).toBe("Sage");
    expect(paletteColorName("#123456")).toBeNull();
  });
});

describe("pickNewEmployeeColor", () => {
  it("starts with Terracotta", () => {
    expect(pickNewEmployeeColor([])).toBe(TERRACOTTA);
  });

  it("takes the first palette color nobody active uses", () => {
    expect(pickNewEmployeeColor(["#7f6c50", SAGE, MUSTARD.toLowerCase()])).toBe(MOSS);
    // Colors outside the palette don't use anything up, including #2F855A, the U3 table's lighter
    // version of Moss's stored hex.
    expect(pickNewEmployeeColor(["#123456", TERRACOTTA])).toBe(SAGE);
    expect(pickNewEmployeeColor([TERRACOTTA, SAGE, "#2F855A"])).toBe(MOSS);
  });

  it("falls back to the least-used color once all are taken", () => {
    const all = EMPLOYEE_PALETTE.map((c) => c.hex);
    expect(pickNewEmployeeColor(all)).toBe(TERRACOTTA);
    expect(pickNewEmployeeColor([...all, TERRACOTTA, SAGE])).toBe(MOSS);
  });
});

describe("assignDistinctColors", () => {
  it("gives everyone a different color when they all share one, Terracotta first", () => {
    const active = Array.from({ length: 14 }, (_, i) => ({ id: `e${i}`, color: TERRACOTTA }));
    const result = assignDistinctColors(active);
    expect(result.map((r) => r.id)).toEqual(active.map((a) => a.id));
    expect(result[0].color).toBe(TERRACOTTA);
    expect(new Set(result.map((r) => r.color.toUpperCase())).size).toBe(14);
    expect(result.map((r) => r.color)).toEqual(EMPLOYEE_PALETTE.slice(0, 14).map((c) => c.hex));
  });

  it("keeps palette colors for the first employee using them, exactly as stored", () => {
    const result = assignDistinctColors([
      { id: "a", color: "#123456" },
      { id: "b", color: "#2b6cb0" },
      { id: "c", color: "#2B6CB0" },
      { id: "d", color: TERRACOTTA },
    ]);
    expect(result).toEqual([
      { id: "a", color: MOSS },
      { id: "b", color: "#2b6cb0" },
      { id: "c", color: MUSTARD },
      { id: "d", color: TERRACOTTA },
    ]);
  });

  it("repeats the palette past 16 employees", () => {
    const active = Array.from({ length: 18 }, (_, i) => ({ id: `e${i}`, color: "#000000" }));
    const colors = assignDistinctColors(active).map((r) => r.color);
    expect(colors.slice(0, 16)).toEqual(EMPLOYEE_PALETTE.map((c) => c.hex));
    expect(colors.slice(16)).toEqual([TERRACOTTA, SAGE]);
  });

  it("changes nothing when colors are already distinct palette colors", () => {
    const active = EMPLOYEE_PALETTE.slice(3, 8).map((c, i) => ({ id: `e${i}`, color: c.hex }));
    expect(assignDistinctColors(active)).toEqual(active);
  });
});
