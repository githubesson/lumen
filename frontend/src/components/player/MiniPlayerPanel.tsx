import { usePlayer, usePlayerTime, useRemotePlayback } from "../../context/Player";
import { lyricsDurationSeconds, useTrackLyrics } from "../../lib/useTrackLyrics";
import { DeviceConnectionStatus, DeviceList } from "../PlaybackDevicePopover";
import PlayerLyricsLine from "../PlayerLyricsLine";
import {
  QueueList,
  useQueuePosition,
  type ExternalQueue,
} from "../QueuePopover";
import {
  useContextMenuClickGuard,
  useTrackContextMenu,
} from "../../lib/useTrackContextMenu";
import { MINI_PANEL_ID, type MiniPanel } from "./useMiniPlayerMode";

const TITLES: Record<MiniPanel, string> = {
  devices: "Play on",
  lyrics: "Lyrics",
  queue: "Queue",
};

const LABELS: Record<MiniPanel, string> = {
  devices: "Playback device",
  lyrics: "Lyrics",
  queue: "Play queue",
};

/**
 * The mini player's side panel: the queue, lyrics or device list the utility
 * buttons used to open as popovers. Renders two items of the player grid, a
 * heading beside the utility row and the body under it. `enter` slides a
 * panel swapped in for another from the side its button sits on.
 */
export default function MiniPlayerPanel({
  panel,
  enter,
  externalQueue,
}: {
  panel: MiniPanel;
  enter?: "forward" | "back";
  externalQueue?: ExternalQueue;
}) {
  const position = useQueuePosition(externalQueue);
  const title =
    panel === "queue" && externalQueue ? externalQueue.title : TITLES[panel];

  return (
    <>
      <div className="mini-panel-head" key={panel} data-enter={enter}>
        <span className="mini-panel-title">{title}</span>
        {panel === "queue" && position && (
          <span className="queue-pop-pos">{position}</span>
        )}
        {panel === "devices" && <DeviceConnectionStatus />}
      </div>
      <div
        className="mini-panel-body"
        id={MINI_PANEL_ID}
        role="region"
        aria-label={LABELS[panel]}
      >
        <div
          key={panel}
          className={"mini-panel-content mini-panel-" + panel}
          data-enter={enter}
        >
          {panel === "queue" ? (
            <MiniQueue externalQueue={externalQueue} />
          ) : panel === "lyrics" ? (
            <MiniLyrics />
          ) : (
            <DeviceList />
          )}
        </div>
      </div>
    </>
  );
}

function MiniQueue({ externalQueue }: { externalQueue?: ExternalQueue }) {
  const { targetDevice } = useRemotePlayback();
  // Only this app's own queue gets the row menu, as in the queue popover.
  const { bind, menu } = useTrackContextMenu();
  const canContext = !externalQueue && !targetDevice;
  // A click that dismisses an open menu mustn't also play the row under it.
  const clickGuard = useContextMenuClickGuard();
  return (
    <div
      onMouseDownCapture={clickGuard.onMouseDownCapture}
      onClickCapture={clickGuard.onClickCapture}
    >
      <QueueList
        externalQueue={externalQueue}
        bindCtx={canContext ? bind : undefined}
      />
      {menu}
    </div>
  );
}

function MiniLyrics() {
  const { current } = usePlayer();
  const { currentTime, duration } = usePlayerTime();
  const { lyrics, loading, error } = useTrackLyrics(current, true);

  if (!current) {
    return (
      <p className="player-lyric-status player-lyric-sidebar">
        Nothing playing
      </p>
    );
  }
  return (
    <PlayerLyricsLine
      variant="sidebar"
      lyrics={lyrics}
      loading={loading}
      error={error}
      currentTime={currentTime}
      durationSeconds={lyricsDurationSeconds(current, duration)}
    />
  );
}
