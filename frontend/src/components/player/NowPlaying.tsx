import type { TrackListItem } from "@music-library/core";
import { trackCoverUrl } from "../../api";
import { displayText } from "../../lib/format";
import CoverArt from "../CoverArt";

export default function NowPlaying({
  track,
  title,
  artist,
  error,
  isFH6Mode,
  onContextMenu,
}: {
  track: TrackListItem | null;
  title: string;
  artist: string;
  /** Why the track stopped playing; shown in place of the artist. */
  error?: string | null;
  isFH6Mode: boolean;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const coverSrc = track ? trackCoverUrl(track) : null;
  return (
    <div className="np" onContextMenu={onContextMenu}>
      <CoverArt
        className="np-art"
        src={coverSrc}
        label={
          isFH6Mode
            ? "Lumen Radio"
            : displayText(track?.album_title || track?.title, "·")
        }
        forcePlaceholder={!track}
      />
      <div className="np-text">
        <div className="np-title" title={title}>{title}</div>
        <div
          className={"np-artist" + (error ? " np-error" : "")}
          title={error || artist}
        >
          {/* Always rendered, so screen readers announce a failure as it
              appears rather than only when they reach the line. */}
          <span role="status">{error}</span>
          {!error && artist}
        </div>
      </div>
    </div>
  );
}
