import {
  Repeat as ArrowPathRoundedSquareIcon,
  Shuffle as ArrowsRightLeftIcon,
  SkipBack as BackwardIcon,
  SkipForward as ForwardIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
} from "lucide-react";
import type { RepeatMode } from "@music-library/core";
import { usePlayer } from "../../context/Player";
import ProgressBar, { type ProgressOverride } from "./ProgressBar";
import VolumeControl from "./VolumeControl";

export default function Transport({
  shuffle,
  repeat,
  playing,
  muted,
  volume,
  isFH6Mode,
  commandPending,
  transportDisabled,
  miniPlayerMode,
  progressOverride,
  fh6Transport,
}: {
  shuffle: boolean;
  repeat: RepeatMode;
  playing: boolean;
  muted: boolean;
  volume: number;
  isFH6Mode: boolean;
  commandPending: boolean;
  /** Disables previous, play/pause and next. */
  transportDisabled: boolean;
  miniPlayerMode: boolean;
  progressOverride?: ProgressOverride;
  fh6Transport: (action: string, body?: unknown) => Promise<void>;
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
          disabled={isFH6Mode || commandPending}
        >
          <ArrowsRightLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="t-btn"
          aria-label="Previous"
          onClick={isFH6Mode ? () => void fh6Transport("previous") : prev}
          disabled={transportDisabled}
        >
          <BackwardIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="play-btn"
          aria-label={playing ? "Pause" : "Play"}
          onClick={
            isFH6Mode
              ? () => void fh6Transport(playing ? "pause" : "play")
              : toggle
          }
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
          onClick={isFH6Mode ? () => void fh6Transport("next") : next}
          disabled={transportDisabled}
        >
          <ForwardIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={"t-btn" + (repeat !== "off" ? " active" : "")}
          aria-label={`Repeat: ${repeat}`}
          onClick={cycleRepeat}
          disabled={isFH6Mode || commandPending}
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
      <ProgressBar
        miniPlayerMode={miniPlayerMode}
        override={progressOverride}
      />
    </div>
  );
}
