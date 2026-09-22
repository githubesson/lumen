import { useEffect, useState } from "react";
import { usePlayer, usePlayerTime } from "../../context/Player";
import { fmtDurationSec } from "../../lib/format";
import SeekBar from "./SeekBar";

export type ProgressOverride = {
  currentTime: number;
  duration: number;
  isPlaying?: boolean;
  updatedAt?: string;
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
  const { seek } = usePlayer();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!override?.isPlaying) return;
    const interval = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(interval);
  }, [override?.isPlaying]);
  const updatedAt = override?.updatedAt
    ? Date.parse(override.updatedAt)
    : Number.NaN;
  const elapsed =
    override?.isPlaying && Number.isFinite(updatedAt)
      ? Math.max(0, (clock - updatedAt) / 1000)
      : 0;
  const shownCurrentTime = override
    ? Math.min(override.duration || Infinity, override.currentTime + elapsed)
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
