import { useState } from "react";
import { useToast } from "../components/useToast";
import { signOut } from "../lib/auth";
import { supabase } from "../lib/supabase";

/** Signs out and tells the user when it didn't work. Routing reacts to the auth state change. */
export function useSignOut(): { signingOut: boolean; signOut(): void } {
  const toast = useToast();
  const [signingOut, setSigningOut] = useState(false);

  const run = async () => {
    setSigningOut(true);
    await signOut();
    // signOut() usually drops the local session even when the request fails, but not
    // always, so check before assuming the user is signed out.
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      setSigningOut(false);
      toast.show("Couldn't sign out. Check your connection and try again.", "error");
    }
  };

  return { signingOut, signOut: () => void run() };
}
