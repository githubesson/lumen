import { memo } from "react";
import type { TrackListItem } from "@music-library/core";
import { RankedTrackRow } from "../library/ranked-track-row";

/** Numbered chart row for an artist's popular tracks (swipes and the track menu included). */
function PopularTrackRowImpl({
  rank,
  track,
  onPress,
}: {
  rank: number;
  track: TrackListItem;
  onPress: (track: TrackListItem) => void;
}) {
  return <RankedTrackRow rank={rank} track={track} onPress={onPress} />;
}

export const PopularTrackRow = memo(PopularTrackRowImpl);
