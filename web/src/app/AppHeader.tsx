import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { useSignOut } from "./useSignOut";
import "./AppHeader.css";

export interface AppHeaderProps {
  /** The page's call-to-action buttons, shown under the title (use <Button variant="gold">). */
  actions?: ReactNode;
}

export function AppHeader({ actions }: AppHeaderProps) {
  const auth = useAuth();
  const { signingOut, signOut } = useSignOut();

  const accountName =
    auth.status === "signed-in" ? (auth.profile.employee?.name ?? (auth.profile.isAdmin ? "Admin" : null)) : null;

  return (
    <header className="app-header">
      {accountName !== null ? (
        <div className="app-header-account">
          <span className="app-header-user">
            <span className="visually-hidden">Signed in as </span>
            {accountName}
          </span>
          <button type="button" className="app-header-signout" onClick={signOut} disabled={signingOut}>
            Sign out
          </button>
        </div>
      ) : null}
      <h1 className="app-header-title">Mad Potter Schedule</h1>
      {actions ? <div className="app-header-actions">{actions}</div> : null}
    </header>
  );
}
