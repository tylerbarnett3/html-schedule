-- Tests for reviewed_shifts in 20261005000001_reviewed_shifts.sql: who can call it, which
-- payroll records it returns for a range, and that it leaves out the payroll note.
-- Run against the LOCAL database after `npx supabase db reset` (they use seed.sql's logins):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/reviewed_shifts.sql
-- Everything runs in one transaction that is rolled back, so the data is left as it was.
-- The first failing check stops the run; the last line printed on success is
-- ALL REVIEWED SHIFTS TESTS PASSED.
--
-- Logins: avery (an employee without payroll access), admin@example.com, and a login with
-- no employee record.

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

-- A record whose date drifted from its shift's (normally a trigger keeps them together), so
-- the range checks below can tell "dated in the range" from "its shift is in the range".
do $$
declare
    drifted uuid;
begin
    assert (select count(*) from public.shift_actuals where shift_id is not null) > 0,
        'the seed should have payroll records for shifts: run `npx supabase db reset`';
    assert exists (select 1 from public.shift_actuals where status = 'unscheduled'), 'the seed should have unscheduled work';
    select a.id into drifted from public.shift_actuals a where a.shift_id is not null order by a.id limit 1;
    update public.shift_actuals set work_date = work_date + 40 where id = drifted;
    perform set_config('tests.drifted', drifted::text, true);
    perform set_config('tests.count', (select count(*) from public.shift_actuals)::text, true);
end;
$$;

-- The expected rows for a range, read straight from the tables.
create function pg_temp.expected(p_start date, p_end date)
returns setof text
language sql
as $$
    select concat_ws('|', a.id, a.shift_id, a.employee_id, a.work_date, a.start_time, a.end_time, a.status)
    from public.shift_actuals a
    where a.work_date between p_start and p_end
       or a.shift_id in (select s.id from public.shifts s where s.shift_date between p_start and p_end)
$$;

create function pg_temp.got(p_start date, p_end date)
returns setof text
language sql
as $$
    select concat_ws('|', r.id, r.shift_id, r.employee_id, r.work_date, r.start_time, r.end_time, r.status)
    from public.reviewed_shifts(p_start, p_end) r
$$;

grant execute on function pg_temp.got(date, date) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 1. Grants and function settings
-- ---------------------------------------------------------------------------

do $$
declare
    fn constant text := 'public.reviewed_shifts(date, date)';
begin
    assert not has_function_privilege('anon', fn, 'execute'), 'anon can call reviewed_shifts';
    assert not has_function_privilege('public', fn, 'execute'), 'public can call reviewed_shifts';
    assert has_function_privilege('authenticated', fn, 'execute'), 'authenticated can''t call reviewed_shifts';
    assert (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = fn::regprocedure),
        'reviewed_shifts must be security definer with an empty search_path';
    assert (select p.provolatile = 's' from pg_proc p where p.oid = fn::regprocedure), 'reviewed_shifts should be stable';
    assert (select not ('note' = any(p.proargnames)) from pg_proc p where p.oid = fn::regprocedure),
        'reviewed_shifts must not return the payroll note';
end;
$$;

set local role anon;
do $$
begin
    perform pg_temp.expect_error('select * from public.reviewed_shifts(''2026-01-01'', ''2026-12-31'')',
        'permission denied for function reviewed_shifts', '42501');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Avery, an employee: every record in the range, without notes
-- ---------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';

do $$
declare
    drifted constant uuid := current_setting('tests.drifted')::uuid;
    shift_day date;
    record_day date;
begin
    assert not exists (select 1 from public.shift_actuals), 'Avery must not read shift_actuals directly';
    -- (Avery can't read the table, so the expected rows are compared as the owner below.)
    assert (select count(*) from public.reviewed_shifts('2000-01-01', '2100-12-31'))
        = current_setting('tests.count')::bigint, 'Avery should get every payroll record over a wide range';
    assert not exists (select 1 from public.reviewed_shifts(null, null)), 'no range, no rows';
    assert not exists (select 1 from public.reviewed_shifts('2026-12-31', '2026-01-01')), 'an empty range has no rows';

    select s.shift_date into shift_day
    from public.shifts s
    where s.id = (select r.shift_id from public.reviewed_shifts('2000-01-01', '2100-12-31') r where r.id = drifted);
    select r.work_date into record_day from public.reviewed_shifts('2000-01-01', '2100-12-31') r where r.id = drifted;
    assert shift_day is not null and record_day = shift_day + 40;
    assert exists (select 1 from public.reviewed_shifts(shift_day, shift_day) r where r.id = drifted),
        'a record shows in its shift''s range';
    assert exists (select 1 from public.reviewed_shifts(record_day, record_day) r where r.id = drifted),
        'a record shows in its own date''s range';
    perform set_config('tests.shift_day', shift_day::text, true);
end;
$$;

-- What Avery got, compared with the table (read as the owner).
create temporary table avery_got on commit drop as
    select * from pg_temp.got('2026-09-01', current_setting('tests.shift_day')::date);
reset role;
do $$
begin
    assert (select count(*) from avery_got) > 0, 'the range should hold some records';
    assert not exists (
        (select * from pg_temp.expected('2026-09-01', current_setting('tests.shift_day')::date) except select * from avery_got)
        union all
        (select * from avery_got except select * from pg_temp.expected('2026-09-01', current_setting('tests.shift_day')::date))
    ), 'reviewed_shifts should return exactly the records dated in the range or whose shift is in it';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The admin, and a login with no employee record
-- ---------------------------------------------------------------------------

set local role authenticated;
set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';
do $$
begin
    assert (select count(*) from public.reviewed_shifts('2000-01-01', '2100-12-31'))
        = current_setting('tests.count')::bigint, 'the admin gets every record';
end;
$$;

set local "request.jwt.claims" to '{"sub":"00000000-0000-0000-0000-00000000dead","role":"authenticated"}';
do $$
begin
    assert not public.is_staff();
    assert not exists (select 1 from public.reviewed_shifts('2000-01-01', '2100-12-31')),
        'a login that is neither an admin nor an employee gets nothing';
end;
$$;

reset role;
rollback;

\echo ALL REVIEWED SHIFTS TESTS PASSED
