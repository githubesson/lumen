import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import type { TrackListItem } from "@music-library/core";
import { Card } from "../primitives";
import { CoverArt } from "../cover-art";
import { useTheme } from "../../theme/theme";
import { HairlineSeparator } from "../hairline-separator";

/**
 * Card of ranked top-track rows (rank number, cover, title/artist, play
 * count) separated by inset hairlines. Tapping a row hands the track to the
 * caller's play handler.
 */
export function TopTrackList({
  tracks,
  playsById,
  onTrackPress,
  style,
}: {
  tracks: TrackListItem[];
  playsById: Map<string, number>;
  onTrackPress: (t: TrackListItem) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card style={[{ overflow: "hidden" }, style]}>
      {tracks.map((t, i) => (
        <View key={t.id}>
          {i > 0 && <HairlineSeparator inset={64} />}
          <TopTrackRow
            rank={i + 1}
            track={t}
            plays={playsById.get(t.id) ?? 0}
            onPress={onTrackPress}
          />
        </View>
      ))}
    </Card>
  );
}

function TopTrackRow({
  rank,
  track,
  plays,
  onPress,
}: {
  rank: number;
  track: TrackListItem;
  plays: number;
  onPress: (t: TrackListItem) => void;
}) {
  const theme = useTheme();
  const handlePress = () => {
    void Haptics.selectionAsync();
    onPress(track);
  };
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        track.artist ? `${track.title} by ${track.artist}` : track.title
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        height: theme.row.height,
        paddingHorizontal: theme.space.lg,
        gap: theme.space.md,
        backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
      })}
    >
      <Text
        style={{
          width: 22,
          color: theme.color.fgMuted,
          fontSize: 13,
          fontVariant: ["tabular-nums"],
          textAlign: "right",
        }}
      >
        {rank}
      </Text>
      <CoverArt track={track} size={40} transitionMs={0} priority="low" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fg, fontSize: 16, fontWeight: "500" }}
        >
          {track.title}
        </Text>
        {track.artist ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.color.fgMuted, fontSize: 13 }}
          >
            {track.artist}
          </Text>
        ) : null}
      </View>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 13,
          fontVariant: ["tabular-nums"],
        }}
      >
        {plays.toLocaleString()}
      </Text>
    </Pressable>
  );
}
