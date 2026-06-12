import { useRef } from "react";
import { createPortal } from "react-dom";
import { MusicalNoteIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { trackCoverUrl } from "../api";
import { usePlayer } from "../context/Player";
import { useDismiss } from "../lib/useDismiss";
import CoverArt from "./CoverArt";

interface ExternalQueueTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
}

interface Props {
  open: boolean;
  /** Element the popover anchors above; usually the queue button. */
  anchor: HTMLElement | null;
  miniPlayerMode?: boolean;
  externalQueue?: {
    title: string;
    currentIndex: number;
    tracks: ExternalQueueTrack[];
    onJump?: (index: number) => void;
  };
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
  miniPlayerMode = false,
  externalQueue,
  onClose,
}: Props) {
  const { queue, index, jumpTo, current } = usePlayer();
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, {
    onDismiss: onClose,
    enabled: open,
    capture: true,
    ignore: (target) => !!anchor?.contains(target),
  });

  if (!open || !anchor) return null;

  const anchorRect = anchor.getBoundingClientRect();
  const stackRect = miniPlayerMode ? getMiniControlsRect(anchor) : null;
  const rect = stackRect ?? anchorRect;
  const width = miniPlayerMode ? rect.width : 360;
  const maxHeight = miniPlayerMode
    ? rect.height
    : Math.min(440, window.innerHeight - 120);
  const bottom = miniPlayerMode
    ? Math.max(0, window.innerHeight - rect.bottom)
    : Math.max(12, window.innerHeight - rect.top + 8);
  const right = Math.max(12, window.innerWidth - rect.right);

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
  const position = usingExternal
    ? externalTracks.length > 0
      ? `${externalIndex + 1} / ${externalTracks.length}`
      : null
    : current
      ? `${index + 1} / ${queue.length}`
      : null;

  return createPortal(
    <div
      ref={ref}
      className={"queue-pop" + (miniPlayerMode ? " queue-pop-mini" : "")}
      role="dialog"
      aria-label="Play queue"
      style={{ bottom, right, width, maxHeight }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
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
        {isEmpty ? (
          <div className="queue-pop-empty">
            <MusicalNoteIcon className="size-5" aria-hidden="true" />
            <span>
              {usingExternal ? "No bridge queue loaded." : "Play something to start a queue."}
            </span>
          </div>
        ) : (
          <>
            {(usingExternal ? externalCurrent : current) && (
              <>
                <div className="queue-pop-heading">Now playing</div>
                {usingExternal && externalCurrent ? (
                  <QueueRow
                    title={externalCurrent.title}
                    artist={externalCurrent.artist ?? externalCurrent.album}
                    seed={externalCurrent.id}
                    active
                  />
                ) : current ? (
                  <QueueRow
                    title={current.title}
                    artist={current.artist}
                    coverUrl={trackCoverUrl(current)}
                    seed={current.album_id ?? current.id}
                    active
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
                      seed={t.id}
                      onClick={
                        externalQueue?.onJump
                          ? () => {
                              externalQueue.onJump?.(externalIndex + 1 + i);
                              onClose();
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
                      coverUrl={trackCoverUrl(t)}
                      seed={t.album_id ?? t.id}
                      onClick={() => {
                        jumpTo(index + 1 + i);
                        onClose();
                      }}
                    />
                  ))}
              </>
            ) : (
              <div className="queue-pop-hint">Nothing queued after this.</div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function clampIndex(index: number, length: number) {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function getMiniControlsRect(anchor: HTMLElement): DOMRect | null {
  const player = anchor.closest(".player-bar");
  const transport = player?.querySelector(".transport-row");
  const utility = player?.querySelector(".utility");
  if (!(transport instanceof HTMLElement) || !(utility instanceof HTMLElement)) {
    return null;
  }

  const top = transport.getBoundingClientRect();
  const bottom = utility.getBoundingClientRect();
  const left = Math.min(top.left, bottom.left);
  const right = Math.max(top.right, bottom.right);
  const y = Math.min(top.top, bottom.top);
  const height = Math.max(top.bottom, bottom.bottom) - y;
  return new DOMRect(left, y, right - left, height);
}

function QueueRow({
  title,
  artist,
  coverUrl,
  seed,
  active,
  onClick,
}: {
  title: string;
  artist?: string;
  coverUrl?: string;
  seed: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <CoverArt className="queue-pop-art" src={coverUrl} seed={seed} label={title} />
      <div className="queue-pop-text">
        <div className="queue-pop-title">{title}</div>
        <div className="queue-pop-artist">{artist ?? "Unknown artist"}</div>
      </div>
    </>
  );
  if (!onClick) {
    return (
      <div className={"queue-pop-row" + (active ? " active" : "")}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={"queue-pop-row" + (active ? " active" : "")}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
