// One-time import of a Wix schedule backup (the Edit page's Export file) into Supabase.
//
// Usage:
//   node scripts/import-wix-backup.mjs <backup.json>           dry run: report only, writes nothing
//   node scripts/import-wix-backup.mjs <backup.json> --write   write to Supabase
//
// --write needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env. The secret key bypasses
// Row Level Security, so keep it out of git and never use it in the website.
//
// Re-running with a newer backup makes Supabase match it: imported rows are updated in
// place (matched on wix_id), and imported rows that are no longer in the backup are
// deleted. Rows created in the new app (no wix_id) are left alone, except closed days,
// which always match the backup. Employee logins (employees.user_id) are kept.
//
// Reload the Wix Edit page right before exporting: the export saves what the page
// loaded, so requests submitted after it was opened are missing otherwise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_COLOR = "#7F6C50";
const PERIODS = ["full-day", "morning", "evening"];
const ACTUAL_STATUSES = ["confirmed", "adjusted", "not-worked", "unscheduled"];
const BATCH_SIZE = 500;
const PAGE_SIZE = 1000;
const DELETE_BATCH_SIZE = 100;

function toDateOnly(value, context) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
        return value.slice(0, 10);
    }
    throw new Error(`${context}: expected a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
}

function toTime(value, context) {
    if (typeof value === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
        return value.slice(0, 5);
    }
    throw new Error(`${context}: expected an HH:MM time, got ${JSON.stringify(value)}`);
}

// The Wix Shifts collection holds several record types; work out which one a row is.
function classifyShift(shift) {
    if (shift.isUnscheduledActual) return "unscheduled-actual";
    if (shift.isTimeOffRequest) return "time-off-request";
    if (shift.isDayOff) return "day-off";
    return "shift";
}

// Turns a backup file into rows for each Supabase table. Rows refer to each other by
// wix_id; writeImportPlan swaps those for the new database IDs.
//
// errors block --write (the data can't be stored as-is; fix it in Wix and re-export).
// warnings are rows that were skipped. notes are imported but worth checking.
export function buildImportPlan(backup) {
    const errors = [];
    const warnings = [];
    const notes = [];
    const fallbackTimestamp = backup.exportDate || new Date().toISOString();

    const employeeWixIdByLocalId = new Map();
    const employeeNameByWixId = new Map();
    const employees = [];
    const rates = [];

    backup.employees.forEach((employee, index) => {
        if (!employee.wixId) {
            warnings.push(`Skipped employee "${employee.name}": it was never saved to Wix (no wixId).`);
            return;
        }
        employeeWixIdByLocalId.set(employee.id, employee.wixId);
        employeeNameByWixId.set(employee.wixId, employee.name);
        employees.push({
            wix_id: employee.wixId,
            name: String(employee.name).trim(),
            color: employee.color || DEFAULT_COLOR,
            display_order:
                typeof employee.displayOrder === "number" ? employee.displayOrder : index,
            archived: Boolean(employee.archived),
        });

        (employee.rates || []).forEach((rate, rateIndex) => {
            const context = `Rate ${rateIndex + 1} for ${employee.name}`;
            if (!rate.wixId) {
                warnings.push(`Skipped ${context}: it was never saved to Wix (no wixId).`);
                return;
            }
            rates.push({
                wix_id: rate.wixId,
                employee_wix_id: employee.wixId,
                rate: Number(rate.rate),
                start_date: rate.startDate ? toDateOnly(rate.startDate, context) : null,
                end_date: rate.endDate ? toDateOnly(rate.endDate, context) : null,
            });
        });
    });

    const shifts = [];
    const actuals = [];
    const timeOffByKey = new Map();
    const dayOffKeys = new Set();

    const employeeWixId = (localId, context) => {
        const wixId = employeeWixIdByLocalId.get(localId);
        if (!wixId) throw new Error(`${context}: employee ${localId} is not in the backup`);
        return wixId;
    };
    const describe = (employeeWix, date) => `${employeeNameByWixId.get(employeeWix)} on ${date}`;

    // Payroll row for a shift. Returns null (with a warning) where the old app's payroll
    // would have counted nothing, so the new totals match the old ones.
    const buildActual = (shift, context, scheduledEmployee, date, shiftWixId) => {
        const status = shiftWixId ? shift.actualStatus : "unscheduled";
        if (!ACTUAL_STATUSES.includes(status)) {
            throw new Error(`${context}: unknown actual status ${JSON.stringify(status)}`);
        }
        const worked = status !== "not-worked";
        const hasActualEmployee =
            shift.actualEmployeeId != null && employeeWixIdByLocalId.has(shift.actualEmployeeId);

        if (worked && !hasActualEmployee) {
            warnings.push(
                `Skipped the ${status} actual for ${describe(scheduledEmployee, date)}: it has no employee who worked it (the old payroll didn't count it either).`,
            );
            return null;
        }
        if (worked && (!shift.actualStartTime || !shift.actualEndTime)) {
            warnings.push(
                `Skipped the ${status} actual for ${describe(scheduledEmployee, date)}: it has no actual times (the old payroll didn't count it either).`,
            );
            return null;
        }

        const row = {
            wix_id: shift.wixId,
            shift_wix_id: shiftWixId,
            employee_wix_id: hasActualEmployee
                ? employeeWixId(shift.actualEmployeeId, `${context} actual employee`)
                : scheduledEmployee,
            work_date: date,
            start_time: worked ? toTime(shift.actualStartTime, `${context} actual start`) : null,
            end_time: worked ? toTime(shift.actualEndTime, `${context} actual end`) : null,
            status,
            note: shift.actualNote || "",
            actualized_at: shift.actualizedAt || fallbackTimestamp,
        };
        if (worked && row.start_time === row.end_time) {
            errors.push(
                `The actual for ${describe(row.employee_wix_id, date)} starts and ends at ${row.start_time}. Fix the times in Wix and export again.`,
            );
            return null;
        }
        return row;
    };

    backup.shifts.forEach((shift) => {
        const kind = classifyShift(shift);
        const context = `${kind} ${shift.wixId || shift.id} on ${shift.date}`;
        if (!shift.wixId) {
            warnings.push(`Skipped ${context}: it was never saved to Wix (no wixId).`);
            return;
        }
        const date = toDateOnly(shift.date, context);
        const employee = employeeWixId(shift.employeeId, context);

        if (kind === "time-off-request" || kind === "day-off") {
            if (shift.actualStatus) {
                warnings.push(
                    `Ignored the ${shift.actualStatus} actual on ${describe(employee, date)}: the day is marked as time off (the old payroll ignored it too).`,
                );
            }
            if (shift.requestStatus === "denied") {
                warnings.push(`Skipped a denied request for ${describe(employee, date)}.`);
                return;
            }
            const period = PERIODS.includes(shift.timeOffPeriod) ? shift.timeOffPeriod : "full-day";
            const row = {
                wix_id: shift.wixId,
                employee_wix_id: employee,
                off_date: date,
                period,
                // Approved requests and admin days off are both stored as isDayOff rows;
                // admin days off have no requestStatus.
                status: kind === "day-off" ? "approved" : "pending",
                source: kind === "day-off" && !shift.requestStatus ? "assigned" : "request",
                requested_at: shift.requestDate || fallbackTimestamp,
            };
            const key = `${employee}|${date}|${period}`;
            const existing = timeOffByKey.get(key);
            if (!existing) {
                timeOffByKey.set(key, row);
            } else if (existing.status === "pending" && row.status === "approved") {
                timeOffByKey.set(key, row);
                notes.push(`Dropped a pending request for ${describe(employee, date)} (${period}); an approved one already covers it.`);
            } else {
                notes.push(`Dropped a duplicate ${row.status} time-off record for ${describe(employee, date)} (${period}).`);
            }
            if (row.status === "approved") dayOffKeys.add(`${employee}|${date}`);
            return;
        }

        if (kind === "unscheduled-actual") {
            const actual = buildActual(shift, context, employee, date, null);
            if (actual) actuals.push(actual);
            return;
        }

        const row = {
            wix_id: shift.wixId,
            employee_wix_id: employee,
            shift_date: date,
            start_time: toTime(shift.startTime, `${context} start`),
            end_time: toTime(shift.endTime, `${context} end`),
        };
        if (row.start_time === row.end_time) {
            errors.push(
                `The shift for ${describe(employee, date)} starts and ends at ${row.start_time}. Fix the times in Wix and export again.`,
            );
            return;
        }
        if (shift.requestStatus === "approved") {
            notes.push(
                `${describe(employee, date)} was an approved day off that was edited back into a shift (${row.start_time}-${row.end_time}). Imported as a shift, which is how the old payroll treated it.`,
            );
        }
        shifts.push(row);

        if (shift.actualStatus) {
            const actual = buildActual(shift, context, employee, date, shift.wixId);
            if (actual) actuals.push(actual);
        } else if (shift.actualStartTime || shift.actualEndTime) {
            warnings.push(`Ignored actual times for ${describe(employee, date)}: no actual status was set.`);
        }
    });

    shifts.forEach((shift) => {
        if (dayOffKeys.has(`${shift.employee_wix_id}|${shift.shift_date}`)) {
            notes.push(
                `${describe(shift.employee_wix_id, shift.shift_date)} has a shift (${shift.start_time}-${shift.end_time}) and is also marked off that day. Imported both; check which is right.`,
            );
        }
    });

    const closedDays = [...new Set((backup.closedDays || []).map((day, index) =>
        toDateOnly(typeof day === "string" ? day : day?.date, `Closed day ${index + 1}`),
    ))].map((closedDate) => ({ closed_date: closedDate }));

    if (!Array.isArray(backup.availability)) {
        notes.push(
            "Availability isn't in this export, so it isn't imported. Check the Availability collection in the Wix CMS before switching over.",
        );
    }

    return {
        employees,
        rates,
        shifts,
        actuals,
        timeOff: [...timeOffByKey.values()],
        closedDays,
        errors,
        warnings,
        notes,
    };
}

