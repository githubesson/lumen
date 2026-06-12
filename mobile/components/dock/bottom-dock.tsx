import { useEffect, useState } from "react";
import {
  Keyboard,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useCurrentTrack } from "../../context/player";
import { FloatingTabBar } from "./floating-tab-bar";
import { PhoneMiniPlayer, PadMiniPlayer } from "./dock-mini-player";
import {
  DOCK,
  DOCK_COLLAPSE_TIMING,
  dockBottom,
  isTabletLayout,
  useDockCollapsed,
  useDockControls,
} from "./dock-context";

// Far enough to clear the tallest dock stack (mini pill + gap + tab bar)
// plus its bottom offset on any device.
const KEYBOARD_HIDE_TRANSLATE = 160;

/**
 * The floating bottom dock, rendered as the Tabs navigator's custom
 * `tabBar`. iPhone stacks the mini-player pill above the tab pill; iPad puts
 * them side by side on one row. Absolutely positioned, so scenes keep the
 * full screen height and content scrolls underneath (screens reserve space
 * via `useBottomDockInset`).
 */
export function BottomDock(props: BottomTabBarProps) {
  const { width, height } = useWindowDimensions();
  const tablet = isTabletLayout(width, height);
  const current = useCurrentTrack();
  const { collapseProgress } = useDockControls();
  const collapsed = useDockCollapsed();
  const reducedMotion = useReducedMotion();
  const hidden = useSharedValue(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  // A floating bar would otherwise hover mid-screen above the keyboard, so
  // slide it off-screen while the keyboard is up.
  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () => {
      setKeyboardVisible(true);
      hidden.value = reducedMotion ? 1 : withTiming(1, DOCK_COLLAPSE_TIMING);
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
      hidden.value = reducedMotion ? 0 : withTiming(0, DOCK_COLLAPSE_TIMING);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [hidden, reducedMotion]);

  const bottom = dockBottom(props.insets.bottom);

  // No `opacity` here (or anywhere above the pills): the glass is a
  // UIVisualEffectView, and any ancestor with alpha < 1 makes iOS drop the
  // effect entirely — it doesn't reliably come back. Sliding off-screen
  // hides the dock just as well.
  const rootStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: hidden.value * KEYBOARD_HIDE_TRANSLATE }],
  }));

  // The mini pill slips down behind the tab pill and fades out as the dock
  // collapses. Only transforms here — the fade happens per-layer inside the
  // pill (native glass cross-fade + plain-view opacity), because alpha on
  // this wrapper would permanently kill the glass effect.
  const phoneMiniStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value;
    return {
      transform: [
        { translateY: interpolate(p, [0, 1], [0, 28], Extrapolation.CLAMP) },
        { scale: interpolate(p, [0, 1], [1, 0.92], Extrapolation.CLAMP) },
      ],
    };
  });

  if (tablet) {
    return (
      <Animated.View
        pointerEvents={keyboardVisible ? "none" : "box-none"}
        style={[styles.root, { bottom }, rootStyle]}
      >
        <View
          pointerEvents="box-none"
          style={[
            styles.padRow,
            current ? null : styles.padRowCentered,
          ]}
        >
          <FloatingTabBar {...props} />
          {current ? <PadMiniPlayer /> : null}
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      pointerEvents={keyboardVisible ? "none" : "box-none"}
      style={[styles.root, { bottom }, rootStyle]}
    >
      {current ? (
        <Animated.View
          pointerEvents={collapsed ? "none" : "box-none"}
          style={[styles.phoneMini, phoneMiniStyle]}
        >
          <PhoneMiniPlayer />
        </Animated.View>
      ) : null}
      <FloatingTabBar {...props} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  phoneMini: {
    alignSelf: "stretch",
    marginHorizontal: DOCK.phoneMiniMargin,
    marginBottom: DOCK.gap,
  },
  padRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: DOCK.padRowHPadding,
    gap: DOCK.padRowGap,
  },
  padRowCentered: {
    justifyContent: "center",
  },
});
