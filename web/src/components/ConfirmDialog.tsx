import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { AlertContext, type Alert, type AlertOptions } from "./useAlert";
import { ConfirmContext, type Confirm, type ConfirmOptions } from "./useConfirm";
import "./ConfirmDialog.css";

type Pending = { id: number } & (
  | { kind: "confirm"; options: ConfirmOptions; resolve(confirmed: boolean): void }
  | { kind: "alert"; options: AlertOptions; resolve(): void }
);

// The answer buttons can open right where the user just clicked (a card's Cancel Request,
// the sheet's Submit Request), so the second half of a double-click or double-tap would
// answer a question the user never saw. Clicks this soon after opening are ignored.
const CLICK_GUARD_MS = 500;

function finish(request: Pending, confirmed: boolean): void {
  if (request.kind === "confirm") request.resolve(confirmed);
  else request.resolve();
}

/**
 * Renders the dialog for useConfirm() (./useConfirm.ts) and useAlert() (./useAlert.ts), one
 * question at a time.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Pending | null>(null);
  const pending = useRef<Pending | null>(null);
  const openedAt = useRef(0);
  const nextId = useRef(1);
  const messageId = useId();
  const auth = useAuth();
  const userId = auth.status === "loading" || auth.status === "signed-out" ? null : auth.session.user.id;

  const settle = useCallback((confirmed: boolean) => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    setCurrent(null);
    finish(request, confirmed);
  }, []);

  const open = useCallback((request: Pending) => {
    // A newer question replaces an unanswered one; treat the old one as cancelled.
    if (pending.current) finish(pending.current, false);
    pending.current = request;
    openedAt.current = performance.now();
    setCurrent(request);
  }, []);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => open({ id: nextId.current++, kind: "confirm", options, resolve })),
    [open],
  );

  const alert = useCallback<Alert>(
    (options) => new Promise<void>((resolve) => open({ id: nextId.current++, kind: "alert", options, resolve })),
    [open],
  );

  // A question asked for one login must not be answered after sign-out (or by someone
  // else): the page that asked is gone, and its action would run without a session.
  useEffect(() => {
    settle(false);
  }, [userId, settle]);

  useEffect(
    () => () => {
      if (pending.current) finish(pending.current, false);
    },
    [],
  );

  const answer = (confirmed: boolean) => {
    if (performance.now() - openedAt.current < CLICK_GUARD_MS) return;
    settle(confirmed);
  };

  let footer: ReactNode = null;
  if (current?.kind === "confirm") {
    footer = (
      <>
        <Button variant="secondary" data-autofocus onClick={() => answer(false)}>
          {current.options.cancelLabel}
        </Button>
        <Button variant={current.options.tone === "danger" ? "danger" : "primary"} onClick={() => answer(true)}>
          {current.options.confirmLabel}
        </Button>
      </>
    );
  } else if (current?.kind === "alert") {
    footer = (
      <Button variant="primary" data-autofocus onClick={() => answer(true)}>
        {current.options.okLabel ?? "OK"}
      </Button>
    );
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      <AlertContext.Provider value={alert}>
        {children}
        {/* Keyed so a question that replaces another opens as a new dialog and gets focus. */}
        <Modal
          key={current?.id ?? 0}
          open={current !== null}
          onClose={() => settle(false)}
          title={current?.options.title ?? ""}
          describedBy={messageId}
          size="sm"
          role={current?.kind === "alert" ? "alertdialog" : "dialog"}
          footer={footer}
        >
          <p id={messageId} className="confirm-message">
            {current?.options.message}
          </p>
        </Modal>
      </AlertContext.Provider>
    </ConfirmContext.Provider>
  );
}
