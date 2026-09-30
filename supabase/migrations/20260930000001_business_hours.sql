-- Follow-up to 20260929000001_admin.sql. Run once in the Supabase SQL Editor, before
-- deploying the web app that uses it.
--
-- Business hours:
--   - weekly_hours: the open and close time for each day of the week, kept as a history of
--     sets. Each set starts on a date; the first set has none and also covers every earlier day.
--   - custom_hours: different hours for one date.
--   - admin functions to save them. Setting a date's hours returns a ScheduleChange that
--     admin_undo can reverse, like closing and reopening days.
--   - closing a day now also clears its custom hours.
-- Staff (admins and employees) can read the hours; only admins change them. No hours are
-- added here: the admin enters them in the app.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A set is 7 rows (one per day of the week, 0 = Sunday ... 6 = Saturday) sharing one
-- starts_on. A set is in effect from its starts_on until the day before the next set starts.
create table public.weekly_hours (
    id uuid primary key default gen_random_uuid(),
    -- Null: the first set, which also covers every day before the next set.
    starts_on date,
    weekday smallint not null,
    open_time time not null,
    close_time time not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint weekly_hours_weekday check (weekday between 0 and 6),
    constraint weekly_hours_close_after_open check (open_time < close_time and close_time < time '24:00'),
    constraint weekly_hours_whole_minutes check (extract(second from open_time) = 0 and extract(second from close_time) = 0),
    constraint weekly_hours_one_per_weekday unique nulls not distinct (starts_on, weekday)
);

-- Only dates whose hours differ from the weekly hours have a row. A closed date has none.
create table public.custom_hours (
    hours_date date primary key,
    open_time time not null,
    close_time time not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint custom_hours_close_after_open check (open_time < close_time and close_time < time '24:00'),
    constraint custom_hours_whole_minutes check (extract(second from open_time) = 0 and extract(second from close_time) = 0)
);

-- ---------------------------------------------------------------------------
-- Row Level Security: staff read, admins change
-- ---------------------------------------------------------------------------

alter table public.weekly_hours enable row level security;
alter table public.custom_hours enable row level security;

create policy "staff can read weekly hours" on public.weekly_hours
    for select to authenticated using ((select public.is_staff()));
create policy "admins manage weekly hours" on public.weekly_hours
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "staff can read custom hours" on public.custom_hours
    for select to authenticated using ((select public.is_staff()));
create policy "admins manage custom hours" on public.custom_hours
    for all to authenticated
    using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------

-- The schema's default privileges grant every table to anon; these are never needed signed out.
revoke all on table public.weekly_hours, public.custom_hours from anon;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger set_updated_at before update on public.weekly_hours
    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.custom_hours
    for each row execute function public.set_updated_at();

-- admin_undo puts back a shift's, time off's or custom hours' previous updated_at along with
-- its other values, so the undo step before it still sees the row as unchanged.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_table_name in ('shifts', 'time_off', 'custom_hours')
        and current_setting('schedule.keep_updated_at', true) = 'on' then
        return new;
    end if;
    new.updated_at = now();
    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calendar changes. A ScheduleChange now also lists custom hours:
--   {"made_at": "<timestamptz>",
--    "inserted": {"shifts": [row], "time_off": [row], "closed_days": ["YYYY-MM-DD"], "custom_hours": [row]},
--    "updated":  {"shifts": [{"before": row, "after": row}], "time_off": [...], "custom_hours": [...]},
--    "deleted":  {"shifts": [row], "time_off": [row], "closed_days": [...], "custom_hours": [row],
--                 "actual_links": [...]}}
-- Custom hours rows are listed by date.
-- ---------------------------------------------------------------------------

-- The ScheduleChange shape with every list empty, stamped with the time the change is made
-- (the calling function's transaction time, which is also the updated_at of the rows it saves).
create or replace function public.empty_change()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
    perform public.assert_admin();
    return jsonb_build_object(
        'made_at', now(),
        'inserted', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb, 'closed_days', '[]'::jsonb,
            'custom_hours', '[]'::jsonb),
        'updated', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb, 'custom_hours', '[]'::jsonb),
        'deleted', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb, 'closed_days', '[]'::jsonb,
            'custom_hours', '[]'::jsonb, 'actual_links', '[]'::jsonb)
    );
end;
$$;

