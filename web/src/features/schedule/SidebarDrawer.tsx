import { useId, type ReactNode } from "react";
import "./Sidebar.css";

export interface SidebarDrawerProps {
  title: string;
  /** A 16px outline icon before the title (decorative). */
  icon?: ReactNode;
  /** Short text after the title, e.g. "3 of 14" or a pending count; shown as a pill. */
  badge?: ReactNode;
  /**
   * Accessible name for the toggle when the title and badge don't read well on their own,
   * e.g. "Requests, 3 pending" (D11). Defaults to the button's text.
   */
  label?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** id for the toggle button, so other controls can move focus to it. */
  toggleId?: string;
  children: ReactNode;
}

/** A sidebar section with a clay header button that opens and closes the panel below it. */
export function SidebarDrawer({ title, icon, badge, label, open, onOpenChange, toggleId, children }: SidebarDrawerProps) {
  const drawerId = useId();

  return (
    <div className="sidebar-section">
      <h2 className="sidebar-drawer-heading">
        <button
          id={toggleId}
          type="button"
          className="sidebar-drawer-toggle"
          aria-label={label}
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => onOpenChange(!open)}
        >
          {icon ? (
            <span className="sidebar-drawer-icon" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <span className="sidebar-drawer-title">{title}</span>
          {badge !== undefined && badge !== null && badge !== false ? (
            <span className="sidebar-drawer-count">{badge}</span>
          ) : null}
          <span className="sidebar-drawer-chevron" aria-hidden="true">
            ▼
          </span>
        </button>
      </h2>
      <div id={drawerId} className="sidebar-drawer" data-open={open}>
        <div className="sidebar-drawer-inner">
          <div className="sidebar-drawer-content">{children}</div>
        </div>
      </div>
    </div>
  );
}
