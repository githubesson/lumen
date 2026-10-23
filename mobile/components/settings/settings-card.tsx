import { type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { SectionLabel } from "../primitives";
import { useTheme } from "../../theme/theme";

/** Horizontal padding inside the Settings cards. */
export const SETTINGS_INSET = 14;

/**
 * A Settings card: the elevated surface with the large radius the redesign
 * uses, clipping its rows. Spacing between cards belongs to the screen.
 */
export function SettingsCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          marginHorizontal: theme.space.lg,
          borderRadius: theme.radius.lg,
          borderCurve: "continuous",
          backgroundColor: theme.color.bgElev1,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Muted uppercase label above a card ("Server"). */
export function SettingsSectionLabel({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <SectionLabel
      style={{
        fontSize: 13,
        paddingHorizontal: theme.space.lg,
        paddingBottom: theme.space.sm,
      }}
    >
      {children}
    </SectionLabel>
  );
}

/** A tile's bold title, with an optional value at the top right. */
export function SettingsTileHeader({
  title,
  value,
}: {
  title: string;
  value?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        { paddingHorizontal: SETTINGS_INSET, paddingTop: SETTINGS_INSET },
      ]}
    >
      <Text
        accessibilityRole="header"
        style={{ color: theme.color.fg, fontSize: 17, fontWeight: "600" }}
      >
        {title}
      </Text>
      {value ? (
        <Text
          // The control below announces its own value.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            color: theme.color.accent,
            fontSize: 17,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {value}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A row that opens another screen: glyph, label, an optional problem count
 * (the exception badge) and a chevron. Fires the selection haptic; the
 * caller navigates.
 */
export function SettingsLinkRow({
  label,
  icon,
  onPress,
  border,
  badge,
  accessibilityLabel,
}: {
  label: string;
  icon: Parameters<typeof SymbolView>[0]["name"];
  onPress: () => void;
  /** Hairline above the row, when another row precedes it in the card. */
  border?: boolean;
  /** A count worth attention; hidden at zero. */
  badge?: number;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.row,
        {
          paddingHorizontal: SETTINGS_INSET,
          paddingVertical: 14,
          borderTopWidth: border ? StyleSheet.hairlineWidth : 0,
          borderTopColor: theme.color.separator,
          backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
        },
      ]}
    >
      <View style={styles.lead}>
        <SymbolView name={icon} size={18} tintColor={theme.color.fg} />
        <Text style={{ color: theme.color.fg, fontSize: 16 }}>{label}</Text>
      </View>
      <View style={styles.trail}>
        {badge ? <CountBadge count={badge} /> : null}
        <SymbolView name="chevron.right" size={14} tintColor={theme.color.fgMuted} />
      </View>
    </Pressable>
  );
}

/** Red count pill, for problems that want a look. */
export function CountBadge({ count }: { count: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: 7,
        borderRadius: 11,
        backgroundColor: theme.color.danger,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: "#FFFFFF",
          fontSize: 13,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  lead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexShrink: 1,
  },
  trail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
});
