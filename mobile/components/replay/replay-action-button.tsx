import { type ComponentProps } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";

/**
 * Quiet full-width action row for the bottom of the Replay screen (generate
 * playlist, share image): icon + label on an elevated surface, with a spinner
 * while the action is in flight.
 */
export function ReplayActionButton({
  icon,
  label,
  accessibilityLabel,
  busy,
  onPress,
  style,
}: {
  icon: ComponentProps<typeof SymbolView>["name"];
  label: string;
  accessibilityLabel: string;
  busy: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        {
          backgroundColor: theme.color.bgElev1,
          borderRadius: theme.radius.md,
          borderCurve: "continuous",
          minHeight: 48,
          paddingVertical: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          opacity: pressed || busy ? 0.6 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={theme.color.fgMuted} />
      ) : (
        <SymbolView name={icon} size={18} tintColor={theme.color.fg} />
      )}
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 16,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
