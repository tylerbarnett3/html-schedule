import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useMatch } from "react-router";
import { useToast } from "../../../components/useToast";
import { fetchBackup } from "../../../data/backup";
import { adminErrorMessage } from "../../../data/errors";
import { useEmployees } from "../../../data/schedule";
import { backupFilename, backupJson, backupToast } from "../../../lib/backup";
import { ToolbarButton } from "../ToolbarButton";
import { useAdminView } from "../useAdminView";
import { downloadSchedulePdf, PdfToolMissingError } from "./downloadSchedulePdf";
import "./ToolbarTools.css";

const NO_EMPLOYEES = "Select at least one employee to include in the PDF.";
const PDF_FAILED = "Couldn't create the PDF. Check your connection and try again.";
const PDF_TOOL_MISSING = "Couldn't load the PDF tool. Reload the page and try again.";
const BACKUP_FAILED = "Couldn't download the backup. Check your connection and try again.";

/**
 * Download PDF and Export Backup as plain toolbar buttons (D2). Returned as a fragment so
 * they join the toolbar's own row, and its full-width column on phones. Download PDF prints
 * the schedule view, so it hides on Payroll (D14); Export Backup always shows.
 */
export function ToolbarTools() {
  const onPayroll = useMatch("/admin/payroll") !== null;
  return (
    <>
      {onPayroll ? null : <DownloadPdfButton />}
      <ExportBackupButton />
    </>
  );
}

/**
 * A click guard plus a busy flag. While busy the button is aria-disabled rather than
 * disabled, so keyboard focus stays on it.
 */
function useBusyAction(action: () => Promise<void>) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}

function DownloadPdfButton() {
  const client = useQueryClient();
  const toast = useToast();
  const { range, selectedEmployeeIds } = useAdminView();
  // The filter's selection is only known once the employee list has loaded.
  const employeesLoaded = useEmployees().data !== undefined;

  const { busy, run } = useBusyAction(async () => {
    try {
      const result = await downloadSchedulePdf({ client, range, selectedEmployeeIds });
      // Only archived employees with nothing in this range are selected.
      if (result === "empty") toast.show(NO_EMPLOYEES, "info");
    } catch (error) {
      toast.show(error instanceof PdfToolMissingError ? PDF_TOOL_MISSING : PDF_FAILED, "error");
    }
  });

  return (
    <ToolbarButton
      variant="cream"
      className={busy ? "toolbar-tools-busy" : undefined}
      disabled={!employeesLoaded}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (busy) return;
        if (selectedEmployeeIds.size === 0) toast.show(NO_EMPLOYEES, "info");
        else void run();
      }}
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" focusable="false">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
          />
        </svg>
      }
    >
      {busy ? "Preparing PDF…" : "Download PDF"}
    </ToolbarButton>
  );
}

function ExportBackupButton() {
  const toast = useToast();

  const { busy, run } = useBusyAction(async () => {
    try {
      const file = await fetchBackup();
      saveFile(
        new Blob([backupJson(file)], { type: "application/json" }),
        backupFilename(new Date(file.exportedAt)),
      );
      const { title, message } = backupToast(file);
      toast.show(message, "success", { title });
    } catch (error) {
      toast.show(adminErrorMessage(error, BACKUP_FAILED), "error");
    }
  });

  return (
    <ToolbarButton
      variant="cream"
      className={busy ? "toolbar-tools-busy" : undefined}
      aria-disabled={busy || undefined}
      onClick={() => void run()}
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" focusable="false">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
          />
        </svg>
      }
    >
      {busy ? "Preparing backup…" : "Export Backup"}
    </ToolbarButton>
  );
}

/**
 * Hands a file to the browser's downloads. The temporary link is never shown; the object
 * URL is released a little later because revoking it at once can cancel the download.
 */
function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
