import { type ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { useTheme } from "../theme/theme";

/** Muted caption above section titles and feature cards (home shelves). */
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
          fontSize: 13,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
