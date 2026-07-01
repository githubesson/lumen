import {
  Pressable,
  ScrollView,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "../../theme/theme";
import { periodKey, periodLabel, type Period } from "./period";

/**
 * Horizontal pill scroller for choosing the Replay time window. The active
 * pill is filled with the accent color; selection fires a haptic.
 */
export function PeriodPicker({
  options,
  selected,
  onSelect,
  style,
}: {
  options: Period[];
  selected: Period;
  onSelect: (p: Period) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={style}
      contentContainerStyle={{
        paddingHorizontal: theme.space.lg,
        gap: 8,
      }}
    >
      {options.map((p) => {
        const active = periodKey(p) === periodKey(selected);
        return (
          <Pressable
            key={periodKey(p)}
            onPress={() => {
              void Haptics.selectionAsync();
              onSelect(p);
            }}
            style={({ pressed }) => ({
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 999,
              borderCurve: "continuous",
              backgroundColor: active
                ? theme.color.accent
                : theme.color.bgElev1,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                color: active ? theme.color.onAccent : theme.color.fg,
                fontSize: 14,
                fontWeight: active ? "600" : "500",
              }}
            >
              {periodLabel(p)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
