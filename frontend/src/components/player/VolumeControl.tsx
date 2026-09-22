import {
  Volume2 as SpeakerWaveIcon,
  VolumeX as SpeakerXMarkIcon,
} from "lucide-react";
import SeekBar from "./SeekBar";

export default function VolumeControl({
  className,
  muted,
  volume,
  onToggleMute,
  onSeek,
}: {
  className?: string;
  muted: boolean;
  volume: number;
  onToggleMute: () => void;
  onSeek: (v: number) => void;
}) {
  const off = muted || volume === 0;
  return (
    <div className={className}>
      <button
        type="button"
        className="t-btn"
        aria-label={off ? "Unmute" : "Mute"}
        onClick={onToggleMute}
      >
        {off ? (
          <SpeakerXMarkIcon className="size-3.5" />
        ) : (
          <SpeakerWaveIcon className="size-3.5" />
        )}
      </button>
      <SeekBar value={muted ? 0 : volume} onSeek={onSeek} label="Volume" />
    </div>
  );
}
