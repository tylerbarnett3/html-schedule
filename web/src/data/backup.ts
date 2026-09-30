import { buildBackupFile, type BackupFile } from "../lib/backup";
import { supabase } from "../lib/supabase";
import { fetchAll } from "./schedule";

/**
 * Reads every row of the ten schedule tables for Export Backup (admin RLS lets the admin
 * read them all). Ordered by id, so paging can't skip or repeat rows; closed_days,
 * custom_hours and hour_logs have no id and are ordered by their keys. The tables are read side by
 * side, not as one snapshot, which is fine for a studio-sized schedule that one admin edits.
 */
export async function fetchBackup(): Promise<BackupFile> {
  const exportedAt = new Date();
  const [
    employees,
    employee_rates,
    shifts,
    time_off,
    availability,
    shift_actuals,
    closed_days,
    weekly_hours,
    custom_hours,
    hour_logs,
  ] = await Promise.all([
    fetchAll((from, to) => supabase.from("employees").select("*").order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("employee_rates").select("*").order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("shifts").select("*").order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("time_off").select("*").order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("availability").select("*").order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("shift_actuals").select("*").order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("closed_days").select("*").order("closed_date").range(from, to)),
    fetchAll((from, to) => supabase.from("weekly_hours").select("*").order("id").range(from, to)),
    fetchAll((from, to) => supabase.from("custom_hours").select("*").order("hours_date").range(from, to)),
    fetchAll((from, to) => supabase.from("hour_logs").select("*").order("shift_id").range(from, to)),
  ]);
  return buildBackupFile(
    {
      employees,
      employee_rates,
      shifts,
      time_off,
      availability,
      shift_actuals,
      closed_days,
      weekly_hours,
      custom_hours,
      hour_logs,
    },
    exportedAt,
  );
}
