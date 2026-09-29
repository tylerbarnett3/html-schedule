import { QueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

// Cached rows were fetched as whoever was signed in. Drop them on sign-out or when a
// different login signs in on the same device (e.g. a shared studio tablet).
let cachedUserId: string | null | undefined;
supabase.auth.onAuthStateChange((_event, session) => {
  const userId = session?.user.id ?? null;
  if (cachedUserId !== undefined && userId !== cachedUserId) queryClient.clear();
  cachedUserId = userId;
});
