import {
  Repeat as ArrowPathRoundedSquareIcon,
  Shuffle as ArrowsRightLeftIcon,
  SkipBack as BackwardIcon,
  SkipForward as ForwardIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
} from "lucide-react";
import { repeatModeLabel, type RepeatMode } from "@music-library/core";
import { usePlayer } from "../../context/Player";
import ProgressBar from "./ProgressBar";
import VolumeControl from "./VolumeControl";

export default function Transport({
  shuffle,
  repeat,
  playing,
  muted,
  volume,
  commandPending,
  transportDisabled,
  miniPlayerMode,
}: {
  shuffle: boolean;
  repeat: RepeatMode;
  playing: boolean;
  muted: boolean;
  volume: number;
  commandPending: boolean;
  /** Disables previous, play/pause and next. */
  transportDisabled: boolean;
  miniPlayerMode: boolean;
}) {
  const {
    toggle,
    next,
    prev,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
  } = usePlayer();

  return (
    <div className="transport">
      <div className="transport-row">
        <button
          type="button"
          className={"t-btn" + (shuffle ? " active" : "")}
          aria-label="Shuffle"
          aria-pressed={shuffle}
          onClick={toggleShuffle}
          disabled={commandPending}
        >
          <ArrowsRightLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="t-btn"
          aria-label="Previous"
          onClick={prev}
          disabled={transportDisabled}
        >
          <BackwardIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="play-btn"
          aria-label={playing ? "Pause" : "Play"}
          onClick={toggle}
          disabled={transportDisabled}
        >
          {playing ? (
            <PauseIcon className="size-4" />
          ) : (
            <PlayIcon className="size-4" />
          )}
        </button>
        <button
          type="button"
          className="t-btn"
          aria-label="Next"
          onClick={next}
          disabled={transportDisabled}
        >
          <ForwardIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={"t-btn" + (repeat !== "off" ? " active" : "")}
          aria-label={repeatModeLabel(repeat)}
          onClick={cycleRepeat}
          disabled={commandPending}
        >
          <ArrowPathRoundedSquareIcon className="size-3.5" />
          {repeat === "one" && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                fontSize: 12,
                fontWeight: 600,
                transform: "translate(8px, 8px)",
              }}
            >
              1
            </span>
          )}
        </button>
        <VolumeControl
          className="volume transport-volume"
          muted={muted}
          volume={volume}
          onToggleMute={toggleMute}
          onSeek={setVolume}
        />
      </div>
      <ProgressBar miniPlayerMode={miniPlayerMode} />
    </div>
  );
}