-- Marks days closed and deletes every shift and every time off (any status) on them.
-- Availability and payroll actuals are kept. Custom hours on those days are cleared too.
-- Only days that weren't closed already are listed in inserted.closed_days.
create or replace function public.admin_close_days(p_dates date[])
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
    removed_hours jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    perform pg_advisory_xact_lock(hashtextextended('business_hours', 0));
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
    with deleted as (
        delete from public.custom_hours h where h.hours_date = any(dates) returning h.*
    )
    select coalesce(jsonb_agg(to_jsonb(deleted) order by deleted.hours_date), '[]'::jsonb)
    into removed_hours
    from deleted;

    change := jsonb_set(public.empty_change(), '{inserted,closed_days}', newly_closed);
    change := jsonb_set(change, '{deleted,shifts}', removed -> 'shifts');
    change := jsonb_set(change, '{deleted,time_off}', removed_time_off);
    change := jsonb_set(change, '{deleted,custom_hours}', removed_hours);
    return jsonb_set(change, '{deleted,actual_links}', removed -> 'actual_links');
end;
$$;

-- Reverses a ScheduleChange, all or nothing. Raises 'undo_stale' (and changes nothing) when a
-- row it would put back or remove has changed since, when the result would leave a shift, time
-- off or custom hours on a closed day, or when a row it puts back would clash with one saved
-- since, in a way the schedule page refuses when adding or editing. Custom hours are put back
-- like shifts and time off and take part in no clash rules. A change without the custom_hours
-- lists (from a page older than business hours) still undoes.
create or replace function public.admin_undo(p_change jsonb)
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
    inserted_hours jsonb := coalesce(p_change #> '{inserted,custom_hours}', '[]'::jsonb);
    updated_hours jsonb := coalesce(p_change #> '{updated,custom_hours}', '[]'::jsonb);
    deleted_hours jsonb := coalesce(p_change #> '{deleted,custom_hours}', '[]'::jsonb);
    item jsonb;
    shift_before public.shifts%rowtype;
    shift_after public.shifts%rowtype;
    time_off_before public.time_off%rowtype;
    time_off_after public.time_off%rowtype;
    hours_before public.custom_hours%rowtype;
    hours_after public.custom_hours%rowtype;
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
        or jsonb_typeof(actual_links) is distinct from 'array'
        or jsonb_typeof(inserted_hours) is distinct from 'array'
        or jsonb_typeof(updated_hours) is distinct from 'array'
        or jsonb_typeof(deleted_hours) is distinct from 'array' then
        raise exception 'invalid_input' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('business_hours', 0));

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

        -- 2b. Remove added custom hours, unless they changed since.
        with target as (
            select r.hours_date, r.updated_at from jsonb_populate_recordset(null::public.custom_hours, inserted_hours) r
        ), removed as (
            delete from public.custom_hours h
            using target
            where h.hours_date = target.hours_date and h.updated_at = target.updated_at
            returning h.hours_date
        )
        select count(*) into n from removed;
        if n <> jsonb_array_length(inserted_hours) then
            raise exception 'undo_stale' using detail = 'Added hours changed since.';
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
        for item in select * from jsonb_array_elements(updated_hours) loop
            hours_before := jsonb_populate_record(null::public.custom_hours, item -> 'before');
            hours_after := jsonb_populate_record(null::public.custom_hours, item -> 'after');
            update public.custom_hours h
            set open_time = hours_before.open_time, close_time = hours_before.close_time,
                updated_at = hours_before.updated_at
            where h.hours_date = hours_after.hours_date and h.hours_date = hours_before.hours_date
              and h.updated_at = hours_after.updated_at;
            if not found then
                raise exception 'undo_stale' using detail = 'Edited hours changed since.';
            end if;
        end loop;
        perform set_config('schedule.keep_updated_at', 'off', true);

        -- 5. Put deleted rows back with their original ids (custom hours by date).
        insert into public.shifts
        select * from jsonb_populate_recordset(null::public.shifts, deleted_shifts);
        insert into public.time_off
        select * from jsonb_populate_recordset(null::public.time_off, deleted_time_off);
        insert into public.custom_hours
        select * from jsonb_populate_recordset(null::public.custom_hours, deleted_hours);

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
            union select (r ->> 'hours_date')::date from jsonb_array_elements(inserted_hours || deleted_hours) r
            union select (r #>> '{before,hours_date}')::date from jsonb_array_elements(updated_hours) r
            union select (r #>> '{after,hours_date}')::date from jsonb_array_elements(updated_hours) r
        );
        if exists (
            select 1 from public.shifts s join public.closed_days c on c.closed_date = s.shift_date
            where s.shift_date = any(touched)
        ) or exists (
            select 1 from public.time_off t join public.closed_days c on c.closed_date = t.off_date
            where t.off_date = any(touched)
        ) or exists (
            select 1 from public.custom_hours h join public.closed_days c on c.closed_date = h.hours_date
            where h.hours_date = any(touched)
        ) then
            raise exception 'undo_stale' using detail = 'A closed day now has shifts, time off or custom hours.';
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
-- Business hours
--
-- Every function below takes the same lock as admin_close_days and admin_undo, so two
-- saves can't cross: a date is never left both closed and with custom hours, and custom
-- hours are always compared with settled weekly hours.
-- ---------------------------------------------------------------------------

-- The weekly hours editor's Save (not undoable). p_hours:
--   {"sets":   [{"starts_on": null | "YYYY-MM-DD",
--                "days": [{"weekday": 0-6, "open_time": "HH:MM", "close_time": "HH:MM"}, ... all 7]}],
--    "remove": ["YYYY-MM-DD", ...]}
-- Listed sets are saved (added, or corrected where a set with that starts_on exists); sets
-- that aren't listed are left alone. A set is removed only before it starts: removing one
-- that starts on or before today (New York time) raises 'hours_in_effect' (detail: that
-- date). A removal of a set that no longer exists is ignored. The first set (starts_on null)
-- can't be removed, and a dated set can't be saved without it.
create function public.save_weekly_hours(p_hours jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
    sets jsonb := p_hours -> 'sets';
    removals jsonb := p_hours -> 'remove';
    in_effect date;
begin
    perform public.assert_admin();
    -- Checked in steps, so each one only looks at input the ones before it accepted.
    if jsonb_typeof(p_hours) is distinct from 'object'
        or jsonb_typeof(sets) is distinct from 'array'
        or jsonb_typeof(removals) is distinct from 'array' then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_array_elements(sets) s
        where case
            when jsonb_typeof(s) <> 'object' then true
            when not (s ? 'starts_on') then true
            when jsonb_typeof(s -> 'starts_on') not in ('null', 'string') then true
            when jsonb_typeof(s -> 'days') is distinct from 'array' then true
            else jsonb_array_length(s -> 'days') <> 7
        end
    ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_array_elements(sets) s
        where exists (
            select 1 from jsonb_array_elements(s -> 'days') d
            where case
                when jsonb_typeof(d) <> 'object' then true
                else coalesce(d ->> 'weekday', '') !~ '^[0-6]$'
                    or d ->> 'open_time' is null or d ->> 'close_time' is null
            end
        ) or (select count(distinct d ->> 'weekday') from jsonb_array_elements(s -> 'days') d) <> 7
    ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_array_elements(sets) s
        group by (s ->> 'starts_on')::date
        having count(*) > 1
    ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(removals) r where jsonb_typeof(r) <> 'string') then
        raise exception 'invalid_input' using errcode = '22023';
    end if;
    if exists (
        select 1
        from jsonb_array_elements(removals) r
        join jsonb_array_elements(sets) s on (s ->> 'starts_on')::date = (r #>> '{}')::date
    ) then
        raise exception 'invalid_input' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('business_hours', 0));

    select min((r #>> '{}')::date) into in_effect
    from jsonb_array_elements(removals) r
    where (r #>> '{}')::date <= public.business_today();
    if in_effect is not null then
        raise exception 'hours_in_effect' using detail = to_char(in_effect, 'YYYY-MM-DD');
    end if;
    delete from public.weekly_hours w
    where w.starts_on in (select (r #>> '{}')::date from jsonb_array_elements(removals) r);

    -- Unchanged days keep their updated_at.
    insert into public.weekly_hours (starts_on, weekday, open_time, close_time)
    select (s ->> 'starts_on')::date, (d ->> 'weekday')::smallint, (d ->> 'open_time')::time, (d ->> 'close_time')::time
    from jsonb_array_elements(sets) s
    cross join jsonb_array_elements(s -> 'days') d
    on conflict (starts_on, weekday) do update
    set open_time = excluded.open_time, close_time = excluded.close_time
    where (weekly_hours.open_time, weekly_hours.close_time) is distinct from (excluded.open_time, excluded.close_time);

    if exists (select 1 from public.weekly_hours w where w.starts_on is not null)
        and not exists (select 1 from public.weekly_hours w where w.starts_on is null) then
        raise exception 'invalid_input' using errcode = '22023', detail = 'The first set of hours is missing.';
    end if;
end;
$$;

-- Gives the dates these hours. A closed date is reopened. Hours equal to a date's weekly
-- hours aren't stored: that date's custom hours are deleted instead. Returns a ScheduleChange.
create function public.admin_set_custom_hours(p_dates date[], p_open_time time, p_close_time time)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    dates date[];
    d date;
    std_open time;
    std_close time;
    has_standard boolean;
    has_existing boolean;
    existing public.custom_hours%rowtype;
    saved public.custom_hours%rowtype;
    reopened jsonb;
    added jsonb := '[]'::jsonb;
    edited jsonb := '[]'::jsonb;
    removed jsonb := '[]'::jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    dates := array(select distinct x from unnest(coalesce(p_dates, '{}')) x where x is not null order by x);
    if cardinality(dates) = 0
        or p_open_time is null or p_close_time is null
        or not (p_open_time < p_close_time and p_close_time < time '24:00')
        or extract(second from p_open_time) <> 0 or extract(second from p_close_time) <> 0 then
        raise exception 'invalid_input' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('business_hours', 0));

    with deleted as (
        delete from public.closed_days c where c.closed_date = any(dates) returning c.closed_date
    )
    select coalesce(jsonb_agg(to_jsonb(deleted.closed_date) order by deleted.closed_date), '[]'::jsonb)
    into reopened
    from deleted;

    foreach d in array dates loop
        -- The weekly hours on that date: from the latest set that has started by then, else
        -- the first set.
        select w.open_time, w.close_time into std_open, std_close
        from public.weekly_hours w
        where w.weekday = extract(dow from d)::smallint and (w.starts_on is null or w.starts_on <= d)
        order by w.starts_on desc nulls last
        limit 1;
        has_standard := found;

        select * into existing from public.custom_hours h where h.hours_date = d for update;
        has_existing := found;

        if has_standard and (p_open_time, p_close_time) = (std_open, std_close) then
            if has_existing then
                delete from public.custom_hours h where h.hours_date = d;
                removed := removed || jsonb_build_array(to_jsonb(existing));
            end if;
        elsif not has_existing then
            insert into public.custom_hours (hours_date, open_time, close_time)
            values (d, p_open_time, p_close_time)
            returning * into saved;
            added := added || jsonb_build_array(to_jsonb(saved));
        elsif (existing.open_time, existing.close_time) is distinct from (p_open_time, p_close_time) then
            update public.custom_hours h
            set open_time = p_open_time, close_time = p_close_time
            where h.hours_date = d
            returning * into saved;
            edited := edited || jsonb_build_array(jsonb_build_object('before', to_jsonb(existing), 'after', to_jsonb(saved)));
        end if;
    end loop;

    change := jsonb_set(public.empty_change(), '{deleted,closed_days}', reopened);
    change := jsonb_set(change, '{inserted,custom_hours}', added);
    change := jsonb_set(change, '{updated,custom_hours}', edited);
    return jsonb_set(change, '{deleted,custom_hours}', removed);
end;
$$;

-- Puts the dates back on their weekly hours: reopens closed dates and deletes custom hours.
-- Returns a ScheduleChange, with every list empty when nothing was closed or custom.
create function public.admin_set_standard_hours(p_dates date[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    dates date[];
    reopened jsonb;
    removed jsonb;
    change jsonb;
begin
    perform public.assert_admin();
    dates := array(select distinct x from unnest(coalesce(p_dates, '{}')) x where x is not null order by x);
    if cardinality(dates) = 0 then
        raise exception 'invalid_input' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('business_hours', 0));

    with deleted as (
        delete from public.closed_days c where c.closed_date = any(dates) returning c.closed_date
    )
    select coalesce(jsonb_agg(to_jsonb(deleted.closed_date) order by deleted.closed_date), '[]'::jsonb)
    into reopened
    from deleted;
    with deleted as (
        delete from public.custom_hours h where h.hours_date = any(dates) returning h.*
    )
    select coalesce(jsonb_agg(to_jsonb(deleted) order by deleted.hours_date), '[]'::jsonb)
    into removed
    from deleted;

    change := jsonb_set(public.empty_change(), '{deleted,closed_days}', reopened);
    return jsonb_set(change, '{deleted,custom_hours}', removed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access: signed-in users only (each function also refuses non-admins). The replaced
-- functions keep their grants; they are repeated here to show the intent.
-- ---------------------------------------------------------------------------

revoke execute on function public.empty_change() from public, anon;
revoke execute on function public.admin_close_days(date[]) from public, anon;
revoke execute on function public.admin_undo(jsonb) from public, anon;
revoke execute on function public.save_weekly_hours(jsonb) from public, anon;
revoke execute on function public.admin_set_custom_hours(date[], time, time) from public, anon;
revoke execute on function public.admin_set_standard_hours(date[]) from public, anon;

grant execute on function public.empty_change() to authenticated;
grant execute on function public.admin_close_days(date[]) to authenticated;
grant execute on function public.admin_undo(jsonb) to authenticated;
grant execute on function public.save_weekly_hours(jsonb) to authenticated;
grant execute on function public.admin_set_custom_hours(date[], time, time) to authenticated;
grant execute on function public.admin_set_standard_hours(date[]) to authenticated;
