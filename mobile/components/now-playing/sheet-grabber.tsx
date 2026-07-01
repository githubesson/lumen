import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../../theme/theme";

/**
 * Grabber handle strip at the top of the Now Playing sheet. The whole strip
 * is a tap target that dismisses the screen; the visible bar uses the
 * scheme-aware grabber overlay token.
 */
export function SheetGrabber({
  onPress,
  style,
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.tap, style]}
      accessibilityRole="button"
      accessibilityLabel="Close now playing"
    >
      <View
        style={[styles.grabber, { backgroundColor: theme.color.overlayGrabber }]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tap: {
    alignItems: "center",
    paddingTop: 6,
    paddingBottom: 10,
  },
  grabber: {
    width: 56,
    height: 5,
    borderRadius: 2.5,
  },
});
