import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";

/**
 * Friendly zero-plays placeholder for a Replay window: sparkles glyph,
 * headline, and a nudge toward the Library tab.
 */
export function ReplayEmptyState({
  style,
}: {
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.xl * 2,
          alignItems: "center",
          gap: theme.space.md,
        },
        style,
      ]}
    >
      <SymbolView name="sparkles" size={48} tintColor={theme.color.fgMuted} />
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 17,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        No plays in this window yet
      </Text>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 14,
          textAlign: "center",
          maxWidth: 280,
        }}
      >
        Listen to some music from the Library tab and your stats will show up
        here.
      </Text>
    </View>
  );
}
