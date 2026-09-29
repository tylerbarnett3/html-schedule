import "./Spinner.css";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Announced to screen readers; shown under the ring when `showLabel` is set. */
  label?: string;
  showLabel?: boolean;
  /** Hide from assistive tech, e.g. inside a button whose text already says what's happening. */
  decorative?: boolean;
  className?: string;
}

export function Spinner({
  size = "md",
  label = "Loading...",
  showLabel = false,
  decorative = false,
  className,
}: SpinnerProps) {
  const classes = ["spinner", `spinner-${size}`, className].filter(Boolean).join(" ");
  if (decorative) {
    return (
      <span className={classes} aria-hidden="true">
        <span className="spinner-ring" />
      </span>
    );
  }
  return (
    <span className={classes} role="status">
      <span className="spinner-ring" aria-hidden="true" />
      <span className={showLabel ? "spinner-label" : "visually-hidden"}>{label}</span>
    </span>
  );
}
