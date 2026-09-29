import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { ConfirmContext, type Confirm, type ConfirmOptions } from "./useConfirm";
import "./ConfirmDialog.css";

type Pending = { options: ConfirmOptions; resolve(confirmed: boolean): void };

// The answer buttons can open right where the user just clicked (a card's Cancel Request,
// the sheet's Submit Request), so the second half of a double-click or double-tap would
// answer a question the user never saw. Clicks this soon after opening are ignored.
const CLICK_GUARD_MS = 500;

/** Renders the dialog for useConfirm() (./useConfirm.ts), one question at a time. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Pending | null>(null);
  const pending = useRef<Pending | null>(null);
  const openedAt = useRef(0);
  const messageId = useId();
  const auth = useAuth();
  const userId = auth.status === "loading" || auth.status === "signed-out" ? null : auth.session.user.id;

  const settle = useCallback((confirmed: boolean) => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    setCurrent(null);
    request.resolve(confirmed);
  }, []);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // A newer question replaces an unanswered one; treat the old one as cancelled.
        pending.current?.resolve(false);
        const request = { options, resolve };
        pending.current = request;
        openedAt.current = performance.now();
        setCurrent(request);
      }),
    [],
  );

  // A question asked for one login must not be answered after sign-out (or by someone
  // else): the page that asked is gone, and its action would run without a session.
  useEffect(() => {
    settle(false);
  }, [userId, settle]);

  useEffect(() => () => pending.current?.resolve(false), []);

  const answer = (confirmed: boolean) => {
    if (performance.now() - openedAt.current < CLICK_GUARD_MS) return;
    settle(confirmed);
  };

  const options = current?.options;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={options !== undefined}
        onClose={() => settle(false)}
        title={options?.title ?? ""}
        describedBy={messageId}
        size="sm"
        footer={
          <>
            <Button variant="secondary" data-autofocus onClick={() => answer(false)}>
              {options?.cancelLabel}
            </Button>
            <Button variant={options?.tone === "danger" ? "danger" : "primary"} onClick={() => answer(true)}>
              {options?.confirmLabel}
            </Button>
          </>
        }
      >
        <p id={messageId} className="confirm-message">
          {options?.message}
        </p>
      </Modal>
    </ConfirmContext.Provider>
  );
}
