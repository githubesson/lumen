import type { TrackListItem } from "@music-library/core";
import { trackCoverUrl } from "../../api";
import { displayText } from "../../lib/format";
import CoverArt from "../CoverArt";

export default function NowPlaying({
  track,
  title,
  artist,
  isFH6Mode,
  onContextMenu,
}: {
  track: TrackListItem | null;
  title: string;
  artist: string;
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
        <div className="np-artist" title={artist}>{artist}</div>
      </div>
    </div>
  );
}
