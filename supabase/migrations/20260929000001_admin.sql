-- Follow-up to 20260928000003_request_rules.sql. Run once in the Supabase SQL Editor.
--
-- Adds what the admin screens need:
--   - rate, color and shift constraints (rates > 0 and never overlapping, colors are hex
--     codes, no two identical shifts)
--   - payroll actuals follow their shift when the shift moves to another day
--   - database functions for every multi-row admin change, so each one saves all or nothing:
--     calendar edits (with undo), request approval, employees and payroll actuals
--
-- Every function here runs as the signed-in user (row level security still applies) and
-- refuses anyone who isn't an admin with 'not_admin'.
--
-- Pre-flight: before applying this to a database with real data, run these. Each must
-- return 0 rows, or the new constraints below will fail to apply.
--
--   -- rates that aren't above zero
--   select * from public.employee_rates where rate <= 0;
--
--   -- overlapping rate periods for one employee (null dates are open-ended)
--   select a.employee_id, a.id as rate_a, b.id as rate_b
--   from public.employee_rates a
--   join public.employee_rates b on b.employee_id = a.employee_id and a.id < b.id
--   where daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]');
--
--   -- colors that aren't #RRGGBB
--   select * from public.employees where color !~ '^#[0-9A-Fa-f]{6}$';
--
--   -- identical shifts
--   select employee_id, shift_date, start_time, end_time, count(*)
--   from public.shifts group by 1, 2, 3, 4 having count(*) > 1;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

create extension if not exists btree_gist with schema extensions;

alter table public.employee_rates drop constraint if exists employee_rates_rate_check;
alter table public.employee_rates add constraint employee_rates_rate_positive check (rate > 0);

-- Null start or end means open-ended; both ends are inclusive. Deferred so one save can
-- move several periods at once; save_employee checks it before returning.
alter table public.employee_rates add constraint employee_rates_no_overlap
    exclude using gist (employee_id with =, daterange(start_date, end_date, '[]') with &&)
    deferrable initially deferred;

alter table public.employees add constraint employees_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$');

alter table public.shifts add constraint shifts_unique_slot unique (employee_id, shift_date, start_time, end_time);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- An actual follows its shift's date when the shift is dragged or edited to another day.
create function public.sync_actual_work_date()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    update public.shift_actuals set work_date = new.shift_date where shift_id = new.id;
    return null;
end;
$$;

create trigger sync_actual_work_date after update of shift_date on public.shifts
    for each row when (old.shift_date is distinct from new.shift_date)
    execute function public.sync_actual_work_date();

-- admin_undo puts back a shift's or time off's previous updated_at along with its other
-- values, so the undo step before it still sees the row as unchanged.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_table_name in ('shifts', 'time_off')
        and current_setting('schedule.keep_updated_at', true) = 'on' then
        return new;
    end if;
    new.updated_at = now();
    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers used by the functions below
-- ---------------------------------------------------------------------------

create function public.assert_admin()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'not_admin' using errcode = '42501';
    end if;
end;
$$;

