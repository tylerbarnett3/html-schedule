import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Import-free, so it loads under this file's Node module settings (tsconfig.node.json).
import { EMPLOYEE_PALETTE } from "../lib/employeePalette.ts";

// Guards the color setup: a theme file in themes/ is a palette, roles.css turns it into color
// roles, and every other stylesheet and script paints with roles only.

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The 16 ANSI slots plus background and text: the terminal palette format of Nebula's themes. */
const ANSI_PALETTE = [
  "--color-black",
  "--color-red",
  "--color-green",
  "--color-yellow",
  "--color-blue",
  "--color-magenta",
  "--color-cyan",
  "--color-white",
  "--color-bright-black",
  "--color-bright-red",
  "--color-bright-green",
  "--color-bright-yellow",
  "--color-bright-blue",
  "--color-bright-magenta",
  "--color-bright-cyan",
  "--color-bright-white",
  "--terminal-background",
  "--terminal-foreground",
];

/** The levels the theme adds to it (see themes/earth.css). */
const PALETTE_LEVELS = ["--terminal-surface", "--terminal-ink"];

/** The palette: everything roles.css reads besides its own roles. */
const PALETTE = [...ANSI_PALETTE, ...PALETTE_LEVELS];

/** What a theme sets besides the palette: images, which can't read variables, so no role can build them. */
const THEME_IMAGES = ["--image-select-chevron"];

/** The 16 employee colors as roles.css names them; employeeColor.ts builds the names in inline styles. */
const EMPLOYEE_VARS = EMPLOYEE_PALETTE.map(({ name }) => `--employee-${name.toLowerCase()}`);

/** CSS named colors; transparent and currentColor are allowed, so they aren't listed. */
const NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
  burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
  darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred
  darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
  deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold
  goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush
  lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey
  lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise
  palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue
  saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow
  springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(
    /\s+/,
  ),
);

/** System colors, as written (Background and Menu would otherwise match ordinary words). */
const SYSTEM_COLORS = new Set(
  `AccentColor AccentColorText ActiveText ButtonBorder ButtonFace ButtonText Canvas CanvasText Field FieldText
  GrayText Highlight HighlightText LinkText Mark MarkText SelectedItem SelectedItemText VisitedText
  ActiveBorder ActiveCaption AppWorkspace Background ButtonHighlight ButtonShadow CaptionText InactiveBorder
  InactiveCaption InactiveCaptionText InfoBackground InfoText Menu MenuText Scrollbar ThreeDDarkShadow ThreeDFace
  ThreeDHighlight ThreeDLightShadow ThreeDShadow Window WindowFrame WindowText`.split(/\s+/),
);

/** In a property that takes a color, a system color counts in any case (the minifier lowercases them). */
const SYSTEM_COLORS_LOWER = new Set([...SYSTEM_COLORS].map((color) => color.toLowerCase()));
const COLOR_PROPERTY = new RegExp(
  `^(?:${[
    "color",
    "background(?:-color|-image)?",
    "border(?:-[a-z]+)*",
    "outline(?:-color)?",
    "fill",
    "stroke",
    "(?:box|text)-shadow",
    "text-decoration(?:-color)?",
    "(?:caret|accent|scrollbar)-color",
    "column-rule(?:-color)?",
  ].join("|")})$`,
);

/** A block inside @media (forced-colors: active), but not @media not (forced-colors: active). */
const FORCED_COLORS = /^@media\b.*(?<!\bnot\s*)\(\s*forced-colors\s*:\s*active\s*\)/;

const MASK_PROPERTIES = new Set(["mask", "mask-image", "-webkit-mask", "-webkit-mask-image"]);

interface Declaration {
  line: number;
  property: string;
  value: string;
  /** Selectors and at-rule headers of the enclosing blocks, outermost first. */
  blocks: string[];
}

interface CssFile {
  /** Path under src, e.g. "styles/roles.css". */
  name: string;
  /** The file with its comments blanked out (line breaks kept, so line numbers still match). */
  text: string;
  declarations: Declaration[];
}

