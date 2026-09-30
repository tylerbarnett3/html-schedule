import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import { hoursChangeLabel, hoursLines, sidebarHours, type HoursSet } from "../../lib/hours";
import type { ISODate } from "../../lib/types";
import { SidebarDrawer } from "./SidebarDrawer";
import "./BusinessHoursDrawer.css";

export interface BusinessHoursDrawerProps {
  /** Undefined while loading. */
  sets: readonly HoursSet[] | undefined;
  /** Loading failed and there is nothing to show (also while it is being tried again). */
  failed: boolean;
  /** A failed load is being tried again: Retry stays in place (and keeps focus), marked busy. */
  retrying?: boolean;
  onRetry?(): void;
  today: ISODate;
  /** Admin page only: shows Set Hours / Edit Hours and the empty, loading and error states. */
  onEdit?(): void;
}

/** One set's seven days, Monday first. */
function HoursList({ set }: { set: HoursSet }) {
  return (
    <dl className="business-hours-list">
      {hoursLines(set).map((line) => (
        <Fragment key={line.weekday}>
          <dt className="business-hours-day">{line.day}</dt>
          <dd className="business-hours-hours">
            <span className="business-hours-time">{line.open}</span> -{" "}
            <span className="business-hours-time">{line.close}</span>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * The sidebar's read-only "Business Hours" section: the hours in effect today, then each
 * upcoming change under "From Nov 1:". Employees only see it once hours exist; the admin
 * always does (AM1), with the button that opens the weekly editor.
 */
export function BusinessHoursDrawer({ sets, failed, retrying = false, onRetry, today, onEdit }: BusinessHoursDrawerProps) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const retryFocused = useRef(false);
  const admin = onEdit !== undefined;
  const loaded = sets !== undefined;
  const hours = sets ? sidebarHours(sets, today) : null;

  // The hours loaded and replaced the Retry button that had focus: Set Hours / Edit Hours
  // takes it, so the keyboard doesn't drop back to the top of the page.
  useEffect(() => {
    if (!loaded || !retryFocused.current) return;
    retryFocused.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      contentRef.current?.querySelector<HTMLButtonElement>(".business-hours-edit")?.focus();
    }
  }, [loaded]);

  if (!admin && !hours) return null;

  let body;
  if (hours) {
    body = (
      <>
        <HoursList set={hours.current} />
        {hours.upcoming.map((set) =>
          set.startsOn === null ? null : (
            <Fragment key={set.startsOn}>
              <h3 className="business-hours-change">{hoursChangeLabel(set.startsOn, today)}:</h3>
              <HoursList set={set} />
            </Fragment>
          ),
        )}
      </>
    );
  } else if (sets) {
    body = <p className="business-hours-empty">No business hours yet.</p>;
  } else if (failed) {
    body = (
      <div className="business-hours-status">
        {/* A new alert after each failed try, so a retry that fails again is announced. */}
        <p
          key={retrying ? "retrying" : "failed"}
          className="business-hours-error"
          role={retrying ? undefined : "alert"}
        >
          Couldn't load the business hours.
        </p>
        <Button
          variant="secondary"
          size="sm"
          className={retrying ? "business-hours-working" : undefined}
          aria-disabled={retrying || undefined}
          onClick={retrying ? undefined : onRetry}
          onFocus={() => {
            retryFocused.current = true;
          }}
          onBlur={() => {
            retryFocused.current = false;
          }}
        >
          {retrying ? <Spinner size="sm" decorative /> : null}
          Retry
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="business-hours-status">
        <Spinner size="sm" label="Loading hours..." />
      </div>
    );
  }

  return (
    <SidebarDrawer title="Business Hours" open={open} onOpenChange={setOpen}>
      <div ref={contentRef} className="business-hours">
        {body}
        {/* Always the last child, so the same button goes from Set Hours to Edit Hours after
            the first save and keeps focus when the editor closes. */}
        {admin && sets ? (
          <Button
            key="hours-edit"
            variant={hours ? "secondary" : "primary"}
            className="business-hours-edit"
            aria-haspopup="dialog"
            onClick={onEdit}
          >
            {hours ? "Edit Hours" : "Set Hours"}
          </Button>
        ) : null}
      </div>
    </SidebarDrawer>
  );
}
