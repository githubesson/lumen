import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { type StoryBackgroundCrop } from "@music-library/core";
import { useTheme } from "../../theme/theme";
import { selectionTint } from "./selection-tint";
import { SharePanel } from "./share-panel";
import {
  clampCrop,
  cropEditorMetrics,
  type PickedStoryBackground,
} from "./story-crop";

const CROP_EDITOR_MAX_HEIGHT = 360;

/**
 * "Story Background" section: previews the user's picked photo and lets them
 * drag the story-aspect crop window over it. Header offers Change (re-pick)
 * and Clear (back to generated colors). Crop state is normalized (0..1) and
 * owned by the screen.
 */
export function StoryBackgroundCropEditor({
  image,
  crop,
  disabled,
  onChangeCrop,
  onPickPhoto,
  onReset,
  style,
}: {
  image: PickedStoryBackground;
  crop: StoryBackgroundCrop;
  disabled: boolean;
  onChangeCrop: (crop: StoryBackgroundCrop) => void;
  onPickPhoto: () => void;
  onReset: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const layoutRef = useRef(layout);
  const cropRef = useRef(crop);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

  const metrics = useMemo(
    () => cropEditorMetrics(image, layout.width, layout.height, crop),
    [crop, image, layout.height, layout.width],
  );

  const setCropCenter = useCallback(
    (x: number, y: number) => {
      const currentLayout = layoutRef.current;
      const currentCrop = cropRef.current;
      const currentMetrics = cropEditorMetrics(
        image,
        currentLayout.width,
        currentLayout.height,
        currentCrop,
      );
      if (!currentMetrics) return;
      const nx =
        (x - currentMetrics.imageLeft) / Math.max(1, currentMetrics.imageWidth);
      const ny =
        (y - currentMetrics.imageTop) / Math.max(1, currentMetrics.imageHeight);
      onChangeCrop(
        clampCrop({
          ...currentCrop,
          x: nx - currentCrop.width / 2,
          y: ny - currentCrop.height / 2,
        }),
      );
    },
    [image, onChangeCrop],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => {
          setCropCenter(event.nativeEvent.locationX, event.nativeEvent.locationY);
          void Haptics.selectionAsync();
        },
        onPanResponderMove: (event) => {
          setCropCenter(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },
      }),
    [disabled, setCropCenter],
  );

  const editorHeight = layout.width
    ? cropEditorHeightForWidth(layout.width)
    : CROP_EDITOR_MAX_HEIGHT;

  return (
    <SharePanel
      title="Story Background"
      accessory={
        <View style={styles.cropActionRow}>
          <CropTextButton
            label="Change"
            color={theme.color.accent}
            disabled={disabled}
            accessibilityLabel="Choose a different story background photo"
            onPress={onPickPhoto}
          />
          <CropTextButton
            label="Clear"
            color={theme.color.fgMuted}
            disabled={disabled}
            accessibilityLabel="Remove custom story background"
            onPress={onReset}
          />
        </View>
      }
      style={style}
    >
      <View
        onLayout={(event) => {
          const { width } = event.nativeEvent.layout;
          setLayout({ width, height: cropEditorHeightForWidth(width) });
        }}
        pointerEvents="box-only"
        {...panResponder.panHandlers}
        style={[
          styles.cropEditor,
          styles.dragSurface,
          {
            height: editorHeight,
            backgroundColor: theme.color.bg,
            borderColor: theme.color.separator,
          },
        ]}
      >
        {metrics ? (
          <>
            <Image
              source={{ uri: image.uri }}
              style={{
                position: "absolute",
                left: metrics.imageLeft,
                top: metrics.imageTop,
                width: metrics.imageWidth,
                height: metrics.imageHeight,
              }}
              contentFit="contain"
            />
            <View
              pointerEvents="none"
              style={[
                styles.cropWindow,
                {
                  left: metrics.cropLeft,
                  top: metrics.cropTop,
                  width: metrics.cropWidth,
                  height: metrics.cropHeight,
                  borderColor: theme.color.accent,
                  backgroundColor: selectionTint(theme.scheme),
                },
              ]}
            />
          </>
        ) : null}
      </View>

    </SharePanel>
  );
}

/** Small text-only header action (Change/Clear) with the shared pressed/disabled fade. */
function CropTextButton({
  label,
  color,
  disabled,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  color: string;
  disabled: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.cropTextButton,
        { opacity: disabled ? 0.45 : pressed ? 0.6 : 1 },
      ]}
    >
      <Text style={{ color, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

function cropEditorHeightForWidth(width: number) {
  return Math.min(CROP_EDITOR_MAX_HEIGHT, Math.max(260, width * 0.92));
}

const styles = StyleSheet.create({
  cropActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cropTextButton: {
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  cropEditor: {
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  dragSurface: {
    userSelect: "none",
  },
  cropWindow: {
    position: "absolute",
    borderWidth: 2,
    borderRadius: 12,
    borderCurve: "continuous",
  },
});
