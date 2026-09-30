import { createContext, useContext } from "react";

export interface AlertOptions {
  title: string;
  /** Plain text; "\n" starts a new line. */
  message: string;
  /** Defaults to "OK". */
  okLabel?: string;
}

export type Alert = (options: AlertOptions) => Promise<void>;

/** Provided by <ConfirmProvider> (./ConfirmDialog.tsx), which shows alerts and confirms one at a time. */
export const AlertContext = createContext<Alert | null>(null);

/**
 * In-app replacement for window.alert(): `await alert({...})` resolves once it is dismissed.
 * Only for messages with no dialog to show them in (drag and drop); dialogs show theirs inline.
 */
export function useAlert(): Alert {
  const alert = useContext(AlertContext);
  if (!alert) throw new Error("useAlert must be used inside <ConfirmProvider>.");
  return alert;
}
