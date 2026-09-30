// Gives every active employee a different color from the employee palette, so the
// calendar can tell them apart (they all started out the same brown).
//
// Usage:
//   node scripts/assign-colors.mjs            show the plan; changes nothing
//   node scripts/assign-colors.mjs --write    save the new colors
//
// The palette and the rule live in web/src/lib/employeePalette.ts, the same file the
// admin page uses for new employees: in display order, the first employee using a
// palette color keeps it, and everyone else gets the next unused color. Archived
// employees are left alone. Running it again after --write changes nothing.
//
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env (or in the shell, which wins), and
// Node 22.18 or later, which can load the TypeScript palette file directly.

import { createClient } from "@supabase/supabase-js";

const MIN_NODE = "22.18";

function nodeCanLoadTypeScript() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

async function loadPalette() {
    if (!nodeCanLoadTypeScript()) {
        throw new Error(
            `This script needs Node ${MIN_NODE} or later (this is Node ${process.versions.node}), ` +
                "because it loads web/src/lib/employeePalette.ts directly. Update Node and try again.",
        );
    }
    try {
        return await import(new URL("../web/src/lib/employeePalette.ts", import.meta.url).href);
    } catch (error) {
        throw new Error(
            `Loading web/src/lib/employeePalette.ts failed: ${error.message}\n` +
                `Node ${MIN_NODE} or later can load TypeScript files; this is Node ${process.versions.node}.`,
        );
    }
}

async function readEmployees(supabase) {
    // Same order as the app's employee list.
    const { data, error } = await supabase
        .from("employees")
        .select("id, name, color, archived")
        .order("display_order")
        .order("created_at", { ascending: false })
        .order("name")
        .order("id");
    if (error) throw new Error(`Reading employees failed: ${error.message}`);
    return data;
}

function colorLabel(palette, color) {
    const name = palette.paletteColorName(color);
    return name ? `${color} (${name})` : color;
}

async function main() {
    const args = process.argv.slice(2);
    const write = args.includes("--write");
    if (args.some((arg) => arg !== "--write")) {
        throw new Error("Usage: node scripts/assign-colors.mjs [--write]");
    }
    const palette = await loadPalette();

    try {
        process.loadEnvFile(".env");
    } catch {
        // Variables may already be set in the shell.
    }
    const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
        throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env first.");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log(`Database: ${new URL(SUPABASE_URL).host}`);

    const employees = await readEmployees(supabase);
    const active = employees.filter((employee) => !employee.archived);
    const byId = new Map(active.map((employee) => [employee.id, employee]));
    const plan = palette
        .assignDistinctColors(active.map(({ id, color }) => ({ id, color })))
        .map(({ id, color }) => ({ employee: byId.get(id), color }));
    const changes = plan.filter(({ employee, color }) => employee.color !== color);

    console.table(
        plan.map(({ employee, color }) => ({
            employee: employee.name,
            now: colorLabel(palette, employee.color),
            new: employee.color === color ? "(keeps it)" : colorLabel(palette, color),
        })),
    );
    const skipped = employees.length - active.length;
    if (skipped > 0) console.log(`Skipped ${skipped} archived employee${skipped === 1 ? "" : "s"}.`);

    if (changes.length === 0) {
        console.log("Every active employee already has a different color. Nothing to change.");
        return;
    }
    if (!write) {
        console.log(
            `${changes.length} employee${changes.length === 1 ? "" : "s"} would get a new color. ` +
                "Run again with --write to save.",
        );
        return;
    }

    // One update per employee. If one fails, the others are kept; running the script
    // again finishes the job, because employees who already have their color are skipped.
    let saved = 0;
    for (const { employee, color } of changes) {
        const { data, error } = await supabase.from("employees").update({ color }).eq("id", employee.id).select("id");
        if (error) throw new Error(`Saving the color for ${employee.name} failed: ${error.message} (${saved} saved before this)`);
        if (data.length === 0) {
            console.log(`${employee.name} no longer exists; skipped.`);
            continue;
        }
        saved += 1;
    }
    console.log(`Saved new colors for ${saved} employee${saved === 1 ? "" : "s"}.`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
