-- Tests for business hours in 20260930000001_business_hours.sql: the weekly_hours and
-- custom_hours tables, save_weekly_hours, admin_set_custom_hours, admin_set_standard_hours, and
-- what closing a day and admin_undo now do with custom hours.
-- Run against the LOCAL database after `npx supabase db reset` (they rely on seed.sql):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/business_hours.sql
-- Everything runs in one transaction that is rolled back, so the data is left as it was.
-- The first failing check stops the run; the last line printed on success is
-- ALL BUSINESS HOURS TESTS PASSED.
--
-- Seed rows are found by their dates relative to the day of the reset (seed_today below), as in
-- admin_rpcs.sql. Rules about "today" (which weekly sets are upcoming) use business_today(),
-- the date in New York, which can differ from seed_today. Scratch dates for custom hours are
-- seed_today + 41 ... + 45: open, with no custom hours.

\set QUIET on
\set ON_ERROR_STOP 1

begin;

-- ---------------------------------------------------------------------------
-- Test helpers (this session only)
-- ---------------------------------------------------------------------------

-- The day seed.sql counted as today (see admin_rpcs.sql). Also checks the seeded business
-- hours are there. Sets added since (other start dates) don't matter.
do $$
declare
    seeded_on date := (select (min(created_at) at time zone 'UTC')::date from public.employees);
    friday date;
begin
    assert seeded_on is not null, 'no employees: run `npx supabase db reset` first';
    assert exists (select 1 from public.closed_days where closed_date = seeded_on + 9)
        and exists (select 1 from public.closed_days where closed_date = seeded_on + 30),
        'the seeded closed days (reset day + 9 and + 30) are missing: run `npx supabase db reset` first';
    friday := seeded_on + 21 + (5 - extract(dow from seeded_on + 21)::int + 7) % 7;
    assert (select count(*) from public.weekly_hours where starts_on is null) = 7
        and (select count(*) from public.weekly_hours where starts_on = seeded_on - 60) = 7
        and (select count(*) from public.weekly_hours where starts_on = seeded_on + 21) = 7
        and (select count(*) from public.custom_hours
             where hours_date in (seeded_on + 3, seeded_on + 4, seeded_on + 11, friday)) = 4,
        'the seeded business hours (first set, sets at reset day - 60 and + 21, custom hours at + 3, + 4, + 11 '
        'and the Friday after + 21) are missing: run `npx supabase db reset` first';
    perform set_config('tests.seed_today', seeded_on::text, true);
end;
$$;

create function pg_temp.seed_today()
returns date
language sql
stable
as $$
    select current_setting('tests.seed_today')::date;
$$;

-- The seeded custom hours on the first Friday on or after seed_today + 21.
create function pg_temp.seed_friday()
returns date
language sql
stable
as $$
    select pg_temp.seed_today() + 21 + (5 - extract(dow from pg_temp.seed_today() + 21)::int + 7) % 7;
$$;

create function pg_temp.emp(p_first_name text)
returns uuid
language sql
as $$
    select id from public.employees where split_part(name, ' ', 1) = p_first_name;
$$;

-- Runs p_sql and checks it fails with a message like p_message and SQLSTATE p_state.
-- Returns the error's detail. The failed statement's changes are rolled back.
create function pg_temp.expect_error(p_sql text, p_message text, p_state text)
returns text
language plpgsql
as $$
declare
    got_message text;
    got_state text;
    got_detail text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics got_message = message_text, got_state = returned_sqlstate, got_detail = pg_exception_detail;
        if got_message not like p_message or got_state <> p_state then
            raise exception 'expected "%" (%) from: %  got "%" (%)', p_message, p_state, p_sql, got_message, got_state;
        end if;
        return got_detail;
    end;
    raise exception 'expected "%" (%) from: %  but it succeeded', p_message, p_state, p_sql;
end;
$$;

-- A fingerprint of the calendar, payroll and business hours tables, to check that an undo puts
-- back exactly what was there (same ids, same values, same updated_at).
create function pg_temp.schedule_state()
returns text
language sql
as $$
    select md5(concat_ws('|',
        (select string_agg(concat_ws(',', id, employee_id, shift_date, start_time, end_time, wix_id, created_at, updated_at), ';' order by id)
            from public.shifts),
        (select string_agg(concat_ws(',', id, employee_id, off_date, period, status, source, requested_by, requested_at,
                reviewed_at, wix_id, created_at, updated_at), ';' order by id)
            from public.time_off),
        (select string_agg(closed_date::text, ';' order by closed_date) from public.closed_days),
        (select string_agg(concat_ws(',', id, shift_id, employee_id, work_date, start_time, end_time, status, note), ';' order by id)
            from public.shift_actuals),
        (select string_agg(concat_ws(',', id, employee_id, available_date, period, status, reviewed_at), ';' order by id)
            from public.availability),
        (select string_agg(concat_ws(',', hours_date, open_time, close_time, created_at, updated_at), ';' order by hours_date)
            from public.custom_hours),
        (select string_agg(concat_ws(',', id, starts_on, weekday, open_time, close_time, created_at, updated_at), ';' order by id)
            from public.weekly_hours)
    ));
$$;

