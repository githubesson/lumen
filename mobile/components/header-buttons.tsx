import { ActivityIndicator, Pressable, Text } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useTheme } from "../theme/theme";

export function HeaderTextButton({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        opacity: disabled ? 0.35 : pressed ? 0.55 : 1,
        paddingVertical: 4,
        paddingHorizontal: 2,
      })}
    >
      <Text
        style={{
          color: theme.color.accent,
          fontSize: 17,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Header "Save" affordance for edit screens. Shows a muted spinner while
 * saving, otherwise an accent text button. Replaces the byte-identical
 * `SaveButton` previously hand-rolled in the track and album edit screens.
 */
export function HeaderSaveButton({
  saving,
  onPress,
  label = "Save",
}: {
  saving: boolean;
  onPress: () => void;
  label?: string;
}) {
  const theme = useTheme();
  if (saving) {
    return <ActivityIndicator color={theme.color.fgMuted} />;
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      <Text
        style={{ color: theme.color.accent, fontSize: 17, fontWeight: "600" }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function HeaderIconButton({
  icon,
  label,
  disabled = false,
  onPress,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : pressed ? 0.55 : 1,
      })}
    >
      <SymbolView name={icon} size={22} tintColor={theme.color.accent} />
    </Pressable>
  );
}
