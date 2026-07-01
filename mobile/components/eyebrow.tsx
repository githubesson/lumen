import { type ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { useTheme } from "../theme/theme";

/**
 * Muted uppercase micro-label above section titles and feature cards (home
 * shelves, replay sections). Smaller and wider-tracked than the form
 * `SectionLabel`.
 */
export function Eyebrow({
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
          fontSize: 11,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
