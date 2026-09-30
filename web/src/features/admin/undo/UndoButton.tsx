import { useMatch } from "react-router";
import { ToolbarButton } from "../ToolbarButton";
import { useUndo } from "./useUndo";

/** Toolbar Undo for calendar edits. Payroll saves never go on the stack, so it hides there (D14). */
export function UndoButton() {
  const { undo, canUndo, running, nextLabel } = useUndo();
  const onPayroll = useMatch("/admin/payroll") !== null;
  if (onPayroll) return null;

  const name = nextLabel ? `Undo: ${nextLabel}` : "Nothing to undo";
  const unavailable = !canUndo || running;
  return (
    <ToolbarButton
      variant="on-dark"
      className="admin-undo-btn"
      aria-label={name}
      title={name}
      // aria-disabled rather than disabled: a disabled button drops keyboard focus to <body>,
      // both while the undo runs and once the last step is gone.
      aria-disabled={unavailable || undefined}
      data-busy={running || undefined}
      onClick={() => {
        if (!unavailable) void undo();
      }}
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" focusable="false">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
        </svg>
      }
    >
      Undo
    </ToolbarButton>
  );
}
