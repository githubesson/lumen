import { useCallback } from "react";
import {
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "../../theme/theme";
import { ShareActionButton } from "./share-action-button";
import { showActionMenu } from "../../lib/action-menu";

/**
 * The featured "Instagram Story" button. Tapping opens a background chooser
 * (native action sheet on iOS, Alert elsewhere): generated colors, the
 * custom photo, or — once a photo is picked — choosing a different one.
 */
export function StoryShareMenuButton({
  disabled,
  loading,
  hasCustomBackground,
  onGenerated,
  onCustom,
  onPickCustom,
  style,
}: {
  disabled: boolean;
  loading: boolean;
  hasCustomBackground: boolean;
  onGenerated: () => void;
  onCustom: () => void;
  onPickCustom: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const label = loading ? "Rendering story…" : "Instagram Story";

  const openStoryOptions = useCallback(() => {
    if (disabled || loading) return;
    void Haptics.selectionAsync();

    const customLabel = hasCustomBackground
      ? "Use custom image"
      : "Choose custom image";

    showActionMenu({
      // The Alert fallback needs a title; the iOS sheet reads fine without.
      title: process.env.EXPO_OS === "ios" ? undefined : "Instagram Story Background",
      items: [
        { label: "Use generated colors", onPress: onGenerated },
        { label: customLabel, onPress: onCustom },
        ...(hasCustomBackground
          ? [{ label: "Choose different image", onPress: onPickCustom }]
          : []),
      ],
      tintColor: theme.color.accent,
      userInterfaceStyle: theme.scheme,
    });
  }, [
    disabled,
    hasCustomBackground,
    loading,
    onCustom,
    onGenerated,
    onPickCustom,
    theme.color.accent,
    theme.scheme,
  ]);

  return (
    <ShareActionButton
      label={label}
      icon="camera"
      primary
      disabled={disabled}
      loading={loading}
      onPress={openStoryOptions}
      style={style}
    />
  );
}
