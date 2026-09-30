import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./AdminToolbar.css";

/** on-dark: translucent pill (Undo); cream: solid light pill (tools); gold: Payroll. */
export type ToolbarButtonVariant = "on-dark" | "cream" | "gold";

export interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ToolbarButtonVariant;
  /** An 18px outline icon before the label (decorative). */
  icon?: ReactNode;
}

/** A button for the dark admin toolbar: 36px tall on desktop, a full-width 44px row on phones. */
export function ToolbarButton({
  variant = "on-dark",
  icon,
  type = "button",
  className,
  children,
  ...rest
}: ToolbarButtonProps) {
  const classes = ["toolbar-btn", `toolbar-btn-${variant}`, className].filter(Boolean).join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {icon ? (
        <span className="toolbar-btn-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}
