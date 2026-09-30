import { useRef, useState } from "react";
import { useConfirm } from "../../../components/useConfirm";
import { useToast } from "../../../components/useToast";
import {
  fetchPendingRequestIds,
  useApproveAvailability,
  useApproveTimeOff,
  useDenyAvailability,
  useDenyTimeOff,
  useRemoveApprovedAvailability,
} from "../../../data/adminRequests";
import { fetchEditingRows, fetchShiftIdsWithActuals, useDeleteScheduleItems } from "../../../data/adminSchedule";
import { adminErrorCode, adminErrorMessage } from "../../../data/errors";
import { useEmployees } from "../../../data/schedule";
import {
  ALREADY_REVIEWED_MESSAGE,
  approveToast,
  denyConfirm,
  denyToast,
  groupNotApprovedMessage,
  removeApprovedConfirm,
  removeApprovedToast,
  type RequestItem,
} from "../../../lib/adminRequests";
import { buildShiftDeletionMessage, getApprovalConflicts, uniqueShiftIds } from "../../../lib/scheduleEditing";

/** The Requests drawer's toggle, so the toolbar's Requests button can move focus to it (D11). */
export const REQUESTS_TOGGLE_ID = "admin-requests-toggle";

export type ReviewAction = "approve" | "deny" | "remove";

export interface RequestReview {
  /**
   * Approves one request, or every day of a group (same kind and employee), all or nothing.
   * Resolves true once the list has changed under the admin: approved, or found already
   * reviewed or removed (for a group, the toast says whether days are still waiting). False
   * when the admin backed out or the save failed.
   */
  approve(items: readonly RequestItem[]): Promise<boolean>;
  /** Denies (deletes) pending requests after a confirm. Same result as approve. */
  deny(items: readonly RequestItem[]): Promise<boolean>;
  /** Takes back an approved request after a confirm (R5). Same result as approve. */
  remove(item: RequestItem): Promise<boolean>;
  /** The action running for each request id. */
  busy: ReadonlyMap<string, ReviewAction>;
}

const APPROVE_TIME_OFF_FAILED = "There was an error approving this time-off request.";
const DENY_TIME_OFF_FAILED = "There was an error deleting this time-off request.";
const AVAILABILITY_FAILED = "There was an error updating this availability request.";
const REMOVE_FAILED = "There was an error removing this request.";
const CLOSED_DAY = "This business day is closed, so the request can't be approved. Deny it, or reopen the day first.";

/** After "Approve all" on a group found some days no longer pending: nothing was approved. */
async function groupNotApprovedText(items: readonly RequestItem[]): Promise<string> {
  const first = items[0];
  if (!first) return ALREADY_REVIEWED_MESSAGE;
  const ids = items.map((item) => item.id);
  try {
    const pending = await fetchPendingRequestIds(first.kind, ids);
    return groupNotApprovedMessage(ids.length, ids.filter((id) => pending.has(id)).length);
  } catch {
    return groupNotApprovedMessage(ids.length, null);
  }
}

/**
 * Approve, deny and remove for the Requests drawer and the calendar's review dialog, with
 * their confirms and toasts. Checks run on rows read fresh at click time (C15).
 */
