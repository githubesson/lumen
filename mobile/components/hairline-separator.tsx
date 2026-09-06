import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme/theme";

/**
 * Hairline divider between rows inside a card, inset from the left to
 * align with the row text.
 */
export function HairlineSeparator({
  inset = 0,
  style,
}: {
  inset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          height: StyleSheet.hairlineWidth,
          marginLeft: inset,
          backgroundColor: theme.color.separator,
        },
        style,
      ]}
    />
  );
}
