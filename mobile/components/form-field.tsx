import { type ReactNode } from "react";
import {
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SectionLabel } from "./primitives";
import { useTheme } from "../theme/theme";

/**
 * Labeled form section used by every form screen. Mirrors the web `Field`
 * component: an uppercase label (with an optional "Optional" tag), the
 * control, and an optional hint below it.
 */
export function FormField({
  label,
  optional,
  hint,
  style,
  children,
}: {
  label: string;
  /** Renders a muted "Optional" tag beside the label. */
  optional?: boolean;
  hint?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[{ gap: 8 }, style]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          gap: 6,
          paddingHorizontal: 4,
        }}
      >
        <SectionLabel style={{ fontWeight: "600" }}>{label}</SectionLabel>
        {optional ? (
          <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
            Optional
          </Text>
        ) : null}
      </View>
      {children}
      {hint ? (
        <Text
          style={{
            color: theme.color.fgMuted,
            fontSize: 12,
            paddingHorizontal: 4,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Themed single-line text input matching the elevated-surface form style. */
export function FormTextInput(props: TextInputProps) {
  const theme = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.color.fgMuted}
      selectionColor={theme.color.accent}
      keyboardAppearance={theme.scheme}
      {...props}
      style={[
        {
          backgroundColor: theme.color.bgElev1,
          color: theme.color.fg,
          borderRadius: theme.radius.md,
          borderCurve: "continuous",
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 17,
        },
        props.style,
      ]}
    />
  );
}

/** Selectable danger-colored error line under a form. Renders nothing when there is no message. */
export function FormError({
  message,
  style,
}: {
  message: string | null | undefined;
  style?: StyleProp<TextStyle>;
}) {
  const theme = useTheme();
  if (!message) return null;
  return (
    <Text
      selectable
      style={[{ color: theme.color.danger, fontSize: 13 }, style]}
    >
      {message}
    </Text>
  );
}
