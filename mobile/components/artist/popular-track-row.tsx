import { memo } from "react";
import type { TrackListItem } from "@music-library/core";
import { RankedTrackRow } from "../library/ranked-track-row";
import { TrackActionsContextMenu } from "../track-actions-menu";

/** Numbered chart row for an artist's popular tracks, with the track menu. */
function PopularTrackRowImpl({
  rank,
  track,
  onPress,
}: {
  rank: number;
  track: TrackListItem;
  onPress: (track: TrackListItem) => void;
}) {
  return (
    <TrackActionsContextMenu track={track}>
      <RankedTrackRow rank={rank} track={track} onPress={onPress} menu />
    </TrackActionsContextMenu>
  );
}

export const PopularTrackRow = memo(PopularTrackRowImpl);
