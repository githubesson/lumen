import { useId, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { errorMessage } from "../api";
import { Button } from "./Button";
import CoverArt from "./CoverArt";
import { DialogShell } from "./DialogShell";
import ErrorBanner from "./ErrorBanner";

/** The picture beside the subject's name. */
export type ConfirmArt =
  | { cover: string | null | undefined; label: string }
  /** A person without a picture: their initials, as the sidebar shows them. */
  | { person: string }
  | { icon: LucideIcon };

/** What the action happens to, shown as a card: its art, name and a detail. */
export interface ConfirmSubject {
  art: ConfirmArt;
  name: string;
  /** Artist · album, a track count, where it's from. */
  detail?: string;
}

export interface ConfirmOptions {
  /** The question, short: "Delete this playlist?". */
  title: string;
  /** What happens if they go ahead, in a sentence. */
  message: ReactNode;
  subject?: ConfirmSubject;
  /** The confirming button, a verb for what it does ("Delete"). */
  confirmLabel: string;
  confirmIcon?: LucideIcon;
  /**
   * Run from the dialog, for an opener that's gone by the time it finishes
   * (a menu closes as the dialog opens). The dialog stays open and busy until
   * it settles and shows the error if it throws, so the answer is only true
   * once it has succeeded.
   */
  action?: () => Promise<unknown>;
  /** The confirming button while `action` runs ("Deleting…"). */
  busyLabel?: string;
  /** Shown when `action` throws without a message of its own. */
  errorFallback?: string;
}

export interface ConfirmRequest {
  id: number;
  options: ConfirmOptions;
}

/**
 * One question at a time, shaped like the share page's card: the subject as
 * a card, the question under it, and the answers side by side below.
 */
export function ConfirmDialog({
  open,
  request,
  onSettle,
}: {
  open: boolean;
  /** Kept through the closing fade, so the text doesn't vanish as it goes. */
  request: ConfirmRequest | null;
  onSettle: (id: number, confirmed: boolean) => void;
}) {
  const titleId = useId();
  const subjectId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each question starts idle, without the last one's error.
  const [shownId, setShownId] = useState(request?.id);
  if (request?.id !== shownId) {
    setShownId(request?.id);
    setBusy(false);
    setError(null);
  }

  // The same closed shell the first question opens, so it animates in.
  if (!request) return <DialogShell open={false} onClose={() => {}}>{null}</DialogShell>;
  const { id, options } = request;
  const { title, message, subject, confirmLabel, confirmIcon: ConfirmIcon, action, busyLabel, errorFallback } = options;

  const go = async () => {
    if (busy) return;
    if (!action) {
      onSettle(id, true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action();
      onSettle(id, true);
    } catch (err) {
      setError(errorMessage(err, errorFallback ?? "Something went wrong."));
      setBusy(false);
    }
  };

  // Ignored mid-action: the dialog is where its result or error shows up.
  const cancel = () => {
    if (!busy) onSettle(id, false);
  };

  return (
    <DialogShell
      open={open}
      role="alertdialog"
      labelledBy={titleId}
      // What it happens to (the card), then what happens.
      describedBy={subject ? `${subjectId} ${messageId}` : messageId}
      // The safe answer, so a stray Enter doesn't go ahead.
      initialFocus={cancelRef}
      onClose={cancel}
      maxWidth={400}
      footer={
        <div className="confirm-actions">
          <Button ref={cancelRef} onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void go()}
            disabled={busy}
            leadingIcon={ConfirmIcon && <ConfirmIcon className="size-4" aria-hidden />}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="confirm-body">
        {subject && <SubjectCard id={subjectId} subject={subject} />}
        <div className="confirm-text">
          <h2 id={titleId} className="confirm-title">{title}</h2>
          <p id={messageId} className="confirm-message">{message}</p>
        </div>
        {error && <ErrorBanner message={error} />}
      </div>
    </DialogShell>
  );
}

function SubjectCard({ id, subject: { art, name, detail } }: { id: string; subject: ConfirmSubject }) {
  return (
    <div className="confirm-subject">
      {"cover" in art ? (
        <CoverArt className="confirm-subject-art" src={art.cover} label={art.label} />
      ) : "person" in art ? (
        <span className="confirm-subject-art confirm-subject-tile" aria-hidden="true">
          {art.person.slice(0, 2).toUpperCase()}
        </span>
      ) : (
        <span className="confirm-subject-art confirm-subject-tile">
          <art.icon className="size-5" aria-hidden />
        </span>
      )}
      <div id={id} className="confirm-subject-text">
        <div className="confirm-subject-name">{name}</div>
        {detail && <div className="confirm-subject-detail">{detail}</div>}
      </div>
    </div>
  );
}
