-- Fictional data for the LOCAL Supabase only (npx supabase start / db reset).
-- Never run this against the real project.
--
-- Logins (password for all: localpass123):
--   admin@example.com   admin, not an employee
--   avery, jordan, mia, sam, taylor, nora, eli, grace, leo   employees
--   archived            linked to an archived employee
--   nobody              a login that isn't an admin or an employee

create function pg_temp.add_login(p_username text, p_id uuid)
returns void
language sql
as $$
    insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
        '00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated',
        case when p_username like '%@%' then p_username else p_username || '@schedule.madpotter.invalid' end,
        crypt('localpass123', gen_salt('bf')), now(), now(), now(),
        '{"provider":"email","providers":["email"]}', '{}', '', '', '', ''
    );
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    select gen_random_uuid(), p_id::text, p_id,
        jsonb_build_object('sub', p_id::text, 'email', u.email, 'email_verified', true),
        'email', now(), now(), now()
    from auth.users u where u.id = p_id;
$$;

select pg_temp.add_login('admin@example.com', '00000000-0000-0000-0000-00000000a001');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-00000000a001');

insert into public.employees (id, name, color, display_order, archived) values
    ('e0000000-0000-0000-0000-000000000001', 'Avery Lane',    '#7F6C50', 0, false),
    ('e0000000-0000-0000-0000-000000000002', 'Jordan Price',  '#2F855A', 1, false),
    ('e0000000-0000-0000-0000-000000000003', 'Mia Chen',      '#2B6CB0', 2, false),
    ('e0000000-0000-0000-0000-000000000004', 'Sam Rivera',    '#B7791F', 3, false),
    ('e0000000-0000-0000-0000-000000000005', 'Taylor Brooks', '#9F7AEA', 4, false),
    ('e0000000-0000-0000-0000-000000000006', 'Nora Patel',    '#C05621', 5, false),
    ('e0000000-0000-0000-0000-000000000007', 'Eli Morgan',    '#319795', 6, false),
    ('e0000000-0000-0000-0000-000000000008', 'Grace Kim',     '#D53F8C', 7, false),
    ('e0000000-0000-0000-0000-000000000009', 'Leo Bennett',   '#4A5568', 8, false),
    ('e0000000-0000-0000-0000-000000000010', 'Pat O''Brien',  '#9C4221', 9, true);

do $$
declare
    logins text[] := array['avery', 'jordan', 'mia', 'sam', 'taylor', 'nora', 'eli', 'grace', 'leo', 'archived'];
    i int;
    login_id uuid;
begin
    for i in 1..array_length(logins, 1) loop
        login_id := ('00000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid;
        perform pg_temp.add_login(logins[i], login_id);
        update public.employees set user_id = login_id
        where id = ('e0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid;
    end loop;
    perform pg_temp.add_login('nobody', '00000000-0000-0000-0000-0000000000ff');
end;
$$;

-- Shifts from 3 weeks ago to 7 weeks ahead: most employees work most days on a
-- rotating pattern, plus one overnight shift a week.
insert into public.shifts (employee_id, shift_date, start_time, end_time)
select e.id, d::date,
    (array['09:00', '10:00', '12:00', '13:00', '14:00'])[1 + (e.display_order + extract(doy from d)::int) % 5]::time,
    (array['15:00', '16:00', '18:00', '19:00', '20:00'])[1 + (e.display_order + extract(doy from d)::int) % 5]::time
from public.employees e
cross join generate_series(current_date - 21, current_date + 49, interval '1 day') as d
where not e.archived
  and (e.display_order + extract(doy from d)::int) % 3 <> 0;

insert into public.shifts (employee_id, shift_date, start_time, end_time)
select 'e0000000-0000-0000-0000-000000000009', d::date, '22:00', '02:00'
from generate_series(current_date - 21, current_date + 49, interval '7 days') as d;

-- The archived employee still has past shifts.
insert into public.shifts (employee_id, shift_date, start_time, end_time)
select 'e0000000-0000-0000-0000-000000000010', d::date, '10:00', '16:00'
from generate_series(current_date - 21, current_date - 1, interval '3 days') as d;

insert into public.closed_days (closed_date) values (current_date + 9), (current_date + 30);

-- Time off. Inserted without a login, so the request rules don't apply here.
insert into public.time_off (employee_id, off_date, period, status, source, requested_at) values
    -- admin-assigned days off
    ('e0000000-0000-0000-0000-000000000003', current_date + 8,  'full-day', 'approved', 'assigned', now() - interval '10 days'),
    ('e0000000-0000-0000-0000-000000000008', current_date + 14, 'evening',  'approved', 'assigned', now() - interval '9 days'),
    -- approved requests
    ('e0000000-0000-0000-0000-000000000001', current_date + 5,  'full-day', 'approved', 'request',  now() - interval '8 days'),
    ('e0000000-0000-0000-0000-000000000004', current_date + 5,  'morning',  'approved', 'request',  now() - interval '7 days'),
    -- pending requests, including five on one day so the 4th and 5th turn purple
    ('e0000000-0000-0000-0000-000000000006', current_date + 12, 'morning',  'pending',  'request',  now() - interval '6 days'),
    ('e0000000-0000-0000-0000-000000000001', current_date + 20, 'full-day', 'pending',  'request',  now() - interval '5 days'),
    ('e0000000-0000-0000-0000-000000000002', current_date + 20, 'full-day', 'pending',  'request',  now() - interval '4 days'),
    ('e0000000-0000-0000-0000-000000000003', current_date + 20, 'evening',  'pending',  'request',  now() - interval '3 days'),
    ('e0000000-0000-0000-0000-000000000004', current_date + 20, 'full-day', 'pending',  'request',  now() - interval '2 days'),
    ('e0000000-0000-0000-0000-000000000005', current_date + 20, 'morning',  'pending',  'request',  now() - interval '1 day'),
    -- a past approved day off
    ('e0000000-0000-0000-0000-000000000007', current_date - 4,  'full-day', 'approved', 'request',  now() - interval '20 days');

insert into public.availability (employee_id, available_date, period, status, requested_at) values
    ('e0000000-0000-0000-0000-000000000001', current_date + 2,  'full-day', 'approved', now() - interval '6 days'),
    ('e0000000-0000-0000-0000-000000000005', current_date + 6,  'evening',  'pending',  now() - interval '2 days'),
    ('e0000000-0000-0000-0000-000000000002', current_date + 6,  'morning',  'approved', now() - interval '3 days');
