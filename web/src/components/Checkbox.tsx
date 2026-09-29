import type { InputHTMLAttributes, ReactNode } from "react";
import "./Checkbox.css";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  /** "card" is the old sidebar toggle row; "plain" is just the box and label. */
  appearance?: "card" | "plain";
}

/** Native checkbox with the old page's square clay check, wrapped in its label. */
export function Checkbox({ label, appearance = "card", className, ...inputProps }: CheckboxProps) {
  const classes = ["checkbox", `checkbox-${appearance}`, className].filter(Boolean).join(" ");
  return (
    <label className={classes}>
      <input type="checkbox" className="checkbox-input" {...inputProps} />
      <span className="checkbox-label">{label}</span>
    </label>
  );
}
