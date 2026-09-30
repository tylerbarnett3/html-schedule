import { onlineManager, type QueryClient } from "@tanstack/react-query";
import type { Styles, UserOptions } from "jspdf-autotable";
import { EMPLOYEE_REORDER_MUTATION_KEY } from "../../../data/adminKeys";
import { CUSTOM_HOURS_KEY, fetchCustomHours, fetchWeeklyHours, WEEKLY_HOURS_KEY } from "../../../data/hours";
import { fetchCalendarData, fetchClosedDays, fetchEmployees } from "../../../data/schedule";
import {
  buildSchedulePdfTables,
  PDF_LAYOUT,
  PDF_TITLE,
  pdfFilename,
  pdfFirstStartY,
  pdfHoursKey,
  pdfKeyLines,
  pdfPageFooter,
  type SchedulePdfInput,
  type SchedulePdfTable,
} from "../../../lib/schedulePdf";
import type { DateRange, Employee } from "../../../lib/types";

/** jsPDF couldn't be downloaded. The browser remembers the failure, so only a reload retries. */
export class PdfToolMissingError extends Error {}

// jsPDF and autotable are big and only needed here, so they load on the first click, in
// their own chunk. Only type imports of them may appear at the top of this file.
function loadPdfLibraries() {
  return Promise.all([import("jspdf"), import("jspdf-autotable")]).catch((error: unknown) => {
    throw new PdfToolMissingError("The PDF tool couldn't be downloaded.", { cause: error });
  });
}

export interface DownloadSchedulePdfInput {
  client: QueryClient;
  range: DateRange;
  /** The admin filter's selection, worked out from the cached employee list. */
  selectedEmployeeIds: ReadonlySet<string>;
}

/**
 * Builds the schedule PDF for the admin's range and filter from freshly fetched rows, then
 * saves it. Returns "empty" (and saves nothing) when no employee row would print. Throws
 * when the data or the PDF chunk can't be loaded.
 */
export async function downloadSchedulePdf({
  client,
  range,
  selectedEmployeeIds,
}: DownloadSchedulePdfInput): Promise<"saved" | "empty"> {
  // Offline, the data reads would wait for the connection while the PDF tool's download
  // fails, and the browser would remember that failure until a reload. Fail at once instead.
  if (!onlineManager.isOnline()) throw new Error("Offline.");
  const libraries = loadPdfLibraries();
  // Loaded side by side with the data; the catch only stops an unhandled rejection when the
  // PDF turns out to be empty. The real error still surfaces at the await below.
  libraries.catch(() => undefined);

  // Never print placeholder or stale rows (T4). While an employee reorder is saving, the
  // cached list holds the new order, and refetching it would flash the old order back.
  const cachedEmployees = client.getQueryData<Employee[]>(["employees"]) ?? [];
  const reordering = client.isMutating({ mutationKey: EMPLOYEE_REORDER_MUTATION_KEY }) > 0;
  const [employees, calendar, closedDays, sets, custom] = await Promise.all([
    reordering
      ? cachedEmployees
      : client.fetchQuery({
          queryKey: ["employees"],
          queryFn: ({ signal }) => fetchEmployees(signal),
          staleTime: 0,
        }),
    client.fetchQuery({
      queryKey: ["calendar", range.start, range.end],
      queryFn: ({ signal }) => fetchCalendarData(range, signal),
      staleTime: 0,
    }),
    client.fetchQuery({
      queryKey: ["closedDays"],
      queryFn: ({ signal }) => fetchClosedDays(signal),
      staleTime: 0,
    }),
    client.fetchQuery({
      queryKey: WEEKLY_HOURS_KEY,
      queryFn: ({ signal }) => fetchWeeklyHours(signal),
      staleTime: 0,
    }),
    client.fetchQuery({
      queryKey: CUSTOM_HOURS_KEY,
      queryFn: ({ signal }) => fetchCustomHours(signal),
      staleTime: 0,
    }),
  ]);

  // The filter stores who is hidden, so an employee added since the list was cached shows.
  const known = new Set(cachedEmployees.map((e) => e.id));
  const selected = new Set(
    employees.filter((e) => selectedEmployeeIds.has(e.id) || !known.has(e.id)).map((e) => e.id),
  );

  const input: SchedulePdfInput = {
    range,
    employees,
    selectedEmployeeIds: selected,
    shifts: calendar.shifts,
    timeOff: calendar.timeOff,
    closedDays,
    hours: { sets, custom },
  };
  const tables = buildSchedulePdfTables(input);
  if (tables.every((table) => table.body.length === 0)) return "empty";

  const [{ jsPDF }, { autoTable }] = await libraries;
  const doc = new jsPDF({
    orientation: PDF_LAYOUT.orientation,
    unit: PDF_LAYOUT.unit,
    format: PDF_LAYOUT.format,
  });

  const { title } = PDF_LAYOUT;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(title.fontSize);
  doc.text(PDF_TITLE, title.x, title.y, { align: "center" });
  doc.setTextColor(0, 0, 0);

  // The business hours key, once, between the title and the first table (none without hours).
  // Wrap after setting the font: the lines are measured in it.
  const { key } = PDF_LAYOUT;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(key.fontSize);
  doc.setTextColor(0, 0, 0);
  const keyLines = pdfKeyLines(pdfHoursKey(input), key.maxWidth, (text) => doc.getTextWidth(text));
  if (keyLines.length > 0) {
    doc.text(keyLines, key.x, key.y, { align: "center", lineHeightFactor: 1.15 });
  }

  tables.forEach((table, index) => {
    // One week per page; the title and key sit above the first.
    if (index > 0) doc.addPage();
    autoTable(doc, {
      startY: index === 0 ? pdfFirstStartY(keyLines.length) : PDF_LAYOUT.nextStartY,
      head: [table.head],
      body: table.body,
      ...tableStyles(table),
    });
  });

  // Footers last, once the page count is known.
  const { footer } = PDF_LAYOUT;
  const pages = doc.getNumberOfPages();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(footer.fontSize);
  doc.setTextColor(...footer.color);
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.text(pdfPageFooter(page, pages), footer.x, footer.y, { align: "center" });
  }

  doc.save(pdfFilename(range));
  return "saved";
}