/** Index just past the string that opens at `start`. */
function stringEnd(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length && css[i] !== quote) i += css[i] === "\\" ? 2 : 1;
  return i + 1;
}

function blankComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === '"' || css[i] === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (css.startsWith("/*", i)) {
      const close = css.indexOf("*/", i + 2);
      const end = close === -1 ? css.length : close + 2;
      out += css.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else {
      out += css[i];
      i += 1;
    }
  }
  return out;
}

function parseDeclarations(css: string): Declaration[] {
  const declarations: Declaration[] = [];
  const blocks: string[] = [];
  let buffer = "";
  let bufferLine = 1;
  let line = 1;
  let parens = 0;
  const take = () => {
    const text = buffer.trim();
    const colon = text.indexOf(":");
    if (colon > 0 && !text.startsWith("@")) {
      declarations.push({
        line: bufferLine,
        property: text.slice(0, colon).trim(),
        value: text.slice(colon + 1).trim(),
        blocks: [...blocks],
      });
    }
    buffer = "";
  };
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (char === '"' || char === "'") {
      const end = stringEnd(css, i);
      if (!buffer.trim()) bufferLine = line;
      buffer += css.slice(i, end);
      i = end - 1;
      continue;
    }
    if (char === "\n") line += 1;
    if (parens === 0 && char === "{") {
      blocks.push(buffer.trim());
      buffer = "";
    } else if (parens === 0 && (char === ";" || char === "}")) {
      take();
      if (char === "}") blocks.pop();
    } else {
      if (char === "(") parens += 1;
      if (char === ")") parens -= 1;
      if (!buffer.trim() && char.trim()) bufferLine = line;
      buffer += char;
    }
  }
  return declarations;
}

