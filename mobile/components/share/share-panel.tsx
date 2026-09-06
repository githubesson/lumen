import { type ReactNode } from "react";
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../../theme/theme";

/**
 * Bordered elevated panel with a bold title row, used for the share sheet's
 * sections (snippet picker, story background editor). An optional `accessory`
 * renders on the right side of the header; body children are spaced by the
 * panel's own gap. Margins belong to the call site.
 */
export function SharePanel({
  title,
  accessory,
  style,
  children,
}: {
  title: string;
  accessory?: ReactNode;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.panel,
        {
          backgroundColor: theme.color.bgElev1,
          borderColor: theme.color.separator,
          borderRadius: theme.radius.lg,
          padding: theme.space.lg,
          gap: theme.space.md,
        },
        style,
      ]}
    >
      <View style={styles.panelHeader}>
        <Text
          style={{
            color: theme.color.fg,
            fontSize: 17,
            fontWeight: "700",
          }}
        >
          {title}
        </Text>
        {accessory}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: "continuous",
  },
  panelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
});
