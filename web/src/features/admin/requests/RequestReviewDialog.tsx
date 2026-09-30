import { useEffect, useRef } from "react";
import { Button } from "../../../components/Button";
import { Modal } from "../../../components/Modal";
import { Spinner } from "../../../components/Spinner";
import { useClosedDays, useEmployees } from "../../../data/schedule";
import { useBusinessToday } from "../../../data/useBusinessToday";
import { requestedOnText, reviewTargetItem } from "../../../lib/adminRequests";
import { formatLongDate } from "../../../lib/dates";
import { formatPeriod } from "../../../lib/periods";
import type { ReviewTarget } from "../../../lib/scheduleEditing";
import { useRequestReview, type ReviewAction } from "./useRequestReview";
import "./RequestList.css";
import "./RequestReviewDialog.css";

export interface RequestReviewDialogProps {
  target: ReviewTarget | null;
  onClose(): void;
}

const NO_CLOSED_DAYS: ReadonlySet<string> = new Set();

/**
 * Approve or deny the pending request behind a calendar card (C9, D8). Closes only once the
 * request is settled; a cancelled confirm or a failed save leaves it open.
 */
export function RequestReviewDialog({ target, onClose }: RequestReviewDialogProps) {
  const employees = useEmployees().data;
  const closedDays = useClosedDays().data;
  const today = useBusinessToday();
  const review = useRequestReview();

  const item = target
    ? reviewTargetItem(target, { employees: employees ?? [], closedDays: closedDays ?? NO_CLOSED_DAYS, today })
    : null;

  // An action can finish after the admin closed this dialog and opened another request;
  // only close the one it was started from.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    shownId.current = item?.id ?? null;
  });

  // Approve goes away if the day turns out to be closed; if it had focus, keep focus in here.
  useEffect(() => {
    if (target !== null && document.activeElement === document.body) {
      document.querySelector<HTMLElement>(".request-review [data-autofocus]")?.focus();
    }
  });

  const busy = item ? review.busy.get(item.id) : undefined;
  const act = async (action: Exclude<ReviewAction, "remove">) => {
    if (!item || busy) return;
    const settled = action === "approve" ? await review.approve([item]) : await review.deny([item]);
    if (settled && shownId.current === item.id) onClose();
  };

  const title = target?.kind === "availability" ? "Availability Request" : "Time Off Request";
  // Nothing can be approved on a closed day (R6). Wait for the closed days before offering it.
  const canApprove = item !== null && closedDays !== undefined && !item.closed;

  const actionButton = (action: Exclude<ReviewAction, "remove">, label: string) => (
    <Button
      variant={action === "approve" ? "success" : "danger"}
      className="request-action"
      aria-disabled={busy ? true : undefined}
      aria-busy={busy === action ? true : undefined}
      onClick={() => void act(action)}
    >
      {busy === action ? <Spinner size="sm" decorative /> : null}
      {label}
    </Button>
  );

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      size="sm"
      title={title}
      className="request-review"
      footer={
        <>
          {canApprove ? actionButton("approve", "Approve") : null}
          {item ? actionButton("deny", "Deny") : null}
          {/* Focus starts on the harmless choice, as in the confirm dialog: Enter shouldn't approve. */}
          <Button variant="secondary" data-autofocus onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {item ? (
        <>
          <div className="request-review-panel">
            <p className="request-review-name">
              {item.employeeName}
              {item.archived ? <span className="request-review-archived"> (archived)</span> : null}
            </p>
            <p>{formatLongDate(item.date)}</p>
            <p>{formatPeriod(item.period)}</p>
            <p className="request-review-requested">{requestedOnText(item.requestedAt)}</p>
          </div>
          {item.closed ? (
            <p className="request-review-note">
              <span className="request-flag request-flag-closed">Closed</span>
              The business is closed this day, so the request can only be denied.
            </p>
          ) : null}
          {item.past ? (
            <p className="request-review-note">
              <span className="request-flag">Past date</span>
              This date has already passed.
            </p>
          ) : null}
        </>
      ) : (
        <p className="request-review-missing">This request can't be shown.</p>
      )}
    </Modal>
  );
}
