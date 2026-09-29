import type { Tables } from "./supabase";

/** A calendar date as 'YYYY-MM-DD', exactly as Postgres `date` columns come back. */
export type ISODate = string;
/** A time of day as 'HH:MM:SS' (Postgres `time`); 'HH:MM' is also accepted. */
export type PgTime = string;

export type { DayPeriod, RequestStatus } from "./supabase";
export type TimeOffSource = "request" | "assigned";

export type Employee = Pick<Tables<"employees">, "id" | "name" | "color" | "display_order" | "archived">;
export type Shift = Pick<Tables<"shifts">, "id" | "employee_id" | "shift_date" | "start_time" | "end_time">;
export type TimeOff = Pick<
  Tables<"time_off">,
  "id" | "employee_id" | "off_date" | "period" | "status" | "requested_at"
> & { source: TimeOffSource };
export type Availability = Pick<
  Tables<"availability">,
  "id" | "employee_id" | "available_date" | "period" | "status" | "requested_at"
>;

/** Inclusive date range; start <= end. */
export type DateRange = { start: ISODate; end: ISODate };

/** Result of submitting a request for several dates at once. */
export type RequestResult = { submitted: ISODate[]; skipped: ISODate[] };

export const DEFAULT_EMPLOYEE_COLOR = "#7F6C50";
export const BUSINESS_TIME_ZONE = "America/New_York";
