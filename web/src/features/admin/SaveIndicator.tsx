import { useIsMutating, useMutationState, type Mutation } from "@tanstack/react-query";
import { adminErrorCode, isInfoOutcome } from "../../data/errors";
import "./AdminToolbar.css";

type SaveState = "saving" | "saved" | "error";

const LABELS: Record<SaveState, string> = {
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save",
};

/** A rejection the page shows as an info toast: everywhere, or for this mutation (meta.infoCodes). */
function isInfo(mutation: Mutation): boolean {
  const { error } = mutation.state;
  if (isInfoOutcome(error)) return true;
  const codes = mutation.options.meta?.infoCodes;
  return Array.isArray(codes) && codes.includes(adminErrorCode(error));
}

/**
 * A write that went through, or one that failed. Rejections shown as info toasts (a stale
 * undo, a request someone already reviewed, a calendar item changed elsewhere) lost nothing,
 * so they are left out: otherwise the toolbar would say "Couldn't save" next to a toast
 * saying all is well.
 */
function isFinishedWrite(mutation: Mutation): boolean {
  const { status } = mutation.state;
  return status === "success" || (status === "error" && !isInfo(mutation));
}

/**
 * Every admin change saves right away, so this only reports how the latest one went (D1):
 * "Saving…" while anything is being written, "Couldn't save" when the newest finished write
 * failed (its own error toast says why), otherwise "Saved".
 */
export function SaveIndicator() {
  const saving = useIsMutating() > 0;
  const finished = useMutationState({
    filters: { predicate: isFinishedWrite },
    select: (mutation) => ({ failed: mutation.state.status === "error", submittedAt: mutation.state.submittedAt }),
  });

  let newest: (typeof finished)[number] | null = null;
  for (const mutation of finished) {
    if (!newest || mutation.submittedAt >= newest.submittedAt) newest = mutation;
  }
  const state: SaveState = saving ? "saving" : newest?.failed ? "error" : "saved";

  return (
    <div className="admin-save-indicator" data-state={state} role="status">
      <svg
        className="admin-save-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
        focusable="false"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z"
        />
      </svg>
      <span className="admin-save-dot" aria-hidden="true">
        ●
      </span>
      <span>{LABELS[state]}</span>
    </div>
  );
}
