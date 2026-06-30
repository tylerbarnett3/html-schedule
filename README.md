# HTML Schedule

Small business employee schedule app hosted as a static GitHub Pages app and embedded inside Wix HTML iframe elements.

The app has two separate Wix pages/embeds:

- `edit-schedule.html` is the owner/admin experience for managing employees, rates, shifts, closed business days, and time-off approvals.
- `view-schedule.html` is the employee-facing experience for viewing schedules and submitting/canceling time-off requests.

Both embeds communicate with Wix Velo page code through `postMessage`, and the Velo code reads/writes the same Wix CMS collections.

## Files

- `edit-schedule.html` - owner/admin source HTML. The build publishes it as `edit.html`.
- `view-schedule.html` - employee source HTML. The build publishes it as `view.html`.
- `backend-edit-code.js` - Wix Velo page code for the edit page.
- `backend-view-code.js` - Wix Velo page code for the view page.
- `scripts/dev-server.mjs` - local Vite dev server that refreshes `edit.html` and `view.html` when source HTML files are saved.
- `scripts/prepare-pages.mjs` - copies the source HTML files into the Vite Pages build root.
- `.github/workflows/deploy-pages.yml` - builds and deploys the app to GitHub Pages.

## Wix Collections

The current code expects these Wix collections:

- `Employees`
  - `name`
  - `archived`
  - `color`
  - `displayOrder`
- `EmployeeRates`
  - `employee` reference to `Employees`
  - `rate`
  - `startDate`
  - `endDate`
- `Shifts`
  - `employee` reference to `Employees`
  - `date`
  - `startTime`
  - `endTime`
  - `isDayOff`
  - `isTimeOffRequest`
  - `requestStatus`
  - `requestDate`
  - `requestedBy`
  - `timeOffPeriod` (`full-day`, `morning`, or `evening`)
- `ClosedDays`
  - `date`

## Deployment Workflow

1. Update the relevant local file.
2. Run `npm run build` to verify the static Pages build.
3. Commit and push the changes to GitHub.
4. GitHub Actions publishes the latest UI to GitHub Pages.
5. The Wix HTML iframe elements should point to:
   - `https://tylerbarnett3.github.io/html-schedule/edit.html`
   - `https://tylerbarnett3.github.io/html-schedule/view.html`
6. Copy `backend-edit-code.js` into the Velo page code for the owner/admin page only when edit database behavior changes.
7. Copy `backend-view-code.js` into the Velo page code for the employee page only when view database behavior changes.
8. Test both pages in Wix after publishing:
   - confirm the Edit page shows the expected app version
   - confirm browser/Wix logs show the same app version for HTML and Velo code
   - load schedule data
   - add/edit/delete a shift
   - submit a time-off request from View
   - approve/deny that request from Edit
   - confirm the employee view does not expose rate data

## Access Model

There is no per-user authentication in this app. Access is controlled by the password-protected Wix page that contains each HTML element. Anyone with access to the owner/admin page can use the edit interface and write schedule data.

The employee-facing View code intentionally strips employee rate data before sending it to the iframe.

Direct visits to the public GitHub Pages URLs load fictional mock data. Real Wix database reads and writes only happen when the app is embedded in the Wix pages and communicating with the Velo bridge code.

## Maintenance Notes

- Edit and View use separate HTML and Velo files, so message action names must stay in sync across each pair.
- UI-only changes deploy through GitHub Pages after a push to `main`; they do not require pasting full HTML into Wix.
- Local development/builds require Node.js compatible with Vite 8. GitHub Actions uses Node 22.
- The app uses local IDs in the iframe and Wix `_id` values in the database. The Velo code maps between those IDs when loading and syncing.
- Edit automatically deletes `Shifts` records older than 90 days on load and after successful sync to stay below Wix record limits.
- Syncs are additive/update-oriented for shifts and employees. Explicit delete actions handle shift deletion, denied time-off request deletion, closed-day cleanup, and permanent employee deletion.
- Successful edit syncs return Wix `_id` mappings for newly inserted employees, rates, and shifts. The iframe applies those IDs immediately so later autosaves update the same rows instead of inserting duplicates.
- Shift sync is idempotent for exact semantic matches. If a stale client submits a shift/day-off/time-off request without a `wixId`, the Velo code reuses the matching database row when employee, date, times, request fields, and time-off period match.
- The Edit tools menu includes `Remove Duplicates`, which deletes exact duplicate `Shifts` records already created in Wix while keeping one canonical copy of each matching record.
- Employee rate periods removed in Edit are cleaned up during sync for the affected employee.
- Archiving is the preferred way to remove employees from normal scheduling. Permanent employee delete removes the employee, their rates, and their shifts from Wix.
- Before major data changes, use the app's export feature to download a JSON backup.
