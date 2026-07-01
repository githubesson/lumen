import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { AdaptiveGlass } from "../adaptive-glass";
import {
  AirPlayRoutePickerView,
  isAirPlayRoutePickerAvailable,
} from "../../modules/air-play-route-picker";
import { useTheme } from "../../theme/theme";
import { GlassIconButton } from "./glass-icon-button";

/**
 * AirPlay affordance for the Now Playing bottom toolbar: the native route
 * picker inside a glass circle when the module is built in, otherwise a
 * plain glass icon button that just warns in dev.
 */
export function AirPlayButton({ style }: { style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();

  if (!isAirPlayRoutePickerAvailable()) {
    return (
      <GlassIconButton
        icon="airplayaudio"
        iconSize={26}
        size={44}
        hitSlop={14}
        tintColor={theme.color.fgMuted}
        accessibilityLabel="AirPlay"
        onPress={() => {
          void Haptics.selectionAsync();
          if (__DEV__) {
            console.warn(
              "AirPlayRoutePicker is not available. Rebuild the iOS app to include the native route picker module.",
            );
          }
        }}
        style={style}
      />
    );
  }

  return (
    <AdaptiveGlass style={[styles.glass, style]} interactive>
      <AirPlayRoutePickerView
        accessibilityLabel="AirPlay"
        activeTintColor={theme.color.fg}
        prioritizesVideoDevices={false}
        style={styles.button}
        tintColor={theme.color.fgMuted}
      />
    </AdaptiveGlass>
  );
}

/**
 * Queue show/hide toggle for the bottom toolbar: a glass circle whose icon
 * highlights while the queue is open and wears a small shuffle badge when
 * shuffle is on.
 */
export function QueueToggleButton({
  queueOpen,
  shuffle,
  onPress,
  style,
}: {
  queueOpen: boolean;
  shuffle: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const label = queueOpen
    ? "Hide queue"
    : shuffle
      ? "Show queue, shuffle on"
      : "Show queue";

  return (
    <AdaptiveGlass style={[styles.glass, style]} interactive>
      <Pressable
        onPress={onPress}
        hitSlop={14}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: queueOpen || shuffle }}
        style={({ pressed }) => [
          styles.button,
          { opacity: pressed ? 0.55 : 1 },
        ]}
      >
        <QueueButtonLabel queueOpen={queueOpen} shuffle={shuffle} />
      </Pressable>
    </AdaptiveGlass>
  );
}

function QueueButtonLabel({
  queueOpen,
  shuffle,
}: {
  queueOpen: boolean;
  shuffle: boolean;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.button, styles.queueButton]}>
      <View
        style={
          queueOpen
            ? [
                styles.queueButtonSelected,
                {
                  backgroundColor:
                    theme.scheme === "dark"
                      ? "rgba(255,255,255,0.16)"
                      : "rgba(255,255,255,0.72)",
                },
              ]
            : undefined
        }
      >
        <SymbolView
          name="list.bullet"
          size={26}
          tintColor={queueOpen ? theme.color.fg : theme.color.fgMuted}
        />
        {shuffle ? (
          <View
            style={[
              styles.shuffleBadge,
              { backgroundColor: theme.color.overlayMuted },
            ]}
          >
            <SymbolView
              name="shuffle"
              size={9}
              weight="bold"
              tintColor={theme.color.fg}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  glass: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: "hidden",
  },
  button: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  queueButton: {
    minWidth: 42,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  queueButtonSelected: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  shuffleBadge: {
    position: "absolute",
    top: -6,
    right: -8,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
});
