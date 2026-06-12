import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import QueuePopover from "./QueuePopover";
import {
  ArrowPathRoundedSquareIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  ArrowsRightLeftIcon,
  BackwardIcon,
  ForwardIcon,
  HeartIcon,
  PauseIcon,
  PlayIcon,
  QueueListIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
} from "@heroicons/react/16/solid";
import { trackCoverUrl } from "../api";
import CoverArt from "./CoverArt";
import { useTrackContextMenu } from "./TrackContextMenu";
import { useFavorites } from "../context/Favorites";
import { usePlayer, usePlayerTime } from "../context/Player";
import { usePopKey } from "../lib/useTransitionMount";
import { useAccentFromCover } from "../lib/accent";
import { displayText, fmtDurationSec } from "../lib/format";
import {
  canSetMiniPlayer,
  setMiniPlayerMode as setElectronMiniPlayer,
} from "../lib/platform";
import { fh6Transport as sendFH6Transport, useFH6Snapshot } from "../lib/fh6";

export default function MiniPlayer() {
  const location = useLocation();
  const {
    current,
    isPlaying,
    volume,
    muted,
    shuffle,
    repeat,
    toggle,
    next,
    prev,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
  } = usePlayer();
  const { isFavorite, toggle: toggleFavorite } = useFavorites();
  const fh6Snapshot = useFH6Snapshot();
  const isFH6Page = location.pathname.startsWith("/fh6-radio");
  const fh6Source = fh6Snapshot?.state?.sources?.available?.find(
    (s) => s.name === "lumen",
  );
  const fh6Track = fh6Snapshot?.state?.track;
  const fh6HasTrack = !!fh6Track?.title;
  const fh6Playing = fh6Source?.playback_state === "playing";
  const displayCurrent = isFH6Page ? null : current;
  const displayHasTrack = isFH6Page ? fh6HasTrack : !!current;
  const displayPlaying = isFH6Page ? fh6Playing : isPlaying;
  const displayTitle = isFH6Page
    ? displayText(fh6Track?.title, "Waiting for FH6")
    : displayText(current?.title, "Nothing playing");
  const displayArtist = isFH6Page
    ? [fh6Track?.artist, fh6Track?.album].filter(Boolean).join(" \u00b7 ") ||
      "Lumen Radio"
    : current
      ? `${displayText(current.artist, "\u2014")}${
          current.album_title ? ` \u00b7 ${displayText(current.album_title)}` : ""
        }`
      : "\u2014";

  const fav = displayCurrent ? isFavorite(displayCurrent.id) : false;
  const popKey = usePopKey(fav);
  const coverSrc = displayCurrent ? trackCoverUrl(displayCurrent) : null;
  useAccentFromCover(coverSrc);
  const { bind: bindCtx, menu: trackCtxMenu } = useTrackContextMenu();
  const queueBtnRef = useRef<HTMLButtonElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [miniPlayerMode, setMiniPlayerMode] = useState(false);
  const canResizeWindow = canSetMiniPlayer;

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-mini-player",
      miniPlayerMode,
    );
    return () => {
      document.documentElement.removeAttribute("data-mini-player");
    };
  }, [miniPlayerMode]);

  const toggleMiniPlayerMode = async () => {
    if (!canSetMiniPlayer) return;
    const next = !miniPlayerMode;
    setMiniPlayerMode(next);
    const result = await setElectronMiniPlayer(next);
    if (!result.ok || result.miniPlayer !== next) {
      setMiniPlayerMode(result.miniPlayer);
    }
  };

  return (
    <section
      className={"player-bar" + (miniPlayerMode ? " player-bar-window" : "")}
      aria-label="Player"
      data-has-track={displayHasTrack ? "true" : "false"}
      data-playing={displayPlaying ? "true" : "false"}
    >
      {trackCtxMenu}
      {/* Now playing */}
      <div
        className="np"
        onContextMenu={displayCurrent ? bindCtx(displayCurrent) : undefined}
      >
        <CoverArt
          className="np-art"
          src={coverSrc}
          seed={displayCurrent?.album_id ?? displayCurrent?.id ?? "fh6-radio"}
          label={isFH6Page ? "Lumen Radio" : displayText(displayCurrent?.album_title || displayCurrent?.title, "\u00b7")}
          forcePlaceholder={!displayCurrent}
        />
        <div className="np-text">
          <div className="np-title">{displayTitle}</div>
          <div className="np-artist">{displayArtist}</div>
        </div>
      </div>

      {/* Transport */}
      <div className="transport">
        <div className="transport-row">
          <button
            type="button"
            className={"t-btn" + (shuffle ? " active" : "")}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            onClick={toggleShuffle}
            disabled={isFH6Page}
          >
            <ArrowsRightLeftIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className="t-btn"
            aria-label="Previous"
            onClick={isFH6Page ? () => void fh6Transport("previous") : prev}
            disabled={isFH6Page ? !fh6Snapshot?.state : !current}
          >
            <BackwardIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className="play-btn"
            aria-label={displayPlaying ? "Pause" : "Play"}
            onClick={isFH6Page ? () => void fh6Transport(displayPlaying ? "pause" : "play") : toggle}
            disabled={isFH6Page ? !fh6Snapshot?.state : !current}
          >
            {displayPlaying ? (
              <PauseIcon className="size-4" />
            ) : (
              <PlayIcon className="size-4" />
            )}
          </button>
          <button
            type="button"
            className="t-btn"
            aria-label="Next"
            onClick={isFH6Page ? () => void fh6Transport("next") : next}
            disabled={isFH6Page ? !fh6Snapshot?.state : !current}
          >
            <ForwardIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={"t-btn" + (repeat !== "off" ? " active" : "")}
            aria-label={`Repeat: ${repeat}`}
            onClick={cycleRepeat}
            disabled={isFH6Page}
          >
            <ArrowPathRoundedSquareIcon className="size-3.5" />
            {repeat === "one" && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  fontSize: 8,
                  fontWeight: 700,
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
          override={
            isFH6Page
              ? {
                  currentTime: (fh6Track?.position_ms ?? 0) / 1000,
                  duration: (fh6Track?.duration_ms ?? 0) / 1000,
                  onSeek: (seconds) =>
                    void fh6Transport("seek", { position_ms: Math.round(seconds * 1000) }),
                }
              : undefined
          }
        />
      </div>

      {/* Utility */}
      <div className="utility">
        <button
          type="button"
          className={"t-btn" + (fav ? " active" : "")}
          aria-label={fav ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={fav}
          disabled={!displayCurrent}
          onClick={() => displayCurrent && void toggleFavorite(displayCurrent.id)}
        >
          <HeartIcon
            key={popKey}
            className={`size-3.5 shrink-0 ${popKey > 0 ? "motion-safe:animate-heart-pop" : ""}`}
            aria-hidden="true"
          />
        </button>
        <button
          ref={queueBtnRef}
          type="button"
          className={"t-btn" + (queueOpen ? " active" : "")}
          title="Queue"
          aria-label="Queue"
          aria-expanded={queueOpen}
          onClick={() => setQueueOpen((v) => !v)}
        >
          <QueueListIcon className="size-3.5" />
        </button>
        <QueuePopover
          open={queueOpen}
          anchor={queueBtnRef.current}
          miniPlayerMode={miniPlayerMode}
          externalQueue={
            isFH6Page
              ? {
                  title: "Lumen Radio Queue",
                  tracks: fh6Snapshot?.queue ?? [],
                  currentIndex: fh6Snapshot?.currentIndex ?? 0,
                  onJump: (index) => void fh6Transport("jump", { index }),
                }
              : undefined
          }
          onClose={() => setQueueOpen(false)}
        />
        <div className="mini-divider" aria-hidden="true" />
        <VolumeControl
          className="volume"
          muted={muted}
          volume={volume}
          onToggleMute={toggleMute}
          onSeek={setVolume}
        />
        {canResizeWindow && (
          <button
            type="button"
            className={
              "t-btn mini-mode-toggle" + (miniPlayerMode ? " active" : "")
            }
            title={miniPlayerMode ? "Exit mini player" : "Mini player"}
            aria-label={miniPlayerMode ? "Exit mini player" : "Mini player"}
            aria-pressed={miniPlayerMode}
            onClick={() => void toggleMiniPlayerMode()}
          >
            {miniPlayerMode ? (
              <ArrowsPointingOutIcon className="size-3.5" />
            ) : (
              <ArrowsPointingInIcon className="size-3.5" />
            )}
          </button>
        )}
      </div>
    </section>
  );

  function fh6Transport(action: string, body?: unknown) {
    return sendFH6Transport(fh6Snapshot?.bridgeUrl, action, body);
  }
}

function VolumeControl({
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

function ProgressBar({
  miniPlayerMode,
  override,
}: {
  miniPlayerMode: boolean;
  override?: {
    currentTime: number;
    duration: number;
    onSeek: (seconds: number) => void;
  };
}) {
  const { currentTime, duration } = usePlayerTime();
  const { seek } = usePlayer();
  const shownCurrentTime = override?.currentTime ?? currentTime;
  const shownDuration = override?.duration ?? duration;
  const progress = shownDuration > 0 ? shownCurrentTime / shownDuration : 0;
  const remainingTime = shownDuration > 0 ? Math.max(0, shownDuration - shownCurrentTime) : 0;

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

function SeekBar({
  value,
  onSeek,
  label,
}: {
  value: number;
  onSeek: (v: number) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const fromEvent = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return r.width > 0 ? x / r.width : 0;
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (ev: PointerEvent) => onSeek(fromEvent(ev.clientX));
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, onSeek, fromEvent]);

  const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    setDragging(true);
    onSeek(fromEvent(e.clientX));
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onSeek(Math.max(0, value - 0.05));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onSeek(Math.min(1, value + 0.05));
    } else if (e.key === "Home") {
      e.preventDefault();
      onSeek(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onSeek(1);
    }
  };

  const pct = Math.max(0, Math.min(1, value)) * 100;
  const pctStr = pct.toFixed(3);

  return (
    <div
      ref={ref}
      className={"bar" + (dragging ? " dragging" : "")}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <div className="bar-fill" style={{ width: `${pctStr}%` }} />
      <div className="bar-thumb" style={{ left: `${pctStr}%` }} />
    </div>
  );
}
