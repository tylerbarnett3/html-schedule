// Reading Supabase errors. supabase-js hands back plain objects ({ message, code, details })
// for database errors and network failures alike, so everything here is duck-typed.

// Chrome, Firefox, Safari and Node word a failed fetch differently.
export const NETWORK_ERROR = /failed to fetch|fetch failed|networkerror|load failed|network request failed/i;

export function errorFields(error: unknown): { message: string; code: string; details: string } {
  if (typeof error !== "object" || error === null) return { message: "", code: "", details: "" };
  return {
    message: "message" in error && typeof error.message === "string" ? error.message : "",
    code: "code" in error && typeof error.code === "string" ? error.code : "",
    details: "details" in error && typeof error.details === "string" ? error.details : "",
  };
}

export type AdminErrorCode =
  | "not_admin"
  | "closed_day"
  | "pending_request"
  | "day_off_overlap"
  | "request_locked"
  | "not_editable"
  | "not_found"
  | "request_not_pending"
  | "undo_stale"
  | "duplicate_name"
  | "invalid_input"
  | "duplicate" // 23505
  | "check_failed" // 23514
  | "overlap" // 23P01
  | "network"
  | "auth_expired"
  | "unknown";

// The admin database functions raise these words as the whole message (migration 004).
const TOKENS: readonly AdminErrorCode[] = [
  "not_admin",
  "closed_day",
  "pending_request",
  "day_off_overlap",
  "request_locked",
  "not_editable",
  "not_found",
  "request_not_pending",
  "undo_stale",
  "duplicate_name",
  "invalid_input",
];

// Several tokens share a SQLSTATE (day_off_overlap is 23P01, duplicate_name is 23505), so the
// message is read first and the code only when the message isn't one of ours.
const SQLSTATES: Readonly<Record<string, AdminErrorCode>> = {
  "23505": "duplicate",
  "23514": "check_failed",
  "23P01": "overlap",
  "42501": "not_admin", // row-level security refused a plain table write
  "22023": "invalid_input",
};

export function adminErrorCode(error: unknown): AdminErrorCode {
  const { message, code } = errorFields(error);
  const token = TOKENS.find((t) => t === message.trim());
  if (token) return token;
  const byCode = SQLSTATES[code];
  if (byCode) return byCode;
  if (NETWORK_ERROR.test(message)) return "network";
  if (code === "PGRST301" || code === "PGRST303" || /jwt/i.test(message)) return "auth_expired";
  return "unknown";
}

const MESSAGES: Partial<Record<AdminErrorCode, string>> = {
  network: "Couldn't reach the schedule. Check your connection and try again.",
  auth_expired: "Your sign-in has expired. Sign out, then sign in again.",
  not_admin: "Only an admin can make this change.",
  not_found: "This item was changed or removed. The page has been refreshed.",
  request_not_pending: "This request was already reviewed or removed.",
  undo_stale: "This change can't be undone because the schedule changed since.",
};

/** The shared wording for errors any admin action can hit; anything else gets `fallback`. */
export function adminErrorMessage(error: unknown, fallback: string): string {
  return MESSAGES[adminErrorCode(error)] ?? fallback;
}

// Rejections the admin pages report as information, not failures: nothing the admin saved
// was lost. A stale undo is dropped from the stack (§6); a request someone else already
// reviewed just refreshes the drawer (R10).
const INFO_OUTCOMES: ReadonlySet<AdminErrorCode> = new Set<AdminErrorCode>(["undo_stale", "request_not_pending"]);

/**
 * Codes a calendar edit reports as info rather than failure: the row was changed or removed
 * elsewhere and the page has been refreshed. The calendar mutations carry them as
 * `meta.infoCodes`, so the Save indicator agrees with the toast.
 */
export const SCHEDULE_INFO_CODES: readonly AdminErrorCode[] = ["not_found"];

/** True when a failed write is shown as an info toast rather than an error (the Save indicator ignores it). */
export function isInfoOutcome(error: unknown): boolean {
  return INFO_OUTCOMES.has(adminErrorCode(error));
}