export function useRequestReview(): RequestReview {
  const confirm = useConfirm();
  const toast = useToast();
  const employees = useEmployees().data;
  const approveTimeOff = useApproveTimeOff();
  const denyTimeOff = useDenyTimeOff();
  const approveAvailability = useApproveAvailability();
  const denyAvailability = useDenyAvailability();
  const removeAvailability = useRemoveApprovedAvailability();
  const deleteItems = useDeleteScheduleItems();

  // The ref blocks a second click before the busy state has re-rendered.
  const running = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlyMap<string, ReviewAction>>(() => new Map());

  const run = async (
    items: readonly RequestItem[],
    action: ReviewAction,
    fallback: string,
    work: () => Promise<boolean>,
  ): Promise<boolean> => {
    const ids = items.map((item) => item.id);
    if (ids.length === 0 || ids.some((id) => running.current.has(id))) return false;
    for (const id of ids) running.current.add(id);
    setBusy((current) => new Map([...current, ...ids.map((id) => [id, action] as const)]));
    try {
      return await work();
    } catch (error) {
      const code = adminErrorCode(error);
      if (code === "request_not_pending") {
        // Approvals are all or nothing. For a group, say whether days are still waiting (R4).
        toast.show(items.length > 1 ? await groupNotApprovedText(items) : ALREADY_REVIEWED_MESSAGE, "info");
        return true;
      }
      toast.show(code === "closed_day" ? CLOSED_DAY : adminErrorMessage(error, fallback), "error");
      return false;
    } finally {
      for (const id of ids) running.current.delete(id);
      setBusy((current) => new Map([...current].filter(([id]) => !ids.includes(id))));
    }
  };

  const approve = async (items: readonly RequestItem[]): Promise<boolean> => {
    const first = items[0];
    if (!first) return false;
    const name = first.employeeName;

    if (first.kind === "availability") {
      return run(items, "approve", AVAILABILITY_FAILED, async () => {
        const { approved } = await approveAvailability.mutateAsync({ ids: items.map((item) => item.id) });
        const text = approveToast("availability", name, approved, 0);
        toast.show(text.message, "success", { title: text.title });
        return true;
      });
    }

    return run(items, "approve", APPROVE_TIME_OFF_FAILED, async () => {
      // Approving deletes the shifts the time off covers (R3); ask first when there are any (R9).
      const requests = items.map((item) => ({
        employee_id: item.employeeId,
        off_date: item.date,
        period: item.period,
      }));
      const rows = await fetchEditingRows({ employeeIds: [first.employeeId], dates: items.map((item) => item.date) });
      const conflicts = getApprovalConflicts(requests, rows.shifts, employees ?? []);
      const deleteShiftIds = uniqueShiftIds(conflicts);
      if (conflicts.length > 0) {
        const withHours = await fetchShiftIdsWithActuals(deleteShiftIds);
        const ok = await confirm({
          title: "Approve time off?",
          message: buildShiftDeletionMessage(conflicts, "approve", { payrollKept: withHours.size > 0 }),
          confirmLabel: "Approve and delete shifts",
          cancelLabel: "Cancel",
          tone: "danger",
        });
        if (!ok) return false;
      }
      const change = await approveTimeOff.mutateAsync({ ids: items.map((item) => item.id), deleteShiftIds });
      const text = approveToast("time-off", name, change.updated.time_off.length, change.deleted.shifts.length);
      toast.show(text.message, "success", { title: text.title });
      return true;
    });
  };

  const deny = async (items: readonly RequestItem[]): Promise<boolean> => {
    const first = items[0];
    if (!first) return false;
    const kind = first.kind;
    const name = first.employeeName;
    return run(items, "deny", kind === "time-off" ? DENY_TIME_OFF_FAILED : AVAILABILITY_FAILED, async () => {
      const text = denyConfirm(kind, name, items.length);
      if (!(await confirm({ ...text, tone: "danger" }))) return false;
      const ids = items.map((item) => item.id);
      const { deleted } =
        kind === "time-off" ? await denyTimeOff.mutateAsync({ ids }) : await denyAvailability.mutateAsync({ ids });
      if (deleted === 0) {
        toast.show(ALREADY_REVIEWED_MESSAGE, "info");
        return true;
      }
      // Count what was really deleted: some of a group may have been cancelled meanwhile.
      const done = denyToast(kind, name, deleted);
      toast.show(done.message, "info", { title: done.title });
      return true;
    });
  };

  const remove = async (item: RequestItem): Promise<boolean> =>
    run([item], "remove", REMOVE_FAILED, async () => {
      if (!(await confirm({ ...removeApprovedConfirm(item), tone: "danger" }))) return false;
      const removed =
        item.kind === "time-off"
          ? (await deleteItems.mutateAsync({ timeOffIds: [item.id] })).deleted.time_off.length
          : (await removeAvailability.mutateAsync({ id: item.id })).deleted;
      if (removed === 0) {
        toast.show(ALREADY_REVIEWED_MESSAGE, "info");
        return true;
      }
      const text = removeApprovedToast(item);
      toast.show(text.message, "success", { title: text.title });
      return true;
    });

  return { approve, deny, remove, busy };
}
