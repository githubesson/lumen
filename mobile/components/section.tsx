import { type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useTheme } from "../theme/theme";
import { Eyebrow } from "./eyebrow";

/**
 * Section shell for scrolling feature pages (home, replay): eyebrow + large
 * title on the left, optional accent action (label with an optional SF
 * Symbol) on the right, then the section body. Horizontal padding applies to
 * the header only, so full-bleed shelves can manage their own edge insets.
 */
export function Section({
  eyebrow,
  title,
  actionLabel,
  actionIcon,
  onAction,
  style,
  children,
}: {
  eyebrow?: string;
  title: string;
  actionLabel?: string;
  actionIcon?: SymbolViewProps["name"];
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[{ gap: theme.space.sm }, style]}>
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          flexDirection: "row",
          alignItems: "flex-end",
          justifyContent: "space-between",
        }}
      >
        <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <Text
            style={{
              color: theme.color.fg,
              fontSize: 20,
              fontWeight: "600",
              letterSpacing: -0.2,
            }}
          >
            {title}
          </Text>
        </View>
        {actionLabel && onAction && (
          <Pressable
            onPress={onAction}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingBottom: 2,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            {actionIcon && (
              <SymbolView
                name={actionIcon}
                size={13}
                weight="semibold"
                tintColor={theme.color.accent}
              />
            )}
            <Text
              style={{
                color: theme.color.accent,
                fontSize: 14,
                fontWeight: "500",
              }}
            >
              {actionLabel}
            </Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}
