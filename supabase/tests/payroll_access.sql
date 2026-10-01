-- Tests for payroll staff in 20260930000003_payroll_access.sql: payroll_staff, can_edit_payroll,
-- assert_payroll, the payroll policies on shift_actuals and hour_logs, and save_shift_actuals
-- for payroll staff.
-- Run against the LOCAL database after `npx supabase db reset` (they use seed.sql's logins):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/payroll_access.sql
-- Everything runs in one transaction that is rolled back, so the data is left as it was.
-- The first failing check stops the run; the last line printed on success is
-- ALL PAYROLL ACCESS TESTS PASSED.
--
-- Logins: mia (an employee with payroll access), avery (an employee without it) and
-- admin@example.com.

\set QUIET on
\set ON_ERROR_STOP 1

begin;

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

-- Mia has payroll access whatever the seed says; the counts the employees must match.
insert into public.payroll_staff (user_id) values ('00000000-0000-0000-0000-000000000003') on conflict do nothing;
delete from public.payroll_staff where user_id <> '00000000-0000-0000-0000-000000000003';

do $$
declare
    shift_id uuid;
begin
    assert (select count(*) from public.shift_actuals) > 0, 'the seed should have payroll actuals: run `npx supabase db reset`';
    assert (select count(*) from public.employee_rates) > 0, 'the seed should have pay rates';
    perform set_config('tests.actuals', (select count(*) from public.shift_actuals)::text, true);
    perform set_config('tests.logs', (select count(*) from public.hour_logs)::text, true);
    perform set_config('tests.rates', (select sum(rate) from public.employee_rates)::text, true);
    -- A past shift of Mia's own that hasn't been reviewed: she may review her own hours.
    select s.id into shift_id
    from public.shifts s
    join public.employees e on e.id = s.employee_id
    where e.user_id = '00000000-0000-0000-0000-000000000003'
      and s.shift_date < public.business_today()
      and not exists (select 1 from public.shift_actuals a where a.shift_id = s.id)
    order by s.shift_date desc
    limit 1;
    assert shift_id is not null, 'Mia should have an unreviewed past shift in the seed';
    perform set_config('tests.mia_shift', shift_id::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Grants and function settings
-- ---------------------------------------------------------------------------

do $$
declare
    fn text;
begin
    foreach fn in array array['public.can_edit_payroll()', 'public.assert_payroll()', 'public.save_shift_actuals(jsonb)'] loop
        assert not has_function_privilege('anon', fn, 'execute'), fn || ' can be called by anon';
        assert not has_function_privilege('public', fn, 'execute'), fn || ' can be called by public';
        assert has_function_privilege('authenticated', fn, 'execute'), fn || ' can''t be called by authenticated';
        assert (select p.proconfig = array['search_path=""'] from pg_proc p where p.oid = fn::regprocedure),
            fn || ' must have an empty search_path';
    end loop;
    assert (select prosecdef from pg_proc where oid = 'public.can_edit_payroll()'::regprocedure),
        'can_edit_payroll must be security definer (it reads payroll_staff for anyone)';
    assert (select not prosecdef from pg_proc where oid = 'public.assert_payroll()'::regprocedure);
    assert (select not prosecdef from pg_proc where oid = 'public.save_shift_actuals(jsonb)'::regprocedure),
        'save_shift_actuals must stay security invoker';
    assert not has_table_privilege('anon', 'public.payroll_staff', 'select'), 'anon can read payroll_staff';
    assert not has_table_privilege('authenticated', 'public.payroll_staff', 'truncate');
end;
$$;

set local role anon;
do $$
begin
    perform pg_temp.expect_error('select public.save_shift_actuals(''{}'')', 'permission denied for function save_shift_actuals', '42501');
    perform pg_temp.expect_error('select public.can_edit_payroll()', 'permission denied for function can_edit_payroll', '42501');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Mia, payroll staff: payroll and logged hours, nothing else admin-only
-- ---------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}';

do $$
declare
    call text;
    result jsonb;
    saved_id uuid;
begin
    assert public.can_edit_payroll() and not public.is_admin(), 'Mia has payroll access and is not an admin';
    assert (select count(*) from public.shift_actuals) = current_setting('tests.actuals')::bigint,
        'Mia should read every payroll record';
    assert (select count(*) from public.hour_logs) = current_setting('tests.logs')::bigint,
        'Mia should read every logged hours row';
    assert not exists (select 1 from public.employee_rates), 'Mia must not read pay rates';
    assert (select count(*) from public.payroll_staff) = 1
        and exists (select 1 from public.payroll_staff where user_id = auth.uid()), 'Mia sees only her own payroll_staff row';

    -- She reviews her own shift (as scheduled), then takes the review back.
    result := public.save_shift_actuals(jsonb_build_object('scheduled', (
        select jsonb_build_array(jsonb_build_object(
            'shift_id', s.id, 'employee_id', s.employee_id, 'status', 'confirmed',
            'start_time', s.start_time, 'end_time', s.end_time, 'note', ''))
        from public.shifts s where s.id = current_setting('tests.mia_shift')::uuid)));
    select id into saved_id from public.shift_actuals where shift_id = current_setting('tests.mia_shift')::uuid;
    assert saved_id is not null and (result ->> 'saved')::int = 1, 'Mia should save a payroll review: ' || result::text;
    result := public.save_shift_actuals(jsonb_build_object('delete_ids', jsonb_build_array(saved_id)));
    assert (result ->> 'deleted')::int = 1, 'Mia should remove a payroll review';

    -- Unscheduled work.
    result := public.save_shift_actuals(jsonb_build_object('actual_only', jsonb_build_array(jsonb_build_object(
        'employee_id', 'e0000000-0000-0000-0000-000000000001', 'work_date', public.business_today() - 1,
        'start_time', '10:00', 'end_time', '12:00', 'note', 'Inventory'))));
    assert (result ->> 'saved')::int = 1, 'Mia should add unscheduled work';

    -- Nothing else admin-only.
    foreach call in array array[
        'select public.admin_add_shifts(''[]'')',
        'select public.admin_delete_items()',
        'select public.admin_close_days(array[current_date + 3])',
        'select public.approve_time_off(array[gen_random_uuid()])',
        'select public.save_employee(''{"id": null, "name": "Sneaky", "color": "#2B6CB0", "rates": []}'')',
        'select public.save_weekly_hours(''[]'')'
    ] loop
        perform pg_temp.expect_error(call, 'not_admin', '42501');
    end loop;
    perform pg_temp.expect_error(
        'insert into public.payroll_staff (user_id) values (''00000000-0000-0000-0000-000000000001'')',
        'new row violates row-level security policy%', '42501');
    delete from public.payroll_staff where user_id = auth.uid();
    assert exists (select 1 from public.payroll_staff where user_id = auth.uid()), 'Mia can''t remove her own access';
    -- No policy lets her change rates: the update matches nothing.
    update public.employee_rates set rate = rate + 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Avery, an employee without payroll access
-- ---------------------------------------------------------------------------

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
    assert not public.can_edit_payroll();
    assert not exists (select 1 from public.shift_actuals), 'Avery must not read payroll';
    assert not exists (select 1 from public.hour_logs), 'Avery must not read the hour_logs table';
    assert not exists (select 1 from public.payroll_staff), 'Avery has no payroll_staff row to see';
    perform pg_temp.expect_error('select public.save_shift_actuals(''{}'')', 'not_admin', '42501');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The admin manages payroll staff
-- ---------------------------------------------------------------------------

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';
do $$
begin
    assert public.can_edit_payroll(), 'admins can edit payroll';
    insert into public.payroll_staff (user_id) values ('00000000-0000-0000-0000-000000000001');
    assert (select count(*) from public.payroll_staff) = 2, 'the admin sees every payroll_staff row';
    delete from public.payroll_staff where user_id = '00000000-0000-0000-0000-000000000001';
    assert (select count(*) from public.payroll_staff) = 1;
end;
$$;

reset role;
do $$
begin
    assert (select sum(rate) from public.employee_rates)::text = current_setting('tests.rates'),
        'payroll staff must not change pay rates';
end;
$$;

rollback;

\echo ALL PAYROLL ACCESS TESTS PASSED