/** The whole function call that starts at `start`, e.g. "rgba(0, 0, 0, 0.5)". */
function callAt(text: string, start: number): string {
  let parens = 0;
  for (let i = text.indexOf("(", start); i < text.length; i += 1) {
    if (text[i] === "(") parens += 1;
    if (text[i] === ")") parens -= 1;
    if (parens === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Decodes a data URL's body; a body that isn't valid percent-encoding only gets its %23 turned back into #. */
function decodeDataUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url.replaceAll("%23", "#");
  }
}

/**
 * Hard-coded colors in a declaration value. System colors only count outside forced-colors mode,
 * and in any case only in a property that takes a color.
 */
function literalColors(value: string, forcedColors: boolean, colorProperty: boolean): string[] {
  // Other strings are text (font names, content), but an SVG in a data URL can't read variables,
  // so a color there is hard-coded too.
  const found: string[] = [];
  let text = "";
  for (let i = 0; i < value.length; ) {
    if (/^url\(/i.test(value.slice(i, i + 4))) {
      const call = callAt(value, i);
      const inside = call.slice(4, -1).trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
      const dataUrl = /^data:/i.test(inside);
      // A base64 body would hide its colors from this check, so it counts as one.
      if (dataUrl && /^data:[^,]*;base64,/i.test(inside)) found.push("base64 data URL");
      text += dataUrl ? ` ${decodeDataUrl(inside).replace(/["']/g, " ")} ` : " ";
      i += call.length;
    } else if (value[i] === '"' || value[i] === "'") {
      i = stringEnd(value, i);
      text += " ";
    } else {
      text += value[i];
      i += 1;
    }
  }
  for (const match of text.matchAll(/#[0-9a-f]{3,8}(?![\w-])/gi)) found.push(match[0]);
  for (const match of text.matchAll(/(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) {
    found.push(callAt(text, match.index));
  }
  for (const [word] of text.matchAll(/(?<![\w-])[a-z]+(?![\w-])/gi)) {
    const systemColor = SYSTEM_COLORS.has(word) || (colorProperty && SYSTEM_COLORS_LOWER.has(word.toLowerCase()));
    if (NAMED_COLORS.has(word.toLowerCase()) || (systemColor && !forcedColors)) found.push(word);
  }
  return found;
}

function isBlack(color: string): boolean {
  return color.toLowerCase() === "black" || /^rgba?\(\s*0\s*,?\s*0\s*,?\s*0\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.test(color);
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

const isThemeFile = (name: string) => name.startsWith("styles/themes/");

function sourceFiles(pattern: RegExp): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => pattern.test(name))
    .sort();
}

const cssFiles: CssFile[] = sourceFiles(/\.css$/).map((name) => {
  const text = blankComments(readFileSync(join(SRC, name), "utf8"));
  return { name, text, declarations: parseDeclarations(text) };
});

/** App scripts: they set custom properties, and could read them in inline styles. */
const scripts = sourceFiles(/(?<!\.test)\.tsx?$/).map((name) => ({
  name,
  text: readFileSync(join(SRC, name), "utf8"),
}));

const ROLES_CSS = "styles/roles.css";
const rolesFile = cssFiles.find((file) => file.name === ROLES_CSS);
if (!rolesFile) throw new Error(`${ROLES_CSS} is missing`);
const roleDefaults = new Map(rolesFile.declarations.map((d) => [d.property, d.value]));
const roleNames = new Set(roleDefaults.keys());

const themes = cssFiles.filter((file) => isThemeFile(file.name));
const themeName = (file: CssFile) => file.name.slice("styles/themes/".length, -".css".length);

/** The theme index.html puts on <html>, the one the app shows. */
function htmlThemeNames(): string[] {
  const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
  const classes = /<html\b[^>]*\bclass="([^"]*)"/.exec(html)?.[1].split(/\s+/) ?? [];
  return classes.filter((c) => c.startsWith("theme-")).map((c) => c.slice("theme-".length));
}

/** What a theme's block (:root.theme-<name>) sets. */
function themeValues(theme: CssFile): Map<string, string> {
  const block = `:root.theme-${themeName(theme)}`;
  return new Map(theme.declarations.filter((d) => d.blocks.at(-1) === block).map((d) => [d.property, d.value]));
}

/** The custom properties a value reads with var(). */
const readsOf = (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);

/** A color as the browser paints it: sRGB channels and alpha, all 0-1. */
interface Rgba {
  rgb: [number, number, number];
  alpha: number;
}

type Triple = [number, number, number];

const decode = (c: number) => (Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4);
const encode = (c: number) =>
  Math.abs(c) <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055);

/** OKLab coordinates of an sRGB color (https://bottosson.github.io/posts/oklab/). */
function toOklab(rgb: Triple): Triple {
  const [r, g, b] = rgb.map(decode);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Triple): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(encode) as Triple;
}

/** Splits a function's arguments at the commas outside parentheses. */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let parens = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") parens += 1;
    if (text[i] === ")") parens -= 1;
    if (text[i] === "," && parens === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...args, text.slice(start).trim()];
}

function parseHex(text: string): Rgba | null {
  const digits = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (!digits) return null;
  const full = digits.length <= 4 ? [...digits].map((c) => c + c).join("") : digits;
  const [r, g, b, a] = [0, 2, 4, 6].map((i) => (i < full.length ? parseInt(full.slice(i, i + 2), 16) / 255 : 1));
  return { rgb: [r, g, b], alpha: a };
}

/** rgb()/rgba(), comma or space separated, channels as 0-255 or percentages. */
function parseRgb(inside: string): Rgba {
  const parts = inside.split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) throw new Error(`can't read rgb(${inside})`);
  const value = (part: string, scale: number) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number(part) / scale);
  const [r, g, b] = parts.slice(0, 3).map((part) => value(part, 255));
  return { rgb: [r, g, b], alpha: parts[3] === undefined ? 1 : value(parts[3], 1) };
}

/** One color-mix() argument: the color and its percentage, if given. */
function mixArgument(text: string): [Rgba, number | undefined] {
  const trailing = /^([\s\S]*\S)\s+(-?\d*\.?\d+)%$/.exec(text);
  if (trailing) return [evalColor(trailing[1]), Number(trailing[2])];
  const leading = /^(-?\d*\.?\d+)%\s+([\s\S]+)$/.exec(text);
  if (leading) return [evalColor(leading[2]), Number(leading[1])];
  return [evalColor(text), undefined];
}

