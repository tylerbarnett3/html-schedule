import type { MouseEvent } from "react";
import { Link, NavLink, useMatch } from "react-router";
import { useAuth } from "../../lib/auth";
import { RequestsToolbarButton } from "./requests/RequestsToolbarButton";
import { SaveIndicator } from "./SaveIndicator";
import { ToolbarTools } from "./tools/ToolbarTools";
import { UndoButton } from "./undo/UndoButton";
import "./AdminToolbar.css";

/**
 * The dark band under the header on every admin page. On Payroll it drops Undo, Requests and
 * Download PDF (D14); those components hide themselves there.
 */
export function AdminToolbar() {
  const auth = useAuth();
  const hasEmployee = auth.status === "signed-in" && auth.profile.employee !== null;
  const onPayroll = useMatch("/admin/payroll") !== null;

  // Already on Payroll: a click would drop the ?start=&day= in the URL (X1).
  const stayOnPayroll = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onPayroll) event.preventDefault();
  };

  return (
    <section className="admin-toolbar" aria-label="Admin toolbar">
      <div className="admin-toolbar-group admin-toolbar-status">
        <UndoButton />
        <SaveIndicator />
      </div>
      <div className="admin-toolbar-group admin-toolbar-actions">
        <RequestsToolbarButton />
        <ToolbarTools />
        <NavLink to="/admin/payroll" className="toolbar-btn toolbar-btn-gold" title="Review payroll" onClick={stayOnPayroll}>
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
        </NavLink>
        {hasEmployee ? (
          // An admin who is also on the schedule can see their own page (AM2).
          <Link to="/" className="toolbar-btn toolbar-btn-on-dark">
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
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
            Employee view
          </Link>
        ) : null}
      </div>
    </section>
  );
}
