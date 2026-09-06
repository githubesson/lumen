import { SecondaryButton } from "./buttons";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme";

/**
 * Centered muted placeholder for list-empty, loading, and error states.
 * Default is a padded block for `ListEmptyComponent`; `fill` stretches it
 * to a full-screen center for early-return query states.
 */
export function EmptyState({
  loading = false,
  message,
  selectable = false,
  fill = false,
  style,
  action,
}: {
  /** Show a spinner instead of the message. */
  loading?: boolean;
  action?: { label: string; onPress: () => void; disabled?: boolean };
  message?: string;
  /** Allow copying the text (useful for error messages). */
  selectable?: boolean;
  /** Fill the screen and center vertically instead of the padded list block. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        fill
          ? [styles.fill, { backgroundColor: theme.color.bg }]
          : styles.block,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.color.fgMuted} />
      ) : (
        <Text
          selectable={selectable}
          style={{ color: theme.color.fgMuted, textAlign: "center" }}
        >
          {message}
        </Text>
      )}
      {action && !loading && <View style={{ marginTop: 20, minWidth: 140 }}><SecondaryButton {...action} /></View>}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    paddingVertical: 96,
    paddingHorizontal: 32,
    alignItems: "center",
  },
  fill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
