import { memo } from "react";
import type { TrackListItem } from "@music-library/core";
import { CoverArt } from "./cover-art";
import { ListRow } from "./list-row";
import { TrackActionsContextMenu } from "./track-actions-menu";
import { formatDurationMs } from "../lib/format";

interface Props {
  track: TrackListItem;
  onPress: (track: TrackListItem) => void;
}

/**
 * One row in long virtualized track lists. Height is fixed so recycling and
 * scroll-window calculations stay predictable.
 */
function TrackRowImpl({ track, onPress }: Props) {
  const row = (
    <ListRow
      onPress={() => onPress(track)}
      accessibilityLabel={
        track.artist ? `${track.title} by ${track.artist}` : track.title
      }
      accessibilityHint="Double tap to play. Press and hold for more actions."
      leading={<CoverArt track={track} size={40} transitionMs={0} priority="low" />}
      title={track.title}
      subtitle={track.artist}
      trailing={formatDurationMs(track.duration_ms)}
    />
  );

  return <TrackActionsContextMenu track={track}>{row}</TrackActionsContextMenu>;
}

export const TrackRow = memo(TrackRowImpl);
