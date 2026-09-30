import { useMatch } from "react-router";
import { usePendingRequestCount } from "../../../data/adminRequests";
import { ToolbarButton } from "../ToolbarButton";
import { useAdminView } from "../useAdminView";
import { REQUESTS_TOGGLE_ID } from "./useRequestReview";

/**
 * "Requests" with the pending count (D11): opens the sidebar's Requests drawer and moves focus
 * to its header. Hidden on Payroll, which has no sidebar (D14).
 */
export function RequestsToolbarButton() {
  const onPayroll = useMatch("/admin/payroll") !== null;
  // A separate component, so Payroll doesn't load (and keep polling) the requests.
  return onPayroll ? null : <RequestsButton />;
}

function RequestsButton() {
  const { setRequestsDrawerOpen } = useAdminView();
  const count = usePendingRequestCount();

  const open = () => {
    setRequestsDrawerOpen(true);
    // The toggle is on the page whether or not the drawer is open.
    document.getElementById(REQUESTS_TOGGLE_ID)?.focus();
  };

  return (
    <ToolbarButton
      variant="on-dark"
      aria-label={count === undefined ? "Requests" : `Requests, ${count} pending`}
      onClick={open}
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
        >
          <path d="M22 12h-6l-2 3h-4l-2-3H2" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
      }
    >
      Requests
      {count ? (
        <span className="toolbar-btn-badge" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </ToolbarButton>
  );
}
