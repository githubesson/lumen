import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";

/**
 * Tall full-width share-destination button with a leading SF Symbol (or a
 * spinner while loading). `primary` fills it with the accent for the featured
 * destination; otherwise it's a bordered elevated surface.
 */
export function ShareActionButton({
  label,
  icon,
  primary = false,
  disabled = false,
  loading = false,
  onPress,
  style,
}: {
  label: string;
  icon: "camera" | "square.and.arrow.up" | "doc.on.doc";
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();

  return (
    <Pressable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          opacity: disabled ? 0.45 : pressed ? 0.68 : 1,
          backgroundColor: primary ? theme.color.accent : theme.color.bgElev1,
          borderColor: primary ? theme.color.accent : theme.color.separator,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.color.onAccent} />
      ) : (
        <SymbolView
          name={icon}
          size={18}
          weight="semibold"
          tintColor={primary ? theme.color.onAccent : theme.color.fg}
        />
      )}
      <Text
        style={{
          color: primary ? theme.color.onAccent : theme.color.fg,
          fontSize: 17,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    width: "100%",
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
});