/**
 * The old page's autotable options, with D3's padding and page-break rules. A day header with an
 * hours line uses the smaller hoursHead style so that line never wraps; the head stays one row.
 */
function tableStyles(table: SchedulePdfTable): Omit<UserOptions, "head" | "body"> {
  const L = PDF_LAYOUT;
  const cell: Partial<Styles> = {
    cellWidth: L.columnWidth,
    halign: "center",
    valign: "middle",
    overflow: "linebreak",
    cellPadding: { ...L.cellPadding },
  };
  // Every column is the same width, so a short last week is narrower, not stretched.
  const columnStyles: Record<number, Partial<Styles>> = {};
  table.head.forEach((_, column) => {
    columnStyles[column] =
      column === 0
        ? { ...cell, fontStyle: "bold", fillColor: [...L.nameFill], fontSize: L.fontSize }
        : { ...cell };
  });

  return {
    theme: "striped",
    styles: {
      font: "helvetica",
      fontSize: L.fontSize,
      cellPadding: { ...L.cellPadding },
      lineColor: [...L.lineColor],
      lineWidth: L.lineWidth,
      overflow: "linebreak",
      cellWidth: "wrap",
      halign: "center",
      valign: "middle",
    },
    headStyles: {
      fillColor: [...L.headFill],
      textColor: [...L.headText],
      fontStyle: "bold",
      halign: "center",
      valign: "middle",
      fontSize: L.fontSize,
      cellPadding: L.headPadding,
    },
    bodyStyles: { textColor: L.bodyText, halign: "center", valign: "middle" },
    alternateRowStyles: { fillColor: [...L.altRowFill] },
    columnStyles,
    margin: { ...L.margin },
    // A row never splits across pages, and a week that runs over repeats its header.
    rowPageBreak: "avoid",
    showHead: "everyPage",
    didParseCell: (data) => {
      if (data.section !== "head" || !table.hoursColumns.includes(data.column.index)) return;
      data.cell.styles.fontSize = L.hoursHead.fontSize;
      data.cell.styles.cellPadding = { ...L.hoursHead.cellPadding };
    },
  };
}
