import { createContext, useContext } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastOptions {
  /** Short heading shown above the message, e.g. "Time Off Approved". */
  title?: string;
}

export interface ToastApi {
  show(message: string, tone?: ToastTone, options?: ToastOptions): void;
}

/** Provided by <ToastProvider> (./Toast.tsx). */
export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>.");
  return api;
}
