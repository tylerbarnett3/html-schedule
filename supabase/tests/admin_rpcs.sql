-- Tests for the admin database functions in 20260929000001_admin.sql.
-- Run against the LOCAL database after `npx supabase db reset` (they rely on seed.sql):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/admin_rpcs.sql
-- Everything runs in one transaction that is rolled back, so the data is left as it was.
-- The first failing check stops the run; the last line printed on success is
-- ALL ADMIN RPC TESTS PASSED.
--
-- Seed rows are found by their dates relative to the day of the reset (seed_today below), not
-- to current_date, so the tests still pass on a later day. They do need the seed rows as the
-- reset left them: edits made through the app since (deleting a seeded shift, reopening a
-- seeded closed day, ...) can make them fail. Reset again in that case.

\set QUIET on
\set ON_ERROR_STOP 1

begin;

-- ---------------------------------------------------------------------------
-- Test helpers (this session only)
-- ---------------------------------------------------------------------------

-- The day seed.sql counted as today. It dates its rows from current_date when the reset ran
-- it, in the database's time zone (UTC), and every row it inserts has that moment as its
-- created_at. current_date itself may have moved on since (after midnight UTC), or be another
-- day in psql's time zone (PGTZ).
do $$
declare
    seeded_on date := (select (min(created_at) at time zone 'UTC')::date from public.employees);
begin
    assert seeded_on is not null, 'no employees: run `npx supabase db reset` first';
    assert exists (select 1 from public.closed_days where closed_date = seeded_on + 9)
        and exists (select 1 from public.closed_days where closed_date = seeded_on + 30),
        'the seeded closed days (reset day + 9 and + 30) are missing: run `npx supabase db reset` first';
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
create function pg_temp.edited_later(p_table text, p_id uuid)
returns void
language plpgsql
as $$
begin
    perform set_config('schedule.keep_updated_at', 'on', true);
    execute format('update public.%I set updated_at = updated_at + interval ''1 minute'' where id = %L', p_table, p_id);
    perform set_config('schedule.keep_updated_at', 'off', true);
end;
$$;

