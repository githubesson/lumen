import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  FadeInLeft,
  FadeInRight,
  FadeOutLeft,
  FadeOutRight,
} from "react-native-reanimated";
import type { TrackListItem } from "@music-library/core";
import { CoverArt } from "../cover-art";

/**
 * Hero cover artwork with a directional cross-fade when the track changes:
 * the outgoing cover slides toward the skip direction while the incoming one
 * fades in from the opposite side. The parent owns positioning and the
 * open/close scale transform; this only renders the swap stage.
 */
export function HeroArtwork({
  track,
  size,
  transitionKey,
  direction,
  style,
}: {
  track: TrackListItem;
  size: number;
  /** Remount key for the swap; album id keeps same-album skips from flashing. */
  transitionKey: string;
  /** 1 when advancing forward in the queue, -1 when going back. */
  direction: 1 | -1;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.stage, style]}>
      <Animated.View
        key={transitionKey}
        entering={
          direction > 0 ? FadeInRight.duration(260) : FadeInLeft.duration(260)
        }
        exiting={
          direction > 0 ? FadeOutLeft.duration(180) : FadeOutRight.duration(180)
        }
        style={styles.layer}
      >
        <View style={styles.shadow}>
          <CoverArt track={track} size={size} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    position: "relative",
  },
  layer: {
    ...StyleSheet.absoluteFillObject,
  },
  shadow: {
    borderRadius: 12,
    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.45)",
  },
});
