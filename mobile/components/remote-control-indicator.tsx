import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  subscribeRemotePlaybackControl,
  type RemotePlaybackControlEvent,
} from "@music-library/core";
import { useTheme } from "../theme/theme";

const VISIBLE_MS = 6_000;

export function RemoteControlIndicator() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [event, setEvent] = useState<RemotePlaybackControlEvent | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return subscribeRemotePlaybackControl((nextEvent) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setEvent(nextEvent);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setEvent(null);
      }, VISIBLE_MS);
    });
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  if (!event) return null;

  return (
    <View
      pointerEvents="none"
      style={[styles.host, { top: insets.top + 8 }]}
    >
      <Animated.View
        key={event.commandId}
        entering={FadeInDown.duration(180)}
        exiting={FadeOutUp.duration(150)}
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        style={[
          styles.pill,
          {
            backgroundColor: theme.color.bgElev2,
            borderColor:
              theme.scheme === "dark"
                ? "rgba(112,145,255,0.48)"
                : "rgba(63,91,190,0.32)",
            boxShadow:
              theme.scheme === "dark"
                ? "0 8px 24px rgba(0,0,0,0.42)"
                : "0 8px 24px rgba(0,0,0,0.16)",
          },
        ]}
      >
        <SymbolView
          name="iphone.gen3"
          size={14}
          tintColor={theme.color.accent}
        />
        <Text selectable style={[styles.text, { color: theme.color.fg }]}>Controlled from another device</Text>
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
    minHeight: 30,
    paddingHorizontal: 13,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  text: {
    fontSize: 12,
    fontWeight: "600",
  },
});