-- now() is the same for every statement in this one test transaction, so an edit made by a
-- later request is simulated by moving the row's updated_at forward.
create function pg_temp.hours_edited_later(p_date date)
returns void
language plpgsql
as $$
begin
    perform set_config('schedule.keep_updated_at', 'on', true);
    update public.custom_hours set updated_at = updated_at + interval '1 minute' where hours_date = p_date;
    perform set_config('schedule.keep_updated_at', 'off', true);
end;
$$;

create function pg_temp.assert_change_shape(p_change jsonb)
returns void
language plpgsql
as $$
begin
    assert jsonb_typeof(p_change -> 'made_at') = 'string'
        and jsonb_typeof(p_change #> '{inserted,shifts}') = 'array'
        and jsonb_typeof(p_change #> '{inserted,time_off}') = 'array'
        and jsonb_typeof(p_change #> '{inserted,closed_days}') = 'array'
        and jsonb_typeof(p_change #> '{inserted,custom_hours}') = 'array'
        and jsonb_typeof(p_change #> '{updated,shifts}') = 'array'
        and jsonb_typeof(p_change #> '{updated,time_off}') = 'array'
        and jsonb_typeof(p_change #> '{updated,custom_hours}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,shifts}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,time_off}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,closed_days}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,custom_hours}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,actual_links}') = 'array',
        'change is missing a key: ' || p_change::text;
end;
$$;

-- True when every list in the change is empty.
create function pg_temp.is_empty_change(p_change jsonb)
returns boolean
language sql
as $$
    select (p_change - 'made_at') = (public.empty_change() - 'made_at');
$$;

-- True when the three custom_hours lists are empty.
create function pg_temp.no_hours_changes(p_change jsonb)
returns boolean
language sql
as $$
    select p_change #> '{inserted,custom_hours}' = '[]'::jsonb
        and p_change #> '{updated,custom_hours}' = '[]'::jsonb
        and p_change #> '{deleted,custom_hours}' = '[]'::jsonb;
$$;

-- The weekly hours on a date, with the lookup the functions use.
create function pg_temp.standard_hours(p_date date, out open_time time, out close_time time)
language sql
stable
as $$
    select w.open_time, w.close_time
    from public.weekly_hours w
    where w.weekday = extract(dow from p_date)::smallint and (w.starts_on is null or w.starts_on <= p_date)
    order by w.starts_on desc nulls last
    limit 1;
$$;

-- A save_weekly_hours set with the same hours every day.
create function pg_temp.hours_set(p_starts_on date, p_open text, p_close text)
returns jsonb
language sql
as $$
    select jsonb_build_object('starts_on', p_starts_on, 'days',
        (select jsonb_agg(jsonb_build_object('weekday', w, 'open_time', p_open, 'close_time', p_close) order by w)
         from generate_series(0, 6) w));
$$;

-- A saved set as save_weekly_hours takes it (days Sunday first, times as HH:MM).
create function pg_temp.saved_set(p_starts_on date)
returns jsonb
language sql
as $$
    select jsonb_build_object('starts_on', p_starts_on, 'days',
        jsonb_agg(jsonb_build_object('weekday', w.weekday, 'open_time', to_char(w.open_time, 'HH24:MI'),
            'close_time', to_char(w.close_time, 'HH24:MI')) order by w.weekday))
    from public.weekly_hours w
    where w.starts_on is not distinct from p_starts_on;
$$;

-- The starts_on of the set in effect on business_today() (null: the first set).
create function pg_temp.current_set_start()
returns date
language sql
as $$
    select max(w.starts_on) from public.weekly_hours w where w.starts_on <= public.business_today();
$$;

-- ---------------------------------------------------------------------------
-- 1. Grants and function settings
-- ---------------------------------------------------------------------------

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.save_weekly_hours(jsonb)',
        'public.admin_set_custom_hours(date[], time, time)',
        'public.admin_set_standard_hours(date[])',
        'public.empty_change()',
        'public.admin_close_days(date[])',
        'public.admin_undo(jsonb)'
    ] loop
        assert not has_function_privilege('anon', fn, 'execute'), fn || ' can be called by anon';
        assert not has_function_privilege('public', fn, 'execute'), fn || ' can be called by public';
        assert has_function_privilege('authenticated', fn, 'execute'), fn || ' can''t be called by authenticated';
        assert (
            select not p.prosecdef and p.proconfig = array['search_path=""'] and l.lanname = 'plpgsql'
            from pg_proc p join pg_language l on l.oid = p.prolang
            where p.oid = fn::regprocedure
        ), fn || ' must be plpgsql, security invoker, with an empty search_path';
        assert (
            select count(*) from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = (select proname from pg_proc where oid = fn::regprocedure)
        ) = 1, fn || ' has an overload';
        if fn <> 'public.empty_change()' then
            assert (select prosrc from pg_proc where oid = fn::regprocedure)
                like '%pg_advisory_xact_lock(hashtextextended(''business_hours'', 0))%',
                fn || ' must take the business_hours lock';
        end if;
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables: row level security, policies, triggers, no anon privileges
-- ---------------------------------------------------------------------------

do $$
declare
    tbl text;
begin
    foreach tbl in array array['weekly_hours', 'custom_hours'] loop
        assert (select relrowsecurity from pg_class where oid = ('public.' || tbl)::regclass), tbl || ' needs row level security';
        assert (select array_agg(policyname::text order by policyname) from pg_policies
                where schemaname = 'public' and tablename = tbl)
            = array['admins manage ' || replace(tbl, '_', ' '), 'staff can read ' || replace(tbl, '_', ' ')],
            tbl || ' should have exactly its two policies';
        assert exists (
            select 1 from pg_trigger
            where tgrelid = ('public.' || tbl)::regclass and tgname = 'set_updated_at' and not tgisinternal
        ), tbl || ' needs its set_updated_at trigger';
        assert not has_table_privilege('anon', 'public.' || tbl, 'select'), 'anon can read ' || tbl;
        assert not has_table_privilege('anon', 'public.' || tbl, 'insert'), 'anon can insert into ' || tbl;
        assert has_table_privilege('authenticated', 'public.' || tbl, 'select'), 'authenticated can''t read ' || tbl;
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. anon can't read the tables at all
-- ---------------------------------------------------------------------------

set local role anon;
do $$
begin
    perform pg_temp.expect_error('select 1 from public.weekly_hours', 'permission denied for table weekly_hours', '42501');
    perform pg_temp.expect_error('select 1 from public.custom_hours', 'permission denied for table custom_hours', '42501');
    perform pg_temp.expect_error('select public.save_weekly_hours(''{}'')', 'permission denied for function save_weekly_hours', '42501');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A login that isn't staff sees nothing
-- ---------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';

do $$
begin
    assert auth.uid() = '00000000-0000-0000-0000-0000000000ff' and not public.is_staff();
    assert (select count(*) from public.weekly_hours) = 0, 'nobody should see no weekly hours';
    assert (select count(*) from public.custom_hours) = 0, 'nobody should see no custom hours';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Employees read the hours but can't change them
-- ---------------------------------------------------------------------------

-- avery, an employee login
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';

savepoint t;
do $$
declare
    before_state text := pg_temp.schedule_state();
    n integer;
    call text;
begin
    assert auth.uid() = '00000000-0000-0000-0000-000000000001' and public.is_staff() and not public.is_admin();
    assert (select count(*) from public.weekly_hours) > 0, 'avery should read weekly hours';
    assert (select count(*) from public.custom_hours) > 0, 'avery should read custom hours';

    perform pg_temp.expect_error(
        'insert into public.weekly_hours (starts_on, weekday, open_time, close_time) values (current_date + 400, 1, ''09:00'', ''17:00'')',
        'new row violates row-level security policy%', '42501');
    perform pg_temp.expect_error(
        'insert into public.custom_hours (hours_date, open_time, close_time) values (current_date + 400, ''09:00'', ''17:00'')',
        'new row violates row-level security policy%', '42501');

    update public.weekly_hours set open_time = '08:00';
    get diagnostics n = row_count;
    assert n = 0, 'avery updated weekly hours';
    delete from public.weekly_hours;
    get diagnostics n = row_count;
    assert n = 0, 'avery deleted weekly hours';
    update public.custom_hours set open_time = '08:00';
    get diagnostics n = row_count;
    assert n = 0, 'avery updated custom hours';
    delete from public.custom_hours;
    get diagnostics n = row_count;
    assert n = 0, 'avery deleted custom hours';
    assert pg_temp.schedule_state() = before_state, 'nothing should change';

    foreach call in array array[
        'select public.save_weekly_hours(''{"sets": [], "remove": []}'')',
        'select public.admin_set_custom_hours(array[current_date + 400], ''09:00'', ''17:00'')',
        'select public.admin_set_standard_hours(array[current_date + 400])'
    ] loop
        perform pg_temp.expect_error(call, 'not_admin', '42501');
    end loop;
end;
$$;
rollback to savepoint t;

-- The admin login for everything else.
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';

do $$
begin
    assert public.is_admin(), 'admin@example.com should be an admin';
    perform pg_temp.assert_change_shape(public.empty_change());
    assert pg_temp.is_empty_change(public.empty_change());
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. save_weekly_hours: invalid input changes nothing
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    later date := public.business_today() + 100;
    good jsonb := pg_temp.hours_set(later, '10:00', '18:00');
    days jsonb := good -> 'days';
    payload jsonb;
    before_state text := pg_temp.schedule_state();
begin
    foreach payload in array array[
        -- not an object; a list missing
        '[]'::jsonb,
        '"sets"'::jsonb,
        jsonb_build_object('remove', '[]'::jsonb),
        jsonb_build_object('sets', '[]'::jsonb),
        jsonb_build_object('sets', '{}'::jsonb, 'remove', '[]'::jsonb),
        jsonb_build_object('sets', '[]'::jsonb, 'remove', '"2030-01-01"'::jsonb),
        -- a set that isn't an object, has no starts_on key, or a starts_on that isn't a string
        jsonb_build_object('sets', jsonb_build_array('[]'::jsonb), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(good - 'starts_on'), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{starts_on}', '20301231')), 'remove', '[]'::jsonb),
        -- days: missing, 6, 8, a duplicate weekday, weekday 7, 1.5 or "1.5", a null open time
        jsonb_build_object('sets', jsonb_build_array(good - 'days'), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days}', days - 6)), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days}', days || jsonb_build_array(days -> 0))),
            'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days,6,weekday}', '0')), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days,6,weekday}', '7')), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days,1,weekday}', '1.5')), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days,1,weekday}', '"1.5"')), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days,2,open_time}', 'null')), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days,2}', '{"weekday": 2, "open_time": "10:00"}')),
            'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(jsonb_set(good, '{days,3}', '"10:00-18:00"')), 'remove', '[]'::jsonb),
        -- two first sets; two sets on one date
        jsonb_build_object('sets', jsonb_build_array(pg_temp.hours_set(null, '10:00', '18:00'),
            pg_temp.hours_set(null, '11:00', '18:00')), 'remove', '[]'::jsonb),
        jsonb_build_object('sets', jsonb_build_array(good, pg_temp.hours_set(later, '11:00', '18:00')), 'remove', '[]'::jsonb),
        -- a removal that isn't a string; a date both saved and removed
        jsonb_build_object('sets', '[]'::jsonb, 'remove', jsonb_build_array(20301231)),
        jsonb_build_object('sets', jsonb_build_array(good), 'remove', jsonb_build_array(later))
    ] loop
        perform pg_temp.expect_error(format('select public.save_weekly_hours(%L)', payload), 'invalid_input', '22023');
    end loop;
    perform pg_temp.expect_error('select public.save_weekly_hours(null)', 'invalid_input', '22023');
    assert pg_temp.schedule_state() = before_state, 'invalid weekly saves should change nothing';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 7. save_weekly_hours: times the table refuses
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    later date := public.business_today() + 100;
    good jsonb := pg_temp.hours_set(later, '10:00', '18:00');
    before_state text := pg_temp.schedule_state();
