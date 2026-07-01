import { type ReactNode } from "react";
import { ScrollView, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme/theme";

/**
 * Full-bleed horizontal rail for tile shelves (home shelves, replay top
 * artists/albums): hidden scroll indicator, screen-edge content padding, and
 * the standard tile gap.
 */
export function HorizontalShelf({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: theme.space.lg,
        gap: theme.space.md,
      }}
      style={style}
    >
      {children}
    </ScrollView>
  );
}
