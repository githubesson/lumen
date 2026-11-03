import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SymbolView } from "expo-symbols";
import { PrimaryButton, SecondaryButton } from "../buttons";
import { useTheme } from "../../theme/theme";

/**
 * First-run block shown when the account has nothing personal yet (no plays,
 * no favorites): one line plus buttons into browse and upload, instead of a
 * page of empty shelves.
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
          paddingVertical: theme.space.xl,
          alignItems: "center",
          gap: theme.space.md,
        },
        style,
      ]}
    >
      <SymbolView name="waveform" size={40} tintColor={theme.color.fgMuted} />
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 17,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        Nothing played yet
      </Text>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 14,
          textAlign: "center",
          maxWidth: 280,
        }}
      >
        Songs you play and favorite show up here
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignSelf: "stretch",
          gap: theme.space.md,
          marginTop: theme.space.xs,
        }}
      >
        <View style={{ flex: 1 }}>
          <PrimaryButton label="Browse library" onPress={onBrowse} />
        </View>
        <View style={{ flex: 1 }}>
          <SecondaryButton label="Upload music" onPress={onUpload} />
        </View>
      </View>
    </View>
  );
}
