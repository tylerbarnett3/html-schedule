-- Schedule app schema for Supabase.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- Replaces the Wix collections:
--   Employees      -> employees
--   EmployeeRates  -> employee_rates
--   Shifts         -> shifts, time_off, shift_actuals (split by record type)
--   Availability   -> availability
--   ClosedDays     -> closed_days
--
-- Enum values match the strings the current app already uses ('full-day', etc.).
-- wix_id columns record where each row came from so the import can be re-run safely.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.day_period as enum ('full-day', 'morning', 'evening');
create type public.request_status as enum ('pending', 'approved');
create type public.actual_status as enum ('confirmed', 'adjusted', 'not-worked', 'unscheduled');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Users who can use the edit (owner/admin) screens. Add rows from the dashboard.
create table public.admins (
    user_id uuid primary key references auth.users (id) on delete cascade,
    created_at timestamptz not null default now()
);

create table public.employees (
    id uuid primary key default gen_random_uuid(),
    -- Login account for this employee; null until they are given one.
    user_id uuid unique references auth.users (id) on delete set null,
    name text not null check (btrim(name) <> ''),
    color text not null default '#7F6C50',
    display_order integer not null default 0,
    archived boolean not null default false,
    wix_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.employee_rates (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references public.employees (id) on delete cascade,
    rate numeric(10, 2) not null check (rate >= 0),
    -- Null start/end means open-ended, same as the current app.
    start_date date,
    end_date date,
    wix_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (start_date is null or end_date is null or start_date <= end_date)
);

-- Scheduled shifts only. Days off and time off live in time_off.
create table public.shifts (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references public.employees (id) on delete cascade,
    shift_date date not null,
    start_time time not null,
    -- An end_time earlier than start_time means the shift runs past midnight.
    end_time time not null,
    wix_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (start_time <> end_time)
);

-- Employee time-off requests and admin-assigned days off.
-- Denied requests are deleted, matching the current app.
create table public.time_off (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references public.employees (id) on delete cascade,
    off_date date not null,
    period public.day_period not null default 'full-day',
    status public.request_status not null default 'pending',
    -- 'request' = submitted by the employee, 'assigned' = day off set by the admin.
    source text not null default 'request' check (source in ('request', 'assigned')),
    requested_by uuid default auth.uid() references auth.users (id) on delete set null,
    requested_at timestamptz not null default now(),
    reviewed_at timestamptz,
    wix_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (employee_id, off_date, period),
    check (source = 'request' or status = 'approved')
);

create table public.availability (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references public.employees (id) on delete cascade,
    available_date date not null,
    period public.day_period not null default 'full-day',
    status public.request_status not null default 'pending',
    requested_by uuid default auth.uid() references auth.users (id) on delete set null,
    requested_at timestamptz not null default now(),
    reviewed_at timestamptz,
    wix_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (employee_id, available_date, period)
);

-- What actually happened, for payroll. Each row is self-contained (employee,
-- date, times) so payroll still adds up if the scheduled shift is later deleted.
create table public.shift_actuals (
    id uuid primary key default gen_random_uuid(),
    -- The scheduled shift this confirms or adjusts; null for unscheduled work.
    shift_id uuid unique references public.shifts (id) on delete set null,
    -- Who actually worked, which may differ from the scheduled employee.
    employee_id uuid not null references public.employees (id) on delete cascade,
    work_date date not null,
    start_time time,
    end_time time,
    status public.actual_status not null,
    note text not null default '',
    actualized_at timestamptz not null default now(),
    wix_id text unique,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (
        status = 'not-worked'
        or (start_time is not null and end_time is not null and start_time <> end_time)
    ),
    check (status <> 'unscheduled' or shift_id is null)
);

create table public.closed_days (
    closed_date date primary key,
    created_at timestamptz not null default now()
);

create index shifts_date_idx on public.shifts (shift_date);
create index shifts_employee_idx on public.shifts (employee_id);
create index employee_rates_employee_idx on public.employee_rates (employee_id);
create index time_off_date_idx on public.time_off (off_date);
create index availability_date_idx on public.availability (available_date);
create index shift_actuals_date_idx on public.shift_actuals (work_date);
create index shift_actuals_employee_idx on public.shift_actuals (employee_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create trigger set_updated_at before update on public.employees
    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.employee_rates
    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.shifts
    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.time_off
    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.availability
    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.shift_actuals
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

-- True when the logged-in user is in admins. The app can call this via rpc('is_admin').
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- The employees.id linked to the logged-in user, or null.
create function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
    select id from public.employees where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Everyone must be logged in to see anything.
-- Admins can do everything.
-- Employees can read the schedule, and create or cancel their own pending
-- time-off and availability requests. They cannot see pay rates or actuals.
-- ---------------------------------------------------------------------------

alter table public.admins enable row level security;
alter table public.employees enable row level security;
alter table public.employee_rates enable row level security;
alter table public.shifts enable row level security;
alter table public.time_off enable row level security;
alter table public.availability enable row level security;
alter table public.shift_actuals enable row level security;
alter table public.closed_days enable row level security;

create policy "users can see their own admin row" on public.admins
    for select to authenticated
    using (user_id = (select auth.uid()));

-- employees
create policy "logged-in users can read employees" on public.employees
    for select to authenticated using (true);
create policy "admins manage employees" on public.employees
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- employee_rates (admin only)
create policy "admins manage rates" on public.employee_rates
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- shifts
create policy "logged-in users can read shifts" on public.shifts
    for select to authenticated using (true);
create policy "admins manage shifts" on public.shifts
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- time_off
create policy "logged-in users can read time off" on public.time_off
    for select to authenticated using (true);
create policy "admins manage time off" on public.time_off
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "employees request their own time off" on public.time_off
    for insert to authenticated
    with check (
        employee_id = (select public.current_employee_id())
        and status = 'pending'
        and source = 'request'
    );
create policy "employees cancel their own pending time off" on public.time_off
    for delete to authenticated
    using (
        employee_id = (select public.current_employee_id())
        and status = 'pending'
    );

-- availability
create policy "logged-in users can read availability" on public.availability
    for select to authenticated using (true);
create policy "admins manage availability" on public.availability
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "employees submit their own availability" on public.availability
    for insert to authenticated
    with check (
        employee_id = (select public.current_employee_id())
        and status = 'pending'
    );
create policy "employees cancel their own pending availability" on public.availability
    for delete to authenticated
    using (
        employee_id = (select public.current_employee_id())
        and status = 'pending'
    );

-- shift_actuals (admin only)
create policy "admins manage actuals" on public.shift_actuals
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- closed_days
create policy "logged-in users can read closed days" on public.closed_days
    for select to authenticated using (true);
create policy "admins manage closed days" on public.closed_days
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));
