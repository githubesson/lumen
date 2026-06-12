import { type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "../theme/theme";

/**
 * Shared chrome for rows in long virtualized lists: fixed theme height (so
 * recycling and scroll-window math stay predictable), pressed highlight,
 * selection haptic, and the title/subtitle text styles. Rows supply only the
 * leading visual, strings, and an optional trailing accessory (a plain string
 * renders as the standard muted detail text).
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: string | null;
  trailing?: ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        styles.row,
        {
          height: theme.row.height,
          paddingHorizontal: theme.space.lg,
          gap: theme.space.md,
          backgroundColor: pressed ? theme.color.bgElev1 : "transparent",
        },
        style,
      ]}
    >
      {leading}
      <View style={styles.body}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 16, fontWeight: "500", color: theme.color.fg }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: 13, color: theme.color.fgMuted }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {typeof trailing === "string" ? (
        <Text style={{ fontSize: 13, color: theme.color.fgMuted }}>
          {trailing}
        </Text>
      ) : (
        (trailing ?? null)
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
});
