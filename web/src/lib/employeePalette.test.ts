import { describe, expect, it } from "vitest";
import { contrastRatio, employeeColor, shiftCardColors } from "../features/schedule/employeeColor";
import {
  assignDistinctColors,
  EMPLOYEE_PALETTE,
  paletteColorName,
  paletteIndex,
  pickNewEmployeeColor,
} from "./employeePalette";

const CLAY = "#7F6C50";
const BLUE = "#2B6CB0";
const GREEN = "#147C44";
const ORANGE = "#B84A1E";

describe("EMPLOYEE_PALETTE", () => {
  it("has the 16 colors from decision U3, in order", () => {
    expect(EMPLOYEE_PALETTE.map((c) => c.name)).toEqual([
      "Clay",
      "Blue",
      "Green",
      "Orange",
      "Pink",
      "Teal",
      "Slate",
      "Brown",
      "Purple",
      "Ochre",
      "Navy",
      "Olive",
      "Plum",
      "Cyan",
      "Indigo",
      "Forest",
    ]);
    expect(new Set(EMPLOYEE_PALETTE.map((c) => c.hex)).size).toBe(16);
    for (const { hex } of EMPLOYEE_PALETTE) expect(hex).toMatch(/^#[0-9A-F]{6}$/);
  });

  it.each(EMPLOYEE_PALETTE.map((c) => [c.name, c.hex]))("%s keeps white text readable and unchanged", (_name, hex) => {
    expect(contrastRatio(hex, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(shiftCardColors(employeeColor(hex))).toEqual({ background: hex, darkText: false });
    // Margin for the cards' white sheen, which lightens the background behind the name.
    expect(contrastRatio(hex, "#ffffff")).toBeGreaterThanOrEqual(5);
  });

  it("finds colors in any letter case", () => {
    expect(paletteIndex("#2b6cb0")).toBe(1);
    expect(paletteColorName(" #2b6cb0 ")).toBe("Blue");
    expect(paletteColorName("#123456")).toBeNull();
  });
});

describe("pickNewEmployeeColor", () => {
  it("starts with Clay", () => {
    expect(pickNewEmployeeColor([])).toBe(CLAY);
  });

  it("takes the first palette color nobody active uses", () => {
    expect(pickNewEmployeeColor(["#7f6c50", BLUE, ORANGE.toLowerCase()])).toBe(GREEN);
    // Colors outside the palette don't use anything up, including Green's old shade.
    expect(pickNewEmployeeColor(["#123456", CLAY])).toBe(BLUE);
    expect(pickNewEmployeeColor([CLAY, BLUE, "#2F855A"])).toBe(GREEN);
  });

  it("falls back to the least-used color once all are taken", () => {
    const all = EMPLOYEE_PALETTE.map((c) => c.hex);
    expect(pickNewEmployeeColor(all)).toBe(CLAY);
    expect(pickNewEmployeeColor([...all, CLAY, BLUE])).toBe(GREEN);
  });
});

describe("assignDistinctColors", () => {
  it("gives everyone a different color when they all share one, Clay first", () => {
    const active = Array.from({ length: 14 }, (_, i) => ({ id: `e${i}`, color: CLAY }));
    const result = assignDistinctColors(active);
    expect(result.map((r) => r.id)).toEqual(active.map((a) => a.id));
    expect(result[0].color).toBe(CLAY);
    expect(new Set(result.map((r) => r.color.toUpperCase())).size).toBe(14);
    expect(result.map((r) => r.color)).toEqual(EMPLOYEE_PALETTE.slice(0, 14).map((c) => c.hex));
  });

  it("keeps palette colors for the first employee using them, exactly as stored", () => {
    const result = assignDistinctColors([
      { id: "a", color: "#123456" },
      { id: "b", color: "#2b6cb0" },
      { id: "c", color: "#2B6CB0" },
      { id: "d", color: CLAY },
    ]);
    expect(result).toEqual([
      { id: "a", color: GREEN },
      { id: "b", color: "#2b6cb0" },
      { id: "c", color: ORANGE },
      { id: "d", color: CLAY },
    ]);
  });

  it("repeats the palette past 16 employees", () => {
    const active = Array.from({ length: 18 }, (_, i) => ({ id: `e${i}`, color: "#000000" }));
    const colors = assignDistinctColors(active).map((r) => r.color);
    expect(colors.slice(0, 16)).toEqual(EMPLOYEE_PALETTE.map((c) => c.hex));
    expect(colors.slice(16)).toEqual([CLAY, BLUE]);
  });

  it("changes nothing when colors are already distinct palette colors", () => {
    const active = EMPLOYEE_PALETTE.slice(3, 8).map((c, i) => ({ id: `e${i}`, color: c.hex }));
    expect(assignDistinctColors(active)).toEqual(active);
  });
});
