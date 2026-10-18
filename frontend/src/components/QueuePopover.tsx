import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Music as MusicalNoteIcon, X as XMarkIcon } from "lucide-react";
import { queueProgress } from "@music-library/core";
import { trackCoverUrl, type TrackListItem } from "../api";
import { usePlayer, usePlayerControls, useRemotePlayback } from "../context/Player";
import { displayText } from "../lib/format";
import { useDismiss } from "../lib/useDismiss";
import { useTransitionMount } from "../lib/useTransitionMount";
import CoverArt from "./CoverArt";
import {
  useContextMenuClickGuard,
  useTrackContextMenu,
} from "../lib/useTrackContextMenu";

type BindTrackContext = ReturnType<typeof useTrackContextMenu>["bind"];

interface Props {
  open: boolean;
  /** Element the popover anchors above; usually the queue button. */
  anchor: HTMLElement | null;
  onClose: () => void;
}

/**
 * Upcoming-tracks list anchored above the mini-player queue button.
 * Click a row to jump playback there. Portaled to body so the mini-player's
 * `overflow: hidden` can't clip it.
 */
export default function QueuePopover({
  open,
  anchor,
  onClose,
}: Props) {
  const { targetDevice } = useRemotePlayback();
  const position = useQueuePosition();
  const ref = useRef<HTMLDivElement>(null);
  // Same right-click menu as every other track list. Only for this app's
  // own queue: a remote device's rows aren't ours to act on.
  const {
    bind: bindCtx,
    menu: ctxMenu,
    close: closeCtx,
    isOpen: ctxOpen,
  } = useTrackContextMenu();
  const canContext = !targetDevice;

  useDismiss(ref, {
    onDismiss: onClose,
    // While the row menu is open, Escape and outside clicks are the menu's:
    // the first one closes only the menu, the next one the queue.
    enabled: open && !ctxOpen,
    capture: true,
    // The context menu is portaled outside the popover; using it mustn't
    // close the queue it was opened from.
    ignore: (target) =>
      !!anchor?.contains(target) ||
      (target instanceof Element && !!target.closest(".ctx-menu")),
  });

  // The queue stops mousedown from bubbling, so the row menu never sees
  // clicks inside it; the guard closes it instead, and swallows the click so
  // it can't also play a row and close the queue.
  const clickGuard = useContextMenuClickGuard(closeCtx);

  // The menu belongs to a queue row; it goes when the queue does.
  useEffect(() => {
    if (!open) closeCtx();
  }, [open, closeCtx]);

  const { mounted, visible } = useTransitionMount(open, 180);

  if (!mounted || !anchor) return null;

  const rect = anchor.getBoundingClientRect();
  const width = 360;
  const maxHeight = Math.min(440, window.innerHeight - 120);
  const bottom = Math.max(12, window.innerHeight - rect.top + 8);
  const right = Math.max(12, window.innerWidth - rect.right);

  return createPortal(
    <div
      ref={ref}
      className="queue-pop"
      data-closed={!visible || undefined}
      // Mounted only to play its exit: pointer-events alone would still
      // leave these controls tabbable and exposed to assistive tech.
      inert={visible ? undefined : ""}
      role="dialog"
      aria-label="Play queue"
      style={{ bottom, right, width, maxHeight }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseDownCapture={clickGuard.onMouseDownCapture}
      onClickCapture={clickGuard.onClickCapture}
    >
      <div className="queue-pop-head">
        <span className="queue-pop-title-h">Queue</span>
        {position && <span className="queue-pop-pos">{position}</span>}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="iconbtn queue-pop-close"
          aria-label="Close queue"
          onClick={onClose}
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>

      <QueueList
        bindCtx={canContext ? bindCtx : undefined}
        onJumped={onClose}
      />
      {ctxMenu}
    </div>,
    document.body,
  );
}

/** "12 / 40": where playback is in the queue, or null with nothing playing. */
export function useQueuePosition(): string | null {
  const { queue, index, current } = usePlayer();
  const { targetDevice } = useRemotePlayback();
  const remoteQueue = targetDevice?.queue;
  if (!current) return null;
  const { position, total } = queueProgress({ queue, index }, remoteQueue);
  return `${position} / ${total}`;
}

/**
 * The now-playing row and everything after it. Click a row to jump playback
 * there. Shared by the queue popover and the mini player's queue panel.
 *
 * Renders two items for its container's flex column: the playing track's
 * band, and under it the scrolling "Up next" list. The band stays put while
 * the list scrolls, and spans the container whatever its scrollbar takes.
 */
export function QueueList({
  bindCtx,
  onJumped,
}: {
  /** Right-click menu for this app's own queue rows. */
  bindCtx?: BindTrackContext;
  /** Called after a row click jumps playback. */
  onJumped?: () => void;
}) {
  const { queue, index, current } = usePlayer();
  const { jumpTo } = usePlayerControls();
  const { targetDevice } = useRemotePlayback();
  // A remote device's queue arrives as a window of a longer one.
  const { upcoming: upcomingTotal } = queueProgress(
    { queue, index },
    targetDevice?.queue,
  );
  return <QueueContents queue={queue} index={index} current={current} jumpTo={jumpTo} upcomingTotal={upcomingTotal} bindCtx={bindCtx} onJumped={onJumped} />;
}

const QueueContents = memo(function QueueContents({ queue, index, current, jumpTo, upcomingTotal, bindCtx, onJumped }: {
  queue: TrackListItem[];
  index: number;
  current: TrackListItem | null;
  jumpTo: (index: number) => void;
  /** Tracks after the current one in the whole queue, beyond any remote window. */
  upcomingTotal: number;
  bindCtx?: BindTrackContext;
  onJumped?: () => void;
}) {
  const upcoming = queue.slice(index + 1);

  if (!current && queue.length === 0) {
    return (
      <div className="queue-pop-list">
        <div className="queue-pop-empty">
          <MusicalNoteIcon className="size-5" aria-hidden="true" />
          <span>Play something to start a queue.</span>
        </div>
      </div>
    );
  }

  return (
    <>
      {current && (
        <QueueRow
          title={current.title}
          artist={current.artist}
          coverUrl={trackCoverUrl(current, 96)}
          active
          onContextMenu={bindCtx?.(current, { queue, onPlay: () => jumpTo(index) })}
        />
      )}

      <div className="queue-pop-list">
        {upcoming.length > 0 ? (
          <>
            <div className="queue-pop-heading">Up next · {upcomingTotal}</div>
            {upcoming.map((t, i) => (
              <QueueRow
                key={`${t.id}-${index + 1 + i}`}
                title={t.title}
                artist={t.artist}
                coverUrl={trackCoverUrl(t, 64)}
                onClick={() => {
                  jumpTo(index + 1 + i);
                  onJumped?.();
                }}
                onContextMenu={bindCtx?.(t, { queue, onPlay: () => jumpTo(index + 1 + i) })}
              />
            ))}
          </>
        ) : (
          <div className="queue-pop-hint">Nothing queued after this.</div>
        )}
      </div>
    </>
  );
});

function QueueRow({
  title,
  artist,
  coverUrl,
  active,
  onClick,
  onContextMenu,
}: {
  title: string;
  artist?: string;
  coverUrl?: string;
  active?: boolean;
  onClick?: () => void;
  onContextMenu?: React.MouseEventHandler<HTMLElement>;
}) {
  const content = (
    <>
      <CoverArt className="queue-pop-art" src={coverUrl} label={title} />
      <div className="queue-pop-text">
        {/* The playing track is a band of its own, captioned like the share
            page's header, rather than a section heading over a row. */}
        {active && <div className="queue-pop-eyebrow">Now playing</div>}
        <div className="queue-pop-title">{displayText(title)}</div>
        <div className="queue-pop-artist">{displayText(artist, "Unknown artist")}</div>
      </div>
    </>
  );
  if (!onClick) {
    return (
      <div className={"queue-pop-row" + (active ? " active" : "")} onContextMenu={onContextMenu}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={"queue-pop-row" + (active ? " active" : "")}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {content}
    </button>
  );
}
