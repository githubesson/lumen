import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsOffline, useOfflineForced } from "../lib/offline-mode";
import { useTheme } from "../theme/theme";

/**
 * Small non-interactive pill overlaid on the tab screens while the app is
 * offline (connectivity loss or the Settings "Offline mode" switch). Plain
 * views — the UIVisualEffectView opacity caveat (see bottom-dock) doesn't
 * apply here, so entering/exiting fades are safe.
 */
export function OfflineBanner() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const offline = useIsOffline();
  const forced = useOfflineForced();

  if (!offline) return null;

  return (
    <View pointerEvents="none" style={[styles.host, { top: insets.top + 4 }]}>
      <Animated.View
        entering={FadeInDown.duration(180)}
        exiting={FadeOutUp.duration(150)}
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        style={[
          styles.pill,
          {
            backgroundColor: theme.color.bgElev2,
            borderRadius: theme.radius.lg,
            paddingVertical: theme.space.sm,
            paddingHorizontal: theme.space.md,
          },
        ]}
      >
        <SymbolView
          name="wifi.slash"
          size={13}
          tintColor={theme.color.fgMuted}
        />
        <Text style={[styles.text, { color: theme.color.fg }]}>
          {forced ? "Offline mode on" : "Offline — showing downloaded music"}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 999,
    alignItems: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderCurve: "continuous",
  },
  text: {
    fontSize: 13,
    fontWeight: "500",
  },
});
