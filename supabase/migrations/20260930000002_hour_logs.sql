-- Follow-up to 20260930000001_business_hours.sql. Run once in the Supabase SQL Editor, before
-- deploying the web app that uses it.
--
-- Logged hours ("Log My Hours"): an employee's own account of when they worked one of their
-- shifts, for the admin to see while reviewing payroll. Logging isn't a payroll review: the
-- shift still needs one, and payroll still counts only shift_actuals.
--
-- An employee can log a shift of their own from Sep 28, 2026 on, once it has ended (New York
-- time), until the admin has reviewed it in payroll (saved its shift_actuals row). Until then
-- they can change or remove what they logged; after that it can't be changed.
--
-- Employees can't read shift_actuals, so they read and write logs only through the functions
-- below. Admins read the table directly.
--
-- A log belongs to its shift: deleting the shift (or undoing its add) hides the log with it,
-- and undoing the delete brings both back.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.hour_logs (
    -- One log per shift. No foreign key to shifts: undo puts a deleted shift back under its
    -- old id, and its log comes back with it. Logs of shifts that stay deleted aren't shown.
    shift_id uuid primary key,
    -- Who logged it (the shift's employee at the time).
    employee_id uuid not null references public.employees (id) on delete cascade,
    start_time time not null,
    -- An end_time earlier than start_time means the work ran past midnight, as on shifts.
    end_time time not null,
    note text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint hour_logs_times check (start_time <> end_time),
    constraint hour_logs_whole_minutes check (extract(second from start_time) = 0 and extract(second from end_time) = 0),
    constraint hour_logs_note_length check (char_length(note) <= 160)
);

create index hour_logs_employee_idx on public.hour_logs (employee_id);

create trigger set_updated_at before update on public.hour_logs
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: admins read (and manage) every log; employees use the functions below
-- ---------------------------------------------------------------------------

alter table public.hour_logs enable row level security;

create policy "admins manage hour logs" on public.hour_logs
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- The schema's default privileges grant every table to anon; this one is never needed signed out.
-- Signed in, row-level security covers reads and writes, but not these.
revoke all on table public.hour_logs from anon;
revoke truncate, references, trigger on table public.hour_logs from authenticated;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

-- Why this employee can't log (or change the log of) this shift now, or null when they can:
--   not_found         not their shift, or from before Sep 28, 2026 (when logging started)
--   shift_not_over    it hasn't ended yet; a shift whose end is before its start ends the next day
--   already_reviewed  the admin has reviewed it in payroll
-- Runs with the rights of the function calling it, which can read shift_actuals.
create function public.hour_log_refusal(p_shift public.shifts, p_employee_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
    select case
        when p_shift.id is null
            or p_shift.employee_id is distinct from p_employee_id
            or p_shift.shift_date < date '2026-09-28' then 'not_found'
        when ((p_shift.shift_date + p_shift.end_time)
                + case when p_shift.end_time < p_shift.start_time then interval '1 day' else interval '0 days' end)
             at time zone 'America/New_York' > now() then 'shift_not_over'
        when exists (select 1 from public.shift_actuals a where a.shift_id = p_shift.id) then 'already_reviewed'
    end;
$$;

-- ---------------------------------------------------------------------------
-- Employee functions
-- ---------------------------------------------------------------------------

-- The signed-in employee's shifts they can log now, newest first, each with what they logged
-- (null when nothing yet). Empty for a login that isn't an employee, or whose employee is archived.
create function public.my_loggable_shifts()
returns table (
    shift_id uuid,
    shift_date date,
    start_time time,
    end_time time,
    logged_start time,
    logged_end time,
    logged_note text,
    logged_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
    select s.id, s.shift_date, s.start_time, s.end_time, l.start_time, l.end_time, l.note, l.updated_at
    from public.shifts s
    left join public.hour_logs l on l.shift_id = s.id and l.employee_id = s.employee_id
    where s.employee_id = public.current_employee_id()
      and not exists (select 1 from public.employees e where e.id = s.employee_id and e.archived)
      and public.hour_log_refusal(s, s.employee_id) is null
    order by s.shift_date desc, s.start_time desc, s.id;
$$;

-- Checks that the signed-in employee may log this shift now and returns their employee id.
-- Locks the shift, so the admin can't save a payroll review of it at the same moment (saving
-- one takes a key-share lock on the shift) and two tabs can't log it at once.
create function public.lock_loggable_shift(p_shift_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
    me uuid := public.current_employee_id();
    shift public.shifts%rowtype;
    refusal text;
begin
    if me is null then
        raise exception 'not_linked' using errcode = '42501';
    end if;
    if exists (select 1 from public.employees where id = me and archived) then
        raise exception 'employee_archived' using errcode = '42501';
    end if;
    select * into shift from public.shifts s where s.id = p_shift_id for update;
    refusal := public.hour_log_refusal(shift, me);
    if refusal = 'not_found' then
        raise exception 'not_found' using errcode = 'P0002';
    elsif refusal is not null then
        raise exception '%', refusal;
    end if;
    return me;
end;
$$;

-- Saves what the signed-in employee worked on one of their shifts (a new log, or a change to
-- theirs). Times are whole minutes; the note is trimmed, up to 160 characters.
create function public.log_shift_hours(p_shift_id uuid, p_start time, p_end time, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid;
    note text := btrim(coalesce(p_note, ''));
begin
    me := public.lock_loggable_shift(p_shift_id);
    if p_start is null or p_end is null or p_start = p_end
        or extract(second from p_start) <> 0 or extract(second from p_end) <> 0
        or char_length(note) > 160 then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    insert into public.hour_logs (shift_id, employee_id, start_time, end_time, note)
    values (p_shift_id, me, p_start, p_end, note)
    on conflict (shift_id) do update
    set employee_id = excluded.employee_id, start_time = excluded.start_time,
        end_time = excluded.end_time, note = excluded.note;
end;
$$;

-- Removes what the signed-in employee logged for one of their shifts. Returns false when
-- there was nothing to remove.
create function public.remove_hour_log(p_shift_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid;
begin
    me := public.lock_loggable_shift(p_shift_id);
    delete from public.hour_logs where shift_id = p_shift_id and employee_id = me;
    return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

-- The helpers are only called from the functions above, never directly.
revoke execute on function public.hour_log_refusal(public.shifts, uuid) from public, anon, authenticated;
revoke execute on function public.lock_loggable_shift(uuid) from public, anon, authenticated;

revoke execute on function public.my_loggable_shifts() from public, anon;
revoke execute on function public.log_shift_hours(uuid, time, time, text) from public, anon;
revoke execute on function public.remove_hour_log(uuid) from public, anon;

grant execute on function public.my_loggable_shifts() to authenticated;
grant execute on function public.log_shift_hours(uuid, time, time, text) to authenticated;
grant execute on function public.remove_hour_log(uuid) to authenticated;
