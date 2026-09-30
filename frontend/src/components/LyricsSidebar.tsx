import { MicVocal as BookOpenIcon, X as XMarkIcon } from "lucide-react";
import { trackCoverUrl, type TrackListItem } from "../api";
import { useLyricsPanel } from "../context/LyricsPanel";
import { usePlayer, usePlayerTime } from "../context/Player";
import { displayText } from "../lib/format";
import { lyricsDurationSeconds, useTrackLyrics } from "../lib/useTrackLyrics";
import { useTransitionMount } from "../lib/useTransitionMount";
import CoverArt from "./CoverArt";
import PlayerLyricsLine from "./PlayerLyricsLine";

export default function LyricsSidebar() {
  const { open, setOpen } = useLyricsPanel();
  const { current } = usePlayer();
  // Keep the content for the sidebar's exit transition, then release its
  // playback-clock subscription while the panel is closed.
  const { mounted } = useTransitionMount(open, 280);

  const coverSrc =
    current && current.has_cover !== false ? trackCoverUrl(current) : null;

  return (
    <aside
      className="lyrics-sidebar"
      aria-label="Lyrics"
      aria-hidden={!open}
      data-open={open ? "true" : "false"}
    >
      <div className="lyrics-sidebar-head">
        <div className="lyrics-sidebar-title">
          <BookOpenIcon className="size-4" aria-hidden="true" />
          <span>Lyrics</span>
        </div>
        <button
          type="button"
          className="iconbtn"
          aria-label="Close lyrics panel"
          title="Close lyrics"
          onClick={() => setOpen(false)}
        >
          <XMarkIcon className="size-4" />
        </button>
      </div>

      {current ? (
        <div className="lyrics-sidebar-track">
          <CoverArt
            className="lyrics-sidebar-art"
            src={coverSrc}
            label={displayText(current.album_title || current.title, "·")}
            size={44}
          />
          <div className="lyrics-sidebar-track-text">
            <div className="lyrics-sidebar-track-title">
              {displayText(current.title)}
            </div>
            <div className="lyrics-sidebar-track-artist">
              {displayText(current.artist, "—")}
              {current.album_title
                ? ` · ${displayText(current.album_title)}`
                : ""}
            </div>
          </div>
        </div>
      ) : (
        <div className="lyrics-sidebar-empty">Nothing playing</div>
      )}

      <div className="lyrics-sidebar-body">
        {mounted && current && <LyricsContent track={current} />}
      </div>
    </aside>
  );
}

function LyricsContent({ track }: { track: TrackListItem }) {
  const { currentTime, duration } = usePlayerTime();
  const { lyrics, loading, error } = useTrackLyrics(track, true);
  return (
    <PlayerLyricsLine
      variant="sidebar"
      lyrics={lyrics}
      loading={loading}
      error={error}
      currentTime={currentTime}
      durationSeconds={lyricsDurationSeconds(track, duration)}
    />
  );
}
