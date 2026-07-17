import type { ComponentProps } from "react";
import type { Stack } from "expo-router";

/** The object form of `Stack`'s `screenOptions` prop (excludes the callback
 *  form). Derived from the component so it tracks expo-router's own stack
 *  options now that the router no longer depends on react-navigation. */
type StackNavigationOptions = Exclude<
  NonNullable<ComponentProps<typeof Stack>["screenOptions"]>,
  (...args: never) => unknown
>;

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
 * `_layout.tsx`. Header text color comes from the navigation `ThemeProvider`
 * (`expo-router/react-navigation`).
 */
export const stackScreenOptions: StackNavigationOptions = {
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