begin
    perform pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', jsonb_build_array(jsonb_set(good, '{days,1,close_time}', '"09:00"')), 'remove', '[]'::jsonb)),
        '%weekly_hours_close_after_open%', '23514');
    perform pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', jsonb_build_array(jsonb_set(good, '{days,1,close_time}', '"10:00"')), 'remove', '[]'::jsonb)),
        '%weekly_hours_close_after_open%', '23514');
    perform pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', jsonb_build_array(jsonb_set(good, '{days,1,close_time}', '"24:00"')), 'remove', '[]'::jsonb)),
        '%weekly_hours_close_after_open%', '23514');
    perform pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', jsonb_build_array(jsonb_set(good, '{days,1,open_time}', '"09:00:30"')), 'remove', '[]'::jsonb)),
        '%weekly_hours_whole_minutes%', '23514');
    assert pg_temp.schedule_state() = before_state, 'refused weekly saves should change nothing';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 8. save_weekly_hours: correcting the set in effect today
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    cur date := pg_temp.current_set_start();
    others_before text;
    custom_before text;
    payload jsonb;
begin
    assert (select count(*) from public.weekly_hours where starts_on is not distinct from cur) = 7;
    assert (select bool_and(updated_at < now()) from public.weekly_hours where starts_on is not distinct from cur),
        'the seeded rows should be older than this test';
    select string_agg(concat_ws(',', id, open_time, close_time, created_at, updated_at), ';' order by weekday)
    into others_before
    from public.weekly_hours where starts_on is not distinct from cur and weekday <> 0;
    select string_agg(concat_ws(',', hours_date, open_time, close_time, updated_at), ';' order by hours_date)
    into custom_before
    from public.custom_hours;

    -- Sunday (index 0) changes from 12-5 to 1-5.
    payload := jsonb_build_object('sets', jsonb_build_array(jsonb_set(pg_temp.saved_set(cur), '{days,0}',
        jsonb_build_object('weekday', 0, 'open_time', '13:00', 'close_time', '17:00'))), 'remove', '[]'::jsonb);
    perform public.save_weekly_hours(payload);

    assert (select open_time = '13:00' and close_time = '17:00' and updated_at = now()
            from public.weekly_hours where starts_on is not distinct from cur and weekday = 0),
        'Sunday should have the new hours';
    assert (select string_agg(concat_ws(',', id, open_time, close_time, created_at, updated_at), ';' order by weekday)
            from public.weekly_hours where starts_on is not distinct from cur and weekday <> 0) = others_before,
        'the other days should be unchanged, updated_at included';
    assert (select count(*) from public.weekly_hours where starts_on is not distinct from cur) = 7;
    assert (select string_agg(concat_ws(',', hours_date, open_time, close_time, updated_at), ';' order by hours_date)
            from public.custom_hours) = custom_before, 'weekly saves never touch custom hours';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 9. save_weekly_hours: add an upcoming change, then remove it
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    later date := public.business_today() + 100;
    before_state text;
