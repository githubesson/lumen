import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  Easing,
  useReducedMotion,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCurrentTrack } from "../../context/player";
import { useTheme } from "../../theme/theme";

/**
 * Sizing for the floating bottom dock (Instagram-style pill tab bar plus the
 * mini-player pill/island). The dock has two states driven by scroll
 * direction: expanded (default) and compact.
 */
export const DOCK = {
  tabBarHeight: 64,
  tabBarHeightCompact: 52,
  tabItemWidth: 64,
  tabItemWidthCompact: 54,
  tabPillHPadding: 8,
  capsuleWidth: 56,
  capsuleWidthCompact: 46,
  capsuleHeight: 48,
  capsuleHeightCompact: 38,
  iconSize: 23,
  iconCompactScale: 0.85,
  miniHeight: 56,
  gap: 10,
  bottomOffset: 6,
  minBottom: 16,
  phoneMiniMargin: 20,
  padRowHPadding: 24,
  padRowGap: 16,
  padIslandMaxWidth: 860,
  /** The dock keeps this fraction of its natural bottom clearance — it sits
   * 60% lower into the gap below it, hugging the screen edge. */
  bottomGapFactor: 0.4,
} as const;

/**
 * Absolute bottom position of the dock. The natural clearance (safe area +
 * offset, floored at minBottom) is scaled by {@link DOCK.bottomGapFactor};
 * `useBottomDockInset` derives from the same number so reserved scroll space
 * stays in sync with where the dock actually sits.
 */
export function dockBottom(insetBottom: number): number {
  return Math.round(
    DOCK.bottomGapFactor *
      Math.max(DOCK.minBottom, insetBottom + DOCK.bottomOffset),
  );
}

export interface DockColors {
  /** Translucent overlay drawn ON TOP of the glass (Liquid Glass ignores a
   * backgroundColor beneath it and auto-adapts to the content behind, which
   * made the two pills render different shades). Matches the theme bg so
   * scrolling content stays visible through the pills. */
  scrim: string;
  border: string;
  shadow: string;
  active: string;
  inactive: string;
  capsule: string;
  muted: string;
}

/** Dock chrome derived from the theme: bg-tinted translucent pills. */
export function useDockColors(): DockColors {
  const theme = useTheme();
  return useMemo(() => {
    const dark = theme.scheme === "dark";
    return {
      scrim: dark ? "rgba(0,0,0,0.62)" : "rgba(255,255,255,0.62)",
      border: dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
      shadow: dark
        ? "0 12px 28px rgba(0, 0, 0, 0.34)"
        : "0 12px 28px rgba(0, 0, 0, 0.16)",
      active: theme.color.fg,
      inactive: theme.color.fgMuted,
      capsule: dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)",
      muted: theme.color.fgMuted,
    };
  }, [theme]);
}

export const DOCK_COLLAPSE_TIMING = {
  duration: 240,
  easing: Easing.bezier(0.2, 0.8, 0.2, 1),
} as const;

// Near-critically-damped spring for the expand/collapse morph: settles fast
// with a fluid deceleration and no visible bounce — the Instagram feel a
// fixed-duration bezier can't match.
export const DOCK_COLLAPSE_SPRING = {
  stiffness: 250,
  damping: 32,
  mass: 1,
} as const;

const TABLET_BREAKPOINT = 600;

export function isTabletLayout(width: number, height: number): boolean {
  return Math.min(width, height) >= TABLET_BREAKPOINT;
}

interface DockControls {
  /** 0 = expanded, 1 = compact. Drives every dock animation. */
  collapseProgress: SharedValue<number>;
  setCollapsed: (collapsed: boolean) => void;
  expand: () => void;
}

const DockControlsCtx = createContext<DockControls | undefined>(undefined);
const DockCollapsedCtx = createContext<boolean | undefined>(undefined);

export function useDockControls(): DockControls {
  const value = useContext(DockControlsCtx);
  if (value === undefined) {
    throw new Error("useDockControls requires DockProvider");
  }
  return value;
}

