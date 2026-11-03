import { ActivityIndicator, Pressable, Text } from "react-native";
import { useTheme } from "../theme/theme";

const BUTTON_HEIGHT = 48;

/**
 * Full-width filled accent button used for primary form actions (sign in,
 * create account, upload, save). Previously hand-rolled in six screens with
 * drifting opacity ladders and a hardcoded white label; centralized here so the
 * accent background, on-accent foreground, and pressed/disabled/loading states
 * stay consistent.
 */
export function PrimaryButton({
  label,
  onPress,
  loading = false,
  disabled = false,
  accessibilityLabel,
  tone = "accent",
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** `inverse` fills with the text color, for the signed-out screens. */
  tone?: "accent" | "inverse";
}) {
  const theme = useTheme();
  const isDisabled = disabled || loading;
  const inverse = tone === "inverse";
  const background = inverse ? theme.color.fg : theme.color.accent;
  const foreground = inverse ? theme.color.bg : theme.color.onAccent;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => ({
        backgroundColor: background,
        borderRadius: theme.radius.md,
        minHeight: BUTTON_HEIGHT,
        paddingVertical: 12,
        alignItems: "center",
        justifyContent: "center",
        borderCurve: "continuous",
        opacity: disabled ? 0.5 : loading || pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <Text style={{ color: foreground, fontSize: 17, fontWeight: "600" }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Quiet, elevated-surface companion to `PrimaryButton` for secondary form
 * actions (replace/remove cover, etc.). `destructive` swaps the label to the
 * danger token.
 */
export function SecondaryButton({
  label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({
        backgroundColor: theme.color.bgElev1,
        borderRadius: theme.radius.md,
        borderCurve: "continuous",
        minHeight: BUTTON_HEIGHT,
        paddingVertical: 12,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <Text
        style={{
          color: destructive ? theme.color.danger : theme.color.fg,
          fontSize: 15,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
