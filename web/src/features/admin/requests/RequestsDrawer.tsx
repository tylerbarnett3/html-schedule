import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { useAdminRequests, type AdminRequests } from "../../../data/adminRequests";
import { useClosedDays, useEmployees } from "../../../data/schedule";
import { groupPending, pendingRequestCount, splitRequests, toRequestItems } from "../../../lib/adminRequests";
import { SidebarDrawer } from "../../schedule/SidebarDrawer";
import { useAdminView } from "../useAdminView";
import { RequestList } from "./RequestList";
import { REQUESTS_TOGGLE_ID, useRequestReview } from "./useRequestReview";
import "./RequestList.css";

type Tab = "pending" | "approved";
const TABS: readonly Tab[] = ["pending", "approved"];

// Admin sessions whose drawer has had its first-load check (D11). The key is the provider's
// useState setter: the same for the provider's whole life (the drawer remounts when the admin
// visits Payroll and comes back) and a new one after signing in again.
const firstLoadChecked = new WeakSet<(open: boolean) => void>();

/** Opens the drawer once, when the first load of the session finds pending requests. */
function useOpenOnFirstLoad(data: AdminRequests | undefined, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (data === undefined || firstLoadChecked.has(setOpen)) return;
    firstLoadChecked.add(setOpen);
    if (pendingRequestCount(data) > 0) setOpen(true);
  }, [data, setOpen]);
}

/**
 * The sidebar's Requests section: every pending request (any date, any employee, whatever the
 * calendar filter) and the recently approved ones. The count badge shows while it's closed.
 */
export function RequestsDrawer() {
  const { today, requestsDrawerOpen, setRequestsDrawerOpen } = useAdminView();
  const requests = useAdminRequests(today);
  const employees = useEmployees();
  const closedDays = useClosedDays();
  const review = useRequestReview();
  const [tab, setTab] = useState<Tab>("pending");
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ pending: null, approved: null });
  const restoreFocus = useRef(false);
  const baseId = useId();

  useOpenOnFirstLoad(requests.data, setRequestsDrawerOpen);

  const lists = useMemo(() => {
    if (!requests.data || !employees.data || !closedDays.data) return null;
    const { pending, approved } = splitRequests(
      toRequestItems({
        timeOff: requests.data.timeOff,
        availability: requests.data.availability,
        employees: employees.data,
        closedDays: closedDays.data,
        today,
      }),
    );
    return { pending, entries: groupPending(pending), approved };
  }, [requests.data, employees.data, closedDays.data, today]);

  // A reviewed card leaves the list and takes keyboard focus with it, so put focus on the
  // tab. The card goes when the refetch renders, which may be just before or after the action
  // settles; the flag only lasts a moment so a later click on the page isn't affected.
  const focusTabIfLost = () => {
    if (!restoreFocus.current || document.activeElement !== document.body) return;
    restoreFocus.current = false;
    tabRefs.current[tab]?.focus();
  };
  useEffect(focusTabIfLost);
  const onDone = () => {
    restoreFocus.current = true;
    focusTabIfLost();
    window.setTimeout(focusTabIfLost, 0);
    window.setTimeout(() => {
      restoreFocus.current = false;
    }, 500);
  };

  const count = requests.data ? pendingRequestCount(requests.data) : undefined;

  const selectTab = (next: Tab) => {
    setTab(next);
    tabRefs.current[next]?.focus();
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    const last = TABS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? TABS[index === last ? 0 : index + 1]
        : event.key === "ArrowLeft"
          ? TABS[index === 0 ? last : index - 1]
          : event.key === "Home"
            ? TABS[0]
            : event.key === "End"
              ? TABS[last]
              : null;
    if (!next) return;
    event.preventDefault();
    selectTab(next);
  };

  const failed = !lists && (requests.isError || employees.isError || closedDays.isError);
  const retry = () => {
    if (requests.isError) void requests.refetch();
    if (employees.isError) void employees.refetch();
    if (closedDays.isError) void closedDays.refetch();
  };

  const tabId = (t: Tab) => `${baseId}-${t}-tab`;
  const panelId = (t: Tab) => `${baseId}-${t}-panel`;
  const labels: Record<Tab, string> = {
    pending: lists ? `Pending (${lists.pending.length})` : "Pending",
    approved: "Approved",
  };

  return (
    <SidebarDrawer
      title="Requests"
      toggleId={REQUESTS_TOGGLE_ID}
      open={requestsDrawerOpen}
      onOpenChange={setRequestsDrawerOpen}
      label={count ? `Requests, ${count} pending` : undefined}
      badge={count || null}
    >
      <div role="tablist" aria-label="Requests" className="requests-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            ref={(element) => {
              tabRefs.current[t] = element;
            }}
            id={tabId(t)}
            type="button"
            role="tab"
            className="requests-tab"
            aria-selected={tab === t}
            aria-controls={panelId(t)}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => selectTab(t)}
            onKeyDown={handleTabKeyDown}
          >
            {labels[t]}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <div key={t} id={panelId(t)} role="tabpanel" aria-labelledby={tabId(t)} hidden={tab !== t}>
          {tab !== t ? null : lists ? (
            t === "pending" ? (
              <RequestList variant="pending" entries={lists.entries} review={review} onDone={onDone} />
            ) : (
              <RequestList variant="approved" items={lists.approved} review={review} onDone={onDone} />
            )
          ) : failed ? (
            <div className="requests-status">
              <p className="requests-status-error">Unable to load requests.</p>
              <Button variant="secondary" size="sm" onClick={retry}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="requests-status">
              <Spinner size="sm" label="Loading requests..." />
            </div>
          )}
        </div>
      ))}
    </SidebarDrawer>
  );
}
