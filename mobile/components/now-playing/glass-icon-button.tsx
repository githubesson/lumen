import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { AdaptiveGlass } from "../adaptive-glass";
import { useTheme } from "../../theme/theme";

/**
 * Round Liquid Glass icon button floating over the Now Playing surface (the
 * favorite chip, the AirPlay fallback). One parameterized shape instead of a
 * hand-rolled variant per size; tint defaults to the primary foreground.
 */
export function GlassIconButton({
  icon,
  iconSize,
  accessibilityLabel,
  onPress,
  size = 36,
  weight,
  tintColor,
  hitSlop,
  style,
}: {
  icon: SymbolViewProps["name"];
  iconSize: number;
  accessibilityLabel: string;
  onPress: () => void;
  /** Diameter of the glass circle. */
  size?: number;
  weight?: SymbolViewProps["weight"];
  tintColor?: string;
  hitSlop?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <AdaptiveGlass
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: "hidden",
        },
        style,
      ]}
      interactive
    >
      <Pressable
        onPress={onPress}
        hitSlop={hitSlop}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => ({
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.55 : 1,
        })}
      >
        <SymbolView
          name={icon}
          size={iconSize}
          weight={weight}
          tintColor={tintColor ?? theme.color.fg}
        />
      </Pressable>
    </AdaptiveGlass>
  );
}
