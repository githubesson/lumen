import { memo } from "react";
import { displayText, type TrackListItem } from "@music-library/core";
import { CoverArt } from "./cover-art";
import { ListRow } from "./list-row";
import { TrackActionsContextMenu } from "./track-actions-menu";
import { formatDurationMs } from "../lib/format";
import { useTrackUnavailableOffline } from "../lib/offline-mode";

interface Props {
  track: TrackListItem;
  onPress: (track: TrackListItem) => void;
}

/**
 * One row in long virtualized track lists. Height is fixed so recycling and
 * scroll-window calculations stay predictable.
 */
function TrackRowImpl({ track, onPress }: Props) {
  const unavailableOffline = useTrackUnavailableOffline(track.id);
  // track.unavailable: no longer on TIDAL and not in the library.
  const unavailable = unavailableOffline || !!track.unavailable;
  const title = displayText(track.title);
  const artist = displayText(track.artist);
  const row = (
    <ListRow
      style={unavailable ? { opacity: 0.4 } : undefined}
      onPress={() => onPress(track)}
      accessibilityLabel={artist ? `${title} by ${artist}` : title}
      accessibilityHint="Double tap to play. Press and hold for more actions."
      leading={<CoverArt track={track} size={40} transitionMs={0} priority="low" />}
      title={title}
      subtitle={track.unavailable ? "Removed from TIDAL" : artist}
      trailing={formatDurationMs(track.duration_ms)}
    />
  );

  return <TrackActionsContextMenu track={track}>{row}</TrackActionsContextMenu>;
}

export const TrackRow = memo(TrackRowImpl);