/** color-mix() as CSS Color 5 defines it, premultiplied, in oklab or srgb. */
function mixColors(inside: string): Rgba {
  const [space, first, second, ...extra] = splitArgs(inside);
  const name = /^in\s+(oklab|srgb)$/i.exec(space)?.[1].toLowerCase();
  if (!name || second === undefined || extra.length > 0) {
    throw new Error(`color-mix(${inside}): this test reads color-mix(in oklab or srgb, A [p%], B [q%]) only`);
  }
  const [a, p1] = mixArgument(first);
  const [b, p2] = mixArgument(second);
  const w1 = p1 ?? (p2 === undefined ? 50 : 100 - p2);
  const w2 = p2 ?? 100 - w1;
  const total = w1 + w2;
  if (total <= 0) throw new Error(`color-mix(${inside}): the percentages add up to 0`);
  const [f1, f2] = [w1 / total, w2 / total];
  const into = name === "oklab" ? toOklab : (rgb: Triple) => rgb;
  const [c1, c2] = [into(a.rgb), into(b.rgb)];
  const alpha = a.alpha * f1 + b.alpha * f2;
  if (alpha === 0) return { rgb: [0, 0, 0], alpha: 0 };
  const mixed = c1.map((c, i) => (c * a.alpha * f1 + c2[i] * b.alpha * f2) / alpha) as Triple;
  // Percentages adding up to less than 100% make the result that much more transparent.
  return { rgb: name === "oklab" ? fromOklab(mixed) : mixed, alpha: alpha * Math.min(total / 100, 1) };
}

const NAMED_TEST_COLORS: Record<string, string> = { black: "#000000", white: "#ffffff" };

/** A color value with its var()s already substituted. */
function evalColor(text: string): Rgba {
  const value = text.trim();
  if (/^transparent$/i.test(value)) return { rgb: [0, 0, 0], alpha: 0 };
  const hex = parseHex(NAMED_TEST_COLORS[value.toLowerCase()] ?? value);
  if (hex) return hex;
  const call = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(value);
  if (call?.[1].toLowerCase() === "color-mix") return mixColors(call[2]);
  if (call && /^rgba?$/i.test(call[1])) return parseRgb(call[2]);
  throw new Error(
    `can't read the color "${value}": write #hex, rgb(), black, white, transparent or color-mix(in oklab or srgb, ...)`,
  );
}

/**
 * Where var() looks a name up: the value declared there, and the scope that value's own var()s
 * resolve in. A custom property set on :root resolves on :root, so it can't see one set on a card.
 */
type Scope = (name: string) => { value: string; scope: Scope } | undefined;

/** The value with every var() replaced, as the browser does before it parses a property. */
function substitute(value: string, scope: Scope, seen: readonly string[] = []): string {
  let out = "";
  let rest = value;
  for (;;) {
    const match = /(?<![\w-])var\(/.exec(rest);
    if (!match) return out + rest;
    const call = callAt(rest, match.index);
    const [, name, fallback] = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(call) ?? [];
    if (!name) throw new Error(`can't read ${call}`);
    if (seen.includes(name)) throw new Error(`${[...seen, name].join(" -> ")} goes in a circle`);
    const found = scope(name);
    let replacement: string;
    if (found) replacement = substitute(found.value, found.scope, [...seen, name]);
    else if (fallback !== undefined) replacement = substitute(fallback, scope, seen);
    else throw new Error(`${name} is not set where it is read${seen.length > 0 ? ` (by ${seen.at(-1)})` : ""}`);
    out += rest.slice(0, match.index) + replacement;
    rest = rest.slice(match.index + call.length);
  }
}

/** :root in a theme: its main block, then the defaults in roles.css. */
function rootScope(theme: CssFile): Scope {
  const own = themeValues(theme);
  const scope: Scope = (name) => {
    const value = own.get(name) ?? roleDefaults.get(name);
    return value === undefined ? undefined : { value, scope };
  };
  return scope;
}

/** An element that sets its own custom properties, inside a parent scope. */
function elementScope(declared: ReadonlyMap<string, string>, parent: Scope): Scope {
  const scope: Scope = (name) => {
    const value = declared.get(name);
    return value === undefined ? parent(name) : { value, scope };
  };
  return scope;
}

/** A property's text in a scope, with every var() substituted. */
const resolve = (property: string, scope: Scope) => substitute(`var(${property})`, scope).trim();

/** A color as painted: channels clamped and rounded to 8 bits. */
function painted({ rgb, alpha }: Rgba): Rgba {
  return { rgb: rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255) / 255) as Triple, alpha };
}