-- Raises 'closed_day' (detail: the first closed date) when any of the dates is closed.
create function public.assert_open(p_dates date[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
    first_closed date;
begin
    perform public.assert_admin();
    select c.closed_date into first_closed
    from public.closed_days c
    where c.closed_date = any(p_dates)
    order by c.closed_date
    limit 1;
    if first_closed is not null then
        raise exception 'closed_day' using detail = to_char(first_closed, 'YYYY-MM-DD');
    end if;
end;
$$;

-- Deletes the shifts and returns {"shifts": [deleted rows], "actual_links": [{actual_id, shift_id}]}.
-- Their actuals are kept (shift_id becomes null); the links let admin_undo reattach them.
create function public.capture_delete_shifts(p_ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    links jsonb;
    deleted jsonb;
begin
    perform public.assert_admin();
    perform 1 from public.shifts s where s.id = any(p_ids) for update;
    select coalesce(jsonb_agg(jsonb_build_object('actual_id', a.id, 'shift_id', a.shift_id) order by a.id), '[]'::jsonb)
    into links
    from public.shift_actuals a
    where a.shift_id = any(p_ids);
    with removed as (
        delete from public.shifts s where s.id = any(p_ids) returning s.*
    )
    select coalesce(jsonb_agg(to_jsonb(removed) order by removed.shift_date, removed.start_time, removed.id), '[]'::jsonb)
    into deleted
    from removed;
    return jsonb_build_object('shifts', deleted, 'actual_links', links);
end;
$$;

-- The ScheduleChange shape with every list empty, stamped with the time the change is made
-- (the calling function's transaction time, which is also the updated_at of the rows it saves).
create function public.empty_change()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
    perform public.assert_admin();
    return jsonb_build_object(
        'made_at', now(),
        'inserted', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb, 'closed_days', '[]'::jsonb),
        'updated', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb),
        'deleted', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb, 'closed_days', '[]'::jsonb,
            'actual_links', '[]'::jsonb)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Calendar changes. Each returns a ScheduleChange:
--   {"inserted": {"shifts": [row], "time_off": [row], "closed_days": ["YYYY-MM-DD"]},
--    "updated":  {"shifts": [{"before": row, "after": row}], "time_off": [...]},
--    "deleted":  {"shifts": [row], "time_off": [row], "closed_days": [...], "actual_links": [...]}}
-- which the page keeps so admin_undo can reverse it.
-- ---------------------------------------------------------------------------

-- p_shifts: [{employee_id, shift_date, start_time, end_time}]. The page checks overlaps and
-- time off first, on rows it fetches fresh.
create function public.admin_add_shifts(p_shifts jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    added jsonb;
begin
    perform public.assert_admin();
    if jsonb_typeof(p_shifts) is distinct from 'array' or jsonb_array_length(p_shifts) = 0
        or exists (
            select 1 from jsonb_array_elements(p_shifts) x
            where jsonb_typeof(x) <> 'object'
               or x ->> 'employee_id' is null or x ->> 'shift_date' is null
               or x ->> 'start_time' is null or x ->> 'end_time' is null
        ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    perform public.assert_open(array(select (x ->> 'shift_date')::date from jsonb_array_elements(p_shifts) x));
    with inserted as (
        insert into public.shifts (employee_id, shift_date, start_time, end_time)
        select (x ->> 'employee_id')::uuid, (x ->> 'shift_date')::date,
            (x ->> 'start_time')::time, (x ->> 'end_time')::time
        from jsonb_array_elements(p_shifts) x
        returning *
    )
    select coalesce(jsonb_agg(to_jsonb(inserted) order by inserted.shift_date, inserted.start_time, inserted.id), '[]'::jsonb)
    into added
    from inserted;
    return jsonb_set(public.empty_change(), '{inserted,shifts}', added);
end;
$$;

-- p_days: [{employee_id, off_date, period}]. Adds approved, admin-assigned days off. Refuses
-- a day that overlaps the employee's pending request ('pending_request', detail: that request
-- as JSON) or approved time off ('day_off_overlap'). Also deletes p_delete_shift_ids, but only
-- shifts of the same employee on the same day as one of the new days off.
create function public.admin_add_days_off(p_days jsonb, p_delete_shift_ids uuid[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    change jsonb;
    new_day record;
    blocking public.time_off%rowtype;
    added public.time_off%rowtype;
    added_rows jsonb := '[]'::jsonb;
    removed jsonb;
begin
    perform public.assert_admin();
    if jsonb_typeof(p_days) is distinct from 'array' or jsonb_array_length(p_days) = 0
        or exists (
            select 1 from jsonb_array_elements(p_days) x
            where jsonb_typeof(x) <> 'object'
               or x ->> 'employee_id' is null or x ->> 'off_date' is null or x ->> 'period' is null
        ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    perform public.assert_open(array(select (x ->> 'off_date')::date from jsonb_array_elements(p_days) x));

    for new_day in
        select (x ->> 'employee_id')::uuid as employee_id, (x ->> 'off_date')::date as off_date,
            (x ->> 'period')::public.day_period as period
        from jsonb_array_elements(p_days) x
        order by 2, 1
    loop
        -- Same lock as employee requests, so a request and a day off can't cross.
        perform pg_advisory_xact_lock(hashtextextended('time_off' || new_day.employee_id || new_day.off_date, 0));
        select t.* into blocking
        from public.time_off t
        where t.employee_id = new_day.employee_id and t.off_date = new_day.off_date
          and public.periods_overlap(t.period, new_day.period)
        order by t.status = 'pending' desc, t.id
        limit 1;
        if found and blocking.status = 'pending' then
            raise exception 'pending_request' using detail = jsonb_build_object(
                'employee_id', blocking.employee_id, 'off_date', blocking.off_date, 'period', blocking.period)::text;
        elsif found then
            raise exception 'day_off_overlap' using errcode = '23P01', detail = jsonb_build_object(
                'employee_id', blocking.employee_id, 'off_date', blocking.off_date, 'period', blocking.period)::text;
        end if;
        insert into public.time_off (employee_id, off_date, period, status, source, reviewed_at)
        values (new_day.employee_id, new_day.off_date, new_day.period, 'approved', 'assigned', null)
        returning * into added;
        added_rows := added_rows || jsonb_build_array(to_jsonb(added));
    end loop;

    removed := public.capture_delete_shifts(array(
        select s.id from public.shifts s
        where s.id = any(coalesce(p_delete_shift_ids, '{}'))
          and exists (
              select 1 from jsonb_array_elements(p_days) x
              where (x ->> 'employee_id')::uuid = s.employee_id and (x ->> 'off_date')::date = s.shift_date
          )
    ));

    change := jsonb_set(public.empty_change(), '{inserted,time_off}', added_rows);
    change := jsonb_set(change, '{deleted,shifts}', removed -> 'shifts');
    return jsonb_set(change, '{deleted,actual_links}', removed -> 'actual_links');
end;
$$;

-- Edit or drag-move a shift. Its actual (if any) follows a date change (trigger above).
create function public.admin_update_shift(
    p_id uuid, p_employee_id uuid, p_shift_date date, p_start_time time, p_end_time time
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    before_row public.shifts%rowtype;
    after_row public.shifts%rowtype;
begin
    perform public.assert_admin();
    if p_id is null or p_employee_id is null or p_shift_date is null
        or p_start_time is null or p_end_time is null then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    select * into before_row from public.shifts where id = p_id for update;
    if not found then
        raise exception 'not_found' using errcode = 'P0002';
    end if;
    perform public.assert_open(array[p_shift_date]);
    update public.shifts
    set employee_id = p_employee_id, shift_date = p_shift_date, start_time = p_start_time, end_time = p_end_time
    where id = p_id
    returning * into after_row;
    return jsonb_set(public.empty_change(), '{updated,shifts}',
        jsonb_build_array(jsonb_build_object('before', to_jsonb(before_row), 'after', to_jsonb(after_row))));
end;
$$;

-- Edit or drag-move an approved day off. A day off the employee requested can change date
-- and period but not employee ('request_locked'). Deletes p_delete_shift_ids that belong to
-- p_employee_id on p_off_date.
create function public.admin_update_day_off(
    p_id uuid, p_employee_id uuid, p_off_date date, p_period public.day_period,
    p_delete_shift_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    before_row public.time_off%rowtype;
    after_row public.time_off%rowtype;
    blocking public.time_off%rowtype;
    removed jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    if p_id is null or p_employee_id is null or p_off_date is null or p_period is null then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    select * into before_row from public.time_off where id = p_id for update;
    if not found then
        raise exception 'not_found' using errcode = 'P0002';
    end if;
    if before_row.status <> 'approved' then
        raise exception 'not_editable';
    end if;
    if before_row.source = 'request' and before_row.employee_id <> p_employee_id then
        raise exception 'request_locked';
    end if;
    perform public.assert_open(array[p_off_date]);

    perform pg_advisory_xact_lock(hashtextextended('time_off' || p_employee_id || p_off_date, 0));
    select t.* into blocking
    from public.time_off t
    where t.employee_id = p_employee_id and t.off_date = p_off_date and t.id <> p_id
      and public.periods_overlap(t.period, p_period)
    order by t.status = 'pending' desc, t.id
    limit 1;
    if found and blocking.status = 'pending' then
        raise exception 'pending_request' using detail = jsonb_build_object(
            'employee_id', blocking.employee_id, 'off_date', blocking.off_date, 'period', blocking.period)::text;
    elsif found then
        raise exception 'day_off_overlap' using errcode = '23P01', detail = jsonb_build_object(
            'employee_id', blocking.employee_id, 'off_date', blocking.off_date, 'period', blocking.period)::text;
    end if;

    update public.time_off
    set employee_id = p_employee_id, off_date = p_off_date, period = p_period
    where id = p_id
    returning * into after_row;

    removed := public.capture_delete_shifts(array(
        select s.id from public.shifts s
        where s.id = any(coalesce(p_delete_shift_ids, '{}'))
          and s.employee_id = p_employee_id and s.shift_date = p_off_date
    ));

    change := jsonb_set(public.empty_change(), '{updated,time_off}',
        jsonb_build_array(jsonb_build_object('before', to_jsonb(before_row), 'after', to_jsonb(after_row))));
    change := jsonb_set(change, '{deleted,shifts}', removed -> 'shifts');
    return jsonb_set(change, '{deleted,actual_links}', removed -> 'actual_links');
end;
$$;

-- Replace a shift with an assigned day off (same checks as admin_add_days_off). Also deletes
-- p_delete_shift_ids that belong to p_employee_id on p_off_date.
create function public.admin_convert_to_day_off(
    p_shift_id uuid, p_employee_id uuid, p_off_date date, p_period public.day_period,
    p_delete_shift_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    blocking public.time_off%rowtype;
    added public.time_off%rowtype;
    removed jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    if p_shift_id is null or p_employee_id is null or p_off_date is null or p_period is null then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    perform 1 from public.shifts where id = p_shift_id for update;
    if not found then
        raise exception 'not_found' using errcode = 'P0002';
    end if;
    perform public.assert_open(array[p_off_date]);

    perform pg_advisory_xact_lock(hashtextextended('time_off' || p_employee_id || p_off_date, 0));
    select t.* into blocking
    from public.time_off t
    where t.employee_id = p_employee_id and t.off_date = p_off_date
      and public.periods_overlap(t.period, p_period)
    order by t.status = 'pending' desc, t.id
    limit 1;
    if found and blocking.status = 'pending' then
        raise exception 'pending_request' using detail = jsonb_build_object(
            'employee_id', blocking.employee_id, 'off_date', blocking.off_date, 'period', blocking.period)::text;
    elsif found then
        raise exception 'day_off_overlap' using errcode = '23P01', detail = jsonb_build_object(
            'employee_id', blocking.employee_id, 'off_date', blocking.off_date, 'period', blocking.period)::text;
    end if;

    removed := public.capture_delete_shifts(array[p_shift_id] || array(
        select s.id from public.shifts s
        where s.id = any(coalesce(p_delete_shift_ids, '{}'))
          and s.employee_id = p_employee_id and s.shift_date = p_off_date
          and s.id <> p_shift_id
    ));
    insert into public.time_off (employee_id, off_date, period, status, source, reviewed_at)
    values (p_employee_id, p_off_date, p_period, 'approved', 'assigned', null)
    returning * into added;

    change := jsonb_set(public.empty_change(), '{inserted,time_off}', jsonb_build_array(to_jsonb(added)));
    change := jsonb_set(change, '{deleted,shifts}', removed -> 'shifts');
    return jsonb_set(change, '{deleted,actual_links}', removed -> 'actual_links');
end;
$$;

-- Replace an assigned day off with a shift. A day off the employee requested can't be
-- turned into a shift ('request_locked').
create function public.admin_convert_to_shift(
    p_time_off_id uuid, p_employee_id uuid, p_shift_date date, p_start_time time, p_end_time time
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    removed public.time_off%rowtype;
    added public.shifts%rowtype;
    change jsonb;
begin
    perform public.assert_admin();
    if p_time_off_id is null or p_employee_id is null or p_shift_date is null
        or p_start_time is null or p_end_time is null then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    select * into removed from public.time_off where id = p_time_off_id for update;
    if not found then
        raise exception 'not_found' using errcode = 'P0002';
    end if;
    if removed.status <> 'approved' then
        raise exception 'not_editable';
    end if;
    if removed.source <> 'assigned' then
        raise exception 'request_locked';
    end if;
    perform public.assert_open(array[p_shift_date]);

    delete from public.time_off where id = p_time_off_id;
    insert into public.shifts (employee_id, shift_date, start_time, end_time)
    values (p_employee_id, p_shift_date, p_start_time, p_end_time)
    returning * into added;

    change := jsonb_set(public.empty_change(), '{inserted,shifts}', jsonb_build_array(to_jsonb(added)));
    return jsonb_set(change, '{deleted,time_off}', jsonb_build_array(to_jsonb(removed)));
end;
$$;

-- Deletes shifts and time off. Ids that no longer exist are skipped; the page treats an
-- empty result as "already removed".
create function public.admin_delete_items(p_shift_ids uuid[] default '{}', p_time_off_ids uuid[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    removed jsonb;
    removed_time_off jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    removed := public.capture_delete_shifts(coalesce(p_shift_ids, '{}'));
    with deleted as (
        delete from public.time_off t where t.id = any(coalesce(p_time_off_ids, '{}')) returning t.*
    )
    select coalesce(jsonb_agg(to_jsonb(deleted) order by deleted.off_date, deleted.id), '[]'::jsonb)
    into removed_time_off
    from deleted;

    change := jsonb_set(public.empty_change(), '{deleted,shifts}', removed -> 'shifts');
    change := jsonb_set(change, '{deleted,time_off}', removed_time_off);
    return jsonb_set(change, '{deleted,actual_links}', removed -> 'actual_links');
end;
$$;

-- Marks days closed and deletes every shift and every time off (any status) on them.
-- Availability and payroll actuals are kept. Only days that weren't closed already are
-- listed in inserted.closed_days.
create function public.admin_close_days(p_dates date[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    dates date[];
    newly_closed jsonb;
    removed jsonb;
    removed_time_off jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    dates := array(select distinct d from unnest(coalesce(p_dates, '{}')) as d where d is not null order by d);
    with inserted as (
        insert into public.closed_days (closed_date)
        select d from unnest(dates) as d
        on conflict (closed_date) do nothing
        returning closed_date
    )
    select coalesce(jsonb_agg(to_jsonb(inserted.closed_date) order by inserted.closed_date), '[]'::jsonb)
    into newly_closed
    from inserted;

    removed := public.capture_delete_shifts(array(
        select s.id from public.shifts s where s.shift_date = any(dates)
    ));
    with deleted as (
        delete from public.time_off t where t.off_date = any(dates) returning t.*
    )
    select coalesce(jsonb_agg(to_jsonb(deleted) order by deleted.off_date, deleted.employee_id, deleted.id), '[]'::jsonb)
    into removed_time_off
    from deleted;

    change := jsonb_set(public.empty_change(), '{inserted,closed_days}', newly_closed);
    change := jsonb_set(change, '{deleted,shifts}', removed -> 'shifts');
    change := jsonb_set(change, '{deleted,time_off}', removed_time_off);
    return jsonb_set(change, '{deleted,actual_links}', removed -> 'actual_links');
end;
$$;

-- Reverses a ScheduleChange, all or nothing. Raises 'undo_stale' (and changes nothing) when a
-- row it would put back or remove has changed since, when the result would leave a shift or
-- time off on a closed day, or when a row it puts back would clash with one saved since, in a
-- way the schedule page refuses when adding or editing.
create function public.admin_undo(p_change jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
    inserted_shifts jsonb := p_change #> '{inserted,shifts}';
    inserted_time_off jsonb := p_change #> '{inserted,time_off}';
    inserted_closed jsonb := p_change #> '{inserted,closed_days}';
    updated_shifts jsonb := p_change #> '{updated,shifts}';
    updated_time_off jsonb := p_change #> '{updated,time_off}';
    deleted_shifts jsonb := p_change #> '{deleted,shifts}';
    deleted_time_off jsonb := p_change #> '{deleted,time_off}';
    deleted_closed jsonb := p_change #> '{deleted,closed_days}';
    actual_links jsonb := p_change #> '{deleted,actual_links}';
    item jsonb;
    shift_before public.shifts%rowtype;
    shift_after public.shifts%rowtype;
    time_off_before public.time_off%rowtype;
    time_off_after public.time_off%rowtype;
    touched date[];
    restored_shift_ids uuid[];
    restored_time_off_ids uuid[];
    saved_at timestamptz;
    n integer;
begin
    perform public.assert_admin();
    if jsonb_typeof(p_change) is distinct from 'object'
        or jsonb_typeof(inserted_shifts) is distinct from 'array'
        or jsonb_typeof(inserted_time_off) is distinct from 'array'
        or jsonb_typeof(inserted_closed) is distinct from 'array'
        or jsonb_typeof(updated_shifts) is distinct from 'array'
        or jsonb_typeof(updated_time_off) is distinct from 'array'
        or jsonb_typeof(deleted_shifts) is distinct from 'array'
        or jsonb_typeof(deleted_time_off) is distinct from 'array'
        or jsonb_typeof(deleted_closed) is distinct from 'array'
        or jsonb_typeof(actual_links) is distinct from 'array' then
        raise exception 'invalid_input' using errcode = '22023';
    end if;

    begin
        -- 1. Remove added shifts, unless they changed since or payroll hours now point at them.
        with target as (
            select r.id, r.updated_at from jsonb_populate_recordset(null::public.shifts, inserted_shifts) r
        ), removed as (
            delete from public.shifts s
            using target
            where s.id = target.id and s.updated_at = target.updated_at
              and not exists (select 1 from public.shift_actuals a where a.shift_id = s.id)
            returning s.id
        )
        select count(*) into n from removed;
        if n <> jsonb_array_length(inserted_shifts) then
            raise exception 'undo_stale' using detail = 'An added shift changed since.';
        end if;

        -- 2. Remove added time off, unless it changed since.
        with target as (
            select r.id, r.updated_at from jsonb_populate_recordset(null::public.time_off, inserted_time_off) r
        ), removed as (
            delete from public.time_off t
            using target
            where t.id = target.id and t.updated_at = target.updated_at
            returning t.id
        )
        select count(*) into n from removed;
        if n <> jsonb_array_length(inserted_time_off) then
            raise exception 'undo_stale' using detail = 'Added time off changed since.';
        end if;

        -- 3. Reopen days this change closed.
        delete from public.closed_days c
        where c.closed_date in (select (d #>> '{}')::date from jsonb_array_elements(inserted_closed) d);

        -- 4. Put edited rows back, including their previous updated_at.
        perform set_config('schedule.keep_updated_at', 'on', true);
        for item in select * from jsonb_array_elements(updated_shifts) loop
            shift_before := jsonb_populate_record(null::public.shifts, item -> 'before');
            shift_after := jsonb_populate_record(null::public.shifts, item -> 'after');
            update public.shifts s
            set employee_id = shift_before.employee_id, shift_date = shift_before.shift_date,
                start_time = shift_before.start_time, end_time = shift_before.end_time,
                updated_at = shift_before.updated_at
            where s.id = shift_after.id and s.id = shift_before.id and s.updated_at = shift_after.updated_at;
            if not found then
                raise exception 'undo_stale' using detail = 'An edited shift changed since.';
            end if;
        end loop;
        for item in select * from jsonb_array_elements(updated_time_off) loop
            time_off_before := jsonb_populate_record(null::public.time_off, item -> 'before');
            time_off_after := jsonb_populate_record(null::public.time_off, item -> 'after');
            update public.time_off t
            set employee_id = time_off_before.employee_id, off_date = time_off_before.off_date,
                period = time_off_before.period, status = time_off_before.status,
                source = time_off_before.source, reviewed_at = time_off_before.reviewed_at,
                updated_at = time_off_before.updated_at
            where t.id = time_off_after.id and t.id = time_off_before.id and t.updated_at = time_off_after.updated_at;
            if not found then
                raise exception 'undo_stale' using detail = 'Edited time off changed since.';
            end if;
        end loop;
        perform set_config('schedule.keep_updated_at', 'off', true);

        -- 5. Put deleted rows back with their original ids.
        insert into public.shifts
        select * from jsonb_populate_recordset(null::public.shifts, deleted_shifts);
        insert into public.time_off
        select * from jsonb_populate_recordset(null::public.time_off, deleted_time_off);

        -- 6. Close days this change reopened.
        insert into public.closed_days (closed_date)
        select (d #>> '{}')::date from jsonb_array_elements(deleted_closed) d
        on conflict (closed_date) do nothing;

        -- 7. Reattach payroll hours to the shifts put back. Skipped when the actual is gone,
        --    already points at a shift, or was saved as unscheduled work since.
        update public.shift_actuals a
        set shift_id = (link ->> 'shift_id')::uuid
        from jsonb_array_elements(actual_links) link
        where a.id = (link ->> 'actual_id')::uuid
          and a.shift_id is null
          and a.status <> 'unscheduled'
          and exists (select 1 from public.shifts s where s.id = (link ->> 'shift_id')::uuid);

        -- 8. Nothing may end up on a closed day.
        touched := array(
            select (r ->> 'shift_date')::date from jsonb_array_elements(inserted_shifts || deleted_shifts) r
            union select (r #>> '{before,shift_date}')::date from jsonb_array_elements(updated_shifts) r
            union select (r #>> '{after,shift_date}')::date from jsonb_array_elements(updated_shifts) r
            union select (r ->> 'off_date')::date from jsonb_array_elements(inserted_time_off || deleted_time_off) r
            union select (r #>> '{before,off_date}')::date from jsonb_array_elements(updated_time_off) r
            union select (r #>> '{after,off_date}')::date from jsonb_array_elements(updated_time_off) r
            union select (d #>> '{}')::date from jsonb_array_elements(inserted_closed || deleted_closed) d
        );
        if exists (
            select 1 from public.shifts s join public.closed_days c on c.closed_date = s.shift_date
            where s.shift_date = any(touched)
        ) or exists (
            select 1 from public.time_off t join public.closed_days c on c.closed_date = t.off_date
            where t.off_date = any(touched)
        ) then
            raise exception 'undo_stale' using detail = 'A closed day now has shifts or time off.';
        end if;

        -- 9. Nor may a row it puts back clash with a row saved after the change was made, in a
        --    way the page refuses when adding or editing: a shift under the same employee's
        --    approved time off that covers its start (morning: starts before 5pm; evening: from
        --    5pm), two overlapping shifts of one employee, or two overlapping time off rows of
        --    one employee on one day. Clashes that were already there when the change was made
        --    (older data) don't count, so the undo can still put things back as they were.
        --    The change says when it was made (made_at); a change without one (built by the
        --    page) counts from its newest row.
        --    Known gap: rows put back keep their old updated_at, so undoing out of order in two
        --    tabs can bring back a clash this doesn't see. One tab undoes newest first.
        restored_shift_ids := array(
            select (r ->> 'id')::uuid from jsonb_array_elements(deleted_shifts) r
            union select (r #>> '{before,id}')::uuid from jsonb_array_elements(updated_shifts) r
        );
        restored_time_off_ids := array(
            select (r ->> 'id')::uuid from jsonb_array_elements(deleted_time_off) r
            union select (r #>> '{before,id}')::uuid from jsonb_array_elements(updated_time_off) r
        );
        select coalesce((p_change ->> 'made_at')::timestamptz, max(x.at)) into saved_at
        from (
            select (r ->> 'updated_at')::timestamptz as at
            from jsonb_array_elements(inserted_shifts || inserted_time_off || deleted_shifts || deleted_time_off) r
            union all
            select (r #>> '{after,updated_at}')::timestamptz
            from jsonb_array_elements(updated_shifts || updated_time_off) r
        ) x;
        if exists (
            select 1
            from public.shifts s
            join public.time_off t
              on t.employee_id = s.employee_id and t.off_date = s.shift_date and t.status = 'approved'
             and (t.period = 'full-day'
                  or (t.period = 'morning' and s.start_time < '17:00')
                  or (t.period = 'evening' and s.start_time >= '17:00'))
            where (s.id = any(restored_shift_ids) and t.id <> all(restored_time_off_ids) and t.updated_at > saved_at)
               or (t.id = any(restored_time_off_ids) and s.id <> all(restored_shift_ids) and s.updated_at > saved_at)
        ) or exists (
            -- Compared on one timeline across days: a shift that ends at or before its start
            -- runs past midnight. Touching shifts don't overlap.
            select 1
            from public.shifts s
            join public.shifts o
              on o.employee_id = s.employee_id and o.id <> s.id
             and o.shift_date between s.shift_date - 1 and s.shift_date + 1
            where s.id = any(restored_shift_ids) and o.id <> all(restored_shift_ids) and o.updated_at > saved_at
              and tsrange(s.shift_date + s.start_time, s.shift_date + s.end_time
                          + case when s.end_time <= s.start_time then interval '1 day' else interval '0 days' end)
               && tsrange(o.shift_date + o.start_time, o.shift_date + o.end_time
                          + case when o.end_time <= o.start_time then interval '1 day' else interval '0 days' end)
        ) or exists (
            select 1
            from public.time_off t
            join public.time_off o
              on o.employee_id = t.employee_id and o.off_date = t.off_date and o.id <> t.id
             and public.periods_overlap(o.period, t.period)
            where t.id = any(restored_time_off_ids) and o.id <> all(restored_time_off_ids) and o.updated_at > saved_at
        ) then
            raise exception 'undo_stale' using detail = 'A row it would put back clashes with one saved since.';
        end if;
    exception
        when unique_violation or foreign_key_violation then
            raise exception 'undo_stale' using detail = sqlerrm;
    end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

-- Approves pending time-off requests together, or none of them ('request_not_pending' when
-- any is missing or already reviewed). Deletes p_delete_shift_ids that belong to the same
-- employee on the same day as an approved request.
create function public.approve_time_off(p_ids uuid[], p_delete_shift_ids uuid[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    ids uuid[];
    ready integer;
    approved jsonb;
    removed jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    ids := array(select distinct i from unnest(coalesce(p_ids, '{}')) as i where i is not null);
    if cardinality(ids) = 0 then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    perform 1 from public.time_off t where t.id = any(ids) for update;
    select count(*) into ready
    from public.time_off t
    where t.id = any(ids) and t.status = 'pending' and t.source = 'request';
    if ready <> cardinality(ids) then
        raise exception 'request_not_pending' using errcode = 'P0002';
    end if;
    perform public.assert_open(array(select t.off_date from public.time_off t where t.id = any(ids)));

    with prev as (
        select t.* from public.time_off t where t.id = any(ids)
    ), upd as (
        update public.time_off t
        set status = 'approved', reviewed_at = now()
        where t.id = any(ids)
        returning t.*
    )
    select coalesce(jsonb_agg(jsonb_build_object('before', to_jsonb(prev), 'after', to_jsonb(upd))
        order by upd.off_date, upd.id), '[]'::jsonb)
    into approved
    from prev join upd on upd.id = prev.id;

    removed := public.capture_delete_shifts(array(
        select s.id from public.shifts s
        where s.id = any(coalesce(p_delete_shift_ids, '{}'))
          and exists (
              select 1 from public.time_off t
              where t.id = any(ids) and t.employee_id = s.employee_id and t.off_date = s.shift_date
          )
    ));

    change := jsonb_set(public.empty_change(), '{updated,time_off}', approved);
    change := jsonb_set(change, '{deleted,shifts}', removed -> 'shifts');
    return jsonb_set(change, '{deleted,actual_links}', removed -> 'actual_links');
end;
$$;

-- Approves pending availability together, or none of it. Returns {"approved_ids": [...]}.
create function public.approve_availability(p_ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    ids uuid[];
    ready integer;
    approved jsonb;
begin
    perform public.assert_admin();
    ids := array(select distinct i from unnest(coalesce(p_ids, '{}')) as i where i is not null);
    if cardinality(ids) = 0 then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    perform 1 from public.availability a where a.id = any(ids) for update;
    select count(*) into ready
    from public.availability a
    where a.id = any(ids) and a.status = 'pending';
    if ready <> cardinality(ids) then
        raise exception 'request_not_pending' using errcode = 'P0002';
    end if;
    perform public.assert_open(array(select a.available_date from public.availability a where a.id = any(ids)));

    with upd as (
        update public.availability a
        set status = 'approved', reviewed_at = now()
        where a.id = any(ids)
        returning a.id, a.available_date
    )
    select coalesce(jsonb_agg(to_jsonb(upd.id) order by upd.available_date, upd.id), '[]'::jsonb)
    into approved
    from upd;
    return jsonb_build_object('approved_ids', approved);
end;
$$;

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------

-- p_employee: {id: uuid|null, name, color, rates: [{id: uuid|null, rate, start_date, end_date}]}.
-- Adds (id null) or updates an employee and makes their rate periods match rates: listed ids
-- are updated, rows without an id are added, and the employee's other rates are deleted.
-- Returns the employee id.
create function public.save_employee(p_employee jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    saved_id uuid;
    new_name text;
    new_color text;
    rates jsonb;
begin
    perform public.assert_admin();
    if jsonb_typeof(p_employee) is distinct from 'object' then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    saved_id := (p_employee ->> 'id')::uuid;
    new_name := btrim(p_employee ->> 'name');
    new_color := p_employee ->> 'color';
    -- Required: a missing list would otherwise delete every rate.
    rates := p_employee -> 'rates';
    if new_name is null or new_color is null or jsonb_typeof(rates) is distinct from 'array'
        or exists (select 1 from jsonb_array_elements(rates) x where jsonb_typeof(x) <> 'object') then
        raise exception 'invalid_input' using errcode = '22023';
    end if;

    -- One save at a time, so two tabs can't both add the same name.
    perform pg_advisory_xact_lock(hashtextextended('save_employee', 0));
    if exists (
        select 1 from public.employees e
        where lower(btrim(e.name)) = lower(new_name) and e.id is distinct from saved_id
    ) then
        raise exception 'duplicate_name' using errcode = '23505';
    end if;

    if saved_id is null then
        insert into public.employees (name, color, display_order)
        values (new_name, new_color, coalesce((select max(e.display_order) + 1 from public.employees e), 0))
        returning id into saved_id;
    else
        update public.employees e set name = new_name, color = new_color
        where e.id = saved_id;
        if not found then
            raise exception 'not_found' using errcode = 'P0002';
        end if;
    end if;

    delete from public.employee_rates r
    where r.employee_id = saved_id
      and r.id not in (
          select (x ->> 'id')::uuid from jsonb_array_elements(rates) x where x ->> 'id' is not null
      );
    -- Ids that belong to another employee (or no longer exist) are ignored.
    update public.employee_rates r
    set rate = round((x ->> 'rate')::numeric, 2),
        start_date = (x ->> 'start_date')::date,
        end_date = (x ->> 'end_date')::date
    from jsonb_array_elements(rates) x
    where x ->> 'id' is not null
      and r.id = (x ->> 'id')::uuid
      and r.employee_id = saved_id
      and (r.rate, r.start_date, r.end_date) is distinct from
          (round((x ->> 'rate')::numeric, 2), (x ->> 'start_date')::date, (x ->> 'end_date')::date);
    insert into public.employee_rates (employee_id, rate, start_date, end_date)
    select saved_id, round((x ->> 'rate')::numeric, 2),
        (x ->> 'start_date')::date, (x ->> 'end_date')::date
    from jsonb_array_elements(rates) x
    where x ->> 'id' is null;

    -- Check for overlapping rate periods now rather than at commit, so the error comes back
    -- from this call.
    set constraints public.employee_rates_no_overlap immediate;
    return saved_id;
end;
$$;

-- p_ids: every employee in the new order. display_order becomes the 0-based position.
create function public.set_employee_order(p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
    perform public.assert_admin();
    if exists (
        select 1 from unnest(coalesce(p_ids, '{}')) as i where i is not null group by i having count(*) > 1
    ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    update public.employees e
    set display_order = o.ord - 1
    from unnest(p_ids) with ordinality as o(id, ord)
    where e.id = o.id and e.display_order is distinct from (o.ord - 1)::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payroll
-- ---------------------------------------------------------------------------

-- p_plan: {delete_ids: [uuid],
--          scheduled: [{shift_id, employee_id, status, start_time, end_time, note}],
--          actual_only: [{id, employee_id, work_date, start_time, end_time, note}]}
-- Scheduled rows take their work_date from the shift; not-worked rows keep the shift's
-- employee and no times. Actual-only rows are unscheduled work with no shift. Returns
-- {"deleted": n, "saved": n}.
create function public.save_shift_actuals(p_plan jsonb)
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
    perform public.assert_admin();
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
-- Access: signed-in users only (each function also refuses non-admins).
-- ---------------------------------------------------------------------------

revoke execute on function public.assert_admin() from public, anon;
revoke execute on function public.assert_open(date[]) from public, anon;
revoke execute on function public.capture_delete_shifts(uuid[]) from public, anon;
revoke execute on function public.empty_change() from public, anon;
revoke execute on function public.admin_add_shifts(jsonb) from public, anon;
revoke execute on function public.admin_add_days_off(jsonb, uuid[]) from public, anon;
revoke execute on function public.admin_update_shift(uuid, uuid, date, time, time) from public, anon;
revoke execute on function public.admin_update_day_off(uuid, uuid, date, public.day_period, uuid[]) from public, anon;
revoke execute on function public.admin_convert_to_day_off(uuid, uuid, date, public.day_period, uuid[]) from public, anon;
revoke execute on function public.admin_convert_to_shift(uuid, uuid, date, time, time) from public, anon;
revoke execute on function public.admin_delete_items(uuid[], uuid[]) from public, anon;
revoke execute on function public.admin_close_days(date[]) from public, anon;
revoke execute on function public.admin_undo(jsonb) from public, anon;
revoke execute on function public.approve_time_off(uuid[], uuid[]) from public, anon;
revoke execute on function public.approve_availability(uuid[]) from public, anon;
revoke execute on function public.save_employee(jsonb) from public, anon;
revoke execute on function public.set_employee_order(uuid[]) from public, anon;
revoke execute on function public.save_shift_actuals(jsonb) from public, anon;

grant execute on function public.assert_admin() to authenticated;
grant execute on function public.assert_open(date[]) to authenticated;
grant execute on function public.capture_delete_shifts(uuid[]) to authenticated;
grant execute on function public.empty_change() to authenticated;
grant execute on function public.admin_add_shifts(jsonb) to authenticated;
grant execute on function public.admin_add_days_off(jsonb, uuid[]) to authenticated;
grant execute on function public.admin_update_shift(uuid, uuid, date, time, time) to authenticated;
grant execute on function public.admin_update_day_off(uuid, uuid, date, public.day_period, uuid[]) to authenticated;
grant execute on function public.admin_convert_to_day_off(uuid, uuid, date, public.day_period, uuid[]) to authenticated;
grant execute on function public.admin_convert_to_shift(uuid, uuid, date, time, time) to authenticated;
grant execute on function public.admin_delete_items(uuid[], uuid[]) to authenticated;
grant execute on function public.admin_close_days(date[]) to authenticated;
grant execute on function public.admin_undo(jsonb) to authenticated;
grant execute on function public.approve_time_off(uuid[], uuid[]) to authenticated;
grant execute on function public.approve_availability(uuid[]) to authenticated;
grant execute on function public.save_employee(jsonb) to authenticated;
grant execute on function public.set_employee_order(uuid[]) to authenticated;
grant execute on function public.save_shift_actuals(jsonb) to authenticated;
