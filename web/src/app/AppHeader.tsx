import type { ReactNode } from "react";
import { Link, useMatch } from "react-router";
import { emailToLogin, useAuth } from "../lib/auth";
import { useSignOut } from "./useSignOut";
import "./AppHeader.css";

export interface AppHeaderProps {
  /** The page's call-to-action buttons, shown under the title (use <Button variant="gold">). */
  actions?: ReactNode;
  /** Shown in the top left corner (Export Backup on the admin pages). */
  corner?: ReactNode;
  /**
   * Where the signed-in name sits in the top row: left (the default) or center, for pages
   * whose top left holds `corner`. Sign out is always on the right.
   */
  nameAlign?: "left" | "center";
}

export function AppHeader({ actions, corner, nameAlign = "left" }: AppHeaderProps) {
  const auth = useAuth();
  const { signingOut, signOut } = useSignOut();
  const onSchedulePage = useMatch("/") !== null;
  const onAdminPage = useMatch({ path: "/admin", end: false }) !== null;

  // An admin with no employee record is shown by username, not "Admin", which would read
  // like the Admin link below.
  const accountName =
    auth.status === "signed-in"
      ? (auth.profile.employee?.name ??
        (auth.profile.isAdmin ? emailToLogin(auth.session.user.email ?? "") || "Admin" : null))
      : null;
  // An admin who is also an employee lands on their own schedule. "Admin" there and
  // "Employee view" on the admin pages switch between the two, in the same spot (AM2).
  // Admins without an employee record never see "/".
  const isAdmin = auth.status === "signed-in" && auth.profile.isAdmin;
  const showAdminLink = isAdmin && onSchedulePage;
  // Payroll staff who aren't admins reach Payroll from the same spot.
  const showPayrollLink = !isAdmin && auth.status === "signed-in" && auth.profile.canEditPayroll && onSchedulePage;
  const showEmployeeLink = isAdmin && auth.status === "signed-in" && auth.profile.employee !== null && onAdminPage;

  const name =
    accountName !== null ? (
      <span className="app-header-user">
        <span className="visually-hidden">Signed in as </span>
        {accountName}
      </span>
    ) : null;

  return (
    <header className={nameAlign === "center" ? "app-header app-header-name-center" : "app-header"}>
      {accountName !== null || corner ? (
        <div className="app-header-bar">
          <div className="app-header-start">
            {corner}
            {nameAlign === "left" ? name : null}
          </div>
          <div className="app-header-middle">{nameAlign === "center" ? name : null}</div>
          <div className="app-header-end">
            {showAdminLink ? (
              <Link to="/admin" className="app-header-link">
                Admin
              </Link>
            ) : null}
            {showPayrollLink ? (
              <Link to="/admin/payroll" className="app-header-link">
                Payroll
              </Link>
            ) : null}
            {showEmployeeLink ? (
              <Link to="/" className="app-header-link">
                Employee view
              </Link>
            ) : null}
            {accountName !== null ? (
              <button type="button" className="app-header-signout" onClick={signOut} disabled={signingOut}>
                Sign out
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <h1 className="app-header-title">Mad Potter Schedule</h1>
      {actions ? <div className="app-header-actions">{actions}</div> : null}
    </header>
  );
}