/** `top` drawn over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
  return painted({ rgb: top.rgb.map((c, i) => c * top.alpha + bottom.rgb[i] * (1 - top.alpha)) as Triple, alpha: 1 });
}

/** A role's color in a theme, as painted. */
const themeColor = (theme: CssFile, property: string, scope = rootScope(theme)) =>
  painted(evalColor(resolve(property, scope)));

const hexOf = ({ rgb }: Rgba) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance, as in employeeColor.ts. */
function luminance({ rgb }: Rgba): number {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two opaque colors. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** 100 x the OKLab distance between two colors. */
function distance(a: Rgba, b: Rgba): number {
  const [p, q] = [toOklab(a.rgb), toOklab(b.rgb)];
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PALETTE_NAME = new RegExp(`(?<![\\w-])(?:${PALETTE.map(escapeRegExp).join("|")})(?![\\w-])`, "g");

/** Stylesheets that paint: everything but the palette and the roles. */
const paintingCss = cssFiles.filter((file) => file.name !== ROLES_CSS && !isThemeFile(file.name));

const DAY_CARD_CSS = "features/schedule/DayCard.css";
/** The shift card's own custom properties (see DayCard.css). */
const CARD_PROPERTY = /(?<![\w-])--(?:employee|custom-solid|card-[\w-]+)(?![\w-])/g;
const CARD_PROPERTY_NAME = /^--(?:employee|custom-solid|card-[\w-]+)$/;

describe("stylesheets", () => {
  it("are all read", () => {
    expect(cssFiles.map((file) => file.name)).toEqual(
      expect.arrayContaining(["styles/base.css", ROLES_CSS, "styles/tokens.css", "components/Button.css"]),
    );
    expect(rolesFile.declarations.length).toBeGreaterThan(100);
    expect(themes.length).toBeGreaterThan(0);
  });

  it("have no hard-coded colors outside the theme files", () => {
    const problems: string[] = [];
    for (const file of cssFiles.filter((f) => !isThemeFile(f.name))) {
      for (const { line, property, value, blocks } of file.declarations) {
        const forcedColors = blocks.some((block) => FORCED_COLORS.test(block));
        // A mask reads only alpha, so black there isn't a theme color.
        const colors = literalColors(value, forcedColors, COLOR_PROPERTY.test(property)).filter(
          (color) => !(MASK_PROPERTIES.has(property) && isBlack(color)),
        );
        if (colors.length > 0) problems.push(`${file.name}:${line} ${property}: ${colors.join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("leave the palette to roles.css", () => {
    // Scripts too, for inline styles.
    const problems: string[] = [];
    for (const file of [...paintingCss, ...scripts]) {
      for (const match of file.text.matchAll(PALETTE_NAME)) {
        problems.push(`${file.name}:${lineAt(file.text, match.index)} ${match[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("leave the shift card's own properties to its rules in DayCard.css", () => {
    // --employee and --custom-solid are set inline on each card (employeeColor.ts), and --card-*
    // on the card by DayCard.css. Read on :root (roles.css, a theme) they would resolve there,
    // where they aren't set; anywhere else they don't exist.
    const problems: string[] = [];
    for (const file of cssFiles.filter((f) => f.name !== DAY_CARD_CSS)) {
      for (const match of file.text.matchAll(CARD_PROPERTY)) {
        problems.push(`${file.name}:${lineAt(file.text, match.index)} ${match[0]}`);
      }
    }
    for (const file of cssFiles) {
      for (const { line, property } of file.declarations) {
        const own = file.name === DAY_CARD_CSS && property.startsWith("--card-");
        if (!own && CARD_PROPERTY_NAME.test(property)) problems.push(`${file.name}:${line} sets ${property}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("define every custom property they read", () => {
    const defined = new Set(
      cssFiles.flatMap((file) => file.declarations.map((d) => d.property).filter((p) => p.startsWith("--"))),
    );
    // Properties the app sets from script (--toast-bottom, --payroll-stats, ...).
    for (const script of scripts) {
      for (const [, property] of script.text.matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(property);
    }
    const problems: string[] = [];
    for (const file of [...cssFiles, ...scripts]) {
      // A name a script builds (`var(--employee-${...})`) is checked by the employee color tests.
      for (const match of file.text.matchAll(/var\(\s*(--[\w-]+)(?![\w-]|\$\{)/g)) {
        if (!defined.has(match[1])) problems.push(`${file.name}:${lineAt(file.text, match.index)} ${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("themes", () => {
  it("are each a palette and its images, set under their own class", () => {
    // Everything else is a role in roles.css. The palette is colors: hex, or palette colors
    // mixed (a level such as --terminal-ink), never a role.
    const allowed = [...PALETTE, ...THEME_IMAGES];
    const hex = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
    for (const theme of themes) {
      const block = `:root.theme-${themeName(theme)}`;
      const set = theme.declarations.map((d) => d.property);
      const notPalette: string[] = [];
      for (const [name, value] of themeValues(theme)) {
        if (THEME_IMAGES.includes(name)) continue;
        const fromPalette =
          /^(?:var|color-mix)\(/.test(value) && readsOf(value).every((read) => PALETTE.includes(read));
        if (!hex.test(value) && !fromPalette) notPalette.push(`${name}: ${value}`);
        else {
          try {
            themeColor(theme, name);
          } catch (error) {
            notPalette.push(`${name}: ${(error as Error).message}`);
          }
        }
      }
      expect({
        theme: theme.name,
        blocks: [...new Set(theme.declarations.map((d) => d.blocks.join(" { ")))],
        missing: [...PALETTE, ...THEME_IMAGES].filter((name) => !set.includes(name)),
        extra: set.filter((name) => !allowed.includes(name)),
        twice: set.filter((name, i) => set.indexOf(name) !== i),
        notPalette,
      }).toEqual({ theme: theme.name, blocks: [block], missing: [], extra: [], twice: [], notPalette: [] });
    }
  });

  it("match the shown theme's colors written out elsewhere: the chevron's stroke and the browser bar", () => {
    // A data URL can't read variables, and index.html's theme-color is read before any CSS.
    const shown = themes.find((theme) => themeName(theme) === htmlThemeNames()[0]);
    if (!shown) throw new Error("index.html names no theme in themes/");
    const chevron = decodeDataUrl(themeValues(shown).get("--image-select-chevron") ?? "");
    const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
    expect({
      chevronStroke: /\bstroke=['"](#[0-9a-f]{3,8})['"]/i.exec(chevron)?.[1].toLowerCase(),
      browserBar: /<meta\s+name="theme-color"\s+content="([^"]*)"/i.exec(html)?.[1].toLowerCase(),
    }).toEqual({
      chevronStroke: hexOf(themeColor(shown, "--terminal-foreground")),
      browserBar: hexOf(themeColor(shown, "--terminal-background")),
    });
  });

  it("include the one <html> names in index.html, and main.tsx loads them all", () => {
    const named = htmlThemeNames();
    expect(named).toHaveLength(1);
    expect(themes.map(themeName)).toContain(named[0]);
    const main = readFileSync(join(SRC, "main.tsx"), "utf8");
    for (const theme of themes) {
      const name = themeName(theme);
      expect({ name, imported: main.includes(`import "./styles/themes/${name}.css";`) }).toEqual({ name, imported: true });
    }
  });
});

describe("roles.css", () => {
  it("sets roles on :root, each once, and leaves the palette to the theme files", () => {
    const set = rolesFile.declarations.map((d) => d.property);
    expect({
      blocks: [...new Set(rolesFile.declarations.map((d) => d.blocks.join(" { ")))],
      palette: set.filter((name) => PALETTE.includes(name)),
      twice: set.filter((name, i) => set.indexOf(name) !== i),
    }).toEqual({ blocks: [":root"], palette: [], twice: [] });
  });

  it("reads only the palette and its own roles", () => {
    const problems: string[] = [];
    for (const { line, property, value } of rolesFile.declarations) {
      for (const read of readsOf(value)) {
        if (!PALETTE.includes(read) && !roleNames.has(read)) problems.push(`${ROLES_CSS}:${line} ${property} reads ${read}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("has no role that nothing uses", () => {
    // Used: read by a stylesheet that paints, by a script (an inline style), or by a used role.
    const used = new Set(paintingCss.flatMap((file) => readsOf(file.text)));
    for (const script of scripts) {
      for (const read of readsOf(script.text)) used.add(read);
      for (const [, property] of script.text.matchAll(/["'`](--[\w-]+)["'`]/g)) used.add(property);
      // employeeColor.ts builds the employee colors' names (var(--employee-<name>)).
      if (script.text.includes("var(--employee-${")) for (const name of EMPLOYEE_VARS) used.add(name);
    }
    for (const role of used) for (const read of readsOf(roleDefaults.get(role) ?? "")) used.add(read);
    expect([...roleNames].filter((role) => !used.has(role))).toEqual([]);
  });
});

/** WCAG AA for normal-size text; card names and times are 10-14px. */
const MIN_TEXT_CONTRAST = 4.5;

/**
 * How far apart the employee colors stay (100 x OKLab distance). New employees and
 * assign-colors.mjs take the palette in order, so the first 12, the ones in use first, stay
 * furthest apart; the last 4 still keep clear of every other color.
 */
const DISTINCT_COUNT = 12;
const MIN_FIRST_DISTANCE = 5.8;
const MIN_ALL_DISTANCE = 5;

/** The declarations of a top-level rule in DayCard.css. */
function dayCardRule(selector: string): Map<string, string> {
  const file = cssFiles.find((f) => f.name === DAY_CARD_CSS);
  if (!file) throw new Error(`${DAY_CARD_CSS} is missing`);
  const declarations = file.declarations.filter((d) => d.blocks.length === 1 && d.blocks[0] === selector);
  return new Map(declarations.map((d) => [d.property, d.value]));
}

/** LIGHT_CARD_TEXT or CARD_INK, the limits employeeColor.ts decides a custom color's card text with. */
function cardTextColor(name: string): Rgba {
  const source = readFileSync(join(SRC, "features/schedule/employeeColor.ts"), "utf8");
  const hex = new RegExp(`export const ${name} = "(#[0-9a-f]{6})";`, "i").exec(source)?.[1];
  if (!hex) throw new Error(`employeeColor.ts has no ${name}`);
  return painted(evalColor(hex));
}

/**
 * A palette color's shift card in a theme, drawn by DayCard.css's own .day-card-shift rule with
 * the --employee that employeeCardPaint sets inline: its fill and text, as painted on the page.
 */
function shiftCard(theme: CssFile, employeeVar: string): { fill: Rgba; text: Rgba } {
  const rule = dayCardRule(".day-card-shift");
  const read = (property: string) => {
    const value = rule.get(property);
    if (value === undefined) throw new Error(`.day-card-shift in ${DAY_CARD_CSS} sets no ${property}`);
    return value;
  };
  const root = rootScope(theme);
  const own = new Map([...rule].filter(([property]) => property.startsWith("--")));
  own.set("--employee", `var(${employeeVar})`);
  const card = elementScope(own, root);
  const fill = over(evalColor(substitute(read("background-color"), card)), themeColor(theme, "--color-background", root));
  return { fill, text: over(evalColor(substitute(read("color"), card)), fill) };
}

/** The two closest of the colors given and their distance. */
function closestPair(colors: { name: string; color: Rgba }[]) {
  let closest = { pair: "", distance: Infinity };
  for (const [i, a] of colors.entries()) {
    for (const b of colors.slice(i + 1)) {
      const d = distance(a.color, b.color);
      if (d < closest.distance) closest = { pair: `${a.name} / ${b.name}`, distance: d };
    }
  }
  return closest;
}

describe("employee colors", () => {
  /** The 16 as a theme paints them, in palette order. */
  const paletteIn = (theme: CssFile) => EMPLOYEE_VARS.map((name) => ({ name, color: themeColor(theme, name) }));

  it("are all 16 in roles.css", () => {
    expect(EMPLOYEE_VARS.filter((name) => !roleNames.has(name))).toEqual([]);
  });

  it("are read only by roles.css and inline styles", () => {
    const problems = paintingCss.flatMap((file) =>
      [...file.text.matchAll(/--employee-[\w-]*/g)].map((m) => `${file.name}:${lineAt(file.text, m.index)} ${m[0]}`),
    );
    expect(problems).toEqual([]);
  });

  for (const theme of themes) {
    describe(`in ${themeName(theme)}`, () => {
      it("are opaque, and made of palette colors and each other only", () => {
        const problems: string[] = [];
        for (const name of EMPLOYEE_VARS) {
          for (const read of readsOf(roleDefaults.get(name) ?? "")) {
            if (!PALETTE.includes(read) && !EMPLOYEE_VARS.includes(read)) problems.push(`${name} reads ${read}`);
          }
          try {
            if (themeColor(theme, name).alpha < 1) problems.push(`${name} is translucent`);
          } catch (error) {
            problems.push(`${name}: ${(error as Error).message}`);
          }
        }
        expect(problems).toEqual([]);
      });

      it("keep custom colors' solid cards within the limits employeeColor.ts decides with", () => {
        // employeeCardPaint picks a custom color's text in script, against the limits
        // LIGHT_CARD_TEXT and CARD_INK. The theme's light text must be at least as light and its
        // ink at least as dark, so the 4.5:1 found against the limit holds on the page.
        const [lightText, ink] = [themeColor(theme, "--color-chip-text"), themeColor(theme, "--color-card-ink")];
        const [lightLimit, inkLimit] = [cardTextColor("LIGHT_CARD_TEXT"), cardTextColor("CARD_INK")];
        const result = (color: Rgba, ok: boolean) => ({ color: hexOf(color), opaque: color.alpha === 1, ok });
        expect({
          lightText: result(lightText, luminance(lightText) >= luminance(lightLimit)),
          ink: result(ink, luminance(ink) <= luminance(inkLimit)),
        }).toEqual({
          lightText: { color: hexOf(lightText), opaque: true, ok: true },
          ink: { color: hexOf(ink), opaque: true, ok: true },
        });
      });

      it("keep their names and times readable on all 16 shift cards", () => {
        const problems: string[] = [];
        for (const name of EMPLOYEE_VARS) {
          const { fill, text } = shiftCard(theme, name);
          const ratio = contrastRatio(fill, text);
          if (ratio < MIN_TEXT_CONTRAST) {
            problems.push(`${name}: ${hexOf(text)} on ${hexOf(fill)}, ${ratio.toFixed(2)} (needs ${MIN_TEXT_CONTRAST})`);
          }
        }
        expect(problems).toEqual([]);
      });

      it(`keep apart (dots, swatches, cards): the first ${DISTINCT_COUNT} by ${MIN_FIRST_DISTANCE}, all 16 by ${MIN_ALL_DISTANCE}`, () => {
        const colors = paletteIn(theme);
        const first = closestPair(colors.slice(0, DISTINCT_COUNT));
        const all = closestPair(colors);
        expect({
          first: { ...first, farEnough: first.distance >= MIN_FIRST_DISTANCE },
          all: { ...all, farEnough: all.distance >= MIN_ALL_DISTANCE },
        }).toEqual({ first: { ...first, farEnough: true }, all: { ...all, farEnough: true } });
      });
    });
  }
});
