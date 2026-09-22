import RemoteControlIndicator from "./RemoteControlIndicator";
import {
  Minimize2 as ArrowsPointingInIcon,
  Maximize2 as ArrowsPointingOutIcon,
  MicVocal as BookOpenIcon,
} from "lucide-react";
import { useTrackContextMenu } from "./TrackContextMenu";
import { FavoriteButton } from "./TrackRowCells";
import { useFavorites } from "../context/Favorites";
import { useLyricsPanel } from "../context/LyricsPanel";
import { usePlayer } from "../context/Player";
import { canSetMiniPlayer } from "../lib/platform";
import DevicePickerButton from "./player/DevicePickerButton";
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
  const { miniPlayerMode, toggleMiniPlayerMode } = useMiniPlayerMode();
  const canResizeWindow = canSetMiniPlayer();

  return (
    <div className="player-shell">
      <section
        className={"player-bar" + (miniPlayerMode ? " player-bar-window" : "")}
        aria-label="Player"
        data-has-track={displayHasTrack ? "true" : "false"}
        data-playing={displayPlaying ? "true" : "false"}
      >
        {trackCtxMenu}
        <NowPlaying
          track={displayCurrent}
          title={displayTitle}
          artist={displayArtist}
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
          <DevicePickerButton miniPlayerMode={miniPlayerMode} />
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
            className={"t-btn" + (lyricsOpen ? " active" : "")}
            title="Lyrics"
            aria-label="Toggle lyrics panel"
            aria-pressed={lyricsOpen}
            disabled={!displayCurrent}
            onClick={() => setLyricsOpen(!lyricsOpen)}
          >
            <BookOpenIcon className="size-3.5" />
          </button>
          <QueueButton
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
      </section>
      <RemoteControlIndicator />
    </div>
  );
}
