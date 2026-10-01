import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { AuthContext, type AuthState, type Profile } from "./auth";
import { supabase } from "./supabase";

// PostgREST's "no such function": the database doesn't have can_edit_payroll yet
// (20260930000003_payroll_access.sql not applied), so only admins have payroll.
const MISSING_FUNCTION = "PGRST202";

async function loadProfile(session: Session): Promise<Profile> {
  const [admin, employee, payroll] = await Promise.all([
    supabase.rpc("is_admin"),
    supabase.from("employees").select("*").eq("user_id", session.user.id).maybeSingle(),
    supabase.rpc("can_edit_payroll"),
  ]);
  if (admin.error) throw admin.error;
  if (employee.error) throw employee.error;
  if (payroll.error && payroll.error.code !== MISSING_FUNCTION) throw payroll.error;
  return {
    isAdmin: admin.data,
    employee: employee.data,
    canEditPayroll: admin.data || (!payroll.error && payroll.data === true),
  };
}

const RETRY_DELAY_MS = 1000;

/** Tries twice, like the data queries (retry: 1), so a single blip doesn't need a click. */
async function loadProfileWithRetry(session: Session): Promise<Profile> {
  try {
    return await loadProfile(session);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return loadProfile(session);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let current = true;
    // Bumped by every auth event. A profile load that finishes after a newer event is
    // dropped, so a slow load can't sign someone back in after they signed out.
    let latest = 0;
    // Whose profile is on screen. Supabase re-sends SIGNED_IN each time the tab becomes
    // visible; the same person doesn't need a reload (and a flaky connection at that
    // moment would otherwise turn a working login into the no-access page).
    let loadedUserId: string | null = null;

    const apply = async (session: Session | null) => {
      const run = ++latest;
      if (!session) {
        loadedUserId = null;
        if (current) setState({ status: "signed-out" });
        return;
      }
      if (session.user.id === loadedUserId) return;

      let next: AuthState;
      let loaded = false;
      try {
        const profile = await loadProfileWithRetry(session);
        loaded = true;
        next =
          profile.isAdmin || profile.employee
            ? { status: "signed-in", session, profile }
            : { status: "no-access", session };
      } catch {
        // Not "no-access": that page tells a real employee to go ask their manager.
        next = { status: "error", session, retry: () => retry(session) };
      }
      if (!current || run !== latest) return;
      // A failed load isn't remembered, so the next SIGNED_IN (the tab coming back) retries it.
      loadedUserId = loaded ? session.user.id : null;
      setState(next);
    };

    const retry = (session: Session) => {
      if (!current) return;
      setState({ status: "loading" });
      void apply(session);
    };

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // Token refreshes don't change who is signed in, so skip reloading the profile.
      if (event === "TOKEN_REFRESHED") return;
      // Supabase warns against awaiting other Supabase calls inside this callback.
      setTimeout(() => void apply(session), 0);
    });

    return () => {
      current = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
