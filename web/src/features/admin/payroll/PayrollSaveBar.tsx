import { useLayoutEffect, useRef, type Ref, type RefObject } from "react";
import { Button } from "../../../components/Button";
import "./PayrollSaveBar.css";

export interface PayrollSaveBarProps {
  /** The bar's root element, so the page can tell whether focus is in it. */
  ref?: Ref<HTMLDivElement>;
  /** Id for the status text, which takes focus when the buttons turn off under it. */
  statusId: string;
  changeCount: number;
  saving: boolean;
  /** Why the last Save didn't go ahead (P9); announced as it appears. */
  error: string | null;
  onDiscard(): void;
  onSave(): void;
}

/** Sticks to the bottom of the window while the list scrolls (D13). */
export function PayrollSaveBar({ ref, statusId, changeCount, saving, error, onDiscard, onSave }: PayrollSaveBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  useSaveBarSpace(bar);

  const dirty = changeCount > 0;
  let title = "No unsaved changes";
  let description = "Update a shift to begin.";
  if (saving) {
    title = "Saving actuals…";
    description = "Keep this page open until the save finishes.";
  } else if (dirty) {
    title = "Unsaved actual shift changes";
    description = `${changeCount} shift change${changeCount === 1 ? "" : "s"} will be saved.`;
  }

  const setRefs = (element: HTMLDivElement | null) => {
    bar.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  };

  return (
    <div ref={setRefs} className="payroll-savebar">
      <div id={statusId} className="payroll-savebar-copy" tabIndex={-1}>
        <strong className="payroll-savebar-title">{title}</strong>
        <span className="payroll-savebar-description">{description}</span>
        {/* Stays mounted so a new message is announced. */}
        <p className="payroll-savebar-error" role="alert">
          {error}
        </p>
      </div>
      <div className="payroll-savebar-actions">
        {/* While saving the buttons are only aria-disabled, so focus stays on Save. */}
        <Button
          variant="secondary"
          disabled={!dirty}
          aria-disabled={saving || undefined}
          onClick={saving ? undefined : onDiscard}
        >
          Cancel
        </Button>
        <Button
          variant="success"
          disabled={!dirty}
          aria-disabled={saving || undefined}
          onClick={saving ? undefined : onSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** Room left between the bar and a toast, or a focused control, above it. */
const CLEARANCE_PX = 12;
/** The bar's sticky offset from the bottom of the window (PayrollSaveBar.css). */
const STICKY_BOTTOM_PX = 12;

/**
 * Publishes how much of the window the bar covers, on the root element:
 * - --toast-bottom lifts desktop toasts just above the bar, wherever it sits (stuck at the
 *   bottom, or higher up in the page flow once the page is scrolled to its end);
 * - --payroll-savebar-space feeds scroll-padding-bottom, so a control that gets focus is
 *   scrolled clear of the bar instead of hiding under it (WCAG 2.4.11).
 */
function useSaveBarSpace(bar: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const root = document.documentElement;
    let frame = 0;
    let toastBottom = "";
    let space = "";

    const measure = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const onScreen = rect.bottom > 0 && rect.top < window.innerHeight;
      const nextToast = onScreen ? `${Math.ceil(window.innerHeight - rect.top + CLEARANCE_PX)}px` : "";
      const nextSpace = `${Math.ceil(rect.height + STICKY_BOTTOM_PX + CLEARANCE_PX)}px`;
      if (nextToast !== toastBottom) {
        toastBottom = nextToast;
        if (nextToast) root.style.setProperty("--toast-bottom", nextToast);
        else root.style.removeProperty("--toast-bottom");
      }
      if (nextSpace !== space) {
        space = nextSpace;
        root.style.setProperty("--payroll-savebar-space", nextSpace);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // The bar grows with an error message; the page above it changes height as rows load.
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(document.body);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      root.style.removeProperty("--toast-bottom");
      root.style.removeProperty("--payroll-savebar-space");
    };
  }, [bar]);
}
