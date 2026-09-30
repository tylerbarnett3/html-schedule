-- Tests for logged hours in 20260930000002_hour_logs.sql: the hour_logs table, its access
-- rules, my_loggable_shifts, log_shift_hours and remove_hour_log.
-- Run against the LOCAL database after `npx supabase db reset` (they use seed.sql's logins):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/hour_logs.sql
-- Everything runs in one transaction that is rolled back, so the data is left as it was.
-- The first failing check stops the run; the last line printed on success is
-- ALL HOUR LOG TESTS PASSED.
--
-- The tests add their own employee ("Lou Tester", linked to the seeded `nobody` login) with
-- shifts around business_today(), the date in New York, so the seeded shifts don't matter.
-- They assume today is after Sep 29, 2026 (the day after logging started).

\set QUIET on
\set ON_ERROR_STOP 1

begin;

-- ---------------------------------------------------------------------------
-- Test helpers (this session only)
-- ---------------------------------------------------------------------------

-- Runs p_sql and checks it fails with a message like p_message and SQLSTATE p_state.
create function pg_temp.expect_error(p_sql text, p_message text, p_state text)
returns void
language plpgsql
as $$
declare
    got_message text;
    got_state text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics got_message = message_text, got_state = returned_sqlstate;
        if got_message not like p_message or got_state <> p_state then
            raise exception 'expected "%" (%) from: %  got "%" (%)', p_message, p_state, p_sql, got_message, got_state;
        end if;
        return;
    end;
    raise exception 'expected "%" (%) from: %  but it succeeded', p_message, p_state, p_sql;
end;
$$;

-- The test shifts, by name (set below).
create function pg_temp.shift(p_name text)
returns uuid
language sql
stable
as $$
    select current_setting('tests.shift_' || p_name)::uuid;
$$;

do $$
begin
    assert public.business_today() >= date '2026-09-30', 'these tests assume today is Sep 30, 2026 or later';
    assert exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000ff'),
        'the seeded `nobody` login is missing: run `npx supabase db reset` first';
    assert not exists (select 1 from public.employees where user_id = '00000000-0000-0000-0000-0000000000ff'),
        '`nobody` should not be linked to an employee yet';
end;
$$;

-- Lou Tester (the `nobody` login) and their shifts. "reviewed" gets a payroll review below.
insert into public.employees (id, name, color, display_order, user_id) values
    ('e0000000-0000-0000-0000-0000000000aa', 'Lou Tester', '#2B6CB0', 99, '00000000-0000-0000-0000-0000000000ff');

do $$
declare
    today date := public.business_today();
    lou uuid := 'e0000000-0000-0000-0000-0000000000aa';
    label text;
    day date;
    start_at time;
    end_at time;
    new_id uuid;
begin
    for label, day, start_at, end_at in
        values
            ('past', today - 1, time '10:00', time '16:00'),
            ('overnight_ended', today - 2, time '22:00', time '02:00'),
            ('reviewed', today - 1, time '17:00', time '19:00'),
            ('future', today + 1, time '10:00', time '16:00'),
            -- Starts today, so its date has come, but it ends tomorrow.
            ('overnight_today', today, time '23:00', time '01:00'),
            -- Ended long ago, but before logging started.
            ('before_start', date '2026-09-27', time '10:00', time '16:00'),
            -- The first day logging is allowed.
            ('first_day', date '2026-09-28', time '10:00', time '16:00')
    loop
        insert into public.shifts (employee_id, shift_date, start_time, end_time)
        values (lou, day, start_at, end_at)
        returning id into new_id;
        perform set_config('tests.shift_' || label, new_id::text, true);
    end loop;

    insert into public.shift_actuals (shift_id, employee_id, work_date, start_time, end_time, status)
    values (pg_temp.shift('reviewed'), lou, today - 1, '17:00', '19:00', 'confirmed');

    -- Avery's shift yesterday, which isn't Lou's to log.
    insert into public.shifts (employee_id, shift_date, start_time, end_time)
    values ('e0000000-0000-0000-0000-000000000001', today - 1, '06:00', '07:00')
    returning id into new_id;
    perform set_config('tests.shift_avery', new_id::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Grants and function settings
-- ---------------------------------------------------------------------------

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.my_loggable_shifts()',
        'public.log_shift_hours(uuid, time, time, text)',
        'public.remove_hour_log(uuid)'
    ] loop
        assert not has_function_privilege('anon', fn, 'execute'), fn || ' can be called by anon';
        assert not has_function_privilege('public', fn, 'execute'), fn || ' can be called by public';
        assert has_function_privilege('authenticated', fn, 'execute'), fn || ' can''t be called by authenticated';
        assert (
            select p.prosecdef and p.proconfig = array['search_path=""']
            from pg_proc p where p.oid = fn::regprocedure
        ), fn || ' must be security definer, with an empty search_path';
    end loop;
    foreach fn in array array[
        'public.hour_log_refusal(public.shifts, uuid)',
        'public.lock_loggable_shift(uuid)'
    ] loop
        assert not has_function_privilege('anon', fn, 'execute'), fn || ' can be called by anon';
        assert not has_function_privilege('authenticated', fn, 'execute'), fn || ' can be called by authenticated';
        assert (
            select not p.prosecdef and p.proconfig = array['search_path=""']
            from pg_proc p where p.oid = fn::regprocedure
        ), fn || ' must be security invoker, with an empty search_path';
    end loop;
    assert not has_table_privilege('anon', 'public.hour_logs', 'select'), 'anon can read hour_logs';
    assert not has_table_privilege('authenticated', 'public.hour_logs', 'truncate'), 'authenticated can truncate hour_logs';
end;
$$;

set local role anon;
do $$
begin
    perform pg_temp.expect_error('select * from public.my_loggable_shifts()',
        'permission denied for function my_loggable_shifts', '42501');
    perform pg_temp.expect_error('select public.log_shift_hours(gen_random_uuid(), ''10:00'', ''11:00'', '''')',
        'permission denied for function log_shift_hours', '42501');
    perform pg_temp.expect_error('select public.remove_hour_log(gen_random_uuid())',
        'permission denied for function remove_hour_log', '42501');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Which shifts Lou can log
-- ---------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';

do $$
declare
    listed uuid[];
begin
    assert public.current_employee_id() = 'e0000000-0000-0000-0000-0000000000aa';
    perform pg_temp.expect_error('select public.hour_log_refusal(null::public.shifts, null)',
        'permission denied for function hour_log_refusal', '42501');
    perform pg_temp.expect_error('select public.lock_loggable_shift(gen_random_uuid())',
        'permission denied for function lock_loggable_shift', '42501');

    listed := array(select shift_id from public.my_loggable_shifts());
    assert listed = array[pg_temp.shift('past'), pg_temp.shift('overnight_ended'), pg_temp.shift('first_day')],
        'Lou should see the ended, unreviewed shifts from Sep 28 on, newest first; got ' || listed::text;
    assert not exists (select 1 from public.my_loggable_shifts() where logged_start is not null),
        'nothing is logged yet';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Logging, changing and removing
-- ---------------------------------------------------------------------------

do $$
declare
    row record;
begin
    perform public.log_shift_hours(pg_temp.shift('past'), '10:05', '16:10', '  Stayed late  ');
    select * into row from public.my_loggable_shifts() where shift_id = pg_temp.shift('past');
    assert row.logged_start = '10:05' and row.logged_end = '16:10' and row.logged_note = 'Stayed late'
        and row.logged_at is not null and row.start_time = '10:00' and row.end_time = '16:00',
        'the log should show with the shift: ' || row::text;

    -- A change replaces it.
    perform public.log_shift_hours(pg_temp.shift('past'), '09:55', '16:00', null);
    select * into row from public.my_loggable_shifts() where shift_id = pg_temp.shift('past');
    assert row.logged_start = '09:55' and row.logged_end = '16:00' and row.logged_note = '',
        'the change should replace the log: ' || row::text;

    -- Past midnight, like an overnight shift.
    perform public.log_shift_hours(pg_temp.shift('overnight_ended'), '22:00', '02:30', '');
    perform public.log_shift_hours(pg_temp.shift('first_day'), '10:00', '16:00', repeat('x', 160));

    -- Employees can't read or write the table itself.
    assert not exists (select 1 from public.hour_logs), 'an employee can read hour_logs';
    perform pg_temp.expect_error(
        format('insert into public.hour_logs (shift_id, employee_id, start_time, end_time) values (%L, %L, ''10:00'', ''11:00'')',
            gen_random_uuid(), 'e0000000-0000-0000-0000-0000000000aa'),
        'new row violates row-level security policy%', '42501');
    update public.hour_logs set end_time = '23:00' where shift_id = pg_temp.shift('past');
    delete from public.hour_logs where shift_id = pg_temp.shift('past');

    -- Removing.
    assert public.remove_hour_log(pg_temp.shift('first_day')), 'the log should be removed';
    assert not public.remove_hour_log(pg_temp.shift('first_day')), 'nothing left to remove';
    assert (select logged_start is null from public.my_loggable_shifts() where shift_id = pg_temp.shift('first_day'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Refusals
-- ---------------------------------------------------------------------------

do $$
declare
    call text;
begin
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''10:00'', ''16:00'', '''')', pg_temp.shift('future')),
        'shift_not_over', 'P0001');
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''23:00'', ''01:00'', '''')', pg_temp.shift('overnight_today')),
        'shift_not_over', 'P0001');
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''17:00'', ''19:00'', '''')', pg_temp.shift('reviewed')),
        'already_reviewed', 'P0001');
    perform pg_temp.expect_error(format('select public.remove_hour_log(%L)', pg_temp.shift('reviewed')),
        'already_reviewed', 'P0001');
    foreach call in array array[
        format('select public.log_shift_hours(%L, ''10:00'', ''16:00'', '''')', pg_temp.shift('before_start')),
        format('select public.log_shift_hours(%L, ''06:00'', ''07:00'', '''')', pg_temp.shift('avery')),
        format('select public.remove_hour_log(%L)', pg_temp.shift('avery')),
        'select public.log_shift_hours(gen_random_uuid(), ''10:00'', ''16:00'', '''')',
        'select public.log_shift_hours(null, ''10:00'', ''16:00'', '''')'
    ] loop
        perform pg_temp.expect_error(call, 'not_found', 'P0002');
    end loop;
    foreach call in array array[
        format('select public.log_shift_hours(%L, ''10:00'', ''10:00'', '''')', pg_temp.shift('first_day')),
        format('select public.log_shift_hours(%L, null, ''16:00'', '''')', pg_temp.shift('first_day')),
        format('select public.log_shift_hours(%L, ''10:00'', null, '''')', pg_temp.shift('first_day')),
        format('select public.log_shift_hours(%L, ''10:00:30'', ''16:00'', '''')', pg_temp.shift('first_day')),
        format('select public.log_shift_hours(%L, ''10:00'', ''16:00'', %L)', pg_temp.shift('first_day'), repeat('x', 161))
    ] loop
        perform pg_temp.expect_error(call, 'invalid_input', '22023');
    end loop;
    assert (select logged_start is null from public.my_loggable_shifts() where shift_id = pg_temp.shift('first_day')),
        'a refused log saves nothing';
