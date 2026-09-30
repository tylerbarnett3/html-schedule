import { useId } from "react";
import { Button } from "../../../components/Button";
import "./PayrollOutput.css";

export interface PayrollOutputProps {
  /** The saved hours, one "- Name - 8 hours" line per employee; '' when there are none. */
  text: string;
  /** Unsaved changes or a save in progress: the output shows saved hours only. */
  stale: boolean;
  onCopy(): void;
}

/** The saved hours for the period, ready to paste into payroll. */
export function PayrollOutput({ text, stale, onCopy }: PayrollOutputProps) {
  const id = useId();
  const empty = text === "";
  const title = empty
    ? "No active employees to copy"
    : stale
      ? "Save your payroll changes before copying hours"
      : "Copy this pay period's saved actual hours";

  return (
    <section className="payroll-output" aria-labelledby={`${id}-title`}>
      <div className="payroll-output-header">
        <div>
          <h3 id={`${id}-title`} className="payroll-output-title">
            Payroll output
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
        className="payroll-output-text"
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
