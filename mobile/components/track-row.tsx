import { memo } from "react";
import type { TrackListItem } from "@music-library/core";
import { CoverArt } from "./cover-art";
import { ListRow } from "./list-row";
import { TrackActionsContextMenu } from "./track-actions-menu";
import { formatDurationMs } from "../lib/format";
import { useTrackRowPresentation } from "../lib/use-track-row-presentation";

interface Props {
  track: TrackListItem;
  onPress: (track: TrackListItem) => void;
}

/**
 * One row in long virtualized track lists. Height is fixed so recycling and
 * scroll-window calculations stay predictable.
 */
function TrackRowImpl({ track, onPress }: Props) {
  const presentation = useTrackRowPresentation(track);
  const row = (
    <ListRow
      style={presentation.dimmed ? { opacity: 0.4 } : undefined}
      onPress={() => onPress(track)}
      disabled={presentation.removed}
      accessibilityLabel={presentation.accessibilityLabel}
      accessibilityHint={presentation.accessibilityHint}
      leading={<CoverArt track={track} size={40} transitionMs={0} priority="low" />}
      title={presentation.title}
      subtitle={presentation.subtitle}
      trailing={formatDurationMs(track.duration_ms)}
    />
  );

  return <TrackActionsContextMenu track={track}>{row}</TrackActionsContextMenu>;
}

export const TrackRow = memo(TrackRowImpl);
