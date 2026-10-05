-- Follow-up to 20260930000003_payroll_access.sql. Run once in the Supabase SQL Editor, before
-- deploying the web app that uses it.
--
-- The schedule shows what payroll recorded for each reviewed shift: the actual times (and who
-- worked them) in place of the scheduled ones, no card for a shift that wasn't worked, and
-- unscheduled work as a card of its own. Employees can't read shift_actuals, so everyone on
-- staff reads that part of it through reviewed_shifts: the employee, date, times and outcome,
-- never the payroll note. Nothing is changed or removed by this file.

-- Payroll records for a date range: those dated in it, plus those of the range's shifts (a
-- record normally shares its shift's date; a trigger keeps them together). Admins and logins
-- linked to an employee get rows; anyone else gets none. The app calls this via
-- rpc('reviewed_shifts').
create function public.reviewed_shifts(p_start date, p_end date)
returns table (
    id uuid,
    shift_id uuid,
    employee_id uuid,
    work_date date,
    start_time time,
    end_time time,
    status public.actual_status
)
language sql
stable
security definer
set search_path = ''
as $$
    select a.id, a.shift_id, a.employee_id, a.work_date, a.start_time, a.end_time, a.status
    from public.shift_actuals a
    where public.is_staff()
      and (
          a.work_date between p_start and p_end
          or a.shift_id in (select s.id from public.shifts s where s.shift_date between p_start and p_end)
      );
$$;

revoke execute on function public.reviewed_shifts(date, date) from public, anon;
grant execute on function public.reviewed_shifts(date, date) to authenticated;
