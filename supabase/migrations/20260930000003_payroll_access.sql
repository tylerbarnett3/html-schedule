-- Follow-up to 20260930000002_hour_logs.sql. Run once in the Supabase SQL Editor, before
-- deploying the web app that uses it.
--
-- Payroll access for people who help with payroll but aren't admins. A login listed in
-- payroll_staff can review and edit payroll like an admin (every shift_actuals row, through
-- save_shift_actuals) and see the hours employees logged (hour_logs), but nothing else that is
-- admin-only: not pay rates, not the calendar editor, requests, employees or business hours.
-- They also need an employee record, as every non-admin login does, which lets them read the
-- schedule. Admins add or remove people here; nobody is added by this file.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.payroll_staff (
    user_id uuid primary key references auth.users (id) on delete cascade,
    created_at timestamptz not null default now()
);

alter table public.payroll_staff enable row level security;

create policy "users can see their own payroll staff row" on public.payroll_staff
    for select to authenticated using (user_id = (select auth.uid()));
create policy "admins manage payroll staff" on public.payroll_staff
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- The schema's default privileges grant every table to anon; this one is never needed signed out.
-- Signed in, row-level security covers reads and writes, but not these.
revoke all on table public.payroll_staff from anon;
revoke truncate, references, trigger on table public.payroll_staff from authenticated;

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

-- True for admins and payroll staff. The app can call this via rpc('can_edit_payroll').
create function public.can_edit_payroll()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select public.is_admin() or exists (select 1 from public.payroll_staff where user_id = auth.uid());
$$;

-- Like assert_admin, for the payroll functions: refuses anyone else with 'not_admin'.
create function public.assert_payroll()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if not public.can_edit_payroll() then
        raise exception 'not_admin' using errcode = '42501';
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: payroll staff work with payroll and read logged hours
-- ---------------------------------------------------------------------------

create policy "payroll staff manage actuals" on public.shift_actuals
    for all to authenticated
    using ((select public.can_edit_payroll())) with check ((select public.can_edit_payroll()));
create policy "payroll staff read hour logs" on public.hour_logs
    for select to authenticated using ((select public.can_edit_payroll()));

-- ---------------------------------------------------------------------------
-- Saving payroll: unchanged from 20260929000001_admin.sql except that payroll staff may too
-- ---------------------------------------------------------------------------

create or replace function public.save_shift_actuals(p_plan jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    delete_ids jsonb := coalesce(p_plan -> 'delete_ids', '[]'::jsonb);
    scheduled jsonb := coalesce(p_plan -> 'scheduled', '[]'::jsonb);
    actual_only jsonb := coalesce(p_plan -> 'actual_only', '[]'::jsonb);
    deleted integer;
    saved_scheduled integer;
    saved_actual_only integer;
begin
    perform public.assert_payroll();
    if jsonb_typeof(p_plan) is distinct from 'object'
        or jsonb_typeof(delete_ids) <> 'array'
        or jsonb_typeof(scheduled) <> 'array'
        or jsonb_typeof(actual_only) <> 'array'
        or exists (select 1 from jsonb_array_elements(scheduled) x where x ->> 'shift_id' is null)
        or exists (
            select 1 from jsonb_array_elements(actual_only) x
            where x ->> 'employee_id' is null or x ->> 'work_date' is null
        ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_array_elements(scheduled) x
        where not exists (select 1 from public.shifts s where s.id = (x ->> 'shift_id')::uuid)
    ) then
        raise exception 'not_found' using errcode = 'P0002';
    end if;

    with removed as (
        delete from public.shift_actuals a
        where a.id in (select (d #>> '{}')::uuid from jsonb_array_elements(delete_ids) d)
        returning a.id
    )
    select count(*) into deleted from removed;

    begin
        with upserted as (
            insert into public.shift_actuals as a
                (shift_id, employee_id, work_date, start_time, end_time, status, note, actualized_at)
            select s.id,
                case when x.status = 'not-worked' then s.employee_id else x.employee_id end,
                s.shift_date,
                case when x.status = 'not-worked' then null else x.start_time end,
                case when x.status = 'not-worked' then null else x.end_time end,
                x.status,
                coalesce(x.note, ''),
                now()
            from jsonb_to_recordset(scheduled) as x(
                shift_id uuid, employee_id uuid, status public.actual_status,
                start_time time, end_time time, note text
            )
            join public.shifts s on s.id = x.shift_id
            on conflict (shift_id) do update
            set employee_id = excluded.employee_id, work_date = excluded.work_date,
                start_time = excluded.start_time, end_time = excluded.end_time,
                status = excluded.status, note = excluded.note, actualized_at = excluded.actualized_at
            returning a.id
        )
        select count(*) into saved_scheduled from upserted;
    exception
        when foreign_key_violation then
            raise exception 'not_found' using errcode = 'P0002', detail = sqlerrm;
    end;

    with upserted as (
        insert into public.shift_actuals as a
            (id, shift_id, employee_id, work_date, start_time, end_time, status, note, actualized_at)
        select coalesce(x.id, gen_random_uuid()), null, x.employee_id, x.work_date,
            x.start_time, x.end_time, 'unscheduled', coalesce(x.note, ''), now()
        from jsonb_to_recordset(actual_only) as x(
            id uuid, employee_id uuid, work_date date, start_time time, end_time time, note text
        )
        on conflict (id) do update
        set shift_id = null, employee_id = excluded.employee_id, work_date = excluded.work_date,
            start_time = excluded.start_time, end_time = excluded.end_time,
            status = excluded.status, note = excluded.note, actualized_at = excluded.actualized_at
        returning a.id
    )
    select count(*) into saved_actual_only from upserted;

    return jsonb_build_object('deleted', deleted, 'saved', saved_scheduled + saved_actual_only);
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

revoke execute on function public.can_edit_payroll() from public, anon;
revoke execute on function public.assert_payroll() from public, anon;
revoke execute on function public.save_shift_actuals(jsonb) from public, anon;

grant execute on function public.can_edit_payroll() to authenticated;
grant execute on function public.assert_payroll() to authenticated;
grant execute on function public.save_shift_actuals(jsonb) to authenticated;
