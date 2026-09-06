import {
  Pressable,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Card } from "../primitives";
import { HairlineSeparator } from "../hairline-separator";
import { useTheme } from "../../theme/theme";

/**
 * "Your library" card on the home page: Songs / Albums / Artists disclosure
 * rows that jump into the browse screen in the matching mode. Haptics belong
 * to the caller's navigation handler.
 */
export function BrowseLinksCard({
  onBrowse,
  style,
}: {
  onBrowse: (mode: "tracks" | "albums" | "artists") => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card style={[{ overflow: "hidden" }, style]}>
      <BrowseLinkRow
        icon="music.note"
        label="Songs"
        onPress={() => onBrowse("tracks")}
      />
      <BrowseLinkRow
        icon="square.stack"
        label="Albums"
        divider
        onPress={() => onBrowse("albums")}
      />
      <BrowseLinkRow
        icon="music.mic"
        label="Artists"
        divider
        onPress={() => onBrowse("artists")}
      />
    </Card>
  );
}

/** One disclosure row inside the card: accent icon, label, chevron, and an optional inset hairline above. */
function BrowseLinkRow({
  icon,
  label,
  divider,
  onPress,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  divider?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <>
      {divider && <HairlineSeparator inset={52} />}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Browse ${label}`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.space.md,
          paddingVertical: 13,
          gap: theme.space.md,
          backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
        })}
      >
        <SymbolView
          name={icon}
          size={20}
          weight="medium"
          tintColor={theme.color.accent}
        />
        <Text style={{ flex: 1, color: theme.color.fg, fontSize: 16 }}>
          {label}
        </Text>
        <SymbolView
          name="chevron.right"
          size={13}
          weight="semibold"
          tintColor={theme.color.fgMuted}
        />
      </Pressable>
    </>
  );
}
