import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Slider from "@react-native-community/slider";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";

/**
 * Volume control row: quiet/loud speaker glyphs flanking the native volume
 * slider. Drag updates go straight to `onSetVolume`; the player throttles
 * what it sends to a remote device, and local volume follows the thumb.
 */
export function VolumeRow({
  value,
  onSetVolume,
  style,
}: {
  /** Current volume in 0..1 (pass 0 when muted). */
  value: number;
  onSetVolume: (value: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.row, style]}>
      <SymbolView
        name="speaker.fill"
        size={13}
        tintColor={theme.color.fgMuted}
      />
      <Slider
        style={{ flex: 1, height: 44 }}
        value={value}
        minimumValue={0}
        maximumValue={1}
        step={0.01}
        accessibilityLabel="Volume"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100), text: `${Math.round(value * 100)} percent` }}
        onValueChange={onSetVolume}
        onSlidingComplete={onSetVolume}
        minimumTrackTintColor={theme.color.overlayStrong}
        maximumTrackTintColor={theme.color.overlayMuted}
        thumbTintColor={theme.color.fg}
      />
      <SymbolView
        name="speaker.wave.3.fill"
        size={17}
        tintColor={theme.color.fgMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
