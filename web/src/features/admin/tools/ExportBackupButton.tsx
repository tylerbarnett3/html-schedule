import { useRef, useState } from "react";
import { Spinner } from "../../../components/Spinner";
import { useToast } from "../../../components/useToast";
import { fetchBackup } from "../../../data/backup";
import { adminErrorMessage } from "../../../data/errors";
import { useAuth } from "../../../lib/auth";
import { backupFilename, backupJson, backupToast } from "../../../lib/backup";
import "./ExportBackupButton.css";

const BACKUP_FAILED = "Couldn't download the backup. Check your connection and try again.";

/**
 * Export Backup (T1) as an icon button in the header's top left corner on the admin pages.
 * Admins only: it renders nothing for anyone else (who couldn't read most tables anyway).
 */
export function ExportBackupButton() {
  const auth = useAuth();
  const isAdmin = auth.status === "signed-in" && auth.profile.isAdmin;
  return isAdmin ? <BackupButton /> : null;
}

function BackupButton() {
  const toast = useToast();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
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
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const label = busy ? "Preparing backup…" : "Export Backup";
  // aria-disabled rather than disabled while busy, so keyboard focus stays on it.
  return (
    <button
      type="button"
      className="export-backup-btn"
      aria-label={label}
      title={label}
      aria-disabled={busy || undefined}
      onClick={() => void run()}
    >
      {busy ? (
        <Spinner size="sm" decorative className="export-backup-spinner" />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
          />
        </svg>
      )}
    </button>
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
