// After a new deploy, a tab opened on the old build asks for code files that no longer exist
// (the admin screens load on demand). Reloading once fetches the new build; if the file still
// won't load, the router's error screen (AppCrash) offers a reload instead.

const RELOADED_KEY = "schedule.reloaded-for-new-build";

/** Whether this tab already reloaded for a missing file. Blocked storage counts as yes, so it can't loop. */
function alreadyReloaded(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return true;
    sessionStorage.setItem(RELOADED_KEY, "1");
    return false;
  } catch {
    return true;
  }
}

/**
 * The rejection handler for the admin screens' import(): reloads the page once (keeping the
 * loading screen up meanwhile), otherwise passes the error on to the error screen. Offline,
 * a reload would only show the browser's own error page, so the error goes straight through.
 */
export function reloadOnceForNewBuild(error: unknown): Promise<never> {
  if (!navigator.onLine || alreadyReloaded()) return Promise.reject(error);
  window.location.reload();
  return new Promise<never>(() => {});
}

/** Call when the admin screens' code has loaded, so a later deploy can reload once again. */
export function codeLoaded(): void {
  try {
    sessionStorage.removeItem(RELOADED_KEY);
  } catch {
    // Storage is blocked; nothing was stored.
  }
}