create function pg_temp.assert_change_shape(p_change jsonb)
returns void
language plpgsql
as $$
begin
    assert jsonb_typeof(p_change #> '{inserted,shifts}') = 'array'
        and jsonb_typeof(p_change #> '{inserted,time_off}') = 'array'
        and jsonb_typeof(p_change #> '{inserted,closed_days}') = 'array'
        and jsonb_typeof(p_change #> '{updated,shifts}') = 'array'
        and jsonb_typeof(p_change #> '{updated,time_off}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,shifts}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,time_off}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,closed_days}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,actual_links}') = 'array'
        and jsonb_typeof(p_change #> '{inserted,custom_hours}') = 'array'
        and jsonb_typeof(p_change #> '{updated,custom_hours}') = 'array'
        and jsonb_typeof(p_change #> '{deleted,custom_hours}') = 'array',
        'change is missing a key: ' || p_change::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants and function settings
-- ---------------------------------------------------------------------------

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.assert_admin()',
        'public.assert_open(date[])',
        'public.capture_delete_shifts(uuid[])',
        'public.empty_change()',
        'public.admin_add_shifts(jsonb)',
        'public.admin_add_days_off(jsonb, uuid[])',
        'public.admin_update_shift(uuid, uuid, date, time, time)',
        'public.admin_update_day_off(uuid, uuid, date, public.day_period, uuid[])',
        'public.admin_convert_to_day_off(uuid, uuid, date, public.day_period, uuid[])',
        'public.admin_convert_to_shift(uuid, uuid, date, time, time)',
        'public.admin_delete_items(uuid[], uuid[])',
        'public.admin_close_days(date[])',
        'public.admin_undo(jsonb)',
        'public.approve_time_off(uuid[], uuid[])',
        'public.approve_availability(uuid[])',
        'public.save_employee(jsonb)',
        'public.set_employee_order(uuid[])',
        'public.save_shift_actuals(jsonb)'
    ] loop
        assert not has_function_privilege('anon', fn, 'execute'), fn || ' can be called by anon';
        assert not has_function_privilege('public', fn, 'execute'), fn || ' can be called by public';
        assert has_function_privilege('authenticated', fn, 'execute'), fn || ' can''t be called by authenticated';
        assert (
            select not p.prosecdef and p.proconfig = array['search_path=""'] and l.lanname = 'plpgsql'
            from pg_proc p join pg_language l on l.oid = p.prolang
            where p.oid = fn::regprocedure
        ), fn || ' must be plpgsql, security invoker, with an empty search_path';
    end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Non-admins are refused (42501 not_admin); anon can't call at all
-- ---------------------------------------------------------------------------

set local role anon;
do $$
begin
    perform pg_temp.expect_error('select public.admin_undo(''{}'')', 'permission denied for function admin_undo', '42501');
    perform pg_temp.expect_error('select public.save_employee(''{}'')', 'permission denied for function save_employee', '42501');
end;
$$;

set local role authenticated;
-- avery, an employee login
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
declare
    call text;
begin
    assert auth.uid() = '00000000-0000-0000-0000-000000000001' and not public.is_admin();
    foreach call in array array[
        'select public.assert_admin()',
        'select public.assert_open(array[current_date])',
        'select public.capture_delete_shifts(array[]::uuid[])',
        'select public.empty_change()',
        'select public.admin_add_shifts(''[]'')',
        'select public.admin_add_days_off(''[]'')',
        'select public.admin_update_shift(null, null, null, null, null)',
        'select public.admin_update_day_off(null, null, null, null)',
        'select public.admin_convert_to_day_off(null, null, null, null)',
        'select public.admin_convert_to_shift(null, null, null, null, null)',
        'select public.admin_delete_items()',
        'select public.admin_close_days(array[current_date + 3])',
        'select public.admin_undo(''{}'')',
        'select public.approve_time_off(array[gen_random_uuid()])',
        'select public.approve_availability(array[gen_random_uuid()])',
        'select public.save_employee(''{"id": null, "name": "Sneaky", "color": "#2B6CB0", "rates": []}'')',
        'select public.set_employee_order(array[]::uuid[])',
        'select public.save_shift_actuals(''{}'')'
    ] loop
        perform pg_temp.expect_error(call, 'not_admin', '42501');
    end loop;
end;
$$;

-- The admin login for everything else.
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';

do $$
begin
    assert public.is_admin(), 'admin@example.com should be an admin';
    perform pg_temp.assert_change_shape(public.empty_change());
end;
$$;

-- ---------------------------------------------------------------------------
-- Closed days: add, update, convert and approve refuse a closed date
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    closed date := today + 9;
    avery uuid := pg_temp.emp('Avery');
    mia uuid := pg_temp.emp('Mia');
    grace uuid := pg_temp.emp('Grace');
    shift public.shifts%rowtype;
    mia_day_off uuid;
    grace_request uuid;
    detail text;
    change jsonb;
begin
    assert exists (select 1 from public.closed_days where closed_date = closed), 'seed should close today + 9';
    select * into shift from public.shifts
    where employee_id = avery and shift_date between today + 1 and today + 7
    order by shift_date, start_time limit 1;
    select id into mia_day_off from public.time_off
    where employee_id = mia and off_date = today + 8 and source = 'assigned';

    detail := pg_temp.expect_error(format('select public.admin_add_shifts(%L)', jsonb_build_array(
        jsonb_build_object('employee_id', avery, 'shift_date', today + 3, 'start_time', '06:00', 'end_time', '07:00'),
        jsonb_build_object('employee_id', avery, 'shift_date', closed, 'start_time', '06:00', 'end_time', '07:00'))),
        'closed_day', 'P0001');
    assert detail = to_char(closed, 'YYYY-MM-DD'), 'closed_day detail should be the closed date, got ' || coalesce(detail, 'null');
    perform pg_temp.expect_error(format('select public.admin_add_days_off(%L)', jsonb_build_array(
        jsonb_build_object('employee_id', avery, 'off_date', closed, 'period', 'full-day'))), 'closed_day', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_update_shift(%L, %L, %L, %L, %L)',
        shift.id, avery, closed, shift.start_time, shift.end_time), 'closed_day', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_update_day_off(%L, %L, %L, %L)',
        mia_day_off, mia, closed, 'full-day'), 'closed_day', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_convert_to_day_off(%L, %L, %L, %L)',
        shift.id, avery, closed, 'full-day'), 'closed_day', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_convert_to_shift(%L, %L, %L, %L, %L)',
        mia_day_off, mia, closed, '11:15', '15:45'), 'closed_day', 'P0001');
    assert exists (select 1 from public.shifts where id = shift.id and shift_date = shift.shift_date);

    -- A pending request on a closed day can't be approved.
    insert into public.time_off (employee_id, off_date, period, status, source)
    values (grace, today + 30, 'full-day', 'pending', 'request')
    returning id into grace_request;
    perform pg_temp.expect_error(format('select public.approve_time_off(%L)', array[grace_request]), 'closed_day', 'P0001');
    assert (select status from public.time_off where id = grace_request) = 'pending';

    -- Closing a day that's already closed isn't an error; it just isn't newly closed.
    change := public.admin_close_days(array[closed]);
    perform pg_temp.assert_change_shape(change);
    assert change #> '{inserted,closed_days}' = '[]'::jsonb;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- admin_add_shifts: duplicates, start = end, empty input; undo; stale undo
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    leo uuid := pg_temp.emp('Leo');
    grace uuid := pg_temp.emp('Grace');
    day date := today + 3;
    existing public.shifts%rowtype;
    before_state text;
    change jsonb;
    edit jsonb;
    added uuid;
begin
    select * into existing from public.shifts where shift_date = day order by id limit 1;
    perform pg_temp.expect_error(format('select public.admin_add_shifts(%L)', jsonb_build_array(jsonb_build_object(
        'employee_id', existing.employee_id, 'shift_date', existing.shift_date,
        'start_time', existing.start_time, 'end_time', existing.end_time))),
        '%shifts_unique_slot%', '23505');
    perform pg_temp.expect_error(format('select public.admin_add_shifts(%L)', jsonb_build_array(jsonb_build_object(
        'employee_id', leo, 'shift_date', day, 'start_time', '06:00', 'end_time', '06:00'))),
        '%shifts_check%', '23514');
    perform pg_temp.expect_error('select public.admin_add_shifts(''[]'')', 'invalid_input', '22023');
    perform pg_temp.expect_error('select public.admin_add_shifts(''[{"employee_id": null}]'')', 'invalid_input', '22023');

    before_state := pg_temp.schedule_state();
    change := public.admin_add_shifts(jsonb_build_array(
        jsonb_build_object('employee_id', leo, 'shift_date', day, 'start_time', '06:00', 'end_time', '08:00'),
        jsonb_build_object('employee_id', grace, 'shift_date', day, 'start_time', '06:00', 'end_time', '08:00')));
    perform pg_temp.assert_change_shape(change);
    assert jsonb_array_length(change #> '{inserted,shifts}') = 2;
    assert change #>> '{inserted,shifts,0,start_time}' = '06:00:00';
    assert (change #> '{inserted,shifts,0}') ?& array['id', 'employee_id', 'shift_date', 'start_time', 'end_time',
        'wix_id', 'created_at', 'updated_at'], 'inserted rows are full rows';
    assert pg_temp.schedule_state() <> before_state;
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of add shifts should restore the schedule';

    -- Edited since it was added: the undo is stale and changes nothing.
    change := public.admin_add_shifts(jsonb_build_array(
        jsonb_build_object('employee_id', leo, 'shift_date', day, 'start_time', '06:00', 'end_time', '08:00')));
    added := (change #>> '{inserted,shifts,0,id}')::uuid;
    edit := public.admin_update_shift(added, leo, day, '06:30', '08:00');
    perform pg_temp.edited_later('shifts', added);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert exists (select 1 from public.shifts where id = added and start_time = '06:30');

    -- Payroll hours recorded on it since: stale too.
    change := public.admin_add_shifts(jsonb_build_array(
        jsonb_build_object('employee_id', grace, 'shift_date', day, 'start_time', '05:00', 'end_time', '06:00')));
    added := (change #>> '{inserted,shifts,0,id}')::uuid;
    perform public.save_shift_actuals(jsonb_build_object('scheduled', jsonb_build_array(jsonb_build_object(
        'shift_id', added, 'employee_id', grace, 'status', 'confirmed', 'start_time', '05:00', 'end_time', '06:00', 'note', ''))));
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert exists (select 1 from public.shifts where id = added);
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- admin_add_days_off
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    nora uuid := pg_temp.emp('Nora');
    mia uuid := pg_temp.emp('Mia');
    grace uuid := pg_temp.emp('Grace');
    avery uuid := pg_temp.emp('Avery');
    detail text;
    day date;
    grace_shift uuid;
    grace_other_shift uuid;
    avery_shift uuid;
    before_state text;
    change jsonb;
    added jsonb;
begin
    -- Over Nora's pending morning request (+12): refused, with the request in the detail.
    detail := pg_temp.expect_error(format('select public.admin_add_days_off(%L)', jsonb_build_array(
        jsonb_build_object('employee_id', nora, 'off_date', today + 12, 'period', 'full-day'))),
        'pending_request', 'P0001');
    assert detail::jsonb = jsonb_build_object('employee_id', nora, 'off_date', today + 12, 'period', 'morning'),
        'pending_request detail: ' || coalesce(detail, 'null');
    perform pg_temp.expect_error(format('select public.admin_add_days_off(%L)', jsonb_build_array(
        jsonb_build_object('employee_id', nora, 'off_date', today + 12, 'period', 'morning'))),
        'pending_request', 'P0001');

    -- Over Mia's approved day off (+8): refused.
    perform pg_temp.expect_error(format('select public.admin_add_days_off(%L)', jsonb_build_array(
        jsonb_build_object('employee_id', mia, 'off_date', today + 8, 'period', 'evening'))),
        'day_off_overlap', '23P01');
    -- Two overlapping days off in one call: the second overlaps the first.
    perform pg_temp.expect_error(format('select public.admin_add_days_off(%L)', jsonb_build_array(
        jsonb_build_object('employee_id', avery, 'off_date', today + 3, 'period', 'full-day'),
        jsonb_build_object('employee_id', avery, 'off_date', today + 3, 'period', 'morning'))),
        'day_off_overlap', '23P01');
    perform pg_temp.expect_error('select public.admin_add_days_off(''[]'')', 'invalid_input', '22023');

    -- Nora's evening doesn't overlap her pending morning.
    change := public.admin_add_days_off(jsonb_build_array(
        jsonb_build_object('employee_id', nora, 'off_date', today + 12, 'period', 'evening')));
    assert jsonb_array_length(change #> '{inserted,time_off}') = 1;

    -- A day where Grace and Avery both work and Grace has no time off.
    select s.shift_date, s.id into day, grace_shift
    from public.shifts s
    where s.employee_id = grace and s.shift_date between today + 1 and today + 7
      and not exists (select 1 from public.time_off t where t.employee_id = grace and t.off_date = s.shift_date)
      and exists (select 1 from public.shifts a where a.employee_id = avery and a.shift_date = s.shift_date)
    order by s.shift_date, s.start_time
    limit 1;
    assert day is not null, 'seed needs a day where Grace and Avery both work';
    select id into avery_shift from public.shifts where employee_id = avery and shift_date = day limit 1;
    select id into grace_other_shift from public.shifts where employee_id = grace and shift_date <> day
    order by shift_date limit 1;

    before_state := pg_temp.schedule_state();
    change := public.admin_add_days_off(
        jsonb_build_array(jsonb_build_object('employee_id', grace, 'off_date', day, 'period', 'full-day')),
        array[grace_shift, avery_shift, grace_other_shift]);
    perform pg_temp.assert_change_shape(change);
    added := change #> '{inserted,time_off,0}';
    assert jsonb_array_length(change #> '{inserted,time_off}') = 1;
    assert added ->> 'source' = 'assigned' and added ->> 'status' = 'approved' and added -> 'reviewed_at' = 'null'::jsonb;
    assert (select reviewed_at is null and source = 'assigned' and status = 'approved'
            from public.time_off where id = (added ->> 'id')::uuid);
    -- Only the listed shift of the same employee on the same day is deleted.
    assert (select array_agg((x ->> 'id')::uuid) from jsonb_array_elements(change #> '{deleted,shifts}') x) = array[grace_shift];
    assert not exists (select 1 from public.shifts where id = grace_shift);
    assert exists (select 1 from public.shifts where id = avery_shift);
    assert exists (select 1 from public.shifts where id = grace_other_shift);

    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of add day off should restore the day off and the shift';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- admin_update_shift: payroll hours follow the shift; undo; chained undo; stale undo
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    avery uuid := pg_temp.emp('Avery');
    actual public.shift_actuals%rowtype;
    shift public.shifts%rowtype;
    before_state text;
    first_move jsonb;
    second_move jsonb;
    change jsonb;
    other public.shifts%rowtype;
begin
    perform pg_temp.expect_error(format('select public.admin_update_shift(%L, %L, %L, %L, %L)',
        gen_random_uuid(), avery, today + 3, '09:00', '17:00'), 'not_found', 'P0002');

    select a.* into actual from public.shift_actuals a
    where a.employee_id = avery and a.status = 'confirmed' and a.shift_id is not null
    order by a.work_date desc limit 1;
    assert actual.id is not null, 'seed needs a confirmed actual for Avery';
    select * into shift from public.shifts where id = actual.shift_id;

    before_state := pg_temp.schedule_state();
    first_move := public.admin_update_shift(shift.id, shift.employee_id, shift.shift_date + 1, shift.start_time, shift.end_time);
    perform pg_temp.assert_change_shape(first_move);
    assert (select work_date from public.shift_actuals where id = actual.id) = shift.shift_date + 1,
        'the actual should move with its shift';
    assert first_move #>> '{updated,shifts,0,before,shift_date}' = to_char(shift.shift_date, 'YYYY-MM-DD');
    assert first_move #>> '{updated,shifts,0,after,shift_date}' = to_char(shift.shift_date + 1, 'YYYY-MM-DD');
    second_move := public.admin_update_shift(shift.id, shift.employee_id, shift.shift_date + 2, '07:00', '09:00');
    assert (select work_date from public.shift_actuals where id = actual.id) = shift.shift_date + 2;

    -- Undo both, newest first.
    perform public.admin_undo(second_move);
    assert (select shift_date from public.shifts where id = shift.id) = shift.shift_date + 1;
    perform public.admin_undo(first_move);
    assert (select work_date from public.shift_actuals where id = actual.id) = shift.shift_date;
    assert (select updated_at from public.shifts where id = shift.id) = shift.updated_at,
        'undo should put back the previous updated_at';
    assert pg_temp.schedule_state() = before_state, 'undo of shift moves should restore the schedule';

    -- Edited again since: stale, nothing changes.
    change := public.admin_update_shift(shift.id, shift.employee_id, shift.shift_date, '07:00', '09:00');
    perform public.admin_update_shift(shift.id, shift.employee_id, shift.shift_date, '07:30', '09:00');
    perform pg_temp.edited_later('shifts', shift.id);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert (select start_time from public.shifts where id = shift.id) = '07:30';

    -- Moving onto an identical shift is refused.
    select * into other from public.shifts where employee_id <> avery and shift_date > today order by id limit 1;
    perform public.admin_add_shifts(jsonb_build_array(jsonb_build_object(
        'employee_id', avery, 'shift_date', other.shift_date, 'start_time', '05:00', 'end_time', '06:00')));
    perform pg_temp.expect_error(format('select public.admin_update_shift(%L, %L, %L, %L, %L)',
        shift.id, avery, other.shift_date, '05:00', '06:00'), '%shifts_unique_slot%', '23505');
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- admin_update_day_off and admin_convert_to_shift on requests
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    avery uuid := pg_temp.emp('Avery');
    jordan uuid := pg_temp.emp('Jordan');
    mia uuid := pg_temp.emp('Mia');
    nora uuid := pg_temp.emp('Nora');
    avery_request public.time_off%rowtype;
    mia_day_off public.time_off%rowtype;
    nora_pending uuid;
    avery_shift uuid;
    before_state text;
    change jsonb;
begin
    select * into avery_request from public.time_off
    where employee_id = avery and off_date = today + 5 and source = 'request' and status = 'approved';
    select * into mia_day_off from public.time_off
    where employee_id = mia and off_date = today + 8 and source = 'assigned';
    select id into nora_pending from public.time_off
    where employee_id = nora and off_date = today + 12 and status = 'pending';

    -- A request can't be given to someone else or turned into a shift.
    perform pg_temp.expect_error(format('select public.admin_update_day_off(%L, %L, %L, %L)',
        avery_request.id, jordan, avery_request.off_date, avery_request.period), 'request_locked', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_convert_to_shift(%L, %L, %L, %L, %L)',
        avery_request.id, avery, avery_request.off_date, '11:15', '15:45'), 'request_locked', 'P0001');
    -- Pending requests aren't edited here.
    perform pg_temp.expect_error(format('select public.admin_update_day_off(%L, %L, %L, %L)',
        nora_pending, nora, today + 13, 'morning'), 'not_editable', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_convert_to_shift(%L, %L, %L, %L, %L)',
        nora_pending, nora, today + 12, '11:15', '15:45'), 'not_editable', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_update_day_off(%L, %L, %L, %L)',
        gen_random_uuid(), nora, today + 13, 'morning'), 'not_found', 'P0002');
    -- Moving Mia's day off onto Nora's pending request is blocked; onto Avery's approved request too.
    perform pg_temp.expect_error(format('select public.admin_update_day_off(%L, %L, %L, %L)',
        mia_day_off.id, nora, today + 12, 'full-day'), 'pending_request', 'P0001');
    perform pg_temp.expect_error(format('select public.admin_update_day_off(%L, %L, %L, %L)',
        mia_day_off.id, avery, today + 5, 'evening'), 'day_off_overlap', '23P01');

    -- The request's date can change; its shift that day is deleted. Undo restores both.
    select id into avery_shift from public.shifts where employee_id = avery and shift_date = today + 6 limit 1;
    before_state := pg_temp.schedule_state();
    change := public.admin_update_day_off(avery_request.id, avery, today + 6, 'full-day',
        array_remove(array[avery_shift], null));
    perform pg_temp.assert_change_shape(change);
    assert (select off_date = today + 6 and source = 'request' and requested_at = avery_request.requested_at
                and reviewed_at is not distinct from avery_request.reviewed_at
            from public.time_off where id = avery_request.id);
    assert avery_shift is null or not exists (select 1 from public.shifts where id = avery_shift);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of a day off move should restore it';

    -- An assigned day off can go to another employee.
    change := public.admin_update_day_off(mia_day_off.id, jordan, today + 8, 'morning');
    assert (select employee_id = jordan and period = 'morning' from public.time_off where id = mia_day_off.id);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state;
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- Converting between a shift and a day off
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    jordan uuid := pg_temp.emp('Jordan');
    mia uuid := pg_temp.emp('Mia');
    shift public.shifts%rowtype;
    mia_day_off public.time_off%rowtype;
    before_state text;
    change jsonb;
begin
    perform pg_temp.expect_error(format('select public.admin_convert_to_day_off(%L, %L, %L, %L)',
        gen_random_uuid(), jordan, today + 3, 'full-day'), 'not_found', 'P0002');

    select s.* into shift from public.shifts s
    where s.employee_id = jordan and s.shift_date between today + 1 and today + 7
      and not exists (select 1 from public.time_off t where t.employee_id = jordan and t.off_date = s.shift_date)
    order by s.shift_date limit 1;
    before_state := pg_temp.schedule_state();
    change := public.admin_convert_to_day_off(shift.id, jordan, shift.shift_date, 'morning');
    perform pg_temp.assert_change_shape(change);
    assert change #>> '{inserted,time_off,0,period}' = 'morning' and change #>> '{inserted,time_off,0,source}' = 'assigned';
    assert change #>> '{deleted,shifts,0,id}' = shift.id::text;
    assert not exists (select 1 from public.shifts where id = shift.id);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of shift to day off should restore the shift';

    select * into mia_day_off from public.time_off
    where employee_id = mia and off_date = today + 8 and source = 'assigned';
    change := public.admin_convert_to_shift(mia_day_off.id, mia, today + 8, '11:15', '15:45');
    perform pg_temp.assert_change_shape(change);
    assert change #>> '{deleted,time_off,0,id}' = mia_day_off.id::text;
    assert change #>> '{inserted,shifts,0,start_time}' = '11:15:00';
    assert not exists (select 1 from public.time_off where id = mia_day_off.id);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of day off to shift should restore the day off';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- admin_delete_items: payroll hours are kept and reattached on undo
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    grace uuid := pg_temp.emp('Grace');
    actual public.shift_actuals%rowtype;
    grace_day_off uuid;
    before_state text;
    change jsonb;
    readded jsonb;
begin
    select * into actual from public.shift_actuals where status = 'adjusted' and shift_id is not null limit 1;
    assert actual.id is not null, 'seed needs an adjusted actual';
    select id into grace_day_off from public.time_off where employee_id = grace and source = 'assigned' limit 1;

    before_state := pg_temp.schedule_state();
    change := public.admin_delete_items(array[actual.shift_id, gen_random_uuid()], array[grace_day_off]);
    perform pg_temp.assert_change_shape(change);
    assert change #> '{deleted,actual_links}' = jsonb_build_array(
        jsonb_build_object('actual_id', actual.id, 'shift_id', actual.shift_id)), 'actual_links: ' || (change #> '{deleted,actual_links}')::text;
    assert jsonb_array_length(change #> '{deleted,shifts}') = 1 and jsonb_array_length(change #> '{deleted,time_off}') = 1;
    assert (select shift_id is null from public.shift_actuals where id = actual.id), 'the actual is kept, detached';
    -- Ids that are already gone are skipped.
    assert public.admin_delete_items(array[gen_random_uuid()], array[gen_random_uuid()]) = public.empty_change();

    perform public.admin_undo(change);
    assert (select shift_id from public.shift_actuals where id = actual.id) = actual.shift_id, 'the actual should be reattached';
    assert pg_temp.schedule_state() = before_state, 'undo of delete should restore the same rows';

    -- The same slot was filled again since: stale.
    change := public.admin_delete_items(array[actual.shift_id]);
    readded := public.admin_add_shifts(jsonb_build_array(jsonb_build_object(
        'employee_id', change #>> '{deleted,shifts,0,employee_id}', 'shift_date', change #>> '{deleted,shifts,0,shift_date}',
        'start_time', change #>> '{deleted,shifts,0,start_time}', 'end_time', change #>> '{deleted,shifts,0,end_time}')));
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert (select shift_id is null from public.shift_actuals where id = actual.id);
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- admin_undo won't put back a row that clashes with one saved since the change
-- ---------------------------------------------------------------------------

-- A deleted shift can't come back under time off approved since. Pending requests and time
-- off for the other part of the day don't block it.
savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    leo uuid := pg_temp.emp('Leo');
    shift public.shifts%rowtype;
    morning uuid;
    evening uuid;
    change jsonb;
begin
    select s.* into shift from public.shifts s
    where s.employee_id = leo and s.shift_date between today + 1 and today + 7 and s.start_time < '17:00'
      and not exists (select 1 from public.time_off t where t.employee_id = leo and t.off_date = s.shift_date)
    order by s.shift_date limit 1;
    assert shift.id is not null, 'seed needs a daytime shift for Leo this week';

    -- Since the delete, Leo asked for that morning off and was given the evening off.
    change := public.admin_delete_items(array[shift.id]);
    insert into public.time_off (employee_id, off_date, period, status, source)
    values (leo, shift.shift_date, 'morning', 'pending', 'request')
    returning id into morning;
    perform pg_temp.edited_later('time_off', morning);
    evening := (public.admin_add_days_off(jsonb_build_array(
        jsonb_build_object('employee_id', leo, 'off_date', shift.shift_date, 'period', 'evening')))
        #>> '{inserted,time_off,0,id}')::uuid;
    perform pg_temp.edited_later('time_off', evening);
    perform public.admin_undo(change);
    assert exists (select 1 from public.shifts where id = shift.id), 'the shift should be back';

    -- Deleted again, then the morning request is approved: the shift would start in it.
    change := public.admin_delete_items(array[shift.id]);
    perform public.approve_time_off(array[morning]);
    perform pg_temp.edited_later('time_off', morning);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert not exists (select 1 from public.shifts where id = shift.id);
end;
$$;
rollback to savepoint t;

-- A deleted day off can't come back over a shift, a day off or a request saved since.
savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    mia uuid := pg_temp.emp('Mia');
    day_off public.time_off%rowtype;
    request uuid;
    before_state text;
    change jsonb;
    added jsonb;
begin
    select * into day_off from public.time_off where employee_id = mia and off_date = today + 8 and source = 'assigned';
    assert day_off.period = 'full-day', 'seed needs Mia''s full day off at +8';
    before_state := pg_temp.schedule_state();
    change := public.admin_delete_items(p_time_off_ids => array[day_off.id]);

    added := public.admin_add_shifts(jsonb_build_array(jsonb_build_object(
        'employee_id', mia, 'shift_date', day_off.off_date, 'start_time', '18:00', 'end_time', '21:00')));
    perform pg_temp.edited_later('shifts', (added #>> '{inserted,shifts,0,id}')::uuid);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    delete from public.shifts where id = (added #>> '{inserted,shifts,0,id}')::uuid;

    added := public.admin_add_days_off(jsonb_build_array(
        jsonb_build_object('employee_id', mia, 'off_date', day_off.off_date, 'period', 'morning')));
    perform pg_temp.edited_later('time_off', (added #>> '{inserted,time_off,0,id}')::uuid);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    delete from public.time_off where id = (added #>> '{inserted,time_off,0,id}')::uuid;

    insert into public.time_off (employee_id, off_date, period, status, source)
    values (mia, day_off.off_date, 'evening', 'pending', 'request')
    returning id into request;
    perform pg_temp.edited_later('time_off', request);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert not exists (select 1 from public.time_off where id = day_off.id);
    delete from public.time_off where id = request;

    -- With those gone again, it can be undone.
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of the day off delete should restore it';
end;
$$;
rollback to savepoint t;

-- A shift can't come back over the same employee's shift saved since. Touching is fine, and
-- an overnight shift runs into the next morning.
savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    leo uuid := pg_temp.emp('Leo');
    shift public.shifts%rowtype;
    overnight public.shifts%rowtype;
    change jsonb;
    added jsonb;
begin
    select s.* into shift from public.shifts s
    where s.employee_id = leo and s.shift_date between today + 1 and today + 6 and s.start_time < '17:00'
    order by s.shift_date limit 1;
    select s.* into overnight from public.shifts s
    where s.employee_id = leo and s.shift_date = today + 7 and s.end_time < s.start_time;
    assert shift.id is not null and overnight.id is not null, 'seed needs a daytime and an overnight shift for Leo';

    -- Changed to 5-6am, then a shift ending when it used to start was saved: undo is fine.
    -- (Every statement here shares one now(), so edited_later marks the later save.)
    change := public.admin_update_shift(shift.id, leo, shift.shift_date, '05:00', '06:00');
    added := public.admin_add_shifts(jsonb_build_array(jsonb_build_object('employee_id', leo,
        'shift_date', shift.shift_date, 'start_time', shift.start_time - interval '2 hours', 'end_time', shift.start_time)));
    perform pg_temp.edited_later('shifts', (added #>> '{inserted,shifts,0,id}')::uuid);
    perform public.admin_undo(change);
    assert (select start_time = shift.start_time from public.shifts where id = shift.id);

    -- Changed again, then a shift overlapping its last hour was saved: stale.
    change := public.admin_update_shift(shift.id, leo, shift.shift_date, '05:00', '06:00');
    added := public.admin_add_shifts(jsonb_build_array(jsonb_build_object('employee_id', leo,
        'shift_date', shift.shift_date, 'start_time', shift.end_time - interval '1 hour', 'end_time', shift.end_time + interval '1 hour')));
    perform pg_temp.edited_later('shifts', (added #>> '{inserted,shifts,0,id}')::uuid);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert (select start_time = '05:00' from public.shifts where id = shift.id);

    -- The 10pm-2am shift deleted, then a 1am shift the next day saved: stale. From 2am it just touches.
    change := public.admin_delete_items(array[overnight.id]);
    added := public.admin_add_shifts(jsonb_build_array(jsonb_build_object('employee_id', leo,
        'shift_date', overnight.shift_date + 1, 'start_time', '01:00', 'end_time', '05:00')));
    perform pg_temp.edited_later('shifts', (added #>> '{inserted,shifts,0,id}')::uuid);
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    update public.shifts set start_time = '02:00' where id = (added #>> '{inserted,shifts,0,id}')::uuid;
    perform pg_temp.edited_later('shifts', (added #>> '{inserted,shifts,0,id}')::uuid);
    perform public.admin_undo(change);
    assert exists (select 1 from public.shifts where id = overnight.id);
end;
$$;
rollback to savepoint t;

-- Clashes that were already there when the change was made don't count, so older data (here a
-- shift under Avery's approved full day off at +5) can still be put back as it was.
savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    avery uuid := pg_temp.emp('Avery');
    request uuid;
    shift_id uuid;
    before_state text;
    change jsonb;
begin
    select id into request from public.time_off
    where employee_id = avery and off_date = today + 5 and period = 'full-day' and status = 'approved';
    assert request is not null, 'seed needs Avery''s approved full day off at +5';
    shift_id := (public.admin_add_shifts(jsonb_build_array(jsonb_build_object(
        'employee_id', avery, 'shift_date', today + 5, 'start_time', '06:00', 'end_time', '07:00')))
        #>> '{inserted,shifts,0,id}')::uuid;
    before_state := pg_temp.schedule_state();

    change := public.admin_delete_items(array[shift_id]);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of the delete should restore the shift';

    change := public.admin_update_day_off(request, avery, today + 6, 'full-day');
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of the move should restore the day off';
end;
$$;
rollback to savepoint t;

-- That holds whichever side of an older clash was saved last, as after the Wix import (time off
-- first, then shifts): deleting either side of Avery's +5 day off and her shift that day can be
-- undone. The seed rotates shift times and working days by date, so her shift that day may start
-- at any seeded time or be missing (the test then adds a 12-6 one).
savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    avery uuid := pg_temp.emp('Avery');
    day_off uuid;
    shift_id uuid;
    before_state text;
    change jsonb;
begin
    select id into day_off from public.time_off
    where employee_id = avery and off_date = today + 5 and period = 'full-day' and status = 'approved';
    select id into shift_id from public.shifts
    where employee_id = avery and shift_date = today + 5
    order by start_time limit 1;
    if shift_id is null then
        insert into public.shifts (employee_id, shift_date, start_time, end_time)
        values (avery, today + 5, '12:00', '18:00')
        returning id into shift_id;
    end if;
    assert day_off is not null, 'seed needs Avery''s +5 day off';

    perform set_config('schedule.keep_updated_at', 'on', true);
    update public.time_off set updated_at = now() - interval '10 minutes' where id = day_off;
    update public.shifts set updated_at = now() - interval '9 minutes' where id = shift_id;
    perform set_config('schedule.keep_updated_at', 'off', true);
    before_state := pg_temp.schedule_state();

    change := public.admin_delete_items(p_time_off_ids => array[day_off]);
    assert change ->> 'made_at' is not null, 'a change says when it was made';
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of the older day off delete should restore it';

    perform set_config('schedule.keep_updated_at', 'on', true);
    update public.shifts set updated_at = now() - interval '11 minutes' where id = shift_id;
    perform set_config('schedule.keep_updated_at', 'off', true);
    before_state := pg_temp.schedule_state();

    change := public.admin_delete_items(array[shift_id]);
    perform public.admin_undo(change);
    assert pg_temp.schedule_state() = before_state, 'undo of the older shift delete should restore it';
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- admin_close_days, reopening, and their undo
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    avery uuid := pg_temp.emp('Avery');
    actual public.shift_actuals%rowtype;
    dates date[];
    newly_closed text[];
    availability_count integer;
    before_state text;
    change jsonb;
    added jsonb;
    reopened date := today + 30;
begin
    select * into actual from public.shift_actuals where status = 'not-worked' and shift_id is not null limit 1;
    assert actual.id is not null, 'seed needs a not-worked actual';
    -- +5 approved requests, +6 availability, +14 assigned day off, +20 pending requests, a past
    -- day with payroll hours, and +9 (already closed).
    dates := array[today + 5, today + 6, today + 14, today + 20, actual.work_date, today + 9];
    select count(*) into availability_count from public.availability where available_date = any(dates);
    assert availability_count > 0;
    assert exists (select 1 from public.time_off where off_date = any(dates) and status = 'pending');
    assert exists (select 1 from public.time_off where off_date = any(dates) and status = 'approved' and source = 'request');
    assert exists (select 1 from public.time_off where off_date = any(dates) and source = 'assigned');

    before_state := pg_temp.schedule_state();
    change := public.admin_close_days(dates);
    perform pg_temp.assert_change_shape(change);
    select array_agg(d #>> '{}' order by d #>> '{}') into newly_closed from jsonb_array_elements(change #> '{inserted,closed_days}') d;
    assert newly_closed = array(select to_char(d, 'YYYY-MM-DD') from unnest(dates) d where d <> today + 9 order by d),
        'only newly closed days are listed: ' || array_to_string(newly_closed, ', ');
    assert not exists (select 1 from public.shifts where shift_date = any(dates));
    assert not exists (select 1 from public.time_off where off_date = any(dates)), 'time off of every status is deleted';
    assert (select count(*) from public.availability where available_date = any(dates)) = availability_count,
        'availability is kept';
    assert (select shift_id is null from public.shift_actuals where id = actual.id), 'payroll actuals are kept';
    assert change #> '{deleted,actual_links}' @> jsonb_build_array(jsonb_build_object('actual_id', actual.id, 'shift_id', actual.shift_id));

    perform public.admin_undo(change);
    assert (select shift_id from public.shift_actuals where id = actual.id) = actual.shift_id;
    assert pg_temp.schedule_state() = before_state, 'undo of close should restore shifts, time off and payroll links';

    -- Reopen the way the page does (a plain delete), then undo it: the day is closed again.
    delete from public.closed_days where closed_date = reopened;
    change := jsonb_set(public.empty_change(), '{deleted,closed_days}', jsonb_build_array(reopened));
    perform public.admin_undo(change);
    assert exists (select 1 from public.closed_days where closed_date = reopened);
    assert pg_temp.schedule_state() = before_state;

    -- Reopen, add a shift that day, then undo the reopen: stale, and nothing changes.
    delete from public.closed_days where closed_date = reopened;
    added := public.admin_add_shifts(jsonb_build_array(jsonb_build_object(
        'employee_id', avery, 'shift_date', reopened, 'start_time', '09:00', 'end_time', '17:00')));
    perform pg_temp.expect_error(format('select public.admin_undo(%L)', change), 'undo_stale', 'P0001');
    assert not exists (select 1 from public.closed_days where closed_date = reopened);
    assert exists (select 1 from public.shifts where id = (added #>> '{inserted,shifts,0,id}')::uuid);

    perform pg_temp.expect_error('select public.admin_undo(''{"inserted": {}}'')', 'invalid_input', '22023');
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- approve_time_off and approve_availability
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    eli uuid := pg_temp.emp('Eli');
    avery uuid := pg_temp.emp('Avery');
    leo uuid := pg_temp.emp('Leo');
    sam uuid := pg_temp.emp('Sam');
    jordan uuid := pg_temp.emp('Jordan');
    r22 uuid;
    r23 uuid;
    r24 uuid;
    avery_request uuid;
    eli_shifts uuid[];
    other_shift uuid;
    change jsonb;
    leo_availability uuid;
    sam_availability uuid;
    jordan_availability uuid;
begin
    select id into r22 from public.time_off where employee_id = eli and off_date = today + 22 and status = 'pending';
    select id into r23 from public.time_off where employee_id = eli and off_date = today + 23 and status = 'pending';
    select id into r24 from public.time_off where employee_id = eli and off_date = today + 24 and status = 'pending';
    assert r22 is not null and r23 is not null and r24 is not null, 'seed needs Eli''s three pending days';
    select id into avery_request from public.time_off
    where employee_id = avery and off_date = today + 5 and status = 'approved';

    -- One reviewed or missing id stops the whole batch.
    perform pg_temp.expect_error(format('select public.approve_time_off(%L)', array[r24, avery_request]),
        'request_not_pending', 'P0002');
    perform pg_temp.expect_error(format('select public.approve_time_off(%L)', array[r24, gen_random_uuid()]),
        'request_not_pending', 'P0002');
    assert (select status from public.time_off where id = r24) = 'pending';
    perform pg_temp.expect_error('select public.approve_time_off(array[]::uuid[])', 'invalid_input', '22023');

    -- Two days approved together; only Eli's listed shifts on those days are deleted.
    eli_shifts := array(select id from public.shifts where employee_id = eli and shift_date in (today + 22, today + 23));
    select id into other_shift from public.shifts where employee_id <> eli and shift_date = today + 22 limit 1;
    change := public.approve_time_off(array[r22, r23], eli_shifts || other_shift);
    perform pg_temp.assert_change_shape(change);
    assert (select count(*) from public.time_off
            where id in (r22, r23) and status = 'approved' and reviewed_at = now()) = 2, 'both approved with reviewed_at';
    assert jsonb_array_length(change #> '{updated,time_off}') = 2;
    assert change #>> '{updated,time_off,0,before,status}' = 'pending' and change #>> '{updated,time_off,0,after,status}' = 'approved';
    assert jsonb_array_length(change #> '{deleted,shifts}') = cardinality(eli_shifts);
    assert not exists (select 1 from public.shifts where id = any(eli_shifts));
    assert exists (select 1 from public.shifts where id = other_shift);
    assert (select status from public.time_off where id = r24) = 'pending';

    -- Availability: a closed day is refused; the rest need to be pending.
    select id into leo_availability from public.availability where employee_id = leo and available_date = today + 9;
    select id into sam_availability from public.availability where employee_id = sam and available_date = today + 40;
    select id into jordan_availability from public.availability where employee_id = jordan and status = 'approved' limit 1;
    assert leo_availability is not null and sam_availability is not null, 'seed needs Leo''s and Sam''s pending availability';
    perform pg_temp.expect_error(format('select public.approve_availability(%L)', array[leo_availability]), 'closed_day', 'P0001');
    perform pg_temp.expect_error(format('select public.approve_availability(%L)', array[sam_availability, jordan_availability]),
        'request_not_pending', 'P0002');
    assert public.approve_availability(array[sam_availability]) = jsonb_build_object('approved_ids', jsonb_build_array(sam_availability));
    assert (select status = 'approved' and reviewed_at = now() from public.availability where id = sam_availability);
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- save_employee and set_employee_order
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    avery uuid := pg_temp.emp('Avery');
    jordan uuid := pg_temp.emp('Jordan');
    max_order integer;
    new_id uuid;
    jordan_old uuid;
    jordan_new uuid;
    avery_rate public.employee_rates%rowtype;
    ids uuid[];
begin
    select max(display_order) into max_order from public.employees;
    new_id := public.save_employee(jsonb_build_object('id', null, 'name', '  Zz Test Potter  ', 'color', '#2B6CB0',
        'rates', jsonb_build_array(jsonb_build_object('id', null, 'rate', 12.345, 'start_date', null, 'end_date', null))));
    assert (select display_order from public.employees where id = new_id) = max_order + 1, 'new employee goes last';
    assert (select name from public.employees where id = new_id) = 'Zz Test Potter', 'name is trimmed';
    assert (select array_agg(rate) from public.employee_rates where employee_id = new_id) = array[12.35::numeric],
        'rate is rounded to cents';

    -- Duplicate names, ignoring case and outer spaces, are refused (new or renamed).
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', null, 'name', '  AVERY lane ', 'color', '#2B6CB0', 'rates', '[]'::jsonb)), 'duplicate_name', '23505');
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', new_id, 'name', 'avery lane', 'color', '#2B6CB0', 'rates', '[]'::jsonb)), 'duplicate_name', '23505');
    -- Keeping your own name is fine.
    assert public.save_employee(jsonb_build_object('id', new_id, 'name', 'ZZ TEST POTTER', 'color', '#2B6CB0',
        'rates', '[]'::jsonb)) = new_id;
    assert not exists (select 1 from public.employee_rates where employee_id = new_id), 'unlisted rates are deleted';

    -- Constraint errors.
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', new_id, 'name', 'Zz Test Potter', 'color', '#2B6CB0',
        'rates', jsonb_build_array(jsonb_build_object('id', null, 'rate', 0, 'start_date', null, 'end_date', null)))),
        '%employee_rates_rate_positive%', '23514');
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', new_id, 'name', 'Zz Test Potter', 'color', 'blue', 'rates', '[]'::jsonb)),
        '%employees_color_hex%', '23514');
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', new_id, 'name', '   ', 'color', '#2B6CB0', 'rates', '[]'::jsonb)),
        '%employees_name_check%', '23514');
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', new_id, 'name', 'Zz Test Potter', 'color', '#2B6CB0',
        'rates', jsonb_build_array(jsonb_build_object('id', null, 'rate', 15, 'start_date', '2026-10-10', 'end_date', '2026-10-01')))),
        '%employee_rates_check%', '23514');
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', gen_random_uuid(), 'name', 'Nobody Here', 'color', '#2B6CB0', 'rates', '[]'::jsonb)),
        'not_found', 'P0002');
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', new_id, 'name', 'Zz Test Potter', 'color', '#2B6CB0')), 'invalid_input', '22023');
    -- Overlapping periods (both ends inclusive). save_employee checks this before returning,
    -- so it doesn't wait for the commit.
    perform pg_temp.expect_error(format('select public.save_employee(%L)', jsonb_build_object(
        'id', new_id, 'name', 'Zz Test Potter', 'color', '#2B6CB0',
        'rates', jsonb_build_array(
            jsonb_build_object('id', null, 'rate', 15, 'start_date', null, 'end_date', '2026-10-10'),
            jsonb_build_object('id', null, 'rate', 16, 'start_date', '2026-10-10', 'end_date', null)))),
        '%employee_rates_no_overlap%', '23P01');
    -- Back-to-back periods are fine.
    perform public.save_employee(jsonb_build_object('id', new_id, 'name', 'Zz Test Potter', 'color', '#2B6CB0',
        'rates', jsonb_build_array(
            jsonb_build_object('id', null, 'rate', 15, 'start_date', null, 'end_date', '2026-10-09'),
            jsonb_build_object('id', null, 'rate', 16, 'start_date', '2026-10-10', 'end_date', null))));
    assert (select count(*) from public.employee_rates where employee_id = new_id) = 2;

    -- Updating: listed ids are updated, other employees' ids are ignored.
    select id into jordan_old from public.employee_rates where employee_id = jordan and start_date is null;
    select id into jordan_new from public.employee_rates where employee_id = jordan and end_date is null;
    select * into avery_rate from public.employee_rates where employee_id = avery limit 1;
    assert jordan_old is not null and jordan_new is not null, 'seed needs Jordan''s two rates';
    perform public.save_employee(jsonb_build_object('id', jordan, 'name', 'Jordan Price', 'color', '#147C44',
        'rates', jsonb_build_array(
            jsonb_build_object('id', jordan_old, 'rate', 15.50, 'start_date', null, 'end_date', today - 30),
            jsonb_build_object('id', jordan_new, 'rate', 17, 'start_date', today - 29, 'end_date', null),
            jsonb_build_object('id', avery_rate.id, 'rate', 99, 'start_date', null, 'end_date', null))));
    assert (select rate from public.employee_rates where id = jordan_new) = 17;
    assert (select count(*) from public.employee_rates where employee_id = jordan) = 2;
    assert (select rate = avery_rate.rate and employee_id = avery from public.employee_rates where id = avery_rate.id),
        'another employee''s rate is left alone';

    -- set_employee_order: 0-based positions in the given order.
    ids := array(select id from public.employees order by display_order desc, id);
    perform public.set_employee_order(ids);
    assert (select bool_and(e.display_order = o.ord - 1)
            from unnest(ids) with ordinality as o(id, ord) join public.employees e on e.id = o.id);
    assert (select display_order from public.employees where id = ids[1]) = 0;
    perform pg_temp.expect_error(format('select public.set_employee_order(%L)', array[avery, avery]), 'invalid_input', '22023');
end;
$$;
rollback to savepoint t;

-- ---------------------------------------------------------------------------
-- save_shift_actuals
-- ---------------------------------------------------------------------------

savepoint t;
do $$
declare
    today date := pg_temp.seed_today();
    grace uuid := pg_temp.emp('Grace');
    jordan uuid := pg_temp.emp('Jordan');
    taylor uuid := pg_temp.emp('Taylor');
    shift public.shifts%rowtype;
    actual public.shift_actuals%rowtype;
    unscheduled uuid;
    orphan uuid;
    untouched public.shift_actuals%rowtype;
    new_id uuid := gen_random_uuid();
    result jsonb;
begin
    select s.* into shift from public.shifts s
    where s.employee_id = grace and s.shift_date between today - 12 and today - 3
      and not exists (select 1 from public.shift_actuals a where a.shift_id = s.id)
    order by s.shift_date limit 1;
    select id into unscheduled from public.shift_actuals where status = 'unscheduled' limit 1;
    select id into orphan from public.shift_actuals where shift_id is null and status = 'confirmed' limit 1;
    select * into untouched from public.shift_actuals where status = 'adjusted' limit 1;
    assert shift.id is not null and unscheduled is not null and orphan is not null and untouched.id is not null,
        'seed needs a past Grace shift, an unscheduled actual, an orphaned actual and an adjusted actual';

    result := public.save_shift_actuals(jsonb_build_object(
        'delete_ids', jsonb_build_array(unscheduled),
        'scheduled', jsonb_build_array(jsonb_build_object(
            'shift_id', shift.id, 'employee_id', jordan, 'status', 'not-worked',
            'start_time', '09:00', 'end_time', '10:00', 'note', 'Sick')),
        'actual_only', jsonb_build_array(
            jsonb_build_object('id', new_id, 'employee_id', grace, 'work_date', today - 3,
                'start_time', '18:00', 'end_time', '20:00', 'note', 'Glaze night'),
            jsonb_build_object('id', null, 'employee_id', grace, 'work_date', today - 4,
                'start_time', '18:00', 'end_time', '19:00', 'note', ''),
            jsonb_build_object('id', orphan, 'employee_id', taylor, 'work_date', today - 8,
                'start_time', '12:00', 'end_time', '18:30', 'note', 'Edited'))));
    assert result = '{"deleted": 1, "saved": 4}'::jsonb, 'save_shift_actuals result: ' || result::text;
    assert not exists (select 1 from public.shift_actuals where id = unscheduled);

    -- Not worked: stored under the scheduled employee, with no times; work_date is the shift's.
    select * into actual from public.shift_actuals where shift_id = shift.id;
    assert actual.employee_id = shift.employee_id and actual.status = 'not-worked'
        and actual.start_time is null and actual.end_time is null and actual.work_date = shift.shift_date
        and actual.note = 'Sick' and actual.actualized_at = now();

    -- Worked by someone else: same row (upsert on shift_id), their name and times.
    result := public.save_shift_actuals(jsonb_build_object('scheduled', jsonb_build_array(jsonb_build_object(
        'shift_id', shift.id, 'employee_id', jordan, 'status', 'adjusted',
        'start_time', '09:00', 'end_time', '12:15', 'note', ''))));
    assert result = '{"deleted": 0, "saved": 1}'::jsonb;
    assert (select id = actual.id and employee_id = jordan and status = 'adjusted' and end_time = '12:15'
                and work_date = shift.shift_date
            from public.shift_actuals where shift_id = shift.id);

    -- Unscheduled work has no shift, including the orphan once it's saved.
    assert (select shift_id is null and status = 'unscheduled' and employee_id = grace
            from public.shift_actuals where id = new_id);
    assert (select count(*) from public.shift_actuals
            where employee_id = grace and work_date = today - 4 and status = 'unscheduled' and shift_id is null) = 1;
    assert (select shift_id is null and status = 'unscheduled' and end_time = '18:30'
            from public.shift_actuals where id = orphan);
    -- Rows that weren't sent are untouched.
    assert (select actualized_at = untouched.actualized_at and actualized_at < now()
            from public.shift_actuals where id = untouched.id);

    -- A shift that no longer exists.
    perform pg_temp.expect_error(format('select public.save_shift_actuals(%L)', jsonb_build_object(
        'scheduled', jsonb_build_array(jsonb_build_object(
            'shift_id', gen_random_uuid(), 'employee_id', grace, 'status', 'confirmed',
            'start_time', '09:00', 'end_time', '10:00', 'note', '')))), 'not_found', 'P0002');
end;
$$;
rollback to savepoint t;

rollback;

\echo ALL ADMIN RPC TESTS PASSED
