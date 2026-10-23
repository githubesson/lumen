import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import { useDockColors } from "../dock/dock-context";
import { DockSurface } from "../dock/dock-surface";
import { FAVORITES_MODES, ModeSwitch, modeColor } from "./mode-switch";
import {
  FAVORITES_HEADER,
  controlsDocked,
  switchPlacement,
  type FavoritesMode,
  type HeaderGeometry,
} from "../../lib/favorites-header";
import { withAlpha, type ThemeTokens } from "../../theme/theme";

const {
  navBarHeight: BAR_HEIGHT,
  sideInset: SIDE,
  switchWidth: SWITCH_WIDTH,
  expandedScale: EXPANDED,
} = FAVORITES_HEADER;

/** The bar's glass Shuffle / Play buttons. */
const BAR_BUTTON = 44;
/** The scroll edge runs this far below the bar. */
const EDGE_OVERHANG = 22;
const FADE = { duration: 200, easing: Easing.linear } as const;
const POP = { duration: 280, easing: Easing.bezier(0.25, 1, 0.5, 1) } as const;
const BAR_BUTTONS_SHADOW = "0 4px 14px rgba(0, 0, 0, 0.18)";

/**
 * Everything floating over the two lists: the scroll edge under the status
 * bar, the inline "♥ Favorites" title, the glass Shuffle / Play that appear
 * once the header's buttons have scrolled under the bar, and the heart | clock
 * switch.
 *
 * The switch is one element: it trails the large title, then rises, slides
 * and shrinks into the bar's leading slot as the title collapses (UI-thread
 * transforms from the active list's offset). With Reduce Motion there is no
 * morph: a copy in the title row and a copy in the bar cross-fade instead.
 */
export function FavoritesNavBar({
  theme,
  mode,
  offset,
  topInset,
  geometry,
  onSelectMode,
  trackCount,
  onPlay,
  onShuffle,
}: {
  theme: ThemeTokens;
  mode: FavoritesMode;
  /** The active list's raw content offset (rest is `-topInset`). */
  offset: SharedValue<number>;
  topInset: number;
  /** The active list's header layout. */
  geometry: HeaderGeometry;
  onSelectMode: (mode: FavoritesMode) => void;
  trackCount: number;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const meta = FAVORITES_MODES[mode];
  const barBottom = topInset + BAR_HEIGHT;

  // Each state flips at a threshold and then animates on its own clock, like
  // the native bar: the edge once content is under the bar, the inline title
  // once the large one is, the bar's buttons once the header's are.
  const edge = useSharedValue(0);
  const titled = useSharedValue(0);
  const docked = useSharedValue(0);
  const [collapsed, setCollapsed] = useState(false);
  const [buttonsShown, setButtonsShown] = useState(false);

  useAnimatedReaction(
    () => offset.value + topInset > FAVORITES_HEADER.edgeAt,
    (on, previous) => {
      if (on !== previous) edge.set(withTiming(on ? 1 : 0, FADE));
    },
    [offset, topInset],
  );
  useAnimatedReaction(
    () => offset.value + topInset > FAVORITES_HEADER.titleAt,
    (on, previous) => {
      if (on === previous) return;
      titled.set(withTiming(on ? 1 : 0, FADE));
      scheduleOnRN(setCollapsed, on);
    },
    [offset, topInset],
  );
  useAnimatedReaction(
    () => controlsDocked(offset.value + topInset, geometry),
    (on, previous) => {
      if (on === previous) return;
      docked.set(withTiming(on ? 1 : 0, POP));
      scheduleOnRN(setButtonsShown, on);
    },
    [offset, topInset, geometry],
  );

  const edgeStyle = useAnimatedStyle(() => ({ opacity: edge.value }));
  const titleStyle = useAnimatedStyle(() => ({
    opacity: titled.value,
    transform: [{ translateY: reducedMotion ? 0 : (1 - titled.value) * 4 }],
  }));

  const bg = theme.color.bg;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.edge,
          {
            height: barBottom + EDGE_OVERHANG,
            experimental_backgroundImage: `linear-gradient(to bottom, ${bg} 0%, ${bg} 38%, ${withAlpha(bg, 0.8)} 62%, ${withAlpha(bg, 0)} 100%)`,
          },
          edgeStyle,
        ]}
      />
      {/* The status bar and nav bar take touches like a native bar would, so
          a tap there never lands on a row scrolled underneath. */}
      <View style={[styles.band, { height: barBottom }]} />
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.inlineTitle,
          { top: topInset, left: SIDE + SWITCH_WIDTH + 8, right: SIDE + SWITCH_WIDTH + 8 },
          titleStyle,
        ]}
      >
        <SymbolView name={meta.icon} size={16} tintColor={modeColor(theme, mode)} />
        <Text numberOfLines={1} style={[styles.inlineTitleText, { color: theme.color.fg }]}>
          {meta.label}
        </Text>
      </Animated.View>
      {trackCount > 0 ? (
        <BarButtons
          theme={theme}
          shown={buttonsShown}
          progress={docked}
          reducedMotion={reducedMotion}
          top={topInset}
          canShuffle={trackCount > 1}
          playLabel={`Play ${meta.label}`}
          onPlay={onPlay}
          onShuffle={onShuffle}
        />
      ) : null}
      {reducedMotion ? (
        <CrossfadingSwitch
          theme={theme}
          mode={mode}
          onSelectMode={onSelectMode}
          offset={offset}
          topInset={topInset}
          geometry={geometry}
          width={width}
          collapsed={collapsed}
          toBar={titled}
        />
      ) : (
        <MorphingSwitch
          theme={theme}
          mode={mode}
          onSelectMode={onSelectMode}
          offset={offset}
          topInset={topInset}
          geometry={geometry}
          width={width}
        />
      )}
    </View>
  );
}

