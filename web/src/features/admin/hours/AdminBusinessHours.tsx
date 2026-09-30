import { useCallback, useState } from "react";
import { useWeeklyHours } from "../../../data/hours";
import type { HoursSet } from "../../../lib/hours";
import { BusinessHoursDrawer } from "../../schedule/BusinessHoursDrawer";
import { useAdminView } from "../useAdminView";
import { WeeklyHoursDialog } from "./WeeklyHoursDialog";

const NO_SETS: readonly HoursSet[] = [];

/**
 * The admin sidebar's Business Hours section: the same lists as the employee page, plus
 * Set Hours / Edit Hours, which opens the weekly editor once the sets have loaded.
 */
export function AdminBusinessHours() {
  const { today } = useAdminView();
  const weekly = useWeeklyHours();
  const [editing, setEditing] = useState(false);
  const sets = weekly.data;
  // A failed read stays failed (with Retry) until it loads: react-query reports it as pending
  // again while it is tried again, and the Retry button must not vanish under focus.
  const failed = sets === undefined && (weekly.isError || weekly.errorUpdateCount > 0);
  const retrying = failed && weekly.isFetching;
  const closeEditor = useCallback(() => setEditing(false), []);

  return (
    <>
      <BusinessHoursDrawer
        sets={sets}
        failed={failed}
        retrying={retrying}
        onRetry={() => void weekly.refetch()}
        today={today}
        onEdit={() => {
          if (sets) setEditing(true);
        }}
      />
      <WeeklyHoursDialog open={editing && sets !== undefined} sets={sets ?? NO_SETS} today={today} onClose={closeEditor} />
    </>
  );
}
