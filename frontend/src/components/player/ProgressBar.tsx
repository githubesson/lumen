import { usePlayerControls, usePlayerTime } from "../../context/Player";
import { fmtDurationSec } from "../../lib/format";
import SeekBar from "./SeekBar";

/**
 * Seeks somewhere other than local playback. Without a position, the bar
 * shows `usePlayerTime`, which already follows (and ticks for) a remote
 * target, so it needs no clock of its own.
 */
export type ProgressOverride = {
  currentTime?: number;
  duration?: number;
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
  const shownCurrentTime = override?.currentTime ?? currentTime;
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
