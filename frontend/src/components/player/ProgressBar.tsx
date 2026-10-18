import { usePlayerControls, usePlayerTime } from "../../context/Player";
import { fmtDurationSec } from "../../lib/format";
import SeekBar from "./SeekBar";

/** The player clock and `seek` already follow (and tick for) a remote target. */
export default function ProgressBar({
  miniPlayerMode,
}: {
  miniPlayerMode: boolean;
}) {
  const { currentTime, duration } = usePlayerTime();
  const { seek } = usePlayerControls();
  const progress = duration > 0 ? currentTime / duration : 0;
  const remainingTime = duration > 0 ? Math.max(0, duration - currentTime) : 0;

  return (
    <div className="progress">
      <span className="progress-time">{fmtDurationSec(currentTime)}</span>
      <SeekBar
        value={progress}
        onSeek={(v) => seek(v * duration)}
        label="Seek"
      />
      <span className="progress-time">
        {miniPlayerMode && duration > 0
          ? `-${fmtDurationSec(remainingTime)}`
          : fmtDurationSec(duration)}
      </span>
    </div>
  );
}
