export type PayrollRowField = "employee" | "start" | "end" | "note";

/** Element id of one of a row's controls, so the page can focus the one a save needs fixed. */
export function payrollFieldId(idPrefix: string, key: string, field: PayrollRowField): string {
  return `${idPrefix}-${key}-${field}`;
}
