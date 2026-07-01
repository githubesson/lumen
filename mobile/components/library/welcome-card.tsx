import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";

/**
 * First-run card shown when the account has nothing personal yet (no plays,
 * no favorites): a short pitch plus pill buttons into browse and upload,
 * instead of a page of empty shelves.
 */
export function WelcomeCard({
  onBrowse,
  onUpload,
  style,
}: {
  onBrowse: () => void;
  onUpload: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.color.bgElev1,
          borderRadius: theme.radius.lg,
          borderCurve: "continuous",
          padding: theme.space.xl,
          alignItems: "center",
          gap: theme.space.md,
        },
        style,
      ]}
    >
      <SymbolView name="sparkles" size={40} tintColor={theme.color.accent} />
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 18,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        Make this place yours
      </Text>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 14,
          textAlign: "center",
          maxWidth: 280,
        }}
      >
        Play a few songs and favorite the keepers — this page fills in with
        your recents, heavy rotation, and daily rediscoveries.
      </Text>
      <View style={{ flexDirection: "row", gap: theme.space.md, marginTop: 4 }}>
        <PillButton
          label="Browse library"
          background={theme.color.accent}
          color={theme.color.onAccent}
          onPress={onBrowse}
        />
        <PillButton
          label="Upload music"
          background={theme.color.bgElev2}
          color={theme.color.fg}
          onPress={onUpload}
        />
      </View>
    </View>
  );
}

/** Compact pill CTA used only inside the welcome card. */
function PillButton({
  label,
  background,
  color,
  onPress,
}: {
  label: string;
  background: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        backgroundColor: background,
        borderRadius: 999,
        paddingHorizontal: 18,
        paddingVertical: 10,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color, fontSize: 15, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