begin
    perform public.save_weekly_hours(jsonb_build_object(
        'sets', jsonb_build_array(pg_temp.hours_set(later, '09:00', '17:00')), 'remove', '[]'::jsonb));
    assert (select count(*) from public.weekly_hours
            where starts_on = later and open_time = '09:00' and close_time = '17:00') = 7, 'the new set should have 7 days';
    assert (select array_agg(weekday order by weekday) from public.weekly_hours where starts_on = later)
        = array[0, 1, 2, 3, 4, 5, 6]::smallint[];

    perform public.save_weekly_hours(jsonb_build_object('sets', '[]'::jsonb, 'remove', jsonb_build_array(later)));
    assert not exists (select 1 from public.weekly_hours where starts_on = later), 'the upcoming set should be removed';

    -- A set that isn't there: nothing happens.
    before_state := pg_temp.schedule_state();
    perform public.save_weekly_hours(jsonb_build_object('sets', '[]'::jsonb, 'remove', jsonb_build_array(later + 1)));
    assert pg_temp.schedule_state() = before_state;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 10. save_weekly_hours: sets in effect can't be removed
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    business_day date := public.business_today();
    detail text;
begin
    detail := pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', '[]'::jsonb, 'remove', jsonb_build_array(today - 60))), 'hours_in_effect', 'P0001');
    assert detail = to_char(today - 60, 'YYYY-MM-DD'), 'hours_in_effect detail: ' || coalesce(detail, 'null');
    assert (select count(*) from public.weekly_hours where starts_on = today - 60) = 7;

    -- A set starting today is in effect.
    perform public.save_weekly_hours(jsonb_build_object(
        'sets', jsonb_build_array(pg_temp.hours_set(business_day, '09:00', '17:00')), 'remove', '[]'::jsonb));
    assert (select count(*) from public.weekly_hours where starts_on = business_day) = 7;
    detail := pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', '[]'::jsonb, 'remove', jsonb_build_array(business_day))), 'hours_in_effect', 'P0001');
    assert detail = to_char(business_day, 'YYYY-MM-DD');
    assert (select count(*) from public.weekly_hours where starts_on = business_day) = 7;

    -- All or nothing: the set in the same call isn't saved either.
    perform pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', jsonb_build_array(pg_temp.hours_set(business_day + 100, '09:00', '17:00')),
        'remove', jsonb_build_array(today - 60))), 'hours_in_effect', 'P0001');
    assert not exists (select 1 from public.weekly_hours where starts_on = business_day + 100),
        'nothing from a refused save should be kept';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 11. save_weekly_hours: a dated set needs the first set
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    later date := public.business_today() + 100;
    detail text;
