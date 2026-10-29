import { useEffect, useId, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import {
  Check as CheckIcon,
  Clipboard as ClipboardIcon,
  X as XMarkIcon,
} from "lucide-react";
import {
  playbackErrorLines,
  playbackErrorText,
  type PlaybackError,
  type TrackListItem,
} from "@music-library/core";
import { usePlayer } from "../../context/Player";
import { copyText } from "../../lib/clipboard";
import { useCopiedFlag } from "../../lib/useCopiedFlag";
import { useDismiss } from "../../lib/useDismiss";
import { useTransitionMount } from "../../lib/useTransitionMount";
import { Button } from "../Button";

/** The playback error line's popover: what happened, above the track. */
export default function PlaybackErrorPopover({
  open,
  anchor,
  toggle,
  onClose,
}: {
  open: boolean;
  /** The now-playing block; the popover opens above it. */
  anchor: HTMLElement | null;
  /** The error line that opened it, which toggles it rather than dismissing. */
  toggle: HTMLElement | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  // Focus lands on Copy, past the lines: they describe the dialog, so a
  // screen reader reads them as focus enters.
  const linesId = useId();

  // Closing while focus is inside sends it back to the line the popover came
  // from, rather than dropping it with the popover. A click elsewhere closes
  // it too, and that click's own focus then wins.
  const close = () => {
    if (ref.current?.contains(document.activeElement)) toggle?.focus();
    onClose();
  };

  useDismiss(ref, {
    onDismiss: close,
    enabled: open,
    capture: true,
    ignore: (target) => !!toggle?.contains(target),
  });

  const { mounted, visible } = useTransitionMount(open, 180);

  // Portaled to the end of the page, it would be the last thing Tab reaches:
  // focus moves in as it opens, to its action, so Space and Enter stay there
  // rather than reaching the player's own keys. It goes back to the line
  // when the popover closes.
  useEffect(() => {
    if (visible) copyRef.current?.focus();
  }, [visible]);

  // Placed from the line's position at render; a window resize places it
  // again.
  const [, setResized] = useState(0);
  useEffect(() => {
    if (!open) return;
    const onResize = () => setResized((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  if (!mounted || !anchor) return null;

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(440, window.innerWidth - 24);
  const bottom = Math.max(12, window.innerHeight - rect.top + 8);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  // In a short window the details scroll under the heading, which stays put.
  const maxHeight = Math.max(120, window.innerHeight - bottom - 12);

  return createPortal(
    <div
      ref={ref}
      className="device-pop error-pop"
      data-closed={!visible || undefined}
      inert={visible ? undefined : ""}
      role="dialog"
      aria-label="Playback error"
      aria-describedby={linesId}
      style={{ bottom, left, width, maxHeight }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="device-pop-head">
        <span className="device-pop-title">Playback error</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="iconbtn device-pop-close"
          aria-label="Close playback error"
          onClick={close}
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>
      <PlaybackErrorDetails frozen={!open} copyRef={copyRef} linesId={linesId} />
    </div>,
    document.body,
  );
}

/**
 * What happened to the current track, line by line, and a button that copies
 * it for a bug report. Shared by the popover and the mini player's panel.
 */
export function PlaybackErrorDetails({
  frozen = false,
  copyRef,
  linesId,
}: {
  /** Closing: keep what was shown, even if another failure comes in. */
  frozen?: boolean;
  copyRef?: Ref<HTMLButtonElement>;
  /** An id for the lines, for whatever they describe. */
  linesId?: string;
}) {
  const { playbackError, current } = usePlayer();
  // Keeps the last failure, and the track it was on, on screen while the
  // popover or panel closes after it clears (another track may be loaded).
  const [last, setLast] = useState<{
    error: PlaybackError;
    track: TrackListItem | null;
  } | null>(null);
  // Frozen only once there's something to keep: a panel that opens already
  // on its way out still shows the failure.
  const live = frozen && last ? null : playbackError;
  if (live && live !== last?.error) setLast({ error: live, track: current });
  const shown = live ? { error: live, track: current } : last;
  const { copied, flash } = useCopiedFlag(2000);
  if (!shown) return null;

  const lines = playbackErrorLines(shown.error, shown.track);
  return (
    <div className="error-pop-body">
      <dl className="error-pop-lines" id={linesId}>
        {lines.map(({ label, value }) => (
          <div key={label} className="error-pop-line" data-label={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="error-pop-actions">
        <Button
          ref={copyRef}
          size="sm"
          onClick={async () => {
            if (await copyText(playbackErrorText(lines))) flash();
          }}
          leadingIcon={
            copied ? <CheckIcon className="size-3.5" /> : <ClipboardIcon className="size-3.5" />
          }
        >
          {copied ? "Copied" : "Copy details"}
        </Button>
      </div>
    </div>
  );
}
