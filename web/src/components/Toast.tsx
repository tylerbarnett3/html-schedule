import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ToastContext, type ToastApi, type ToastTone } from "./useToast";
import "./Toast.css";

type ToastItem = { id: number; message: string; tone: ToastTone };

const MAX_VISIBLE = 4;
const DURATION_MS: Record<ToastTone, number> = { success: 5000, info: 5000, error: 8000 };
const TONE_PREFIX: Record<ToastTone, string> = { success: "", info: "", error: "Error: " };

/** Shows messages from useToast() (./useToast.ts) in a polite live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show(message, tone = "info") {
        const id = nextId.current++;
        setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, message, tone }]);
      },
    }),
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* The live region stays mounted so screen readers pick up toasts added later. */}
      {createPortal(
        <div className="toast-region" aria-live="polite">
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss(id: number): void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(DURATION_MS[toast.tone]);

  // Hovering or focusing a toast pauses its countdown so it can be read or dismissed.
  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, toast.id, onDismiss]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
  };

  return (
    <div
      className={`toast toast-${toast.tone}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={handleBlur}
    >
      <span className="toast-icon" aria-hidden="true">
        {toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}
      </span>
      <p className="toast-message">
        {TONE_PREFIX[toast.tone] ? <span className="visually-hidden">{TONE_PREFIX[toast.tone]}</span> : null}
        {toast.message}
      </p>
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
