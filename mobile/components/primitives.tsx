import { type ReactNode } from "react";
import {
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme";

/**
 * Rounded elevated surface: the house card recipe (elevated background,
 * medium radius, continuous corners). Padding, gap, and margins belong to
 * the call site.
 */
export function Card({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.color.bgElev1,
          borderRadius: theme.radius.md,
          borderCurve: "continuous",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Muted uppercase micro-label above a form section or list group. */
export function SectionLabel({
  style,
  children,
}: {
  style?: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Text
      style={[
        {
          color: theme.color.fgMuted,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
