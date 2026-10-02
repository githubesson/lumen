import { useEffect, useState } from "react";
import { extrapolatePosition } from "@music-library/core";
import { usePlayerControls, usePlayerTime } from "../../context/Player";
import { fmtDurationSec } from "../../lib/format";
import SeekBar from "./SeekBar";

/**
 * Seeks somewhere other than local playback. Without a position, the bar
 * shows `usePlayerTime`, which already follows (and ticks for) a remote
 * target. A polled position (Lumen Radio) passes `sampledAt`, when it was
 * read, while playing, and the bar advances it until the next poll.
 */
export type ProgressOverride = {
  currentTime?: number;
  duration?: number;
  sampledAt?: number;
  onSeek: (seconds: number) => void;
};

export default function ProgressBar({
  miniPlayerMode,
  override,
}: {
  miniPlayerMode: boolean;
  override?: ProgressOverride;
}) {
  const { currentTime, duration } = usePlayerTime();
  const { seek } = usePlayerControls();
  const sampledAt = override?.sampledAt;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (sampledAt === undefined) return;
    const interval = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(interval);
  }, [sampledAt]);
  const elapsed = sampledAt !== undefined ? (clock - sampledAt) / 1000 : 0;
  const shownCurrentTime =
    override?.currentTime !== undefined
      ? extrapolatePosition(override.currentTime, elapsed, override.duration ?? 0)
      : currentTime;
  const shownDuration = override?.duration ?? duration;
  const progress = shownDuration > 0 ? shownCurrentTime / shownDuration : 0;
  const remainingTime =
    shownDuration > 0 ? Math.max(0, shownDuration - shownCurrentTime) : 0;

  return (
    <div className="progress">
      <span className="progress-time">{fmtDurationSec(shownCurrentTime)}</span>
      <SeekBar
        value={progress}
        onSeek={(v) => {
          if (override) override.onSeek(v * shownDuration);
          else seek(v * duration);
        }}
        label="Seek"
      />
      <span className="progress-time">
        {miniPlayerMode && shownDuration > 0
          ? `-${fmtDurationSec(remainingTime)}`
          : fmtDurationSec(shownDuration)}
      </span>
    </div>
  );
}
