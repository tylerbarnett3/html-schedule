// Shared bits of the Employee dialog and its rate editor.

import type { RateError } from "../../../lib/rates";

export type RateField = "rate" | "start" | "end";

/** The id of one rate period input, so the dialog can point at it after a failed check. */
export function rateFieldId(prefix: string, key: string, field: RateField): string {
  return `${prefix}-${key}-${field}`;
}

/** The inputs a rate error is about: [draft index, field] pairs, the one to focus first. */
export function rateErrorFields(error: RateError): [number, RateField][] {
  switch (error.kind) {
    case "invalid-rate":
      return [[error.index, "rate"]];
    case "invalid-date":
      return [
        [error.index, "start"],
        [error.index, "end"],
      ];
    case "end-before-start":
      return [
        [error.index, "end"],
        [error.index, "start"],
      ];
    case "overlap":
      return [
        [error.second, "start"],
        [error.second, "end"],
        [error.first, "start"],
        [error.first, "end"],
      ];
  }
}

let lastRateKey = 0;

/** React keys for rate periods; only need to be unique on the page. */
export function makeRateKey(): string {
  lastRateKey += 1;
  return `rate-${lastRateKey}`;
}
