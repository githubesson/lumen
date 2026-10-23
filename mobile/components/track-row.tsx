import { memo } from "react";
import type { TrackListItem } from "@music-library/core";
import { CoverArt } from "./cover-art";
import { ListRow } from "./list-row";
import { SwipeableTrackRow } from "./swipe/swipeable-track-row";
import { formatDurationMs } from "../lib/format";
import { useTrackRowPresentation } from "../lib/use-track-row-presentation";

interface Props {
  track: TrackListItem;
  onPress: (track: TrackListItem) => void;
  /**
   * The row is in the Favorites list: swiping it to Unfavorite leaves a
   * "Removed · Undo" strip in its place, and it carries no favorite heart
   * (everything there is one).
   */
  inFavorites?: boolean;
  /** May carry the first-run swipe peek (off for a hidden, mounted list). */
  peekable?: boolean;
}

/**
 * One row in long virtualized track lists. Height is fixed so recycling and
 * scroll-window calculations stay predictable (only the Favorites list's
 * Undo strip changes it, for a few seconds). Swipe right for Play Next, left
 * to favorite; press and hold for the track menu.
 */
function TrackRowImpl({ track, onPress, inFavorites = false, peekable = true }: Props) {
  const presentation = useTrackRowPresentation(track);
  return (
    <SwipeableTrackRow track={track} inFavorites={inFavorites} peekable={peekable}>
      {(swipe) => (
        <ListRow
          style={presentation.dimmed ? { opacity: 0.4 } : undefined}
          onPress={() => onPress(track)}
          disabled={presentation.removed}
          accessibilityLabel={presentation.accessibilityLabel}
          accessibilityHint={presentation.accessibilityHint}
          accessibilityValue={swipe.accessibilityValue}
          accessibilityActions={swipe.accessibilityActions}
          onAccessibilityAction={swipe.onAccessibilityAction}
          leading={<CoverArt track={track} size={40} transitionMs={0} priority="low" />}
          title={presentation.title}
          subtitle={presentation.subtitle}
          trailing={formatDurationMs(track.duration_ms)}
          detailAccessory={swipe.favoriteMark()}
        />
      )}
    </SwipeableTrackRow>
  );
}

export const TrackRow = memo(TrackRowImpl);
