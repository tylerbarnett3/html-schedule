import { useEffect, useRef } from "react";
import { Button } from "../../../components/Button";
import { Modal } from "../../../components/Modal";
import type { ISODate } from "../../../lib/types";
import {
  APPLY_HOURS_TITLE,
  applyHoursMessage,
  correctHoursText,
  correctHoursTitle,
  START_TODAY_TITLE,
  startTodayText,
} from "./hoursText";
import "./ApplyHoursDialog.css";

export type ApplyHoursChoice = "today" | "correct";

export interface ApplyHoursDialogProps {
  /** When the edited current hours started; null for the first set. */
  since: ISODate | null;
  today: ISODate;
  onChoose(choice: ApplyHoursChoice): void;
  /** Back to the editor; nothing is saved. */
  onBack(): void;
}

// The choices open where Save was just clicked, so the second half of a double-click
// must not pick one (as in ConfirmDialog).
const CLICK_GUARD_MS = 500;

/**
 * Asked on Save when the current hours were edited: do the new hours start today (the old
 * ones stay on record for past days) or correct every day since the current hours started?
 * Opens over the weekly editor.
 */
export function ApplyHoursDialog({ since, today, onChoose, onBack }: ApplyHoursDialogProps) {
  const openedAt = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => {
    openedAt.current = performance.now();
  }, []);
  const choose = (choice: ApplyHoursChoice) => {
    if (performance.now() - openedAt.current < CLICK_GUARD_MS) return;
    onChoose(choice);
  };

  return (
    <Modal
      open
      onClose={onBack}
      title={APPLY_HOURS_TITLE}
      size="sm"
      className="apply-hours-dialog"
      footer={
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      }
    >
      <p className="apply-hours-message">{applyHoursMessage(since)}</p>
      <div className="apply-hours-choices">
        <button type="button" className="apply-hours-choice" data-autofocus onClick={() => choose("today")}>
          <span className="apply-hours-choice-title">{START_TODAY_TITLE}</span>
          <span className="apply-hours-choice-text">{startTodayText(today)}</span>
        </button>
        <button type="button" className="apply-hours-choice" onClick={() => choose("correct")}>
          <span className="apply-hours-choice-title">{correctHoursTitle(since)}</span>
          <span className="apply-hours-choice-text">{correctHoursText(since)}</span>
        </button>
      </div>
    </Modal>
  );
}
