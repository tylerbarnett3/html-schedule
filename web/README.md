# Mad Potter Schedule (web app)

The schedule site: React + TypeScript (Vite), with Supabase for the database and logins. Employees see the schedule and send requests; the admin edits the schedule, reviews requests, manages employees and records payroll hours. It replaces `view-schedule.html`, `edit-schedule.html` and the Wix setup.

## Run it

```sh
npm install

# Against a local copy of Supabase with made-up data (safe to click anything):
npx supabase start          # from the repo root; needs Docker
npm run dev:local           # http://localhost:5173

# Against the real project (reads and writes real data):
cp .env.example .env.local  # then fill in the URL and publishable key
npm run dev
```

Local logins all use the password `localpass123`: `avery`, `jordan`, `mia`, `sam`, `taylor`, `nora`, `eli`, `grace`, `leo` (employees), `archived`, `nobody`, and `admin@example.com`. `npx supabase db reset` (repo root) restores the local data.

## Checks

```sh
npm run build     # type-check and build to dist/
npm run lint
npm run test:tz   # unit tests in New York and Tokyo time zones
```

The database functions have their own tests. From the repo root, after `npx supabase db reset`:

```sh
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/admin_rpcs.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/business_hours.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/hour_logs.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/payroll_access.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/reviewed_shifts.sql
```

They run inside a transaction that is rolled back, so they leave the local data as it was. They expect the seed rows as the reset left them, so reset again after changing data through the app. The last lines are `ALL ADMIN RPC TESTS PASSED`, `ALL BUSINESS HOURS TESTS PASSED`, `ALL HOUR LOG TESTS PASSED`, `ALL PAYROLL ACCESS TESTS PASSED` and `ALL REVIEWED SHIFTS TESTS PASSED`.

After changing a migration, regenerate the TypeScript types from the local database (repo root; `npx` downloads the `oxfmt` formatter the first time):

```sh
npx supabase gen types typescript --local --schema public > web/src/lib/database.types.ts && npx oxfmt web/src/lib/database.types.ts
```

## Employee page

Employees sign in at `/` and see the schedule. Once the admin has entered business hours, the sidebar has a read-only **Business Hours** drawer (after the employee filter, collapsed at first): the standard hours in effect today, Monday first, and each upcoming change under a heading like "From Nov 1:". A day whose hours differ from the standard hours for its weekday on that date shows them after its date, e.g. "31 Oct (9:00 AM - 5:00 PM)", or "Saturday, Oct 31 (9:00 AM - 5:00 PM)" on a phone. Closed days show CLOSED, without hours.