async function upsertRows(supabase, table, rows, onConflict) {
    const saved = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const { data, error } = await supabase
            .from(table)
            .upsert(rows.slice(i, i + BATCH_SIZE), { onConflict })
            .select();
        if (error) throw new Error(`Writing ${table} failed: ${error.message}`);
        saved.push(...data);
    }
    return saved;
}

// Deletes rows whose key is set but no longer in the backup. Pages through existing keys
// because Supabase returns at most 1000 rows per request.
async function deleteMissingRows(supabase, table, keyColumn, keepKeys) {
    const keep = new Set(keepKeys);
    const stale = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
            .from(table)
            .select(keyColumn)
            .not(keyColumn, "is", null)
            .order(keyColumn)
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
        data.forEach((row) => {
            if (!keep.has(row[keyColumn])) stale.push(row[keyColumn]);
        });
        if (data.length < PAGE_SIZE) break;
    }
    for (let i = 0; i < stale.length; i += DELETE_BATCH_SIZE) {
        const { error } = await supabase
            .from(table)
            .delete()
            .in(keyColumn, stale.slice(i, i + DELETE_BATCH_SIZE));
        if (error) throw new Error(`Removing old ${table} rows failed: ${error.message}`);
    }
    return stale.length;
}

function idLookup(savedRows, table) {
    const idByWixId = new Map(savedRows.map((row) => [row.wix_id, row.id]));
    return (wixId) => {
        const id = idByWixId.get(wixId);
        if (!id) throw new Error(`No ${table} row was saved for wix_id ${wixId}`);
        return id;
    };
}