begin
    delete from public.weekly_hours;
    assert not exists (select 1 from public.weekly_hours);

    detail := pg_temp.expect_error(format('select public.save_weekly_hours(%L)', jsonb_build_object(
        'sets', jsonb_build_array(pg_temp.hours_set(later, '09:00', '17:00')), 'remove', '[]'::jsonb)),
        'invalid_input', '22023');
    assert detail = 'The first set of hours is missing.', 'detail: ' || coalesce(detail, 'null');
    assert not exists (select 1 from public.weekly_hours);

    perform public.save_weekly_hours(jsonb_build_object(
        'sets', jsonb_build_array(pg_temp.hours_set(null, '10:00', '18:00')), 'remove', '[]'::jsonb));
    assert (select count(*) from public.weekly_hours where starts_on is null) = 7;

    perform public.save_weekly_hours(jsonb_build_object(
        'sets', jsonb_build_array(pg_temp.hours_set(later, '09:00', '17:00')), 'remove', '[]'::jsonb));
    assert (select count(*) from public.weekly_hours where starts_on = later) = 7;
    assert (select count(*) from public.weekly_hours) = 14;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 12. Custom hours are compared with the set in effect on their date
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    old_monday date := (select d::date from generate_series(today - 73, today - 67, interval '1 day') d
                        where extract(dow from d::date) = 1);
    recent_monday date := (select d::date from generate_series(today - 14, today - 8, interval '1 day') d
                           where extract(dow from d::date) = 1);
    future_friday date := pg_temp.seed_friday() + 14;
    change jsonb;