interface SwitchProps {
  theme: ThemeTokens;
  mode: FavoritesMode;
  onSelectMode: (mode: FavoritesMode) => void;
  offset: SharedValue<number>;
  topInset: number;
  geometry: HeaderGeometry;
  width: number;
}

/** One switch, rendered at the expanded size and shrunk by transform. */
function MorphingSwitch({
  theme,
  mode,
  onSelectMode,
  offset,
  topInset,
  geometry,
  width,
}: SwitchProps) {
  const style = useAnimatedStyle(() => {
    const p = switchPlacement(offset.value + topInset, geometry, topInset, width);
    return {
      transform: [
        { translateX: p.x },
        { translateY: p.y },
        { scale: p.scale / EXPANDED },
      ],
    };
  });
  return (
    <Animated.View pointerEvents="box-none" style={[styles.switchHost, style]}>
      <ModeSwitch theme={theme} mode={mode} onChange={onSelectMode} scale={EXPANDED} />
    </Animated.View>
  );
}

/**
 * Reduce Motion: the title row's switch scrolls with the header and the bar's
 * stays put; they swap by dissolving when the large title goes under the bar.
 */
function CrossfadingSwitch({
  theme,
  mode,
  onSelectMode,
  offset,
  topInset,
  geometry,
  width,
  collapsed,
  toBar,
}: SwitchProps & {
  /** The large title is under the bar. */
  collapsed: boolean;
  /** 0 in the title row, 1 in the bar. */
  toBar: SharedValue<number>;
}) {
  const toHeader = useDerivedValue(() => 1 - toBar.value);
  const rest = switchPlacement(0, geometry, topInset, width);
  const headerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: rest.x },
      { translateY: rest.y - (offset.value + topInset) },
    ],
  }));
  return (
    <>
      <Animated.View pointerEvents="box-none" style={[styles.switchHost, headerStyle]}>
        <ModeSwitch
          theme={theme}
          mode={mode}
          onChange={onSelectMode}
          scale={EXPANDED}
          hidden={collapsed}
          fadeProgress={toBar}
        />
      </Animated.View>
      <View pointerEvents="box-none" style={[styles.barSwitch, { top: topInset }]}>
        <ModeSwitch
          theme={theme}
          mode={mode}
          onChange={onSelectMode}
          hidden={!collapsed}
          fadeProgress={toHeader}
        />
      </View>
    </>
  );
}

/**
 * The header's Shuffle and Play as one glass pill at the bar's trailing edge.
 * It pops in (fade, and a small scale-up unless Reduce Motion) without alpha
 * on the glass's ancestors: the glass fades natively, every other layer fades
 * as a plain view, and the scale is a transform.
 */
function BarButtons({
  theme,
  shown,
  progress,
  reducedMotion,
  top,
  canShuffle,
  playLabel,
  onPlay,
  onShuffle,
}: {
  theme: ThemeTokens;
  shown: boolean;
  /** 0 hidden, 1 shown. */
  progress: SharedValue<number>;
  reducedMotion: boolean;
  top: number;
  canShuffle: boolean;
  playLabel: string;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  const colors = useDockColors();
  const hiddenProgress = useDerivedValue(() => 1 - progress.value);
  const width = BAR_BUTTON * (canShuffle ? 2 : 1);

  const popStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reducedMotion ? 1 : 0.85 + 0.15 * progress.value }],
  }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const round = { borderRadius: BAR_BUTTON / 2, borderCurve: "continuous" } as const;

  return (
    <Animated.View
      pointerEvents={shown ? "box-none" : "none"}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
      style={[styles.barButtons, { top, width }, popStyle]}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, round, { boxShadow: BAR_BUTTONS_SHADOW }, fadeStyle]}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, round, styles.clip]}>
        <DockSurface hidden={!shown} fadeProgress={hiddenProgress} />
      </View>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          round,
          styles.hairline,
          { borderColor: colors.border },
          fadeStyle,
        ]}
      />
      <Animated.View style={[styles.barButtonRow, fadeStyle]}>
        {canShuffle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Shuffle play"
            onPress={onShuffle}
            style={({ pressed }) => [styles.barButton, { opacity: pressed ? 0.55 : 1 }]}
          >
            <SymbolView name="shuffle" size={20} tintColor={theme.color.fg} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playLabel}
          onPress={onPlay}
          style={({ pressed }) => [styles.barButton, { opacity: pressed ? 0.55 : 1 }]}
        >
          <SymbolView name="play.fill" size={19} tintColor={theme.color.fg} />
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  edge: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  band: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  inlineTitle: {
    position: "absolute",
    height: BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  inlineTitleText: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: "600",
  },
  switchHost: {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "left top",
  },
  barSwitch: {
    position: "absolute",
    left: SIDE,
  },
  barButtons: {
    position: "absolute",
    right: SIDE,
    height: BAR_BUTTON,
  },
  clip: {
    overflow: "hidden",
  },
  hairline: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  barButtonRow: {
    ...StyleSheet.absoluteFill,
    flexDirection: "row",
  },
  barButton: {
    width: BAR_BUTTON,
    height: BAR_BUTTON,
    alignItems: "center",
    justifyContent: "center",
  },
});
