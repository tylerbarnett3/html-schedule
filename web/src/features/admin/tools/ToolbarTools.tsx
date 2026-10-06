import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useMatch } from "react-router";
import { useToast } from "../../../components/useToast";
import { useEmployees } from "../../../data/schedule";
import { ToolbarButton } from "../ToolbarButton";
import { useAdminView } from "../useAdminView";
import { downloadSchedulePdf, PdfToolMissingError } from "./downloadSchedulePdf";
import "./ToolbarTools.css";

const NO_EMPLOYEES = "Select at least one employee to include in the PDF.";
const PDF_FAILED = "Couldn't create the PDF. Check your connection and try again.";
const PDF_TOOL_MISSING = "Couldn't load the PDF tool. Reload the page and try again.";

/**
 * Download PDF as a plain toolbar button (D2), in the toolbar's own row (a full-width row on
 * phones). It prints the schedule view, so it hides on Payroll (D14). Export Backup is in the
 * header (ExportBackupButton).
 */
export function ToolbarTools() {
  const onPayroll = useMatch("/admin/payroll") !== null;
  return onPayroll ? null : <DownloadPdfButton />;
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
      variant="light"
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
