// Creates and resets employee logins for the new schedule site.
//
// Usage:
//   node scripts/manage-logins.mjs list                                   show which employees have logins
//   node scripts/manage-logins.mjs create "<employee name>" <username>    create a login linked to the employee
//   node scripts/manage-logins.mjs reset <username>                       give an existing login a new password
//   node scripts/manage-logins.mjs admin <username>                       create an admin login (not an employee)
//
// New passwords are appended to employee-logins.txt (gitignored), never printed, so
// you can hand them out and then delete the file. Needs SUPABASE_URL and
// SUPABASE_SECRET_KEY in .env.
//
// Employees sign in with just the username. Supabase logins need an email address, so
// the username is stored as <username>@LOGIN_EMAIL_DOMAIN; no email is ever sent to it.
// Keep LOGIN_EMAIL_DOMAIN in sync with web/src/lib/auth.tsx.

import { appendFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const LOGIN_EMAIL_DOMAIN = "schedule.madpotter.invalid";
const PASSWORD_FILE = "employee-logins.txt";
const PASSWORD_WORDS = [
    "clay", "kiln", "glaze", "wheel", "slip", "bisque", "vase", "mug", "bowl", "plate",
    "stone", "ember", "amber", "cobalt", "coral", "maple", "cedar", "birch", "river", "meadow",
    "copper", "silver", "velvet", "canyon", "harbor", "summit", "lantern", "pebble", "orchard", "willow",
    "saffron", "indigo", "juniper", "thistle", "marble", "granite", "falcon", "otter", "heron", "badger",
];

function usernameToEmail(username) {
    return `${username}@${LOGIN_EMAIL_DOMAIN}`;
}

function checkUsername(username) {
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(username || "")) {
        throw new Error(
            `"${username}" isn't a valid username. Use 2-31 lowercase letters, numbers, dots, dashes or underscores.`,
        );
    }
}

function newPassword() {
    const words = Array.from({ length: 3 }, () => PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)]);
    return `${words.join("-")}-${randomInt(10, 100)}`;
}

function savePassword(label, username, password) {
    appendFileSync(PASSWORD_FILE, `${label}\tusername: ${username}\tpassword: ${password}\n`);
}

async function findUserByEmail(supabase, email) {
    for (let page = 1; ; page += 1) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(`Listing logins failed: ${error.message}`);
        const user = data.users.find((candidate) => candidate.email === email);
        if (user || data.users.length < 1000) return user ?? null;
    }
}

async function findEmployee(supabase, name) {
    const { data, error } = await supabase.from("employees").select("id, name, user_id, archived");
    if (error) throw new Error(`Reading employees failed: ${error.message}`);
    const wanted = name.trim().toLowerCase();
    const matches = data.filter((employee) => employee.name.trim().toLowerCase() === wanted);
    if (matches.length === 0) {
        const names = data.map((employee) => employee.name).sort().join(", ");
        throw new Error(`No employee named "${name}". Employees: ${names}`);
    }
    if (matches.length > 1) throw new Error(`More than one employee is named "${name}".`);
    return matches[0];
}

async function createLogin(supabase, username) {
    const password = newPassword();
    const { data, error } = await supabase.auth.admin.createUser({
        email: usernameToEmail(username),
        password,
        email_confirm: true,
    });
    if (error) throw new Error(`Creating the login failed: ${error.message}`);
    return { user: data.user, password };
}

async function list(supabase) {
    const { data, error } = await supabase
        .from("employees")
        .select("name, user_id, archived")
        .order("display_order");
    if (error) throw new Error(`Reading employees failed: ${error.message}`);
    const usernameById = new Map();
    for (let page = 1; ; page += 1) {
        const { data: users, error: usersError } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (usersError) throw new Error(`Listing logins failed: ${usersError.message}`);
        users.users.forEach((user) => usernameById.set(user.id, user.email?.split("@")[0]));
        if (users.users.length < 1000) break;
    }
    console.table(
        data.map((employee) => ({
            employee: employee.name,
            username: employee.user_id ? usernameById.get(employee.user_id) ?? "(unknown login)" : "",
            archived: employee.archived ? "yes" : "",
        })),
    );
}

async function create(supabase, name, username) {
    checkUsername(username);
    const employee = await findEmployee(supabase, name);
    if (employee.user_id) {
        throw new Error(`${employee.name} already has a login. Use "reset" to give them a new password.`);
    }
    const { user, password } = await createLogin(supabase, username);
    const { error } = await supabase.from("employees").update({ user_id: user.id }).eq("id", employee.id);
    if (error) {
        await supabase.auth.admin.deleteUser(user.id);
        throw new Error(`Linking the login to ${employee.name} failed: ${error.message}`);
    }
    savePassword(employee.name, username, password);
    console.log(`Created login "${username}" for ${employee.name}. Password saved to ${PASSWORD_FILE}.`);
    if (employee.archived) console.log(`Note: ${employee.name} is archived.`);
}

async function reset(supabase, username) {
    checkUsername(username);
    const user = await findUserByEmail(supabase, usernameToEmail(username));
    if (!user) throw new Error(`No login with username "${username}".`);
    const password = newPassword();
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
    if (error) throw new Error(`Setting the password failed: ${error.message}`);
    savePassword("(reset)", username, password);
    console.log(`New password for "${username}" saved to ${PASSWORD_FILE}.`);
}

async function admin(supabase, username) {
    checkUsername(username);
    const { user, password } = await createLogin(supabase, username);
    const { error } = await supabase.from("admins").insert({ user_id: user.id });
    if (error) {
        await supabase.auth.admin.deleteUser(user.id);
        throw new Error(`Making "${username}" an admin failed: ${error.message}`);
    }
    savePassword("(admin)", username, password);
    console.log(`Created admin login "${username}". Password saved to ${PASSWORD_FILE}.`);
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
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

    if (command === "list") return list(supabase);
    if (command === "create" && args.length === 2) return create(supabase, args[0], args[1]);
    if (command === "reset" && args.length === 1) return reset(supabase, args[0]);
    if (command === "admin" && args.length === 1) return admin(supabase, args[0]);
    throw new Error(
        'Usage: node scripts/manage-logins.mjs list | create "<employee name>" <username> | reset <username> | admin <username>',
    );
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
