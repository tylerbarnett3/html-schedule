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
```

They run inside a transaction that is rolled back, so they leave the local data as it was. They expect the seed rows as the reset left them, so reset again after changing data through the app. The last line is `ALL ADMIN RPC TESTS PASSED`.

After changing a migration, regenerate the TypeScript types from the local database (repo root; `npx` downloads the `oxfmt` formatter the first time):

```sh
npx supabase gen types typescript --local --schema public > web/src/lib/database.types.ts && npx oxfmt web/src/lib/database.types.ts
```

## Admin screens

Admin logins open `/admin`. An admin who is also linked to an employee sees their own employee schedule at `/`, with an "Admin" link in the header; the admin toolbar then has an "Employee view" link back. Everyone else is sent from `/admin` to `/`.

- **Schedule (`/admin`).** The employee calendar with editing added:
  - "+ Add" on each day adds shifts or days off for several employees and dates at once, or marks days closed. "Reopen day" appears on closed days.
  - Clicking a shift or day off opens it for editing (change times, move it, turn a shift into a day off or back, delete it). A day off an employee asked for stays with that employee and stays a day off; its date and part of the day can still change, or it can be removed.
  - Clicking a pending request opens it for approval.
  - With a mouse, shifts and assigned days off can be dragged to another day.
  - The sidebar's Employee filter and Show Time Off / Show Availability are remembered in this browser. The dates always start at today.
- **Undo** (toolbar) reverses the last 20 calendar changes made on this page: adds, edits, moves, deletes, closing and reopening days. It doesn't cover approvals, denials, employees or payroll, and it's cleared by a reload or sign-out. If the schedule has changed since, the step is dropped with a message instead.
- **Requests** (toolbar button and sidebar drawer) lists pending time-off and availability requests, with a count. It opens by itself on the first load when something is waiting, and refreshes when the tab regains focus and every minute. Approving time off deletes the employee's shifts it covers, after a confirm that lists them. The Approved tab lists approved requests dated from 30 days ago onward and lets the admin remove an approval.
- **Employees** (sidebar drawer) shows each employee's shifts, hours and pay rate for the dates on screen. Add, edit (name, color, pay rates, "New rate starting on…"), archive, delete and reorder employees there.
- **Payroll** (`/admin/payroll`) records who actually worked each shift in a 14-day pay period (by default the 14 days ending yesterday) and copies the hours for payroll. The period and day are in the address (`?start=…&day=…`). Unsaved changes are kept until saved or discarded; leaving the page asks first.
- **Download PDF** prints the current dates and employee filter, one A4 landscape page per 7-day chunk. It always includes time off and never availability, and leaves out archived employees with nothing in those dates. The file is named `schedule-YYYY-MM-DD-to-YYYY-MM-DD.pdf`. The PDF library loads the first time the button is used.
- **Export Backup** downloads every table as `schedule-backup-YYYY-MM-DD-HHMMSS.json` (New York time): `{format: "mad-potter-schedule-backup", version: 1, exportedAt, employees, employee_rates, shifts, time_off, availability, shift_actuals, closed_days}`, with rows exactly as stored and the admins list left out. There's no import button; restoring would need a developer script.

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

The database schema, access rules and database functions live in `../supabase/migrations/`. Employees submit requests through the `request_time_off` and `request_availability` functions. Admin changes that touch several rows (calendar edits and their undo, approvals, employees and rates, payroll actuals) go through functions from `20260929000001_admin.sql`, so each saves all or nothing and refuses anyone who isn't an admin. Before applying that migration to a database with real data, run the four pre-flight queries at the top of the file; each must return no rows.
