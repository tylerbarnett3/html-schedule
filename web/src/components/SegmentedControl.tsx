import { useId, useRef, type KeyboardEvent } from "react";
import "./Field.css";
import "./SegmentedControl.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group; shown above it unless hideLabel is set. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * One-of-N choice drawn as segments (Shift | Day Off | Closed). A radio group: Tab reaches
 * the chosen segment only, and the arrow keys (plus Home/End) move the choice.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  hideLabel = false,
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  const labelId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((option) => option.value === value);
  // With nothing chosen, the first segment takes the tab stop.
  const tabStop = selected === -1 ? 0 : selected;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  };

  return (
    <div className={["segmented-field", className].filter(Boolean).join(" ")}>
      <span id={labelId} className={hideLabel ? "visually-hidden" : "field-label"}>
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} aria-disabled={disabled || undefined} className="segmented">
        {options.map((option, index) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === tabStop ? 0 : -1}
              disabled={disabled}
              className="segmented-option"
              onClick={() => {
                if (!checked) onChange(option.value);
              }}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
