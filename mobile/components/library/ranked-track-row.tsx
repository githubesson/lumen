import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { pluralize, type TrackListItem } from "@music-library/core";
import { CoverArt } from "../cover-art";
import { useTrackRowPresentation } from "../../lib/use-track-row-presentation";
import { useTheme } from "../../theme/theme";

/**
 * Editorial chart row: oversized rank numeral, artwork, then title with the
 * play count (when known) folded into the subtitle so long titles get the
 * full width. `menu`: a wrapping track menu opens on press-and-hold.
 */
export function RankedTrackRow({
  rank,
  track,
  plays,
  onPress,
  menu = false,
  style,
}: {
  rank: number;
  track: TrackListItem;
  plays?: number;
  onPress: (t: TrackListItem) => void;
  menu?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const presentation = useTrackRowPresentation(track, { menu });
  const playsLabel =
    plays == null ? null : pluralize(plays, "play", undefined, { locale: true });
  const subtitle = [presentation.subtitle, playsLabel].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => {
        // Stays pressable when removed, so a wrapping menu still opens.
        if (presentation.removed) return;
        void Haptics.selectionAsync();
        onPress(track);
      }}
      accessibilityRole="button"
      accessibilityLabel={presentation.accessibilityLabel}
      accessibilityHint={presentation.accessibilityHint}
      accessibilityState={presentation.removed ? { disabled: true } : undefined}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm,
          gap: theme.space.md,
          opacity: (presentation.dimmed ? 0.4 : 1) * (pressed ? 0.6 : 1),
        },
        style,
      ]}
    >
      <Text
        style={{
          width: 30,
          color: rank === 1 ? theme.color.accent : theme.color.fgMuted,
          fontSize: 22,
          fontWeight: "700",
          letterSpacing: -0.5,
          fontVariant: ["tabular-nums"],
          textAlign: "center",
        }}
      >
        {rank}
      </Text>
      <CoverArt track={track} size={48} transitionMs={0} priority="low" />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fg, fontSize: 16, fontWeight: "500" }}
        >
          {presentation.title}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: theme.color.fgMuted,
            fontSize: 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}
