import { type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme";

/**
 * Shared shell for square shelf tiles in horizontal rails: fixed width,
 * pressed fade, and artwork above a one-line title with an optional muted
 * subtitle. Callers supply the artwork, press semantics (including any
 * haptic), and the tile width their shelf uses.
 */
export function ShelfTile({
  artwork,
  title,
  subtitle,
  subtitleTabular = false,
  subtitleAccessory,
  width,
  accessibilityLabel,
  onPress,
  style,
}: {
  artwork: ReactNode;
  title: string;
  subtitle?: string;
  /** Render the subtitle with tabular digits (used for bare play counts). */
  subtitleTabular?: boolean;
  /** Small glyph after the subtitle, e.g. a downloaded badge. */
  subtitleAccessory?: ReactNode;
  width: number;
  accessibilityLabel: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.7 : 1 }, style]}
    >
      {artwork}
      <Text
        numberOfLines={1}
        style={{
          color: theme.color.fg,
          fontSize: 14,
          fontWeight: "500",
          marginTop: 8,
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text
            numberOfLines={1}
            style={[
              { color: theme.color.fgMuted, fontSize: 12, flexShrink: 1 },
              subtitleTabular && { fontVariant: ["tabular-nums" as const] },
            ]}
          >
            {subtitle}
          </Text>
          {subtitleAccessory}
        </View>
      ) : null}
    </Pressable>
  );
}
