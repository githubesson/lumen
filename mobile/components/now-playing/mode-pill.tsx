import {
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { AdaptiveGlass } from "../adaptive-glass";
import { useTheme } from "../../theme/theme";

/**
 * Wide glass pill for a queue playback mode (shuffle, repeat). Selection is
 * shown by brightening the translucent fill and the icon tint; the pill
 * flexes to share its row with its siblings.
 */
export function ModePill({
  icon,
  selected,
  accessibilityLabel,
  onPress,
  style,
}: {
  icon: SymbolViewProps["name"];
  selected: boolean;
  accessibilityLabel: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const backgroundColor = selected
    ? theme.scheme === "dark"
      ? "rgba(255,255,255,0.22)"
      : "rgba(255,255,255,0.72)"
    : theme.scheme === "dark"
      ? "rgba(255,255,255,0.10)"
      : "rgba(255,255,255,0.18)";

  return (
    <AdaptiveGlass style={[styles.shell, style]} interactive>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [
          styles.inner,
          { backgroundColor, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <SymbolView
          name={icon}
          size={20}
          weight="regular"
          tintColor={selected ? theme.color.fg : theme.color.fgSubtle}
        />
      </Pressable>
    </AdaptiveGlass>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    overflow: "hidden",
  },
  inner: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
