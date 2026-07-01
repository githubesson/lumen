import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated";
import type { TrackListItem } from "@music-library/core";
import { useTheme } from "../../theme/theme";

/**
 * Hero title/artist block that cross-fades vertically when the track changes.
 * The parent owns absolute positioning and the open/close scale; this only
 * renders the fixed-height swap stage so the layers can overlap mid-swap.
 */
export function HeroMeta({
  track,
  style,
}: {
  track: TrackListItem;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.stage, style]}>
      <Animated.View
        key={track.id}
        entering={FadeInDown.duration(240)}
        exiting={FadeOutUp.duration(160)}
        style={styles.layer}
      >
        <View style={styles.titleLine}>
          <Text
            numberOfLines={1}
            selectable
            style={{
              color: theme.color.fg,
              fontSize: 22,
              fontWeight: "700",
              letterSpacing: -0.3,
              flexShrink: 1,
            }}
          >
            {track.title}
          </Text>
        </View>
        {track.artist ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.color.fgMuted, fontSize: 17 }}
          >
            {track.artist}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    minHeight: 48,
    position: "relative",
  },
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    gap: 2,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});
