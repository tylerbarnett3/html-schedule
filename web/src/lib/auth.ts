import { createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, type Tables } from "./supabase";

// Employees sign in with a username. Supabase logins need an email address, so the
// username is stored as <username>@LOGIN_EMAIL_DOMAIN; nothing is ever emailed there.
// Keep in sync with scripts/manage-logins.mjs.
const LOGIN_EMAIL_DOMAIN = "schedule.madpotter.invalid";

export function loginToEmail(login: string): string {
  const trimmed = login.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : `${trimmed}@${LOGIN_EMAIL_DOMAIN}`;
}

export type Profile = {
  employee: Tables<"employees"> | null;
  isAdmin: boolean;
};

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: Session; profile: Profile }
  // Logged in, but not an admin and not linked to an employee.
  | { status: "no-access"; session: Session }
  // Logged in, but loading who they are failed (offline, server error); retry() tries again.
  | { status: "error"; session: Session; retry(): void };

/** Provided by <AuthProvider> (src/lib/AuthProvider.tsx). */
export const AuthContext = createContext<AuthState>({ status: "loading" });

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export async function signIn(login: string, password: string): Promise<string | null> {
  const { error } = await supabase.auth.signInWithPassword({
    email: loginToEmail(login),
    password,
  });
  if (!error) return null;
  if (error.code === "invalid_credentials") return "That username and password don't match.";
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  return "Couldn't sign in. Check your connection and try again.";
}

// "local" ends only this device's session. The default ("global") would also sign the
// employee out on their phone when they sign out of the shared studio tablet.
export async function signOut(): Promise<void> {
  await supabase.auth.signOut({ scope: "local" });
}
