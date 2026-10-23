import { type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityValue,
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
 *
 * `disabled` rows ignore taps (no haptic) and read as dimmed to VoiceOver;
 * they stay pressable as an element so a wrapping long-press menu still works.
 *
 * `detailAccessory` goes just before a string `trailing` (a swipe row's
 * favorite mark), and the accessibility actions and value are VoiceOver's
 * way to what a wrapping swipe does.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  detailAccessory,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityValue,
  accessibilityActions,
  onAccessibilityAction,
  disabled = false,
  style,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: string | null;
  trailing?: ReactNode;
  detailAccessory?: ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityValue?: AccessibilityValue;
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityValue={accessibilityValue}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      accessibilityState={disabled ? { disabled } : undefined}
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
        detailAccessory ? (
          <View style={styles.detail}>
            {detailAccessory}
            {detailText(trailing, theme.color.fgMuted)}
          </View>
        ) : (
          detailText(trailing, theme.color.fgMuted)
        )
      ) : (
        (trailing ?? null)
      )}
    </Pressable>
  );
}

function detailText(text: string, color: string) {
  return <Text style={{ fontSize: 13, color }}>{text}</Text>;
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
  detail: {
    flexDirection: "row",
    alignItems: "center",
  },
});
