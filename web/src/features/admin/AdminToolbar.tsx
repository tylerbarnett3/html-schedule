import { Link, useMatch } from "react-router";
import { useAuth } from "../../lib/auth";
import { ToolbarTools } from "./tools/ToolbarTools";
import { UndoButton } from "./undo/UndoButton";
import "./AdminToolbar.css";

/**
 * The dark band under the header on every admin page. On Payroll it drops Undo and Download
 * PDF (D14), and the ochre Payroll button becomes "Back to schedule". Export Backup sits in the
 * header's top left corner (ExportBackupButton), and an admin who is also an employee finds
 * "Employee view" in the header, where "Admin" is on their schedule.
 */
export function AdminToolbar() {
  const auth = useAuth();
  const isAdmin = auth.status === "signed-in" && auth.profile.isAdmin;
  const onPayroll = useMatch("/admin/payroll") !== null;

  return (
    <section className="admin-toolbar" aria-label="Admin toolbar">
      {onPayroll ? null : (
        <div className="admin-toolbar-group admin-toolbar-status">
          <UndoButton />
        </div>
      )}
      <div className="admin-toolbar-group admin-toolbar-actions">
        <ToolbarTools />
        {onPayroll ? (
          // Payroll staff who aren't admins go back to their own schedule.
          <Link to={isAdmin ? "/admin" : "/"} className="toolbar-btn toolbar-btn-accent">
            <span className="toolbar-btn-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                focusable="false"
              >
                <path d="M19 12H5" />
                <path d="m12 19-7-7 7-7" />
              </svg>
            </span>
            Back to schedule
          </Link>
        ) : (
          <Link to="/admin/payroll" className="toolbar-btn toolbar-btn-accent" title="Review payroll">
            <span className="toolbar-btn-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                focusable="false"
              >
                <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" />
                <path d="M2 6h4M2 10h4M2 14h4M2 18h4" />
                <path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" />
              </svg>
            </span>
            Payroll
          </Link>
        )}
      </div>
    </section>
  );
}
