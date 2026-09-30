// The printable schedule behind the toolbar's "Download PDF": one table per 7-day chunk of
// the visible range, one row per employee. Page 1 starts with a key of the standard business
// hours, and a date with special hours prints them under its column header. Everything here
// is pure so the layout rules are unit-tested; features/admin/tools/downloadSchedulePdf.ts
// draws the tables with jsPDF.

import { formatRangeLabel, rangeDates, weekdayOf, WEEKDAY_SHORT } from "./dates";
import {
  formatHoursRange,
  HOURS_KEY_SEPARATOR,
  hoursKeyParagraphs,
  specialHoursOn,
  type Hours,
  type HoursData,
} from "./hours";
import { normalizePeriod, periodSortValue } from "./periods";
import { compareTimes, formatShiftTime } from "./time";
import type { DateRange, Employee, ISODate, Shift, TimeOff } from "./types";

export const PDF_TITLE = "Mad Potter Schedule";
export const PDF_EMPTY_CELL = "—";
export const PDF_CLOSED_CELL = "CLOSED";

/**
 * The old page's jsPDF/autotable settings (mm on landscape A4), except the tighter cell
 * padding, which lets a week of about 16 employees fit on one page (D3).
 */
export const PDF_LAYOUT = {
  orientation: "landscape",
  unit: "mm",
  format: "a4",
  title: { x: 148, y: 15, fontSize: 18 },
  /**
   * The business hours key under the title on page 1: centered, one paragraph per weekly set,
   * wrapped to the table width. lineHeight is 9pt × 1.15 in mm (jsPDF's lineHeightFactor).
   */
  key: { x: 148, y: 21, fontSize: 9, lineHeight: 3.651, maxWidth: 269 },
  firstStartY: 25,
  nextStartY: 15,
  /** The page width minus the margins (297 - 28), shared by the name column and 7 days. */
  columnWidth: 269 / 8,
  margin: { left: 14, right: 14 },
  fontSize: 9,
  cellPadding: { top: 3, right: 2, bottom: 3, left: 2 },
  headPadding: 3,
  /** A day header with a third (hours) line: smaller, with the body's side padding, so it never wraps. */
  hoursHead: { fontSize: 8, cellPadding: { top: 3, right: 2, bottom: 3, left: 2 } },
  footer: { x: 148, y: 200, fontSize: 8, color: [150, 150, 150] },
  headFill: [110, 95, 74],
  headText: [255, 255, 255],
  nameFill: [245, 247, 250],
  altRowFill: [250, 250, 252],
  lineColor: [200, 200, 200],
  lineWidth: 0.1,
  bodyText: 80,
} as const;

const WEEK_DAYS = 7;

/** Consecutive 7-day chunks from range.start (not calendar weeks); the last may be shorter. */
export function pdfWeeks(range: DateRange): ISODate[][] {
  const dates = rangeDates(range);
  const weeks: ISODate[][] = [];
  for (let i = 0; i < dates.length; i += WEEK_DAYS) weeks.push(dates.slice(i, i + WEEK_DAYS));
  return weeks;
}