Once a shift has been reviewed in Payroll, the schedule (employees' and admin's alike, and the PDF) shows what was recorded instead of what was scheduled: the actual times, under whoever worked them. A reviewed shift is green (#afd8ac) with a check in its top right corner. A shift recorded as not worked ("Vacated") disappears, and unscheduled work added in Payroll appears as a reviewed shift of its own. The scheduled shift itself isn't changed (Payroll still compares against it), so clearing a review in Payroll brings the scheduled shift back. Everyone sees the times and the employee, never the payroll note. On the admin calendar a reviewed shift can't be opened or dragged: it changes in Payroll. The Employees drawer's shift counts and hours follow what the calendar shows.

**Log My Hours** (header, next to the request buttons) lets an employee record the hours they actually worked on one of their own shifts, with an optional note, for the admin to see in Payroll. It lists their shifts from Sep 28, 2026 on that have ended (New York time; an overnight shift ends the next morning) and that the admin hasn't reviewed in Payroll yet, newest first, each marked "Not logged yet" or with the hours logged. They can change or remove what they logged until the admin saves a review of that shift; then it leaves the list. Logging isn't a review: the shift still shows "Needs review" in Payroll, and only reviewed hours count toward payroll. It's there for employees whose record isn't archived, including an admin who is also an employee. A shift someone else covered, or work that wasn't on the schedule, is still recorded by the admin in Payroll. A log belongs to its shift: deleting the shift (or undoing its add) takes the log with it, and undoing a delete brings both back. Hours that run past midnight on a shift that doesn't are asked about before saving (usually AM and PM mixed up).

On screens 1024px wide and narrower, the sidebar sits above the calendar as a compact two-column grid: the two toggles share a row, the drawer buttons sit two to a row, and an open drawer's panel spans the full width under its row with the drawer's name at the top. On phones the date range fits on one line with Start and End side by side.

## Payroll access

Someone who helps with payroll without being an admin (listed in the `payroll_staff` table) gets a "Payroll" link in their schedule's header, where an admin-employee has "Admin". It opens the same Payroll page, where they can review and edit every shift (their own included), use logged hours, add unscheduled shifts and copy the output; "Back to schedule" returns to their own schedule. They don't see pay rates or the two labor cost estimates, and everything else on the admin side stays admin-only (`/admin` sends them back to `/`). They need an employee login, like any non-admin. Locally, `mia` has payroll access.

To give or remove access on the real project, run this in the Supabase SQL Editor with their username:

```sql
insert into public.payroll_staff (user_id)
select id from auth.users where email = 'USERNAME@schedule.madpotter.invalid';

delete from public.payroll_staff
where user_id = (select id from auth.users where email = 'USERNAME@schedule.madpotter.invalid');
```

The change shows the next time they sign in (or reload the page).

## Admin screens

Admin logins open `/admin`. An admin who is also linked to an employee sees their own employee schedule at `/`, with an "Admin" link in the header; on the admin pages the header has an "Employee view" link back in the same spot (left of Sign out). Everyone else is sent from `/admin` to `/`.

- **Schedule (`/admin`).** The employee calendar with editing added:
  - "+ Add" on each day adds shifts or days off for several employees and dates at once. Its Hours type sets the hours of several dates at once: standard hours, custom hours or closed.
  - Clicking a day's date heading (or Enter/Space on it) opens **Day Hours** for that day: standard hours, custom hours (open and close times for that date only) or closed. Closing deletes the day's shifts and time off, after a confirm that counts them when there are any (payroll records and availability are kept), and it also clears the day's custom hours. Choosing standard or custom hours on a closed day reopens it. Custom hours equal to the day's standard hours count as standard hours. Days with special hours show them after the date, on this calendar and the employees'.
  - "Reopen day" appears on closed days and puts the day back on standard hours.
  - Clicking a shift or day off opens it for editing (change times, move it, turn a shift into a day off or back, delete it). A day off an employee asked for stays with that employee and stays a day off; its date and part of the day can still change, or it can be removed.
  - Clicking a pending request opens it for approval.
  - With a mouse, shifts and assigned days off can be dragged to another day.
  - Shifts reviewed in Payroll (green, with a check) can't be opened or dragged here; change them in Payroll. A new, edited or moved shift is checked against the hours Payroll recorded (the green cards) as well as the scheduled shift behind each review, and a conflict or delete message marks either one "(reviewed in Payroll)". Days off don't remove recorded hours.
  - The sidebar's Employee filter and Show Time Off / Show Availability are remembered in this browser. The dates always start at today.
- **Undo** (toolbar) reverses the last 20 calendar changes made on this page: adds, edits, moves, deletes, closing and reopening days, and each date's hours (undoing a close brings back the day's custom hours too). It doesn't cover approvals, denials, employees, payroll or the weekly business hours, and it's cleared by a reload or sign-out. If the schedule has changed since, the step is dropped with a message instead.
- **Requests** (sidebar drawer) lists pending time-off and availability requests, with a count. The drawer starts closed (its count still shows), and it refreshes when the tab regains focus and every minute. Approving time off deletes the employee's shifts it covers, after a confirm that lists them. The Approved tab lists approved requests dated from 30 days ago onward and lets the admin remove an approval.
- **Business Hours** (sidebar drawer, after Requests) shows the same lists as the employee page. "Edit Hours" opens the weekly editor, which saves with Save Changes / Cancel (not Undo):
  - correct the current hours, an upcoming change, or an earlier set of hours (earlier sets apply to past days, so change them only to fix a mistake);
  - "New hours starting on…" adds a change from a chosen date, any date after the current hours started, even a past one. Days before that date keep the hours they had;
  - "Remove Change" removes an upcoming change. A change that has started can be corrected but not removed.

  Before any hours exist, the drawer shows "No business hours yet." and "Set Hours", which enters the first set; the first set also covers every earlier day. Employees don't see the drawer, and the PDF has no hours key, until then.