/** React-state mirror of the compact state, for `pointerEvents` switching. */
export function useDockCollapsed(): boolean {
  const value = useContext(DockCollapsedCtx);
  if (value === undefined) {
    throw new Error("useDockCollapsed requires DockProvider");
  }
  return value;
}

export function DockProvider({ children }: { children: ReactNode }) {
  const collapseProgress = useSharedValue(0);
  const [collapsed, setCollapsedState] = useState(false);
  const collapsedRef = useRef(false);
  const reducedMotion = useReducedMotion();

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (collapsedRef.current === next) return;
      collapsedRef.current = next;
      setCollapsedState(next);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const target = next ? 1 : 0;
      collapseProgress.value = reducedMotion
        ? target
        : withSpring(target, DOCK_COLLAPSE_SPRING);
    },
    [collapseProgress, reducedMotion],
  );

  const expand = useCallback(() => setCollapsed(false), [setCollapsed]);

  const controls = useMemo(
    () => ({ collapseProgress, setCollapsed, expand }),
    [collapseProgress, setCollapsed, expand],
  );

  return (
    <DockControlsCtx.Provider value={controls}>
      <DockCollapsedCtx.Provider value={collapsed}>
        {children}
      </DockCollapsedCtx.Provider>
    </DockControlsCtx.Provider>
  );
}

// Scroll-direction hysteresis: collapse only after sustained downward
// movement, expand on a smaller upward movement so the bar feels eager to
// come back. Near the top (and for short content) the dock never collapses.
const COLLAPSE_AFTER_PX = 24;
const EXPAND_AFTER_PX = 12;
const TOP_ALWAYS_EXPANDED_PX = 50;
const MIN_SCROLLABLE_PX = 120;

/**
 * Plain JS scroll handler (not a reanimated worklet): the dock state is
 * binary with hysteresis, so per-frame UI-thread tracking buys nothing, and
 * one handler works identically for FlashList, FlatList, and ScrollView.
 * Spread the returned object into the scrollable's props.
 */
export function useDockScrollHandler(): {
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle: number;
} {
  const { setCollapsed } = useDockControls();
  const stateRef = useRef({ y: 0, acc: 0 });

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      const maxY = contentSize.height - layoutMeasurement.height;
      if (maxY < MIN_SCROLLABLE_PX) {
        setCollapsed(false);
        return;
      }

      const state = stateRef.current;
      // Clamp into the real scroll range so rubber-band overscroll and
      // pull-to-refresh don't register as direction changes.
      const y = Math.min(Math.max(contentOffset.y, 0), maxY);
      const dy = y - state.y;
      state.y = y;
      if (dy === 0) return;

      if (y <= TOP_ALWAYS_EXPANDED_PX) {
        state.acc = 0;
        setCollapsed(false);
        return;
      }

      if (dy > 0 !== state.acc > 0) state.acc = 0;
      state.acc += dy;
      if (state.acc > COLLAPSE_AFTER_PX) setCollapsed(true);
      else if (state.acc < -EXPAND_AFTER_PX) setCollapsed(false);
    },
    [setCollapsed],
  );

  return useMemo(() => ({ onScroll, scrollEventThrottle: 16 }), [onScroll]);
}

/**
 * Bottom padding scrollables must add (via contentContainerStyle) so the last
 * row clears the floating dock. `contentInsetAdjustmentBehavior="automatic"`
 * already covers the safe-area inset, so this returns only the dock's height
 * above it — always at expanded size, so padding doesn't shift on collapse.
 */
export function useBottomDockInset(): number {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const current = useCurrentTrack();

  // May be negative when the dock sits inside the safe area; the scroll views
  // add `insets.bottom` separately, so the sum still lands on the dock top.
  const lift = dockBottom(insets.bottom) - insets.bottom;
  if (isTabletLayout(width, height)) return lift + DOCK.tabBarHeight;
  return (
    lift +
    DOCK.tabBarHeight +
    (current ? DOCK.gap + DOCK.miniHeight : 0)
  );
}
