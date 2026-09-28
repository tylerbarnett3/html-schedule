-- Follow-up to 001_schema.sql. Run once in the Supabase SQL Editor.
--
-- 1. Only admins and logins linked to an employee can read the schedule. Before this,
--    any logged-in account could, including one not linked to an employee.
-- 2. When an employee submits time off or availability, who submitted it and when are
--    set by the database, so they can't be filled in by hand.

-- True for admins and for logins linked to an employee.
create function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.admins where user_id = auth.uid())
        or exists (select 1 from public.employees where user_id = auth.uid());
$$;

alter policy "logged-in users can read employees" on public.employees
    using ((select public.is_staff()));
alter policy "logged-in users can read shifts" on public.shifts
    using ((select public.is_staff()));
alter policy "logged-in users can read time off" on public.time_off
    using ((select public.is_staff()));
alter policy "logged-in users can read availability" on public.availability
    using ((select public.is_staff()));
alter policy "logged-in users can read closed days" on public.closed_days
    using ((select public.is_staff()));

alter policy "logged-in users can read employees" on public.employees
    rename to "staff can read employees";
alter policy "logged-in users can read shifts" on public.shifts
    rename to "staff can read shifts";
alter policy "logged-in users can read time off" on public.time_off
    rename to "staff can read time off";
alter policy "logged-in users can read availability" on public.availability
    rename to "staff can read availability";
alter policy "logged-in users can read closed days" on public.closed_days
    rename to "staff can read closed days";

-- Only applies to logged-in non-admins; admins and the import script (no login) keep
-- the values they send.
create function public.stamp_employee_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if auth.uid() is not null and not public.is_admin() then
        new.requested_by := auth.uid();
        new.requested_at := now();
        new.reviewed_at := null;
    end if;
    return new;
end;
$$;

create trigger stamp_employee_request before insert on public.time_off
    for each row execute function public.stamp_employee_request();
create trigger stamp_employee_request before insert on public.availability
    for each row execute function public.stamp_employee_request();
