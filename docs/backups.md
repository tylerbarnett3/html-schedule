# Database backups

`.github/workflows/backup-supabase.yml` backs up the Supabase database every night. Each run produces one encrypted file, `schedule-backup-YYYY-MM-DD.tar.gz.gpg`, saved as a workflow artifact for 90 days. The repo is public, so backups are encrypted before GitHub stores them; without the passphrase the file is unreadable.

A backup contains:

- `public-data.sql`: every row in the schedule tables (employees, rates, shifts, time off, availability, actuals, closed days, business hours (weekly and per date), logged hours, admins, payroll staff)
- `auth-users.sql`: the logins, so employees keep their usernames and passwords after a restore
- `public-schema.sql`: the table definitions at the time of the backup, for reference

## Setup

Add two repository secrets in GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

1. `SUPABASE_DB_URL`: in the Supabase dashboard click **Connect**, choose **Session pooler**, and copy the URI. Replace `[YOUR-PASSWORD]` with the database password you saved when creating the project. (Use the session pooler: the direct connection needs IPv6, which GitHub's runners don't have.)
2. `BACKUP_PASSPHRASE`: a long passphrase you make up. Save it in your password manager. **Without it, the backups can't be opened.**

Then run it once by hand: **Actions → Back up Supabase → Run workflow**. The run should finish green with one artifact.

GitHub pauses scheduled workflows in public repos after 60 days without any commits. It emails you first; click the link or push any commit to keep backups running.

## Downloading and opening a backup

1. **Actions → Back up Supabase**, open a run, and download the artifact under **Artifacts** (GitHub zips it).
2. Unzip it, then decrypt and unpack:

```sh
gpg --decrypt schedule-backup-2026-10-01.tar.gz.gpg | tar -xzf - -C restore/
```

`gpg` asks for the passphrase. It is built into Linux; on a Mac install it with `brew install gnupg`.

## Restoring

Restore into an empty Supabase project that has the migrations applied, either a brand-new project or the local copy (`npx supabase db reset --no-seed`).

1. Apply the migrations: run each file in `supabase/migrations/` in order in the SQL Editor, or `npx supabase db push` after linking the project.
2. Load the logins, then the data, using the new project's session pooler URI:

```sh
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f restore/auth-users.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f restore/public-data.sql
```

3. Update the website's `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (Cloudflare Pages settings) if the project changed, and redeploy.
