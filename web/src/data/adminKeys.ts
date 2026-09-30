import type { NetworkMode, QueryClient } from "@tanstack/react-query";
import { adminErrorCode } from "./errors";

/**
 * mutationKey for the employee reorder (the only optimistic update). While one runs, the
 * employee list already shows the new order, and a refetch could flash the old one back.
 */
export const EMPLOYEE_REORDER_MUTATION_KEY = ["employees", "reorder"] as const;

/**
 * networkMode for every admin mutation. react-query's default ("online") holds a write while
 * the browser reports being offline and sends it by itself once the connection is back, long
 * after the admin moved on. With "always" the write is tried at once, so offline it fails
 * with the "Couldn't reach the schedule" message instead, without waiting for the refetch in
 * onSettled (see waitForRefresh).
 */
export const ADMIN_NETWORK_MODE: NetworkMode = "always";

/**
 * What an admin write's onSettled returns: the refresh (invalidateAdminData), so the caller's
 * toast waits for it and describes what is already on screen. After a network failure the
 * refresh would only retry its way to the same failure (about 20 seconds), so the error shows
 * at once and the refresh carries on in the background, where it still picks up a write that
 * reached the database but whose reply was lost.
 */
export function waitForRefresh(refresh: Promise<unknown>, error: unknown): Promise<unknown> | undefined {
  return error != null && adminErrorCode(error) === "network" ? undefined : refresh;
}

/**
 * Refreshes everything the admin pages show. One admin change can touch several views (a
 * deleted shift orphans its payroll hours, a calendar edit to time off changes the Requests
 * drawer), so every admin mutation returns this from onSettled through waitForRefresh.
 *
 * While an employee reorder is running, the employee list is only marked stale (it
 * refetches on the next focus or mount) so the optimistic order stays put.
 */
export async function invalidateAdminData(client: QueryClient): Promise<void> {
  if (client.isMutating({ mutationKey: EMPLOYEE_REORDER_MUTATION_KEY }) === 0) {
    await client.invalidateQueries();
    return;
  }
  await Promise.all([
    client.invalidateQueries({ queryKey: ["employees"], refetchType: "none" }),
    client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "employees" }),
  ]);
}