// Writes a plan from buildImportPlan and returns how many old rows were removed per table.
// Parents are written first so child rows can point at their new IDs. Old rows are removed
// before upserting so a changed record can't collide with the one it replaces.
export async function writeImportPlan(supabase, plan) {
    const wixIds = (rows) => rows.map((row) => row.wix_id);
    const removed = {};

    const employeeId = idLookup(
        await upsertRows(supabase, "employees", plan.employees, "wix_id"),
        "employees",
    );

    removed.employee_rates = await deleteMissingRows(supabase, "employee_rates", "wix_id", wixIds(plan.rates));
    await upsertRows(
        supabase,
        "employee_rates",
        plan.rates.map(({ employee_wix_id, ...rate }) => ({
            ...rate,
            employee_id: employeeId(employee_wix_id),
        })),
        "wix_id",
    );

    removed.time_off = await deleteMissingRows(supabase, "time_off", "wix_id", wixIds(plan.timeOff));
    await upsertRows(
        supabase,
        "time_off",
        plan.timeOff.map(({ employee_wix_id, ...timeOff }) => ({
            ...timeOff,
            employee_id: employeeId(employee_wix_id),
        })),
        "wix_id",
    );

    removed.shift_actuals = await deleteMissingRows(supabase, "shift_actuals", "wix_id", wixIds(plan.actuals));
    removed.shifts = await deleteMissingRows(supabase, "shifts", "wix_id", wixIds(plan.shifts));
    const shiftId = idLookup(
        await upsertRows(
            supabase,
            "shifts",
            plan.shifts.map(({ employee_wix_id, ...shift }) => ({
                ...shift,
                employee_id: employeeId(employee_wix_id),
            })),
            "wix_id",
        ),
        "shifts",
    );
    await upsertRows(
        supabase,
        "shift_actuals",
        plan.actuals.map(({ employee_wix_id, shift_wix_id, ...actual }) => ({
            ...actual,
            employee_id: employeeId(employee_wix_id),
            shift_id: shift_wix_id ? shiftId(shift_wix_id) : null,
        })),
        "wix_id",
    );

    removed.closed_days = await deleteMissingRows(
        supabase,
        "closed_days",
        "closed_date",
        plan.closedDays.map((day) => day.closed_date),
    );
    await upsertRows(supabase, "closed_days", plan.closedDays, "closed_date");

    // Last, because deleting an employee also deletes their rows in the other tables.
    removed.employees = await deleteMissingRows(supabase, "employees", "wix_id", wixIds(plan.employees));

    return removed;
}

