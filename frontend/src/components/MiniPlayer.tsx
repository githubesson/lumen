import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import QueuePopover from "./QueuePopover";
import PlaybackDevicePopover from "./PlaybackDevicePopover";
import RemoteControlIndicator from "./RemoteControlIndicator";
import {
  ArrowPathRoundedSquareIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  ArrowsRightLeftIcon,
  BackwardIcon,
  BookOpenIcon,
  ComputerDesktopIcon,
  ForwardIcon,
  PauseIcon,
  PlayIcon,
  QueueListIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
} from "@heroicons/react/16/solid";
import type { TrackListItem } from "@music-library/core";
import { trackCoverUrl } from "../api";
import CoverArt from "./CoverArt";
import { useTrackContextMenu } from "./TrackContextMenu";
import { FavoriteButton } from "./TrackRowCells";
import { useFavorites } from "../context/Favorites";
import { useLyricsPanel } from "../context/LyricsPanel";
import {
  usePlayer,
  usePlayerTime,
  useRemotePlayback,
} from "../context/Player";
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
  const { open: lyricsOpen, setOpen: setLyricsOpen } = useLyricsPanel();
  const {
    targetDevice,
    commandPending,
    lastCommandResult,
    controlledVolume,
    controlledMuted,
    controlledShuffle,
    controlledRepeat,
    sendCommand,
  } = useRemotePlayback();
  const { isFavorite, toggle: toggleFavorite } = useFavorites();
  const fh6Snapshot = useFH6Snapshot();
  const isFH6Page = location.pathname.startsWith("/fh6-radio");
  const remoteActivity = targetDevice?.activity ?? null;
  const remoteTrack: TrackListItem | null = remoteActivity
    ? {
        id: remoteActivity.track_id,
        title: remoteActivity.title,
        artist: remoteActivity.artist,
        album_id: remoteActivity.album_id,
        album_title: remoteActivity.album,
        cover_url: remoteActivity.cover_url,
        duration_ms: (remoteActivity.duration_sec ?? 0) * 1000,
      }
    : null;
  const isRemoteMode = !!targetDevice;
  const isFH6Mode = isFH6Page && !isRemoteMode;
  const fh6Source = fh6Snapshot?.state?.sources?.available?.find(
    (s) => s.name === "lumen",
  );
  const fh6Track = fh6Snapshot?.state?.track;
  const fh6HasTrack = !!fh6Track?.title;
  const fh6Playing = fh6Source?.playback_state === "playing";
  const displayCurrent = isRemoteMode
    ? remoteTrack
    : isFH6Mode
      ? null
      : current;
  const displayHasTrack = isRemoteMode
    ? !!remoteActivity
    : isFH6Mode
      ? fh6HasTrack
      : !!current;
  const displayPlaying = isRemoteMode
    ? !!remoteActivity?.is_playing
    : isFH6Mode
      ? fh6Playing
      : isPlaying;
  const displayTitle = isRemoteMode
    ? displayText(remoteActivity?.title, `Nothing playing on ${targetDevice.deviceName}`)
    : isFH6Mode
    ? displayText(fh6Track?.title, "Waiting for FH6")
    : displayText(current?.title, "Nothing playing");
  const displayArtist = isRemoteMode
    ? [remoteActivity?.artist, remoteActivity?.album].filter(Boolean).join(" · ") ||
      targetDevice.deviceName
    : isFH6Mode
      ? [fh6Track?.artist, fh6Track?.album].filter(Boolean).join(" · ") ||
        "Lumen Radio"
      : current
        ? `${displayText(current.artist, "—")}${
            current.album_title ? ` · ${displayText(current.album_title)}` : ""
          }`
        : "—";

  const fav = displayCurrent ? isFavorite(displayCurrent.id) : false;
  const coverSrc = displayCurrent ? trackCoverUrl(displayCurrent) : null;
  useAccentFromCover(coverSrc);
  const { bind: bindCtx, menu: trackCtxMenu } = useTrackContextMenu();
  const queueBtnRef = useRef<HTMLButtonElement>(null);
  const deviceBtnRef = useRef<HTMLButtonElement>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [miniPlayerMode, setMiniPlayerMode] = useState(false);
  const canResizeWindow = canSetMiniPlayer;
  const shownVolume = isRemoteMode ? controlledVolume : volume;
  const shownMuted = isRemoteMode ? controlledMuted : muted;
  const shownShuffle = isRemoteMode ? controlledShuffle : shuffle;
  const shownRepeat = isRemoteMode ? controlledRepeat : repeat;
  const commandError =
    lastCommandResult && lastCommandResult.status !== "applied"
      ? lastCommandResult.error || `Command ${lastCommandResult.status}`
      : null;

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-mini-player",
      miniPlayerMode,
    );
    return () => {
      document.documentElement.removeAttribute("data-mini-player");
    };
  }, [miniPlayerMode]);

  useEffect(() => {
    if (miniPlayerMode && lyricsOpen) {
      setLyricsOpen(false);
    }
  }, [miniPlayerMode, lyricsOpen, setLyricsOpen]);

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
    <div className="player-shell">
      <section
        className={"player-bar" + (miniPlayerMode ? " player-bar-window" : "")}
        aria-label="Player"
        data-has-track={displayHasTrack ? "true" : "false"}
        data-playing={displayPlaying ? "true" : "false"}
      >
        {trackCtxMenu}
      <div
        className="np"
        onContextMenu={
          displayCurrent && !isRemoteMode ? bindCtx(displayCurrent) : undefined
        }
      >
        <CoverArt
          className="np-art"
          src={coverSrc}
          seed={displayCurrent?.album_id ?? displayCurrent?.id ?? "fh6-radio"}
          label={
            isFH6Mode
              ? "Lumen Radio"
              : displayText(
                  displayCurrent?.album_title || displayCurrent?.title,
                  "·",
                )
          }
          forcePlaceholder={!displayCurrent}
        />
        <div className="np-text">
          <div className="np-title">{displayTitle}</div>
          <div className="np-artist">{displayArtist}</div>
        </div>
      </div>

      <div className="transport">
        <div className="transport-row">
          <button
            type="button"
            className={"t-btn" + (shownShuffle ? " active" : "")}
            aria-label="Shuffle"
            aria-pressed={shownShuffle}
            onClick={() => {
              if (isRemoteMode) {
                void sendCommand("set_shuffle", { shuffle: !shownShuffle });
              } else toggleShuffle();
            }}
            disabled={isFH6Mode || commandPending}
          >
            <ArrowsRightLeftIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className="t-btn"
            aria-label="Previous"
            onClick={
              isRemoteMode
                ? () => void sendCommand("previous")
                : isFH6Mode
                  ? () => void fh6Transport("previous")
                  : prev
            }
            disabled={
              commandPending ||
              (isRemoteMode
                ? !remoteActivity
                : isFH6Mode
                  ? !fh6Snapshot?.state
                  : !current)
            }
          >
            <BackwardIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className="play-btn"
            aria-label={displayPlaying ? "Pause" : "Play"}
            onClick={
              isRemoteMode
                ? () =>
                    void sendCommand("set_playing", {
                      playing: !displayPlaying,
                    })
                : isFH6Mode
                  ? () =>
                      void fh6Transport(displayPlaying ? "pause" : "play")
                  : toggle
            }
            disabled={
              commandPending ||
              (isRemoteMode
                ? !remoteActivity
                : isFH6Mode
                  ? !fh6Snapshot?.state
                  : !current)
            }
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
            onClick={
              isRemoteMode
                ? () => void sendCommand("next")
                : isFH6Mode
                  ? () => void fh6Transport("next")
                  : next
            }
            disabled={
              commandPending ||
              (isRemoteMode
                ? !remoteActivity
                : isFH6Mode
                  ? !fh6Snapshot?.state
                  : !current)
            }
          >
            <ForwardIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={"t-btn" + (shownRepeat !== "off" ? " active" : "")}
            aria-label={`Repeat: ${shownRepeat}`}
            onClick={() => {
              if (isRemoteMode) {
                void sendCommand("set_repeat", {
                  repeat:
                    shownRepeat === "off"
                      ? "all"
                      : shownRepeat === "all"
                        ? "one"
                        : "off",
                });
              } else cycleRepeat();
            }}
            disabled={isFH6Mode || commandPending}
          >
            <ArrowPathRoundedSquareIcon className="size-3.5" />
            {shownRepeat === "one" && (
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
            muted={shownMuted}
            volume={shownVolume}
            onToggleMute={() => {
              if (isRemoteMode) {
                void sendCommand("set_muted", { muted: !shownMuted });
              } else toggleMute();
            }}
            onSeek={(nextVolume) => {
              if (isRemoteMode) {
                void sendCommand("set_volume", { volume: nextVolume });
              } else setVolume(nextVolume);
            }}
          />
        </div>
        <ProgressBar
          miniPlayerMode={miniPlayerMode}
          override={
            isRemoteMode && remoteActivity
              ? {
                  currentTime: remoteActivity.position_sec,
                  duration: remoteActivity.duration_sec ?? 0,
                  isPlaying: remoteActivity.is_playing,
                  updatedAt: remoteActivity.updated_at,
                  onSeek: (seconds) =>
                    void sendCommand("seek", { position_sec: seconds }),
                }
              : isFH6Mode
              ? {
                  currentTime: (fh6Track?.position_ms ?? 0) / 1000,
                  duration: (fh6Track?.duration_ms ?? 0) / 1000,
                  onSeek: (seconds) =>
                    void fh6Transport("seek", {
                      position_ms: Math.round(seconds * 1000),
                    }),
                }
              : undefined
          }
        />
      </div>

      <div className="utility">
        <button
          ref={deviceBtnRef}
          type="button"
          className={
            "t-btn device-picker-btn" +
            (isRemoteMode || deviceOpen ? " active" : "") +
            (commandPending ? " pending" : "") +
            (commandError ? " error" : "")
          }
          title={
            commandError
              ? commandError
              : targetDevice
                ? `Controlling ${targetDevice.deviceName}`
                : "Choose playback device"
          }
          aria-label={
            targetDevice
              ? `Playback device: ${targetDevice.deviceName}`
              : "Choose playback device"
          }
          aria-expanded={deviceOpen}
          onClick={() => setDeviceOpen((open) => !open)}
        >
          <ComputerDesktopIcon className="size-3.5" />
          {isRemoteMode && (
            <span className="device-picker-live" aria-hidden="true" />
          )}
        </button>
        <PlaybackDevicePopover
          open={deviceOpen}
          anchor={deviceBtnRef.current}
          miniPlayerMode={miniPlayerMode}
          onClose={() => setDeviceOpen(false)}
        />
        <FavoriteButton
          className="t-btn"
          iconClassName="shrink-0"
          fav={fav}
          disabled={!displayCurrent || isRemoteMode}
          onToggle={() => displayCurrent && void toggleFavorite(displayCurrent.id)}
        />
        <button
          type="button"
          className={"t-btn" + (lyricsOpen ? " active" : "")}
          title="Lyrics"
          aria-label="Toggle lyrics panel"
          aria-pressed={lyricsOpen}
          disabled={!displayCurrent}
          onClick={() => setLyricsOpen(!lyricsOpen)}
        >
          <BookOpenIcon className="size-3.5" />
        </button>
        <button
          ref={queueBtnRef}
          type="button"
          className={"t-btn" + (queueOpen ? " active" : "")}
          title="Queue"
          aria-label="Queue"
          aria-expanded={queueOpen}
          onClick={() => setQueueOpen((v) => !v)}
          disabled={isRemoteMode}
        >
          <QueueListIcon className="size-3.5" />
        </button>
        <QueuePopover
          open={queueOpen}
          anchor={queueBtnRef.current}
          miniPlayerMode={miniPlayerMode}
          externalQueue={
            isFH6Mode
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
          muted={shownMuted}
          volume={shownVolume}
          onToggleMute={() => {
            if (isRemoteMode) {
              void sendCommand("set_muted", { muted: !shownMuted });
            } else toggleMute();
          }}
          onSeek={(nextVolume) => {
            if (isRemoteMode) {
              void sendCommand("set_volume", { volume: nextVolume });
            } else setVolume(nextVolume);
          }}
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
      <RemoteControlIndicator />
    </div>
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
    isPlaying?: boolean;
    updatedAt?: string;
    onSeek: (seconds: number) => void;
  };
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
