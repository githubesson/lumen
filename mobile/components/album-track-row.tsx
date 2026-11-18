import { memo } from "react";
import { Text, View } from "react-native";
import { creditsOnly, type TrackListItem } from "@music-library/core";
import { ListRow } from "./list-row";
import { NowPlayingBars } from "./now-playing-bars";
import { SwipeableTrackRow } from "./swipe/swipeable-track-row";
import { formatDurationMs } from "../lib/format";
import { useTrackRowPresentation } from "../lib/use-track-row-presentation";
import { useTheme } from "../theme/theme";

/** Room for a three-digit position. */
const NUMBER_WIDTH = 28;

interface Props {
  track: TrackListItem;
  /** The track's place on the album, from 1. */
  number: number;
  /** The album's credited artists: a track crediting only them shows no artist line. */
  albumArtists: readonly string[];
  /** The player's current track: bars in place of the number, the title tinted. */
  current: boolean;
  /** The current track is playing, so the bars move. */
  playing: boolean;
  onPress: (track: TrackListItem) => void;
}

/**
 * A row on an album page. Every row there shares the cover, so the place on
 * the album leads instead, and the artist line only shows for a track that
 * credits someone besides the album's artists (a feature). Swipes and the
 * press-and-hold menu are the ones every track row has.
 */
function AlbumTrackRowImpl({ track, number, albumArtists, current, playing, onPress }: Props) {
  const theme = useTheme();
  const presentation = useTrackRowPresentation(track);
  const subtitle = presentation.removed
    ? presentation.subtitle
    : creditsOnly(track.artist, albumArtists)
      ? null
      : presentation.artist;
  const label = current
    ? `${presentation.accessibilityLabel}, ${playing ? "now playing" : "paused"}`
    : presentation.accessibilityLabel;
  return (
    <SwipeableTrackRow track={track}>
      {(swipe) => (
        <ListRow
          style={presentation.dimmed ? { opacity: 0.4 } : undefined}
          onPress={() => onPress(track)}
          disabled={presentation.removed}
          accessibilityLabel={label}
          accessibilityHint={presentation.accessibilityHint}
          accessibilityValue={swipe.accessibilityValue}
          accessibilityActions={swipe.accessibilityActions}
          onAccessibilityAction={swipe.onAccessibilityAction}
          leading={
            <View style={{ width: NUMBER_WIDTH, alignItems: "center" }}>
              {current ? (
                <NowPlayingBars playing={playing} color={theme.color.accent} />
              ) : (
                <Text
                  style={{
                    fontSize: 15,
                    color: theme.color.fgMuted,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {number}
                </Text>
              )}
            </View>
          }
          title={presentation.title}
          titleColor={current ? theme.color.accent : undefined}
          subtitle={subtitle}
          trailing={formatDurationMs(track.duration_ms)}
          detailAccessory={swipe.favoriteMark()}
        />
      )}
    </SwipeableTrackRow>
  );
}

export const AlbumTrackRow = memo(AlbumTrackRowImpl);
