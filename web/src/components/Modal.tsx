import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./Modal.css";

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  /** Overrides aria-labelledby (defaults to the rendered title). */
  labelledBy?: string;
  describedBy?: string;
  /** sm for short confirmations; md for forms. md is a full-height sheet on phones. */
  size?: "sm" | "md";
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[inert]") && el.getClientRects().length > 0,
  );
}

// Open modals, bottom to top. Only the top one handles Escape and Tab, and the
// page behind (plus any lower modal) is made inert while it is open.
type StackEntry = { id: string; overlay: HTMLElement };
const stack: StackEntry[] = [];
let savedStyles: { htmlOverflow: string; bodyOverflow: string; bodyPaddingRight: string } | null = null;

function isTop(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1].id === id;
}

function pushModal(entry: StackEntry): void {
  const below = stack[stack.length - 1];
  if (below) below.overlay.inert = true;
  stack.push(entry);
  if (stack.length !== 1) return;

  const root = document.getElementById("root");
  if (root) root.inert = true;
  const html = document.documentElement;
  const body = document.body;
  const scrollbar = window.innerWidth - html.clientWidth;
  savedStyles = {
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
  };
  if (scrollbar > 0) {
    const padding = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${padding + scrollbar}px`;
  }
  // Lock both: when <html> has its own overflow (base.css sets overflow-x on phones),
  // the page scrolls through <html> and a body-only lock does nothing.
  html.style.overflow = "hidden";
  body.style.overflow = "hidden";
}

function removeModal(id: string): void {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  stack.splice(index, 1);
  const top = stack[stack.length - 1];
  if (top) {
    top.overlay.inert = false;
    return;
  }
  const root = document.getElementById("root");
  if (root) root.inert = false;
  if (savedStyles) {
    document.documentElement.style.overflow = savedStyles.htmlOverflow;
    document.body.style.overflow = savedStyles.bodyOverflow;
    document.body.style.paddingRight = savedStyles.bodyPaddingRight;
    savedStyles = null;
  }
}

export function Modal({
  open,
  onClose,
  title,
  labelledBy,
  describedBy,
  size = "md",
  footer,
  children,
  className,
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const pointerDownOnOverlay = useRef(false);
  // Read through a ref so a new onClose each render doesn't re-run the focus effect.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    if (!open || !overlay || !dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushModal({ id, overlay });

    const initial =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      focusableIn(bodyRef.current)[0] ??
      focusableIn(footerRef.current)[0] ??
      dialog;
    initial.focus({ preventScroll: true });

    return () => {
      removeModal(id);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open, id]);

  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isTop(id)) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    const items = focusableIn(dialog);
    if (items.length === 0) {
      event.preventDefault();
      dialog?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Close only when both press and release happen on the backdrop, so dragging a
  // text selection out of the dialog doesn't dismiss it.
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pointerDownOnOverlay.current = event.target === event.currentTarget;
  };
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (pointerDownOnOverlay.current && event.target === event.currentTarget && isTop(id)) {
      onCloseRef.current();
    }
    pointerDownOnOverlay.current = false;
  };

  const classes = ["modal", `modal-${size}`, className].filter(Boolean).join(" ");

  return createPortal(
    <div ref={overlayRef} className="modal-overlay" onPointerDown={handlePointerDown} onClick={handleClick}>
      <div
        ref={dialogRef}
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={() => onCloseRef.current()}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div ref={bodyRef} className="modal-body">
          {children}
        </div>
        {footer ? (
          <div ref={footerRef} className="modal-footer">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
