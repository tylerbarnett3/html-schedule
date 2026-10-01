import { useId } from "react";
import { Button } from "../../../components/Button";
import { usePersistentState } from "../../../data/usePersistentState";
import "./PayrollOutput.css";

// Starts collapsed; opening or closing it is remembered on this device.
const OPEN_KEY = "payroll.outputOpen.v1";

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export interface PayrollOutputProps {
  /** The saved hours, one "- Name - 8 hours" line per employee; '' when there are none. */
  text: string;
  /** Unsaved changes or a save in progress: the output shows saved hours only. */
  stale: boolean;
  onCopy(): void;
}

/**
 * The saved hours for the period, ready to paste into payroll. The list collapses under its
 * title; Copy works either way.
 */
export function PayrollOutput({ text, stale, onCopy }: PayrollOutputProps) {
  const id = useId();
  const [open, setOpen] = usePersistentState(OPEN_KEY, false, isBoolean);
  const empty = text === "";
  const title = empty
    ? "No active employees to copy"
    : stale
      ? "Save your payroll changes before copying hours"
      : "Copy this pay period's saved actual hours";

  return (
    <section className="payroll-output" data-open={open} aria-labelledby={`${id}-title`}>
      <div className="payroll-output-header">
        <div>
          <h3 className="payroll-output-heading">
            <button
              type="button"
              className="payroll-output-toggle"
              aria-expanded={open}
              aria-controls={`${id}-text`}
              onClick={() => setOpen(!open)}
            >
              <span className="payroll-output-chevron" aria-hidden="true">
                ▼
              </span>
              <span id={`${id}-title`} className="payroll-output-title">
                Payroll output
              </span>
            </button>
          </h3>
          <p id={`${id}-description`} className="payroll-output-description">
            {stale ? "Save changes to update this output." : "Saved actual hours for this pay period."}
          </p>
        </div>
        <Button variant="secondary" disabled={empty || stale} title={title} onClick={onCopy}>
          Copy payroll hours
        </Button>
      </div>
      <pre
        id={`${id}-text`}
        className="payroll-output-text"
        hidden={!open}
        tabIndex={0}
        role="region"
        aria-label="Payroll hours"
        aria-describedby={`${id}-description`}
      >
        {empty ? "No active employees." : text}
      </pre>
    </section>
  );
}
