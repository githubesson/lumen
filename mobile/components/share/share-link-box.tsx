import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../../theme/theme";

/** Quiet bordered box revealing the generated share URL once one exists. */
export function ShareLinkBox({
  url,
  style,
}: {
  url: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.linkBox,
        {
          backgroundColor: theme.color.bgElev1,
          borderColor: theme.color.separator,
          borderRadius: theme.radius.md,
          padding: theme.space.md,
          gap: theme.space.xs,
        },
        style,
      ]}
    >
      <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
        Share link
      </Text>
      <Text style={{ color: theme.color.fg }}>
        {url}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  linkBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: "continuous",
  },
});
