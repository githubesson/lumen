import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { AdaptiveGlass } from "../adaptive-glass";
import { useTheme } from "../../theme/theme";

const HEADER_CAPSULE_HEIGHT = 44;
const HEADER_ACTION_WIDTH = 54;

/**
 * Glass capsule for the home header's right slot: search and upload actions
 * separated by a hairline divider. The wrapper nudges the capsule toward the
 * screen edge so it sits flush with the large title's margin.
 */
export function HomeHeaderCapsule({
  onSearchPress,
  onUploadPress,
  style,
}: {
  onSearchPress: () => void;
  onUploadPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const dividerColor =
    theme.scheme === "dark" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.14)";
  return (
    <View style={[styles.wrap, style]}>
      <AdaptiveGlass style={styles.capsule}>
        <View style={styles.row}>
          <Pressable
            onPress={onSearchPress}
            accessibilityRole="button"
            accessibilityLabel="Search your library"
            style={({ pressed }) => [
              styles.button,
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <SymbolView
              name="magnifyingglass"
              size={21}
              weight="semibold"
              tintColor={theme.color.fg}
            />
          </Pressable>
          <View style={[styles.divider, { backgroundColor: dividerColor }]} />
          <Pressable
            onPress={onUploadPress}
            accessibilityRole="button"
            accessibilityLabel="Upload music"
            style={({ pressed }) => [
              styles.button,
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <SymbolView name="plus" size={24} tintColor={theme.color.fg} />
          </Pressable>
        </View>
      </AdaptiveGlass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: HEADER_CAPSULE_HEIGHT,
    overflow: "hidden",
    transform: [{ translateX: 8 }],
  },
  capsule: {
    height: HEADER_CAPSULE_HEIGHT,
    borderRadius: HEADER_CAPSULE_HEIGHT / 2,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  button: {
    width: HEADER_ACTION_WIDTH,
    height: HEADER_CAPSULE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    opacity: 0.7,
  },
});
