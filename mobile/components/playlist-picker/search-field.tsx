import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";
import { PICKER_MAX_FONT_SCALE } from "./picker-row";

const PLACEHOLDER = "Find or name a new playlist";

/**
 * The picker's one field: it narrows the list, and a name no playlist has
 * becomes the "New Playlist" row. The placeholder says both. `busy` shows
 * a spinner at its end while the list is still finding out which playlists
 * already hold the track.
 */
export function PickerSearchField({
  busy,
  onChangeText,
}: {
  busy: boolean;
  onChangeText: (text: string) => void;
}) {
  const theme = useTheme();
  const dark = theme.scheme === "dark";
  return (
    <View
      style={[
        styles.field,
        {
          backgroundColor: dark
            ? "rgba(118,118,128,0.24)"
            : "rgba(118,118,128,0.12)",
        },
      ]}
    >
      <SymbolView
        name="magnifyingglass"
        size={17}
        tintColor={theme.color.fgMuted}
      />
      <TextInput
        onChangeText={onChangeText}
        placeholder={PLACEHOLDER}
        placeholderTextColor={theme.color.fgMuted}
        accessibilityLabel={PLACEHOLDER}
        selectionColor={theme.color.accent}
        keyboardAppearance={dark ? "dark" : "light"}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="done"
        maxFontSizeMultiplier={PICKER_MAX_FONT_SCALE}
        style={[styles.input, { color: theme.color.fg }]}
      />
      {busy ? (
        <ActivityIndicator
          size="small"
          color={theme.color.fgMuted}
          accessibilityLabel="Checking which playlists have this track"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    height: 40,
    marginTop: 12,
    marginHorizontal: 14,
    marginBottom: 4,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 20,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  input: {
    flex: 1,
    height: 40,
    fontSize: 17,
  },
});
