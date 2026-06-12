import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";

/**
 * Shared stack `screenOptions` preset — Apple-Music-style:
 *
 *   - Header is transparent with NO blur backdrop at rest, so content looks
 *     like it owns the top of the screen (just status bar, no nav-chrome).
 *   - `headerShadowVisible: true` lets iOS draw its subtle 1px shadow under
 *     the nav bar as soon as content scrolls beneath it — the system handles
 *     the transition automatically based on scroll offset.
 *   - Same behavior on the large-title region via
 *     `headerLargeTitleShadowVisible`.
 *   - Minimal back button — no "Back" text next to the chevron.
 *
 * Apply via `<Stack screenOptions={stackScreenOptions}>` in each tab's
 * `_layout.tsx`. Header text color comes from `@react-navigation/native`'s
 * `ThemeProvider`.
 */
export const stackScreenOptions: NativeStackNavigationOptions = {
  headerTransparent: true,
  headerShadowVisible: true,
  headerLargeTitleShadowVisible: true,
  headerLargeStyle: { backgroundColor: "transparent" },
  headerStyle: { backgroundColor: "transparent" },
  headerLargeTitle: true,
  // `"none"` keeps the header chrome from adding a visible blur at rest;
  // iOS still paints the scroll-on shadow when content goes under.
  headerBlurEffect: "none",
  headerBackButtonDisplayMode: "minimal",
  contentStyle: { backgroundColor: "transparent" },
};