end;
$$;

-- An archived employee can't log, and has nothing listed.
reset role;
do $$
begin
    assert (select end_time = '16:00' from public.hour_logs where shift_id = pg_temp.shift('past')),
        'an employee''s direct update or delete of hour_logs should change nothing';
end;
$$;
update public.employees set archived = true where id = 'e0000000-0000-0000-0000-0000000000aa';
set local role authenticated;
do $$
begin
    assert not exists (select 1 from public.my_loggable_shifts()), 'an archived employee has nothing to log';
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''10:00'', ''16:00'', '''')', pg_temp.shift('first_day')),
        'employee_archived', '42501');
    perform pg_temp.expect_error(format('select public.remove_hour_log(%L)', pg_temp.shift('past')),
        'employee_archived', '42501');
end;
$$;
reset role;
update public.employees set archived = false where id = 'e0000000-0000-0000-0000-0000000000aa';
set local role authenticated;

-- A login that isn't an employee (the admin) has nothing to log.
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';
do $$
begin
    assert public.is_admin() and public.current_employee_id() is null;
    assert not exists (select 1 from public.my_loggable_shifts()), 'the admin has no shifts to log';
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''10:00'', ''16:00'', '''')', pg_temp.shift('first_day')),
        'not_linked', '42501');
    perform pg_temp.expect_error(format('select public.remove_hour_log(%L)', pg_temp.shift('past')),
        'not_linked', '42501');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. What the admin sees, and what a payroll review does
