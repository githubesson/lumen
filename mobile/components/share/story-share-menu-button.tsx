import { useCallback } from "react";
import {
  ActionSheetIOS,
  Alert,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "../../theme/theme";
import { ShareActionButton } from "./share-action-button";

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
  const label = loading ? "Rendering Story..." : "Instagram Story";

  const openStoryOptions = useCallback(() => {
    if (disabled || loading) return;
    void Haptics.selectionAsync();

    const customLabel = hasCustomBackground
      ? "Use Custom Image"
      : "Choose Custom Image";

    if (process.env.EXPO_OS === "ios") {
      const options = ["Use Generated Colors", customLabel];
      if (hasCustomBackground) {
        options.push("Choose Different Image");
      }
      options.push("Cancel");

      const cancelButtonIndex = options.length - 1;
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
          tintColor: theme.color.accent,
          userInterfaceStyle: theme.scheme,
        },
        (selectedIndex) => {
          if (selectedIndex === cancelButtonIndex) return;
          if (selectedIndex === 0) {
            onGenerated();
          } else if (selectedIndex === 1) {
            onCustom();
          } else if (hasCustomBackground && selectedIndex === 2) {
            onPickCustom();
          }
        },
      );
      return;
    }

    Alert.alert("Instagram Story Background", undefined, [
      { text: "Use Generated Colors", onPress: onGenerated },
      { text: customLabel, onPress: onCustom },
      ...(hasCustomBackground
        ? [{ text: "Choose Different Image", onPress: onPickCustom }]
        : []),
      { text: "Cancel", style: "cancel" },
    ]);
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
