import { useEffect, useMemo, useRef } from "react";
import RemoteControlIndicator from "./RemoteControlIndicator";
import {
  Minimize2 as ArrowsPointingInIcon,
  Maximize2 as ArrowsPointingOutIcon,
  MicVocal as BookOpenIcon,
} from "lucide-react";
import { useTrackContextMenu } from "../lib/useTrackContextMenu";
import { FavoriteButton } from "./TrackRowCells";
import { useFavorites } from "../context/Favorites";
import { useLyricsPanel } from "../context/LyricsPanel";
import { usePlayer } from "../context/Player";
import { canSetMiniPlayer } from "../lib/platform";
import type { ExternalQueue } from "./QueuePopover";
import DevicePickerButton from "./player/DevicePickerButton";
import MiniPlayerPanel from "./player/MiniPlayerPanel";
import NowPlaying from "./player/NowPlaying";
import QueueButton from "./player/QueueButton";
import Transport from "./player/Transport";
import VolumeControl from "./player/VolumeControl";
import { useMiniPlayerMode } from "./player/useMiniPlayerMode";
import { usePlayerDisplay } from "./player/usePlayerDisplay";

export default function MiniPlayer() {
  const {
    commandPending,
    isRemoteMode,
    isFH6Mode,
    fh6Snapshot,
    displayCurrent,
    displayHasTrack,
    displayPlaying,
    displayTitle,
    displayArtist,
    displayError,
    shownVolume,
    shownMuted,
    shownShuffle,
    shownRepeat,
    transportDisabled,
    progressOverride,
    fh6Transport,
  } = usePlayerDisplay();
  const { setVolume, toggleMute } = usePlayer();
  const { open: lyricsOpen, setOpen: setLyricsOpen } = useLyricsPanel();
  const { isFavorite, toggle: toggleFavorite } = useFavorites();

  const fav = displayCurrent ? isFavorite(displayCurrent.id) : false;
  const { bind: bindCtx, menu: trackCtxMenu } = useTrackContextMenu();
  const {
    miniPlayerMode,
    toggleMiniPlayerMode,
    panel,
    swapDirection,
    anchor,
    barHeight,
    panelToggle,
  } = useMiniPlayerMode();
  const canResizeWindow = canSetMiniPlayer();
  const lyricsToggle = miniPlayerMode ? panelToggle("lyrics") : null;
  // Kept stable between bridge polls so the memoized queue list can skip them.
  const fh6TransportRef = useRef(fh6Transport);
  useEffect(() => {
    fh6TransportRef.current = fh6Transport;
  });
  const fh6Queue = fh6Snapshot?.queue;
  const fh6Index = fh6Snapshot?.currentIndex;
  const externalQueue = useMemo<ExternalQueue | undefined>(
    () =>
      isFH6Mode
        ? {
            title: "Lumen Radio Queue",
            tracks: fh6Queue ?? [],
            currentIndex: fh6Index ?? 0,
            onJump: (index) => void fh6TransportRef.current("jump", { index }),
          }
        : undefined,
    [isFH6Mode, fh6Queue, fh6Index],
  );

  return (
    <div className="player-shell">
      <section
        className={"player-bar" + (miniPlayerMode ? " player-bar-window" : "")}
        aria-label="Player"
        data-has-track={displayHasTrack ? "true" : "false"}
        data-playing={displayPlaying ? "true" : "false"}
        data-mini-panel={(miniPlayerMode && panel) || undefined}
        data-mini-anchor={miniPlayerMode ? anchor : undefined}
        style={
          miniPlayerMode && barHeight
            ? ({ "--mini-bar-h": `${barHeight}px` } as React.CSSProperties)
            : undefined
        }
      >
        {trackCtxMenu}
        <NowPlaying
          track={displayCurrent}
          title={displayTitle}
          artist={displayArtist}
          error={displayError}
          isFH6Mode={isFH6Mode}
          onContextMenu={
            displayCurrent && !isRemoteMode
              ? bindCtx(displayCurrent)
              : undefined
          }
        />

        <Transport
          shuffle={shownShuffle}
          repeat={shownRepeat}
          playing={displayPlaying}
          muted={shownMuted}
          volume={shownVolume}
          isFH6Mode={isFH6Mode}
          commandPending={commandPending}
          transportDisabled={transportDisabled}
          miniPlayerMode={miniPlayerMode}
          progressOverride={progressOverride}
          fh6Transport={fh6Transport}
        />

        <div className="utility">
          <DevicePickerButton
            panel={miniPlayerMode ? panelToggle("devices") : undefined}
          />
          <FavoriteButton
            className="t-btn"
            iconClassName="shrink-0"
            fav={fav}
            disabled={!displayCurrent || isRemoteMode}
            onToggle={() =>
              displayCurrent && void toggleFavorite(displayCurrent.id)
            }
          />
          <button
            type="button"
            className={
              "t-btn" + ((lyricsToggle?.open ?? lyricsOpen) ? " active" : "")
            }
            title="Lyrics"
            aria-label="Toggle lyrics panel"
            aria-pressed={lyricsToggle?.open ?? lyricsOpen}
            aria-controls={lyricsToggle?.controls}
            // The lit tab is the mini panel's close control, so it stays
            // usable if the track goes away while lyrics are showing.
            disabled={!displayCurrent && !lyricsToggle?.open}
            onClick={lyricsToggle?.onToggle ?? (() => setLyricsOpen(!lyricsOpen))}
          >
            <BookOpenIcon className="size-3.5" />
          </button>
          <QueueButton
            externalQueue={externalQueue}
            panel={miniPlayerMode ? panelToggle("queue") : undefined}
          />
          <div className="mini-divider" aria-hidden="true" />
          <VolumeControl
            className="volume"
            muted={shownMuted}
            volume={shownVolume}
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

        {miniPlayerMode && panel && (
          <MiniPlayerPanel
            panel={panel}
            enter={swapDirection}
            externalQueue={externalQueue}
          />
        )}
      </section>
      <RemoteControlIndicator />
    </div>
  );
}
