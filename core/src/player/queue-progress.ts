import type { PlayerState } from "./player-core";
import type { PlaybackQueueSnapshot } from "./queue-sync";

export interface QueueProgress {
  /** Absolute index of `queue[0]`: non-zero when it is a remote snapshot window. */
  offset: number;
  /** 1-based position of the current track in the whole queue; 0 when empty. */
  position: number;
  /** Tracks in the whole queue, including those outside the window. */
  total: number;
  /** Tracks after the current one in the whole queue. */
  upcoming: number;
}

/**
 * Where playback is in its queue. A remote device sends at most a 50-track
 * window of a longer queue (`offset`/`total` in its snapshot), so counting
 * "up next" from the displayed tracks would undercount it; pass the
 * snapshot to get absolute numbers. Without one the displayed queue is the
 * whole queue.
 */
export function queueProgress(
  state: Pick<PlayerState, "queue" | "index">,
  snapshot?: Pick<PlaybackQueueSnapshot, "offset" | "total"> | null,
): QueueProgress {
  const offset = snapshot?.offset ?? 0;
  const length = state.queue.length;
  if (!length) return { offset, position: 0, total: snapshot?.total ?? 0, upcoming: 0 };
  const index = Math.max(0, Math.min(state.index, length - 1));
  // A snapshot's total can never be smaller than the window it carries.
  const total = Math.max(snapshot?.total ?? length, offset + length);
  const position = offset + index + 1;
  return { offset, position, total, upcoming: total - position };
}
