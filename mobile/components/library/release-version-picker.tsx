import { Pressable, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { searchEntityTarget } from "@music-library/core";
import {
  releaseVersionLabels,
  type ArtistRelease,
} from "@music-library/core/artist-releases";
import { showActionMenu } from "../../lib/action-menu";
import { useTheme } from "../../theme/theme";
import { GlassSegmentedControl } from "../glass-segmented-control";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
} from "../optional-swift-ui";

const MENU_HEIGHT = 36;
// What a third of a 375 pt phone's segmented control shows in full. Longer
// labels ("Dolby Atmos · Explicit") would cut to the same "Dolby Atmos…".
const SEGMENT_LABEL_MAX = 12;

/**
 * Switches between a release's versions: segments for up to three short
 * labels, else a menu listing each version's full description.
 */
export function ReleaseVersionPicker({
  versions,
  current,
  onPick,
}: {
  versions: ArtistRelease[];
  /** The TIDAL id of the version on the page. */
  current: string;
  onPick: (id: string) => void;
}) {
  const theme = useTheme();
  const labels = releaseVersionLabels(versions);
  const options = versions.map((version, i) => ({
    value: searchEntityTarget(version).id,
    label: labels[i].label,
    description: labels[i].description,
  }));
  if (
    options.length <= 3 &&
    options.every((option) => option.label.length <= SEGMENT_LABEL_MAX)
  ) {
    return (
      <GlassSegmentedControl options={options} value={current} onChange={onPick} />
    );
  }

  const selected = options.find((option) => option.value === current);
  const accessibilityLabel = `Version: ${selected?.label ?? "None"}`;
  const pick = (id: string) => {
    void Haptics.selectionAsync();
    if (id !== current) onPick(id);
  };
  const trigger = (
    <View
      style={{
        height: MENU_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: theme.space.lg,
        backgroundColor: theme.color.bgElev1,
        borderRadius: MENU_HEIGHT / 2,
        borderCurve: "continuous",
      }}
    >
      <Text style={{ color: theme.color.fg, fontSize: 15, fontWeight: "600" }}>
        {selected?.label ?? "Version"}
      </Text>
      <SymbolView
        name="chevron.up.chevron.down"
        size={12}
        weight="semibold"
        tintColor={theme.color.fgMuted}
      />
    </View>
  );

  const swiftUI = getOptionalSwiftUI();
  if (swiftUI) {
    return (
      <View style={{ alignItems: "center" }}>
        <swiftUI.Host matchContents colorScheme={theme.scheme}>
          <swiftUI.Menu
            label={<swiftUI.RNHostView matchContents>{trigger}</swiftUI.RNHostView>}
            modifiers={[
              swiftAccessibilityLabel(accessibilityLabel),
              swiftButtonStyle("plain"),
              swiftControlSize("regular"),
            ]}
          >
            {options.map((option) => (
              // Keyed by whether it's ticked, so the tick moves by remounting
              // the two items rather than clearing a native prop.
              <swiftUI.Button
                key={`${option.value}:${option.value === current}`}
                label={option.description}
                systemImage={option.value === current ? "checkmark" : undefined}
                modifiers={[swiftDisabled(option.value === current)]}
                onPress={() => pick(option.value)}
              />
            ))}
          </swiftUI.Menu>
        </swiftUI.Host>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() =>
        showActionMenu({
          title: "Version",
          items: options.map((option) => ({
            label: option.description,
            disabled: option.value === current,
            onPress: () => pick(option.value),
          })),
          tintColor: theme.color.accent,
          userInterfaceStyle: theme.scheme,
        })
      }
      style={({ pressed }) => ({
        alignSelf: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {trigger}
    </Pressable>
  );
}