- **Employees** (sidebar drawer) shows each employee's shifts, hours and pay rate for the dates on screen. Add, edit (name, color, pay rates, "New rate starting on…"), archive, delete and reorder employees there.
- **Payroll** (`/admin/payroll`, the toolbar's gold button, which reads "Back to schedule" while you're on Payroll) records who actually worked each shift in a 14-day pay period (by default the 14 days ending yesterday) and copies the hours for payroll. The period and day are in the address (`?start=…&day=…`). Unsaved changes are kept until saved or discarded; leaving the page asks first. The summary shows the scheduled and reviewed hours, their difference, and two estimated labor costs: the scheduled hours and the reviewed hours (for whoever worked them), each priced at the employee's pay rate on that date. Hours with no rate for their date add nothing and are named under the total ("No rate for …"). Each card's scheduled hours show their length, e.g. "Scheduled · 1:00 PM – 7:15 PM (6h 15m)". A shift whose employee logged their hours (Log My Hours) shows them under the Outcome buttons, e.g. "Logged · 1:00 PM – 7:10 PM (+10 min)", with the employee's note; "Use logged hours" fills in those times (and that employee) for the review, which is then saved as usual.
- **Download PDF** prints the current dates and employee filter, one A4 landscape page per 7-day chunk. A week fits one page with about 16 employees (about 15 on page 1 when the hours key takes two lines; fewer when cells wrap to two lines); a longer week continues on the next page with its header repeated. It always includes time off and never availability, and leaves out archived employees with nothing in those dates. The file is named `schedule-YYYY-MM-DD-to-YYYY-MM-DD.pdf`. Once business hours exist, page 1 starts with a key of the standard hours in effect on the first date, e.g. "Monday-Friday: 11:00 AM - 9:00 PM | Saturday: 10:00 AM - 6:00 PM | Sunday: 12:00 PM - 5:00 PM", plus a "From Nov 1: …" line for each change within the dates (a line that wraps leaves out the "|" at the break). A date with special hours gets them as a third line in its column header, e.g. "Sat / 10/31 / (9:00 AM - 5:00 PM)". The PDF library loads the first time the button is used.
- **Export Backup** (the download icon in the header's top left corner, admin pages only) downloads every table as `schedule-backup-YYYY-MM-DD-HHMMSS.json` (New York time): `{format: "mad-potter-schedule-backup", version: 1, exportedAt, employees, employee_rates, shifts, time_off, availability, shift_actuals, closed_days, weekly_hours, custom_hours, hour_logs}`, with rows exactly as stored and the admins list left out. There's no import button; restoring would need a developer script.

## Employee colors

`scripts/assign-colors.mjs` (repo root) gives every active employee a different color from the palette in `src/lib/employeePalette.ts`, the same palette the Employees drawer offers. In display order, the first employee using a palette color keeps it and everyone else gets the next unused one. Archived employees are skipped.

```sh
node scripts/assign-colors.mjs           # shows the plan; changes nothing
node scripts/assign-colors.mjs --write   # saves it
```

- It needs Node 22.18 or later, because it loads the TypeScript palette file directly.
- It reads `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from `.env` in the current folder or from the shell; the shell wins. The repo-root `.env` points at the real project. For the local copy, set both in the shell: the URL is `http://127.0.0.1:54321` and `npx supabase status -o env` prints `SECRET_KEY`.
- It prints which database it's talking to before anything else. Running it again after `--write` changes nothing.

## Layout

- `src/lib/`: dates, periods, calendar, request, schedule-editing, payroll, rate and PDF rules as plain functions, with tests. Dates are always `'YYYY-MM-DD'` strings, never `Date` objects, so time zones and daylight saving can't shift them.
- `src/data/`: loading and saving through Supabase (react-query hooks). After every admin change all data is refetched.
- `src/components/`: shared buttons, dialogs, toasts, alerts and confirm prompts.
- `src/features/`: the sign-in page, the schedule screen, and `admin/` (toolbar, sidebar, schedule editor, requests, employees, payroll and tools).

The database schema, access rules and database functions live in `../supabase/migrations/`. Employees submit requests through the `request_time_off` and `request_availability` functions. Admin changes that touch several rows (calendar edits and their undo, approvals, employees and rates, payroll actuals) go through functions from `20260929000001_admin.sql`, and business hours through functions from `20260930000001_business_hours.sql`, so each saves all or nothing and refuses anyone who isn't an admin; `save_shift_actuals` (payroll) also accepts payroll staff, from `20260930000003_payroll_access.sql`. Employees log their hours through `my_loggable_shifts`, `log_shift_hours` and `remove_hour_log` from `20260930000002_hour_logs.sql`; they can't read the `hour_logs` table (or payroll) directly, unless they have payroll access. The schedule reads reviewed shifts (times and outcome, without the note) through `reviewed_shifts` from `20261005000001_reviewed_shifts.sql`. Before applying the admin migration to a database with real data, run the four pre-flight queries at the top of the file; each must return no rows.

## Deploy

Database changes go to the real project by pasting the migration file into the Supabase SQL Editor. Apply `20260930000001_business_hours.sql` there **before** deploying the web app that uses it. It needs no pre-flight queries and adds no hours: enter them afterwards in the app (Business Hours → Set Hours). Then apply `20260930000002_hour_logs.sql` the same way (it adds the empty `hour_logs` table and its functions), and `20260930000003_payroll_access.sql` (the empty `payroll_staff` list; see Payroll access). `20261005000001_reviewed_shifts.sql` adds the read-only `reviewed_shifts` function the schedule uses to show reviewed shifts; it changes no data.