-- ---------------------------------------------------------------------------

do $$
declare
    result jsonb;
begin
    assert (select count(*) from public.hour_logs where employee_id = 'e0000000-0000-0000-0000-0000000000aa') = 2,
        'the admin should read both of Lou''s logs';
    assert (select start_time = '09:55' and end_time = '16:00' from public.hour_logs where shift_id = pg_temp.shift('past'));

    -- The admin reviews the logged shift, using the logged hours.
    result := public.save_shift_actuals(jsonb_build_object('scheduled', jsonb_build_array(jsonb_build_object(
        'shift_id', pg_temp.shift('past'), 'employee_id', 'e0000000-0000-0000-0000-0000000000aa',
        'status', 'adjusted', 'start_time', '09:55', 'end_time', '16:00', 'note', ''))));
    assert (result ->> 'saved')::int = 1;
    assert exists (select 1 from public.hour_logs where shift_id = pg_temp.shift('past')), 'the log stays after the review';
end;
$$;

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';
do $$
begin
    assert not exists (select 1 from public.my_loggable_shifts() where shift_id = pg_temp.shift('past')),
        'a reviewed shift leaves the list';
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''10:00'', ''16:00'', '''')', pg_temp.shift('past')),
        'already_reviewed', 'P0001');
    perform pg_temp.expect_error(format('select public.remove_hour_log(%L)', pg_temp.shift('past')),
        'already_reviewed', 'P0001');
end;
$$;

-- The admin takes the review back: the shift can be logged again, log and all.
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';
do $$
begin
    perform public.save_shift_actuals(jsonb_build_object('delete_ids', jsonb_build_array(
        (select id from public.shift_actuals where shift_id = pg_temp.shift('past')))));
end;
$$;
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';
do $$
begin
    assert (select logged_start = '09:55' from public.my_loggable_shifts() where shift_id = pg_temp.shift('past')),
        'an unreviewed shift is back in the list, with its log';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Deleting a shift and undoing brings its log back
-- ---------------------------------------------------------------------------

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';
do $$
declare
    change jsonb;
begin
    change := public.admin_delete_items(array[pg_temp.shift('overnight_ended')]);
    perform set_config('tests.delete_change', change::text, true);
end;
$$;

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';
do $$
begin
    assert not exists (select 1 from public.my_loggable_shifts() where shift_id = pg_temp.shift('overnight_ended')),
        'a deleted shift leaves the list';
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''22:00'', ''02:00'', '''')', pg_temp.shift('overnight_ended')),
        'not_found', 'P0002');
