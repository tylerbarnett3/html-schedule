import { useCallback, useEffect } from "react";
import { useBlocker, type BlockerFunction } from "react-router";
import { useConfirm } from "../../../components/useConfirm";

/**
 * Asks before unsaved payroll changes are thrown away by leaving the page (§1.4): in-app
 * links and the browser's Back button through the router, reload and closing the tab
 * through beforeunload. ?start= and ?day= changes stay on the page, so they pass.
 */
export function useLeaveGuard(dirty: boolean): void {
  const confirm = useConfirm();
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
    [dirty],
  );
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let active = true;
    void confirm({
      title: "Leave payroll?",
      message: "Leave payroll and discard your unsaved changes?",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      tone: "danger",
    }).then((leave) => {
      if (!active) return;
      if (leave) blocker.proceed();
      else blocker.reset();
    });
    return () => {
      active = false;
    };
  }, [blocker, confirm]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers only ask when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
