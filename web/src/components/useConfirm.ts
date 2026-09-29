import { createContext, useContext } from "react";

export interface ConfirmOptions {
  title: string;
  /** Plain text; "\n" starts a new line. */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "default";
}

export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

/** Provided by <ConfirmProvider> (./ConfirmDialog.tsx). */
export const ConfirmContext = createContext<Confirm | null>(null);

/** In-app replacement for window.confirm(): `await confirm({...})` resolves true only on the confirm button. */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside <ConfirmProvider>.");
  return confirm;
}