end;
$$;

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';
do $$
begin
    perform public.admin_undo(current_setting('tests.delete_change')::jsonb);
end;
$$;

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';
do $$
begin
    assert (select logged_start = '22:00' and logged_end = '02:30'
            from public.my_loggable_shifts() where shift_id = pg_temp.shift('overnight_ended')),
        'the undone delete should bring the shift back with its log';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A shift given to someone else: the new employee logs it afresh
-- ---------------------------------------------------------------------------

reset role;
update public.shifts set employee_id = 'e0000000-0000-0000-0000-000000000001' where id = pg_temp.shift('overnight_ended');
set local role authenticated;

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}';
do $$
begin
    assert not exists (select 1 from public.my_loggable_shifts() where shift_id = pg_temp.shift('overnight_ended')),
        'Lou no longer sees a shift given to Avery';
    perform pg_temp.expect_error(format('select public.log_shift_hours(%L, ''22:00'', ''02:00'', '''')', pg_temp.shift('overnight_ended')),
        'not_found', 'P0002');
    perform pg_temp.expect_error(format('select public.remove_hour_log(%L)', pg_temp.shift('overnight_ended')),
        'not_found', 'P0002');
end;
$$;

-- avery
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
    assert public.current_employee_id() = 'e0000000-0000-0000-0000-000000000001';
    assert (select logged_start is null from public.my_loggable_shifts() where shift_id = pg_temp.shift('overnight_ended')),
        'Avery doesn''t see what Lou logged';
    perform public.log_shift_hours(pg_temp.shift('overnight_ended'), '22:15', '02:00', 'Covered for Lou');
    assert (select logged_start = '22:15' from public.my_loggable_shifts() where shift_id = pg_temp.shift('overnight_ended'));
end;
$$;

reset role;
do $$
begin
    assert (select employee_id = 'e0000000-0000-0000-0000-000000000001' and note = 'Covered for Lou'
            from public.hour_logs where shift_id = pg_temp.shift('overnight_ended')),
        'Avery''s log replaces Lou''s';
end;
$$;

rollback;

\echo ALL HOUR LOG TESTS PASSED
