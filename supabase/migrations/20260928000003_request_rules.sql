-- Follow-up to 20260928000002_tighten_access.sql. Run once in the Supabase SQL Editor.
--
-- Enforces the request rules in the database, so they hold even when a page has stale
-- data. An employee can only request time off or availability:
--   - from today (New York time) through one year out
--   - on days the business is open
--   - when they don't already have time off (or availability) covering that part of the day
--   - while they aren't archived
-- Admins aren't restricted.
--
-- Adds request_time_off and request_availability, which the website calls to submit
-- several dates at once. Each date that passes the rules is saved; the rest are
-- reported back as skipped.

create function public.business_today()
returns date
language sql
stable
set search_path = ''
as $$
    select (now() at time zone 'America/New_York')::date;
$$;

-- Shared checks for one requested date. Raises when the request isn't allowed.
create function public.check_request_date(p_employee_id uuid, p_date date)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
    if exists (select 1 from public.employees where id = p_employee_id and archived) then
        raise exception 'employee_archived' using errcode = '42501';
    end if;
    if p_date < public.business_today() or p_date > public.business_today() + 365 then
        raise exception 'date_out_of_range';
    end if;
    if exists (select 1 from public.closed_days where closed_date = p_date) then
        raise exception 'closed_day';
    end if;
end;
$$;

-- Morning and evening can both be requested on the same day; anything involving a
-- full day overlaps, as does the same part of the day twice.
create function public.periods_overlap(a public.day_period, b public.day_period)
returns boolean
language sql
immutable
set search_path = ''
as $$
    select a = 'full-day' or b = 'full-day' or a = b;
$$;

create function public.check_time_off_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if auth.uid() is null or public.is_admin() then
        return new;
    end if;
    perform public.check_request_date(new.employee_id, new.off_date);
    -- Serialize requests for the same employee and day so two tabs can't both get in.
    perform pg_advisory_xact_lock(hashtextextended('time_off' || new.employee_id || new.off_date, 0));
    if exists (
        select 1 from public.time_off
        where employee_id = new.employee_id
          and off_date = new.off_date
          and public.periods_overlap(period, new.period)
    ) then
        raise exception 'period_overlap' using errcode = '23P01';
    end if;
    return new;
end;
$$;

create function public.check_availability_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if auth.uid() is null or public.is_admin() then
        return new;
    end if;
    perform public.check_request_date(new.employee_id, new.available_date);
    perform pg_advisory_xact_lock(hashtextextended('availability' || new.employee_id || new.available_date, 0));
    if exists (
        select 1 from public.availability
        where employee_id = new.employee_id
          and available_date = new.available_date
          and public.periods_overlap(period, new.period)
    ) then
        raise exception 'period_overlap' using errcode = '23P01';
    end if;
    return new;
end;
$$;

-- Before-insert triggers run in name order, so these checks run before stamp_employee_request.
create trigger check_time_off_request before insert on public.time_off
    for each row execute function public.check_time_off_request();
create trigger check_availability_request before insert on public.availability
    for each row execute function public.check_availability_request();

-- Submits a time-off request for each date. Returns
-- {"submitted": [dates saved], "skipped": [dates closed, out of range, or already covered]}.
create function public.request_time_off(p_dates date[], p_period public.day_period)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
    me uuid := public.current_employee_id();
    requested date;
    submitted date[] := '{}';
    skipped date[] := '{}';
begin
    if me is null then
        raise exception 'not_linked' using errcode = '42501';
    end if;
    for requested in
        select distinct d from unnest(p_dates) as d where d is not null order by d
    loop
        begin
            insert into public.time_off (employee_id, off_date, period)
            values (me, requested, p_period);
            submitted := submitted || requested;
        exception
            when unique_violation or exclusion_violation or raise_exception then
                skipped := skipped || requested;
        end;
    end loop;
    return jsonb_build_object('submitted', to_jsonb(submitted), 'skipped', to_jsonb(skipped));
end;
$$;

create function public.request_availability(p_dates date[], p_period public.day_period)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
    me uuid := public.current_employee_id();
    requested date;
    submitted date[] := '{}';
    skipped date[] := '{}';
begin
    if me is null then
        raise exception 'not_linked' using errcode = '42501';
    end if;
    for requested in
        select distinct d from unnest(p_dates) as d where d is not null order by d
    loop
        begin
            insert into public.availability (employee_id, available_date, period)
            values (me, requested, p_period);
            submitted := submitted || requested;
        exception
            when unique_violation or exclusion_violation or raise_exception then
                skipped := skipped || requested;
        end;
    end loop;
    return jsonb_build_object('submitted', to_jsonb(submitted), 'skipped', to_jsonb(skipped));
end;
$$;