export async function countRows(supabase) {
    const tables = ["employees", "employee_rates", "shifts", "shift_actuals", "time_off", "closed_days"];
    const counts = {};
    for (const table of tables) {
        const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
        if (error) throw new Error(`Counting ${table} failed: ${error.message}`);
        counts[table] = count;
    }
    return counts;
}

function printList(heading, items) {
    if (!items.length) return;
    console.log(`\n${heading}`);
    items.forEach((item) => console.log(`  - ${item}`));
}

function printPlan(plan) {
    console.log("Rows to import:");
    console.table({
        employees: plan.employees.length,
        employee_rates: plan.rates.length,
        shifts: plan.shifts.length,
        shift_actuals: plan.actuals.length,
        time_off: plan.timeOff.length,
        closed_days: plan.closedDays.length,
    });
    printList("Must fix before importing:", plan.errors);
    printList("Skipped:", plan.warnings);
    printList("Worth a look:", plan.notes);
}

async function main() {
    const args = process.argv.slice(2);
    const write = args.includes("--write");
    const backupPath = args.find((arg) => !arg.startsWith("--"));
    if (!backupPath) {
        console.error("Usage: node scripts/import-wix-backup.mjs <backup.json> [--write]");
        process.exit(1);
    }

    const plan = buildImportPlan(JSON.parse(readFileSync(backupPath, "utf8")));
    printPlan(plan);

    if (plan.errors.length) {
        console.error("\nNothing was written. Fix the rows above in Wix, export again, and re-run.");
        process.exit(1);
    }
    if (!write) {
        console.log("\nDry run: nothing was written. Re-run with --write to import.");
        return;
    }

    try {
        process.loadEnvFile(".env");
    } catch {
        // Variables may already be set in the shell.
    }
    const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
        console.error("\nSet SUPABASE_URL and SUPABASE_SECRET_KEY in .env before using --write.");
        process.exit(1);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const removed = await writeImportPlan(supabase, plan);
    const removedTotal = Object.values(removed).reduce((sum, count) => sum + count, 0);
    if (removedTotal) {
        console.log("\nRemoved rows that are no longer in the backup:");
        console.table(removed);
    }
    console.log("\nImport finished. Rows now in Supabase:");
    console.table(await countRows(supabase));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`\n${error.message}`);
        process.exit(1);
    });
}
