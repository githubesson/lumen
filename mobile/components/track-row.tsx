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
  // track.unavailable: no longer on TIDAL and not in the library. A tap does
  // nothing, so the row is disabled. A track that isn't downloaded while
  // offline stays tappable: the tap explains why it can't play.
  const removed = !!track.unavailable;
  const title = displayText(track.title);
  const artist = displayText(track.artist);
  const label = artist ? `${title} by ${artist}` : title;
  const row = (
    <ListRow
      style={removed || unavailableOffline ? { opacity: 0.4 } : undefined}
      onPress={() => onPress(track)}
      disabled={removed}
      accessibilityLabel={removed ? `${label}, removed from TIDAL` : label}
      accessibilityHint={
        removed
          ? "Press and hold for more actions."
          : unavailableOffline
            ? "Not downloaded, so it can't play offline. Press and hold for more actions."
            : "Double tap to play. Press and hold for more actions."
      }
      leading={<CoverArt track={track} size={40} transitionMs={0} priority="low" />}
      title={title}
      subtitle={removed ? "Removed from TIDAL" : artist}
      trailing={formatDurationMs(track.duration_ms)}
    />
  );

  return <TrackActionsContextMenu track={track}>{row}</TrackActionsContextMenu>;
}

export const TrackRow = memo(TrackRowImpl);
