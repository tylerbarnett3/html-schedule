import { useId, useState } from "react";
import { EMPLOYEE_PALETTE, paletteIndex } from "../../../lib/employeePalette";
import { employeeCardPaint, employeeColor, employeeFill } from "../../schedule/employeeColor";
import "../../../components/Field.css";
// The preview card is drawn by the shift card's own rules (.day-card-shift and friends).
import "../../schedule/DayCard.css";
import "./ColorPicker.css";

export interface ColorPickerProps {
  /** The chosen color as stored (#RRGGBB in either case). */
  value: string;
  onChange(color: string): void;
  /** Shown on the preview card. */
  previewName: string;
  disabled?: boolean;
}

/** <input type="color"> only takes lowercase #rrggbb. */
function toColorInputValue(color: string): string {
  const hex = employeeColor(color).toLowerCase();
  if (hex.length === 4) return `#${[...hex.slice(1)].map((c) => c + c).join("")}`;
  return hex;
}

/**
 * The employee color (D6): the palette as named swatches (native radios, so the arrow
 * keys move between them) in the colors the theme shows, a Custom color, and a shift card
 * showing how the calendar will draw it.
 */
export function ColorPicker({ value, onChange, previewName, disabled = false }: ColorPickerProps) {
  const id = useId();
  const index = paletteIndex(value);
  // Custom stays chosen even when the custom color happens to match a swatch.
  const [customChosen, setCustomChosen] = useState(index === -1);
  const [custom, setCustom] = useState(() => toColorInputValue(value));
  const isCustom = customChosen || index === -1;
  const card = employeeCardPaint(value);

  const chooseCustom = (color: string) => {
    setCustomChosen(true);
    setCustom(color);
    onChange(color);
  };

  return (
    <fieldset className="color-picker" disabled={disabled}>
      <legend className="field-label color-picker-legend">Color</legend>
      <div className="color-picker-options">
        {EMPLOYEE_PALETTE.map((color, i) => (
          <label key={color.hex} className="color-picker-swatch" title={color.name}>
            <input
              type="radio"
              className="color-picker-radio"
              name={`${id}-color`}
              value={color.hex}
              checked={!isCustom && index === i}
              onChange={() => {
                setCustomChosen(false);
                onChange(color.hex);
              }}
            />
            <span className="color-picker-chip" style={{ background: employeeFill(color.hex) }} aria-hidden="true" />
            <span className="visually-hidden">{color.name}</span>
          </label>
        ))}
        <span className="color-picker-custom">
          <label className="color-picker-custom-choice">
            <input
              type="radio"
              className="color-picker-custom-radio"
              name={`${id}-color`}
              value="custom"
              checked={isCustom}
              onChange={() => chooseCustom(custom)}
            />
            <span>Custom</span>
          </label>
          <input
            type="color"
            className="color-picker-input"
            aria-label="Custom color"
            value={custom}
            onChange={(event) => chooseCustom(event.target.value)}
          />
        </span>
      </div>
      <div className="color-picker-preview">
        <div className={`color-picker-card ${card.className}`} style={card.style} aria-hidden="true">
          <span className="color-picker-card-name">{previewName.trim() || "New employee"}</span>
          <span className="color-picker-card-label">9:00 AM - 5:00 PM</span>
        </div>
        <p className="field-hint color-picker-summary">
          {/* A palette color shows its name only: its stored hex is an identity key, not the
              color shown. */}
          <span>
            {isCustom ? (
              <>
                Custom <span className="color-picker-hex">{toColorInputValue(value).toUpperCase()}</span>
              </>
            ) : (
              EMPLOYEE_PALETTE[index].name
            )}
          </span>
          {card.darkened ? (
            <span className="color-picker-note">Shift cards use a darker shade so the text stays readable.</span>
          ) : null}
        </p>
      </div>
    </fieldset>
  );
}
