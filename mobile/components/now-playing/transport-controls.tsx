import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useTheme } from "../../theme/theme";

/**
 * The big previous / play-pause / next row. Haptics live here (light for
 * skips, medium for play/pause) so callers only wire the player actions.
 * Base layout spreads the buttons evenly; the tablet call site overrides
 * with a fixed centered gap via `style`.
 */
export function TransportControls({
  isPlaying,
  onPrev,
  onToggle,
  onNext,
  style,
}: {
  isPlaying: boolean;
  onPrev: () => void;
  onToggle: () => void;
  onNext: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.row, style]}>
      <TransportButton
        icon="backward.fill"
        accessibilityLabel="Previous track"
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPrev();
        }}
      />
      <TransportButton
        icon={isPlaying ? "pause.fill" : "play.fill"}
        accessibilityLabel={isPlaying ? "Pause" : "Play"}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onToggle();
        }}
      />
      <TransportButton
        icon="forward.fill"
        accessibilityLabel="Next track"
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onNext();
        }}
      />
    </View>
  );
}

/** One 44pt transport glyph with the shared pressed-opacity treatment. */
function TransportButton({
  icon,
  accessibilityLabel,
  onPress,
}: {
  icon: SymbolViewProps["name"];
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={16}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
    >
      <SymbolView name={icon} size={44} tintColor={theme.color.fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
  },
});
