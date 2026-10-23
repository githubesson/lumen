import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { SETTINGS_INSET, SettingsCard, SettingsTileHeader } from "./settings-card";
import {
  paletteFor,
  useTheme,
  useThemeMode,
  type ColorScheme,
  type ThemeMode,
} from "../../theme/theme";

const PREVIEW_HEIGHT = 138;
const PREVIEW_RADIUS = 16;
const PREVIEW_LINES = 4;
const RADIO = 20;

const OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Appearance as three little apps, System split corner to corner between
 * the two looks. A tap applies the look at once; the ring and the radio
 * mark the one in use. `covers` dress the previews' rows (any cover URLs;
 * plain tiles stand in without them).
 */
export function AppearanceTile({ covers }: { covers: string[] }) {
  const { mode, setMode } = useThemeMode();
  return (
    <SettingsCard>
      <SettingsTileHeader title="Appearance" />
      <View accessibilityRole="radiogroup" style={styles.options}>
        {OPTIONS.map((option) => (
          <AppearanceOption
            key={option.value}
            label={option.label}
            mode={option.value}
            covers={covers}
            selected={mode === option.value}
            onPress={() => {
              if (mode === option.value) return;
              void Haptics.selectionAsync();
              setMode(option.value);
            }}
          />
        ))}
      </View>
    </SettingsCard>
  );
}

function AppearanceOption({
  label,
  mode,
  covers,
  selected,
  onPress,
}: {
  label: string;
  mode: ThemeMode;
  covers: string[];
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const [width, setWidth] = useState(0);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      style={styles.option}
    >
      <Animated.View
        style={[
          styles.previewRing,
          selected && {
            outlineWidth: 2.5,
            outlineColor: theme.color.accent,
            outlineStyle: "solid",
          },
          {
            // Press feedback: a quick settle-in, none with reduced motion.
            transform: [{ scale: pressed && !reducedMotion ? 0.95 : 1 }],
            transitionProperty: "transform",
            transitionDuration: 150,
            transitionTimingFunction: "ease-out",
          },
        ]}
      >
        <View
          // Only the System preview needs its width, for the diagonal.
          onLayout={
            mode === "system"
              ? (event) => setWidth(event.nativeEvent.layout.width)
              : undefined
          }
          style={[styles.preview, { backgroundColor: theme.color.bgElev2 }]}
        >
          {mode === "system" ? (
            <>
              <MiniApp scheme="light" covers={covers} />
              {width > 0 ? <DarkCorner width={width} covers={covers} /> : null}
            </>
          ) : (
            <MiniApp scheme={mode} covers={covers} />
          )}
          {/* An inset hairline keeps a light preview's edge on a light card; the ring replaces it when chosen. */}
          {selected ? null : (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.previewEdge,
                { borderColor: theme.color.separator },
              ]}
            />
          )}
        </View>
      </Animated.View>
      <View style={styles.label}>
        <View
          style={[
            styles.radio,
            selected
              ? { backgroundColor: theme.color.accent }
              : { borderWidth: 1.5, borderColor: theme.color.fgMuted },
          ]}
        >
          {selected ? (
            <SymbolView
              name="checkmark"
              size={11}
              weight="bold"
              tintColor={theme.color.onAccent}
            />
          ) : null}
        </View>
        <Text style={{ color: theme.color.fg, fontSize: 14 }}>{label}</Text>
      </View>
    </Pressable>
  );
}

/**
 * The dark half of the System preview: the triangle below the diagonal from
 * the bottom-left corner to the top-right one. A clipping view is laid along
 * the diagonal (rotated about its top-left corner, which sits on the
 * bottom-left of the preview) and the dark app inside it is turned back, so
 * the app lines up with the light one underneath.
 */
function DarkCorner({ width, covers }: { width: number; covers: string[] }) {
  const angle = Math.atan2(PREVIEW_HEIGHT, width);
  const diagonal = Math.hypot(width, PREVIEW_HEIGHT);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: PREVIEW_HEIGHT,
        width: diagonal,
        height: diagonal,
        overflow: "hidden",
        transformOrigin: "left top",
        transform: [{ rotate: `${-angle}rad` }],
      }}
    >
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width,
          height: PREVIEW_HEIGHT,
          transformOrigin: "left top",
          transform: [{ rotate: `${angle}rad` }, { translateY: -PREVIEW_HEIGHT }],
        }}
      >
        <MiniApp scheme="dark" covers={covers} />
      </View>
    </View>
  );
}

/** A sketch of the app in one appearance: a title, four rows, the dock. */
function MiniApp({ scheme, covers }: { scheme: ColorScheme; covers: string[] }) {
  const palette = paletteFor(scheme);
  return (
    <View style={[StyleSheet.absoluteFill, styles.mini, { backgroundColor: palette.bg }]}>
      <View style={[styles.miniTitle, { backgroundColor: palette.separator }]} />
      {Array.from({ length: PREVIEW_LINES }, (_, i) => {
        const uri = covers.length > 0 ? covers[i % covers.length] : null;
        return (
          <View key={i} style={styles.miniLine}>
            {uri ? (
              <Image
                source={{ uri }}
                style={[styles.miniCover, { backgroundColor: palette.bgElev2 }]}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={`${uri}:${i}`}
              />
            ) : (
              <View style={[styles.miniCover, { backgroundColor: palette.bgElev2 }]} />
            )}
            <View style={[styles.miniBar, { backgroundColor: palette.separator }]} />
          </View>
        );
      })}
      <View style={[styles.miniDock, { backgroundColor: palette.bgElev2 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  options: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: SETTINGS_INSET,
    paddingTop: 12,
    paddingBottom: SETTINGS_INSET,
  },
  option: {
    flex: 1,
    alignItems: "center",
    gap: 8,
  },
  previewRing: {
    alignSelf: "stretch",
    borderRadius: PREVIEW_RADIUS,
    borderCurve: "continuous",
  },
  preview: {
    height: PREVIEW_HEIGHT,
    borderRadius: PREVIEW_RADIUS,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  previewEdge: {
    borderRadius: PREVIEW_RADIUS,
    borderCurve: "continuous",
    borderWidth: 1,
  },
  label: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  radio: {
    width: RADIO,
    height: RADIO,
    borderRadius: RADIO / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  mini: {
    paddingTop: 14,
    paddingHorizontal: 9,
  },
  miniTitle: {
    height: 7,
    width: "46%",
    borderRadius: 3,
    marginBottom: 9,
  },
  miniLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 7,
  },
  miniCover: {
    width: 15,
    height: 15,
    borderRadius: 3,
  },
  miniBar: {
    flex: 1,
    height: 5,
    borderRadius: 3,
  },
  miniDock: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 8,
    height: 13,
    borderRadius: 7,
  },
});
