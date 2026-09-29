# Mad Potter Schedule (web app)

The employee schedule site: React + TypeScript (Vite), with Supabase for the database and logins. It replaces `view-schedule.html` and the Wix setup; the admin screens come next.

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

## Layout

- `src/lib/`: dates, periods, calendar and request rules as plain functions, with tests. Dates are always `'YYYY-MM-DD'` strings, never `Date` objects, so time zones and daylight saving can't shift them.
- `src/data/`: loading and saving through Supabase (react-query hooks).
- `src/components/`: shared buttons, dialogs, toasts and confirm prompts.
- `src/features/`: the sign-in page and the schedule screen.

The database schema, access rules and request rules live in `../supabase/migrations/`. Employees submit requests through the `request_time_off` and `request_availability` database functions, which enforce the rules server-side.
