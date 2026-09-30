import { useId, type ReactNode } from "react";
import { Button, type ButtonVariant } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import {
  approvedOnText,
  REQUEST_KIND_LABELS,
  requestedOnText,
  requestItemDetail,
  type RequestEntry,
  type RequestGroup,
  type RequestItem,
  type RequestKind,
} from "../../../lib/adminRequests";
import type { RequestReview, ReviewAction } from "./useRequestReview";
import "./RequestList.css";

export type RequestListProps =
  | { variant: "pending"; entries: readonly RequestEntry[]; review: RequestReview; onDone(): void }
  | { variant: "approved"; items: readonly RequestItem[]; review: RequestReview; onDone(): void };

/** The cards in one tab of the Requests drawer. */
export function RequestList(props: RequestListProps) {
  const empty = props.variant === "pending" ? props.entries.length === 0 : props.items.length === 0;
  if (empty) return <p className="requests-empty">No requests</p>;

  // Tell the drawer when a card went away, so it can put focus back on the tab (a removed
  // button leaves focus nowhere).
  const act = async (action: Promise<boolean>) => {
    if (await action) props.onDone();
  };

  return (
    <ul className="requests-list">
      {props.variant === "pending"
        ? props.entries.map((entry) =>
            entry.type === "single" ? (
              <PendingCard key={entry.item.id} item={entry.item} review={props.review} act={act} />
            ) : (
              <GroupCard key={entry.group.key} group={entry.group} review={props.review} act={act} />
            ),
          )
        : props.items.map((item) => <ApprovedCard key={item.id} item={item} review={props.review} act={act} />)}
    </ul>
  );
}

type CardProps = { review: RequestReview; act(action: Promise<boolean>): Promise<void> };

/** What's running on any of these requests, if anything. */
function busyAction(review: RequestReview, items: readonly RequestItem[]): ReviewAction | undefined {
  for (const item of items) {
    const action = review.busy.get(item.id);
    if (action) return action;
  }
  return undefined;
}

function PendingCard({ item, review, act }: CardProps & { item: RequestItem }) {
  const ids = useCardIds();
  const busy = busyAction(review, [item]);
  return (
    <li className={`request-card request-card-${item.kind}`}>
      <CardHeader ids={ids} name={item.employeeName} archived={item.archived} requestedAt={item.requestedAt} />
      <p id={ids.detail} className="request-card-detail">
        <KindPill kind={item.kind} />
        <span>{requestItemDetail(item)}</span>
      </p>
      <Flags past={item.past} closed={item.closed} />
      <div className="request-card-actions">
        {/* Nothing can be approved on a closed day (R6). */}
        {item.closed ? null : (
          <ActionButton
            ids={ids}
            busy={busy}
            action="approve"
            variant="success"
            onClick={() => void act(review.approve([item]))}
          >
            Approve
          </ActionButton>
        )}
        <ActionButton
          ids={ids}
          busy={busy}
          action="deny"
          variant="danger"
          onClick={() => void act(review.deny([item]))}
        >
          Deny
        </ActionButton>
      </div>
    </li>
  );
}

function GroupCard({ group, review, act }: CardProps & { group: RequestGroup }) {
  const ids = useCardIds();
  const busy = busyAction(review, group.items);
  const count = group.items.length;
  return (
    <li className={`request-card request-card-${group.kind} request-card-group`}>
      <CardHeader ids={ids} name={group.employeeName} archived={group.archived} requestedAt={group.requestedAt} />
      <div id={ids.detail}>
        <p className="request-card-detail">
          <KindPill kind={group.kind} />
          <span>{count} days</span>
        </p>
        <ul className="request-group-days">
          {group.items.map((item) => (
            <li key={item.id}>
              {requestItemDetail(item)}
              {item.past ? <span className="request-flag request-flag-inline">Past date</span> : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="request-card-actions request-card-actions-stacked">
        <ActionButton
          ids={ids}
          busy={busy}
          action="approve"
          variant="success"
          onClick={() => void act(review.approve(group.items))}
        >
          Approve all {count} days
        </ActionButton>
        <ActionButton
          ids={ids}
          busy={busy}
          action="deny"
          variant="danger"
          onClick={() => void act(review.deny(group.items))}
        >
          Deny all
        </ActionButton>
      </div>
    </li>
  );
}

function ApprovedCard({ item, review, act }: CardProps & { item: RequestItem }) {
  const ids = useCardIds();
  const busy = busyAction(review, [item]);
  const approvedOn = approvedOnText(item.reviewedAt);
  return (
    <li className={`request-card request-card-${item.kind}`}>
      <CardHeader ids={ids} name={item.employeeName} archived={item.archived} requestedAt={item.requestedAt} />
      <p id={ids.detail} className="request-card-detail">
        <KindPill kind={item.kind} />
        <span>{requestItemDetail(item)}</span>
      </p>
      {approvedOn ? <p className="request-card-approved">{approvedOn}</p> : null}
      <div className="request-card-actions">
        <ActionButton
          ids={ids}
          busy={busy}
          action="remove"
          variant="ghost"
          onClick={() => void act(review.remove(item))}
        >
          Remove
        </ActionButton>
      </div>
    </li>
  );
}

type CardIds = { name: string; detail: string };

function useCardIds(): CardIds {
  const id = useId();
  return { name: `${id}-name`, detail: `${id}-detail` };
}

function CardHeader({
  ids,
  name,
  archived,
  requestedAt,
}: {
  ids: CardIds;
  name: string;
  archived: boolean;
  requestedAt: string;
}) {
  return (
    <div className="request-card-head">
      <p id={ids.name} className="request-card-name">
        {name}
        {archived ? <span className="request-card-archived"> (archived)</span> : null}
      </p>
      <p className="request-card-requested">{requestedOnText(requestedAt)}</p>
    </div>
  );
}

function KindPill({ kind }: { kind: RequestKind }) {
  return <span className="request-pill">{REQUEST_KIND_LABELS[kind]}</span>;
}

function Flags({ past, closed }: { past: boolean; closed: boolean }) {
  if (!past && !closed) return null;
  return (
    <p className="request-flags">
      {closed ? <span className="request-flag request-flag-closed">Closed</span> : null}
      {past ? <span className="request-flag">Past date</span> : null}
    </p>
  );
}

/**
 * Approve / Deny / Remove. The buttons name the request through aria-describedby. While the
 * card is busy they are aria-disabled rather than disabled, so keyboard focus stays put
 * (the hook ignores the extra clicks).
 */
function ActionButton({
  ids,
  busy,
  action,
  variant,
  onClick,
  children,
}: {
  ids: CardIds;
  busy: ReviewAction | undefined;
  action: ReviewAction;
  variant: ButtonVariant;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      className={`request-action request-action-${action}`}
      aria-describedby={`${ids.name} ${ids.detail}`}
      aria-disabled={busy ? true : undefined}
      aria-busy={busy === action ? true : undefined}
      onClick={busy ? undefined : onClick}
    >
      {busy === action ? <Spinner size="sm" decorative /> : null}
      {children}
    </Button>
  );
}
