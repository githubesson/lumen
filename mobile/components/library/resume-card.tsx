import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { type TrackListItem } from "@music-library/core";
import { AdaptiveGlass } from "../adaptive-glass";
import { CoverArt } from "../cover-art";
import { useTheme } from "../../theme/theme";
import { Eyebrow } from "../eyebrow";

/**
 * Big "pick up where you left off" card for the most recent play. Liquid
 * Glass surface with the artwork flush to the card's left edge so it lines up
 * exactly with the shelf tiles below.
 */
export function ResumeCard({
  track,
  onPress,
  style,
}: {
  track: TrackListItem;
  onPress: (t: TrackListItem) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress(track);
      }}
      accessibilityRole="button"
      accessibilityLabel={`Resume ${track.title}${track.artist ? ` by ${track.artist}` : ""}`}
      style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }, style]}
    >
      <AdaptiveGlass
        interactive
        style={{
          borderRadius: theme.radius.lg,
          borderCurve: "continuous",
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: theme.space.md,
          }}
        >
          <CoverArt track={track} size={84} priority="high" radius={0} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Eyebrow>Jump back in</Eyebrow>
            <Text
              numberOfLines={1}
              style={{ color: theme.color.fg, fontSize: 17, fontWeight: "600" }}
            >
              {track.title}
            </Text>
            {track.artist ? (
              <Text
                numberOfLines={1}
                style={{ color: theme.color.fgMuted, fontSize: 14 }}
              >
                {track.artist}
              </Text>
            ) : null}
          </View>
          <SymbolView
            name="play.circle.fill"
            size={36}
            tintColor={theme.color.accent}
            style={{ marginRight: theme.space.md }}
          />
        </View>
      </AdaptiveGlass>
    </Pressable>
  );
}