/** 'Tue\n9/29', or 'Sat\n10/31\n(9:00 AM - 5:00 PM)' with special hours. */
function dayHeader(d: ISODate, hours: Hours | null): string {
  const label = `${WEEKDAY_SHORT[weekdayOf(d)]}\n${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return hours ? `${label}\n(${formatHoursRange(hours)})` : label;
}

/**
 * ["Week of\nSep 29 - Oct 5", "Tue\n9/29", ...]; empty for an empty week. A day that hoursFor
 * gives hours gets them as a third line.
 */
export function pdfWeekHeader(week: readonly ISODate[], hoursFor?: (date: ISODate) => Hours | null): string[] {
  const first = week[0];
  const last = week[week.length - 1];
  if (first === undefined || last === undefined) return [];
  return [
    `Week of\n${formatRangeLabel({ start: first, end: last }).text}`,
    ...week.map((d) => dayHeader(d, hoursFor ? hoursFor(d) : null)),
  ];
}

/**
 * The page 1 key: the standard hours in effect on the first day, then a "From Nov 1: …"
 * paragraph for each change within the range. Empty without hours (or with no weekly sets).
 */
export function pdfHoursKey(input: Pick<SchedulePdfInput, "hours" | "range">): string[] {
  return input.hours ? hoursKeyParagraphs(input.hours.sets, input.range) : [];
}

/**
 * The key's printed lines. Each paragraph wraps to maxWidth only between its
 * '<days>: <hours>' groups, so a time range never splits and no line starts with '- '; a
 * 'From Nov 1:' label stays with its first group. The ' | ' between two groups is left out
 * where the line breaks, so no line starts or ends with '|'. widthOf measures text in the
 * key's font (jsPDF's getTextWidth). A group too wide for a line on its own (none is at 9pt)
 * breaks at its spaces.
 */
export function pdfKeyLines(
  paragraphs: readonly string[],
  maxWidth: number,
  widthOf: (text: string) => number,
): string[] {
  return paragraphs.flatMap((paragraph) => {
    // Each piece with what joins it to the piece before when both are on one line.
    const pieces = paragraph.split(HOURS_KEY_SEPARATOR).flatMap((group, groupIndex) => {
      const words = widthOf(group) > maxWidth ? group.split(" ") : [group];
      return words.map((text, wordIndex) => ({
        text,
        joiner: wordIndex > 0 ? " " : groupIndex > 0 ? HOURS_KEY_SEPARATOR : "",
      }));
    });
    const lines: string[] = [];
    let line = "";
    for (const { text, joiner } of pieces) {
      const joined = line === "" ? text : `${line}${joiner}${text}`;
      if (line !== "" && widthOf(joined) > maxWidth) {
        lines.push(line);
        line = text;
      } else {
        line = joined;
      }
    }
    if (line !== "") lines.push(line);
    return lines;
  });
}

/** Where the first table starts: under the title, and lower when the key needs more than one line. */
export function pdfFirstStartY(keyLines: number): number {
  const { firstStartY, key } = PDF_LAYOUT;
  return keyLines <= 1 ? firstStartY : firstStartY + (keyLines - 1) * key.lineHeight;
}

const APPROVED_TEXT = { "full-day": "OFF", morning: "MORNING OFF", evening: "EVENING OFF" } as const;
const PENDING_TEXT = {
  "full-day": "PENDING",
  morning: "PENDING - MORNING",
  evening: "PENDING - EVENING",
} as const;

/** Time off keeps its part of the day (the old PDF printed every approved day as "OFF"). */
export function pdfTimeOffText(row: Pick<TimeOff, "period" | "status">): string {
  const period = normalizePeriod(row.period);
  return row.status === "pending" ? PENDING_TEXT[period] : APPROVED_TEXT[period];
}

/** Shifts by start then end time, then time off by part of the day, joined with ", ". */
export function pdfCellText(cell: {
  closed: boolean;
  shifts: readonly Pick<Shift, "start_time" | "end_time">[];
  timeOff: readonly Pick<TimeOff, "period" | "status">[];
}): string {
  if (cell.closed) return PDF_CLOSED_CELL;
  const shifts = [...cell.shifts].sort(
    (a, b) => compareTimes(a.start_time, b.start_time) || compareTimes(a.end_time, b.end_time),
  );
  const timeOff = [...cell.timeOff].sort((a, b) => periodSortValue(a.period) - periodSortValue(b.period));
  const parts = [...shifts.map(formatShiftTime), ...timeOff.map(pdfTimeOffText)];
  return parts.length > 0 ? parts.join(", ") : PDF_EMPTY_CELL;
}

export interface SchedulePdfInput {
  range: DateRange;
  /** Already in display order. */
  employees: readonly Employee[];
  selectedEmployeeIds: ReadonlySet<string>;
  shifts: readonly Shift[];
  timeOff: readonly TimeOff[];
  closedDays: ReadonlySet<ISODate>;
  /** Missing: no key and no hours lines. */
  hours?: HoursData;
}

export interface SchedulePdfTable {
  head: string[];
  body: string[][];
  /** Indexes into head of the day cells that have an hours line. */
  hoursColumns: number[];
}

function cellKey(employeeId: string, date: ISODate): string {
  return `${employeeId}|${date}`;
}

function pushTo<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/**
 * One table per week. Rows follow the admin's employee filter in display order; an archived
 * employee only gets a row when something of theirs prints in the range (D3). Time off always
 * prints (whatever the Show Time Off toggle says) and availability never does. With hours, a
 * date whose hours differ from the standard (specialHoursOn; never a closed date) prints them
 * in its header.
 */
export function buildSchedulePdfTables(input: SchedulePdfInput): SchedulePdfTable[] {
  const { range, closedDays, hours } = input;
  const hoursFor = hours ? (d: ISODate) => specialHoursOn(d, hours, closedDays) : undefined;
  // A closed date prints CLOSED, so rows on it don't count as printing anything.
  const prints = (d: ISODate) => d >= range.start && d <= range.end && !closedDays.has(d);

  const shiftsByCell = new Map<string, Pick<Shift, "start_time" | "end_time">[]>();
  const timeOffByCell = new Map<string, Pick<TimeOff, "period" | "status">[]>();
  const withRows = new Set<string>();
  for (const shift of input.shifts) {
    if (!prints(shift.shift_date)) continue;
    pushTo(shiftsByCell, cellKey(shift.employee_id, shift.shift_date), shift);
    withRows.add(shift.employee_id);
  }
  for (const row of input.timeOff) {
    if (!prints(row.off_date)) continue;
    pushTo(timeOffByCell, cellKey(row.employee_id, row.off_date), row);
    withRows.add(row.employee_id);
  }

  const employees = input.employees.filter(
    (e) => input.selectedEmployeeIds.has(e.id) && (!e.archived || withRows.has(e.id)),
  );

  return pdfWeeks(range).map((week) => ({
    head: pdfWeekHeader(week, hoursFor),
    body: employees.map((employee) => [
      employee.name,
      ...week.map((date) =>
        pdfCellText({
          closed: closedDays.has(date),
          shifts: shiftsByCell.get(cellKey(employee.id, date)) ?? [],
          timeOff: timeOffByCell.get(cellKey(employee.id, date)) ?? [],
        }),
      ),
    ]),
    // Head index 0 is the week label, so day i sits at i + 1.
    hoursColumns: hoursFor ? week.flatMap((date, i) => (hoursFor(date) ? [i + 1] : [])) : [],
  }));
}

/** 'schedule-2026-09-29-to-2026-11-02.pdf' (T5). */
export function pdfFilename(range: DateRange): string {
  return `schedule-${range.start}-to-${range.end}.pdf`;
}

/** 'Page 1 of 5' */
export function pdfPageFooter(page: number, total: number): string {
  return `Page ${page} of ${total}`;
}
