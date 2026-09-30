import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Music as MusicalNoteIcon, X as XMarkIcon } from "lucide-react";
import { trackCoverUrl, type TrackListItem } from "../api";
import { usePlayer, usePlayerControls, useRemotePlayback } from "../context/Player";
import { useDismiss } from "../lib/useDismiss";
import { useTransitionMount } from "../lib/useTransitionMount";
import CoverArt from "./CoverArt";
import {
  useContextMenuClickGuard,
  useTrackContextMenu,
} from "../lib/useTrackContextMenu";

interface ExternalQueueTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
}

/** A queue this app doesn't own, e.g. the Lumen Radio bridge's. */
export interface ExternalQueue {
  title: string;
  currentIndex: number;
  tracks: ExternalQueueTrack[];
  onJump?: (index: number) => void;
}

type BindTrackContext = ReturnType<typeof useTrackContextMenu>["bind"];

interface Props {
  open: boolean;
  /** Element the popover anchors above; usually the queue button. */
  anchor: HTMLElement | null;
  externalQueue?: ExternalQueue;
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
  externalQueue,
  onClose,
}: Props) {
  const { targetDevice } = useRemotePlayback();
  const position = useQueuePosition(externalQueue);
  const ref = useRef<HTMLDivElement>(null);
  // Same right-click menu as every other track list. Only for this app's
  // own queue: a remote device's or the bridge's rows aren't ours to act on.
  const {
    bind: bindCtx,
    menu: ctxMenu,
    close: closeCtx,
    isOpen: ctxOpen,
  } = useTrackContextMenu();
  const canContext = !externalQueue && !targetDevice;

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
        <span className="queue-pop-title-h">{externalQueue?.title ?? "Queue"}</span>
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

      <div className="queue-pop-body">
        <QueueList
          externalQueue={externalQueue}
          bindCtx={canContext ? bindCtx : undefined}
          onJumped={onClose}
        />
      </div>
      {ctxMenu}
    </div>,
    document.body,
  );
}

function clampIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/** "12 / 40": where playback is in the queue, or null with nothing playing. */
export function useQueuePosition(externalQueue?: ExternalQueue): string | null {
  const { queue, index, current } = usePlayer();
  const { targetDevice } = useRemotePlayback();
  const remoteQueue = targetDevice?.queue;
  if (externalQueue) {
    const total = externalQueue.tracks.length;
    if (total === 0) return null;
    return `${clampIndex(externalQueue.currentIndex, total) + 1} / ${total}`;
  }
  if (!current) return null;
  return `${(remoteQueue?.offset ?? 0) + index + 1} / ${remoteQueue?.total ?? queue.length}`;
}

/**
 * The now-playing row and everything after it. Click a row to jump playback
 * there. Shared by the queue popover and the mini player's queue panel.
 */
export function QueueList({
  externalQueue,
  bindCtx,
  onJumped,
}: {
  externalQueue?: ExternalQueue;
  /** Right-click menu for this app's own queue rows. */
  bindCtx?: BindTrackContext;
  /** Called after a row click jumps playback. */
  onJumped?: () => void;
}) {
  const { queue, index, current } = usePlayer();
  const { jumpTo } = usePlayerControls();
  return <QueueContents queue={queue} index={index} current={current} jumpTo={jumpTo} externalQueue={externalQueue} bindCtx={bindCtx} onJumped={onJumped} />;
}

const QueueContents = memo(function QueueContents({ queue, index, current, jumpTo, externalQueue, bindCtx, onJumped }: {
  queue: TrackListItem[];
  index: number;
  current: TrackListItem | null;
  jumpTo: (index: number) => void;
  externalQueue?: ExternalQueue;
  bindCtx?: BindTrackContext;
  onJumped?: () => void;
}) {

  const usingExternal = !!externalQueue;
  const externalTracks = externalQueue?.tracks ?? [];
  const externalIndex = clampIndex(
    externalQueue?.currentIndex ?? 0,
    externalTracks.length,
  );
  const externalCurrent = externalTracks[externalIndex];
  const externalUpcoming = externalTracks.slice(externalIndex + 1);
  const localUpcoming = queue.slice(index + 1);
  const upcoming = usingExternal ? externalUpcoming : localUpcoming;
  const isEmpty = usingExternal
    ? externalTracks.length === 0
    : !current && queue.length === 0;

  if (isEmpty) {
    return (
      <div className="queue-pop-empty">
        <MusicalNoteIcon className="size-5" aria-hidden="true" />
        <span>
          {usingExternal ? "No bridge queue loaded." : "Play something to start a queue."}
        </span>
      </div>
    );
  }

  return (
    <>
      {(usingExternal ? externalCurrent : current) && (
        <>
          <div className="queue-pop-heading">Now playing</div>
          {usingExternal && externalCurrent ? (
            <QueueRow
              title={externalCurrent.title}
              artist={externalCurrent.artist ?? externalCurrent.album}
              active
            />
          ) : current ? (
            <QueueRow
              title={current.title}
              artist={current.artist}
              coverUrl={trackCoverUrl(current, 64)}
              active
              onContextMenu={bindCtx?.(current, { queue, onPlay: () => jumpTo(index) })}
            />
          ) : null}
        </>
      )}

      {upcoming.length > 0 ? (
        <>
          <div className="queue-pop-heading">
            Up next · {upcoming.length}
          </div>
          {usingExternal
            ? externalUpcoming.map((t, i) => (
              <QueueRow
                key={`${t.id}-${externalIndex + 1 + i}`}
                title={t.title}
                artist={t.artist ?? t.album}
                onClick={
                  externalQueue?.onJump
                    ? () => {
                        externalQueue.onJump?.(externalIndex + 1 + i);
                        onJumped?.();
                      }
                    : undefined
                }
              />
            ))
            : localUpcoming.map((t, i) => (
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
        <div className="queue-pop-title">{title}</div>
        <div className="queue-pop-artist">{artist ?? "Unknown artist"}</div>
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