begin
    assert old_monday < today - 60 and recent_monday > today - 60 and future_friday between today + 35 and today + 41;
    assert not exists (select 1 from public.custom_hours where hours_date in (old_monday, recent_monday, future_friday));
    assert not exists (select 1 from public.closed_days where closed_date in (old_monday, recent_monday, future_friday));

    -- Before the set 60 days ago: the first set (Monday 10-8) applies.
    change := public.admin_set_custom_hours(array[old_monday], '10:00', '20:00');
    perform pg_temp.assert_change_shape(change);
    assert pg_temp.is_empty_change(change), 'hours equal to the first set: ' || change::text;
    assert not exists (select 1 from public.custom_hours where hours_date = old_monday);
    change := public.admin_set_custom_hours(array[old_monday], '11:00', '21:00');
    assert change #>> '{inserted,custom_hours,0,hours_date}' = to_char(old_monday, 'YYYY-MM-DD')
        and jsonb_array_length(change #> '{inserted,custom_hours}') = 1;
    assert exists (select 1 from public.custom_hours where hours_date = old_monday and open_time = '11:00');

    -- In the set from 60 days ago (Monday 11-9), so 10-8 is stored. (With nulls first, the
    -- first set would win and this would count as standard.)
    change := public.admin_set_custom_hours(array[recent_monday], '10:00', '20:00');
    assert change #>> '{inserted,custom_hours,0,hours_date}' = to_char(recent_monday, 'YYYY-MM-DD')
        and jsonb_array_length(change #> '{inserted,custom_hours}') = 1;
    assert exists (select 1 from public.custom_hours where hours_date = recent_monday and open_time = '10:00');

    -- In the set starting in three weeks (Friday 11-10).
    change := public.admin_set_custom_hours(array[future_friday], '11:00', '22:00');
    assert pg_temp.no_hours_changes(change), 'hours equal to the upcoming set: ' || change::text;
    assert not exists (select 1 from public.custom_hours where hours_date = future_friday);
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 13. admin_set_custom_hours: add, change, same again, several dates
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    x date := pg_temp.seed_today() + 41;
    change jsonb;
    row_json jsonb;
begin
    assert not exists (select 1 from public.custom_hours where hours_date between x and x + 4);
    assert not exists (select 1 from public.closed_days where closed_date between x and x + 4);

    change := public.admin_set_custom_hours(array[x], '12:00', '16:00');
    perform pg_temp.assert_change_shape(change);
    assert jsonb_array_length(change #> '{inserted,custom_hours}') = 1;
    row_json := change #> '{inserted,custom_hours,0}';
    assert row_json ->> 'hours_date' = to_char(x, 'YYYY-MM-DD')
        and row_json ->> 'open_time' = '12:00:00' and row_json ->> 'close_time' = '16:00:00', row_json::text;
    assert (select array_agg(k order by k) from jsonb_object_keys(row_json) k)
        = array['close_time', 'created_at', 'hours_date', 'open_time', 'updated_at'], 'a full row: ' || row_json::text;
    assert row_json = (select to_jsonb(h) from public.custom_hours h where h.hours_date = x);
    assert (change - 'made_at' - 'inserted') = (public.empty_change() - 'made_at' - 'inserted')
        and change #> '{inserted,shifts}' = '[]' and change #> '{inserted,time_off}' = '[]'
        and change #> '{inserted,closed_days}' = '[]', 'only the new hours are listed';

    change := public.admin_set_custom_hours(array[x], '12:00', '15:00');
    perform pg_temp.assert_change_shape(change);
    assert jsonb_array_length(change #> '{updated,custom_hours}') = 1
        and change #>> '{updated,custom_hours,0,before,close_time}' = '16:00:00'
        and change #>> '{updated,custom_hours,0,after,close_time}' = '15:00:00'
        and change #>> '{updated,custom_hours,0,before,hours_date}' = to_char(x, 'YYYY-MM-DD')
        and change #>> '{updated,custom_hours,0,after,hours_date}' = to_char(x, 'YYYY-MM-DD'), change::text;
    assert change #> '{inserted,custom_hours}' = '[]' and change #> '{deleted,custom_hours}' = '[]';
    assert (select close_time = '15:00' from public.custom_hours where hours_date = x);

    change := public.admin_set_custom_hours(array[x], '12:00', '15:00');
    assert pg_temp.is_empty_change(change), 'the same hours again: ' || change::text;

    -- Duplicates, nulls and order don't matter.
    change := public.admin_set_custom_hours(array[x + 3, x + 1, x + 3, null], '12:00', '16:00');
    assert (select array_agg(r ->> 'hours_date' order by ord) from jsonb_array_elements(change #> '{inserted,custom_hours}')
            with ordinality as e(r, ord))
        = array[to_char(x + 1, 'YYYY-MM-DD'), to_char(x + 3, 'YYYY-MM-DD')], change::text;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 14. Custom hours equal to the weekly hours delete a date's custom hours
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    day date := pg_temp.seed_today() + 4;
    std record;
    existing jsonb;
    change jsonb;
begin
    select to_jsonb(h) into existing from public.custom_hours h where h.hours_date = day;
    assert existing is not null, 'seed needs custom hours at + 4';
    select * into std from pg_temp.standard_hours(day);
    change := public.admin_set_custom_hours(array[day], std.open_time, std.close_time);
    perform pg_temp.assert_change_shape(change);
    assert change #> '{deleted,custom_hours}' = jsonb_build_array(existing), change::text;
    assert change #> '{inserted,custom_hours}' = '[]' and change #> '{updated,custom_hours}' = '[]';
    assert not exists (select 1 from public.custom_hours where hours_date = day);
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 15. Custom hours on a closed day reopen it
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    closed date := pg_temp.seed_today() + 9;
    change jsonb;
begin
    assert exists (select 1 from public.closed_days where closed_date = closed);
    change := public.admin_set_custom_hours(array[closed], '12:00', '16:00');
    perform pg_temp.assert_change_shape(change);
    assert change #> '{deleted,closed_days}' = jsonb_build_array(to_char(closed, 'YYYY-MM-DD')), change::text;
    assert change #>> '{inserted,custom_hours,0,hours_date}' = to_char(closed, 'YYYY-MM-DD')
        and jsonb_array_length(change #> '{inserted,custom_hours}') = 1;
    assert not exists (select 1 from public.closed_days where closed_date = closed), 'the day should be open';
    assert exists (select 1 from public.custom_hours where hours_date = closed and open_time = '12:00' and close_time = '16:00');
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 16. admin_set_custom_hours: invalid input
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    x date := pg_temp.seed_today() + 41;
    call text;
    before_state text := pg_temp.schedule_state();
begin
    foreach call in array array[
        'select public.admin_set_custom_hours(array[]::date[], ''12:00'', ''16:00'')',
        'select public.admin_set_custom_hours(null, ''12:00'', ''16:00'')',
        'select public.admin_set_custom_hours(array[null, null]::date[], ''12:00'', ''16:00'')',
        format('select public.admin_set_custom_hours(%L, null, ''16:00'')', array[x]),
        format('select public.admin_set_custom_hours(%L, ''12:00'', null)', array[x]),
        format('select public.admin_set_custom_hours(%L, ''12:00'', ''12:00'')', array[x]),
        format('select public.admin_set_custom_hours(%L, ''16:00'', ''12:00'')', array[x]),
        format('select public.admin_set_custom_hours(%L, ''12:00'', ''24:00'')', array[x]),
        format('select public.admin_set_custom_hours(%L, ''09:00:30'', ''16:00'')', array[x]),
        format('select public.admin_set_custom_hours(%L, ''09:00'', ''16:00:30'')', array[x])
    ] loop
        perform pg_temp.expect_error(call, 'invalid_input', '22023');
    end loop;
    assert pg_temp.schedule_state() = before_state;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 17. admin_set_standard_hours
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    existing jsonb;
    change jsonb;
begin
    -- Custom hours are cleared.
    select to_jsonb(h) into existing from public.custom_hours h where h.hours_date = today + 4;
    change := public.admin_set_standard_hours(array[today + 4]);
    perform pg_temp.assert_change_shape(change);
    assert change #> '{deleted,custom_hours}' = jsonb_build_array(existing), change::text;
    assert change #> '{deleted,closed_days}' = '[]';
    assert not exists (select 1 from public.custom_hours where hours_date = today + 4);

    -- A closed day is reopened.
    change := public.admin_set_standard_hours(array[today + 30]);
    assert change #> '{deleted,closed_days}' = jsonb_build_array(to_char(today + 30, 'YYYY-MM-DD')), change::text;
    assert change #> '{deleted,custom_hours}' = '[]';
    assert not exists (select 1 from public.closed_days where closed_date = today + 30);

    -- A day already on its weekly hours: nothing to do.
    change := public.admin_set_standard_hours(array[today + 41, today + 41]);
    perform pg_temp.assert_change_shape(change);
    assert pg_temp.is_empty_change(change), change::text;

    perform pg_temp.expect_error('select public.admin_set_standard_hours(array[]::date[])', 'invalid_input', '22023');
    perform pg_temp.expect_error('select public.admin_set_standard_hours(array[null]::date[])', 'invalid_input', '22023');
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 18. Closing a day clears its custom hours; undo puts them back
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    day date := today + 4;
    existing jsonb;
    before_state text;
    change jsonb;
begin
    select to_jsonb(h) into existing from public.custom_hours h where h.hours_date = day;
    before_state := pg_temp.schedule_state();
    change := public.admin_close_days(array[day]);
    perform pg_temp.assert_change_shape(change);
    assert change #> '{inserted,closed_days}' = jsonb_build_array(to_char(day, 'YYYY-MM-DD'));
    assert change #> '{deleted,custom_hours}' = jsonb_build_array(existing), change::text;
    assert not exists (select 1 from public.custom_hours where hours_date = day);

    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of the close should restore the custom hours as they were';
    assert not exists (select 1 from public.closed_days where closed_date = day);

    -- Already closed: nothing to clear.
    change := public.admin_close_days(array[today + 9]);
    assert change #> '{deleted,custom_hours}' = '[]' and change #> '{inserted,closed_days}' = '[]';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 19. Undo puts everything back
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    x date := today + 41;
    std record;
    before_state text;
    change jsonb;
begin
    -- Custom hours added.
    before_state := pg_temp.schedule_state();
    change := public.admin_set_custom_hours(array[x, x + 1], '12:00', '16:00');
    assert jsonb_array_length(change #> '{inserted,custom_hours}') = 2;
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of added custom hours';

    -- Custom hours changed (the seeded + 11, so its older updated_at must come back).
    change := public.admin_set_custom_hours(array[today + 11], '12:00', '15:00');
    assert jsonb_array_length(change #> '{updated,custom_hours}') = 1;
    assert (select updated_at = now() from public.custom_hours where hours_date = today + 11);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of changed custom hours';
    assert (select updated_at < now() from public.custom_hours where hours_date = today + 11);

    -- Custom hours set equal to the weekly hours (deleted).
    select * into std from pg_temp.standard_hours(today + 4);
    change := public.admin_set_custom_hours(array[today + 4], std.open_time, std.close_time);
    assert jsonb_array_length(change #> '{deleted,custom_hours}') = 1;
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of custom hours equal to standard';

    -- Custom hours on a closed day: the undo closes it again.
    change := public.admin_set_custom_hours(array[today + 9], '12:00', '16:00');
    perform public.admin_undo(change);
    assert exists (select 1 from public.closed_days where closed_date = today + 9);
    assert pg_temp.schedule_state() = before_state, 'undo of custom hours on a closed day';

    -- Standard hours clearing custom hours.
    change := public.admin_set_standard_hours(array[today + 4, today + 11]);
    assert jsonb_array_length(change #> '{deleted,custom_hours}') = 2;
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of standard hours clearing custom hours';

    -- Standard hours reopening a closed day.
    change := public.admin_set_standard_hours(array[today + 30]);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of standard hours reopening a day';

    -- Closing days with and without custom hours.
    change := public.admin_close_days(array[today + 4, today + 11, x]);
    assert jsonb_array_length(change #> '{deleted,custom_hours}') = 2;
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of a close that cleared custom hours';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 20. Undo is refused when the hours changed since
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    x date := today + 41;
    state_before_undo text;
    change jsonb;
    reopen jsonb;
begin
    -- Added, then edited since.
    change := public.admin_set_custom_hours(array[x], '12:00', '16:00');
    perform pg_temp.hours_edited_later(x);
    state_before_undo := pg_temp.schedule_state();
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert pg_temp.schedule_state() = state_before_undo;

    -- Changed, then edited since.
    change := public.admin_set_custom_hours(array[x], '12:00', '15:00');
    assert jsonb_array_length(change #> '{updated,custom_hours}') = 1;
    perform pg_temp.hours_edited_later(x);
    state_before_undo := pg_temp.schedule_state();
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert pg_temp.schedule_state() = state_before_undo;
    assert (select close_time = '15:00' from public.custom_hours where hours_date = x);

    -- Added, then the day was closed (which cleared them): the day stays closed.
    change := public.admin_set_custom_hours(array[x + 1], '12:00', '16:00');
    perform public.admin_close_days(array[x + 1]);
    state_before_undo := pg_temp.schedule_state();
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert pg_temp.schedule_state() = state_before_undo;
    assert exists (select 1 from public.closed_days where closed_date = x + 1);

    -- Reopened, then given custom hours: undoing the reopen would leave custom hours on a closed day.
    reopen := public.admin_set_standard_hours(array[today + 30]);
    assert reopen #> '{deleted,closed_days}' = jsonb_build_array(to_char(today + 30, 'YYYY-MM-DD'));
    perform public.admin_set_custom_hours(array[today + 30], '12:00', '16:00');
    state_before_undo := pg_temp.schedule_state();
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', reopen), 'undo_stale', 'P0001');
    assert pg_temp.schedule_state() = state_before_undo;
    assert not exists (select 1 from public.closed_days where closed_date = today + 30);

    -- Cleared, then set again: putting the old row back would clash with the new one.
    change := public.admin_set_standard_hours(array[today + 4]);
    assert jsonb_array_length(change #> '{deleted,custom_hours}') = 1;
    perform public.admin_set_custom_hours(array[today + 4], '12:00', '16:00');
    state_before_undo := pg_temp.schedule_state();
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert pg_temp.schedule_state() = state_before_undo;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 21. Changes from before business hours still undo; bad hours lists are refused
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    reopened date := today + 30;
    before_state text := pg_temp.schedule_state();
    old_change jsonb;
    list text;
begin
    -- Reopened the way the old page did (a plain delete), with its change (no custom_hours lists).
    delete from public.closed_days where closed_date = reopened;
    old_change := jsonb_build_object(
        'made_at', now(),
        'inserted', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb, 'closed_days', '[]'::jsonb),
        'updated', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb),
        'deleted', jsonb_build_object('shifts', '[]'::jsonb, 'time_off', '[]'::jsonb,
            'closed_days', jsonb_build_array(reopened), 'actual_links', '[]'::jsonb));
    perform public.admin_undo(old_change);
    assert exists (select 1 from public.closed_days where closed_date = reopened), 'an old change should still undo';
    assert pg_temp.schedule_state() = before_state;

    foreach list in array array['{inserted,custom_hours}', '{updated,custom_hours}', '{deleted,custom_hours}'] loop
        perform pg_temp.expect_error(format('select public.admin_undo(%L)',
            jsonb_set(public.empty_change(), list::text[], '{}'::jsonb)), 'invalid_input', '22023');
        perform pg_temp.expect_error(format('select public.admin_undo(%L)',
            jsonb_set(public.empty_change(), list::text[], 'null'::jsonb)), 'invalid_input', '22023');
    end loop;
    assert pg_temp.schedule_state() = before_state;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 22. Undoing hours leaves shifts, time off and payroll alone
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    x date := pg_temp.seed_today() + 42;
    shift_count integer := (select count(*) from public.shifts where shift_date = x);
    before_state text := pg_temp.schedule_state();
    change jsonb;
begin
    assert shift_count > 0, 'seed needs shifts at + 42';
    change := public.admin_set_custom_hours(array[x], '12:00', '16:00');
    assert (select count(*) from public.shifts where shift_date = x) = shift_count;
    assert change #> '{deleted,shifts}' = '[]' and change #> '{deleted,time_off}' = '[]'
        and change #> '{deleted,actual_links}' = '[]';
    perform public.admin_undo(change);
    assert (select count(*) from public.shifts where shift_date = x) = shift_count;
    assert pg_temp.schedule_state() = before_state;

    change := public.admin_set_standard_hours(array[pg_temp.seed_today() + 4]);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- 23. The seeded hours are what the app's checks rely on
-- ---------------------------------------------------------------------------

do $$
declare
    today date := pg_temp.seed_today();
    day date;
begin
    assert (select (h.open_time, h.close_time) = (s.open_time, s.close_time)
            from public.custom_hours h, pg_temp.standard_hours(h.hours_date) s
            where h.hours_date = today + 3), 'the custom hours at + 3 should equal that day''s weekly hours';
    foreach day in array array[today + 4, today + 11, pg_temp.seed_friday()] loop
        assert (select (h.open_time, h.close_time) <> (s.open_time, s.close_time)
                from public.custom_hours h, pg_temp.standard_hours(h.hours_date) s
                where h.hours_date = day), 'the custom hours at ' || day || ' should differ from its weekly hours';
    end loop;
    assert (select open_time = '11:00' and close_time = '21:00' from public.custom_hours
            where hours_date = pg_temp.seed_friday());
    assert (select (open_time, close_time) = ('11:00'::time, '22:00'::time)
            from pg_temp.standard_hours(pg_temp.seed_friday())), 'the seeded Friday is in the set from + 21';
    assert not exists (
        select 1 from public.custom_hours h join public.closed_days c on c.closed_date = h.hours_date
    ), 'no custom hours on a closed day';
end;
$$;

rollback;

\echo ALL BUSINESS HOURS TESTS PASSED
