/** The Favorites | Recent switch is a tab list VoiceOver can read and use. */
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModeSwitch } from "../components/favorites/mode-switch";
import type { ThemeTokens } from "../theme/theme";

type Props = Record<string, unknown> & { children?: ReactNode };

const observed = vi.hoisted(() => ({
  views: [] as Record<string, unknown>[],
  tabs: [] as Record<string, unknown>[],
  glyphs: [] as { name: unknown; tintColor: unknown }[],
  surfaces: [] as { hidden: unknown }[],
}));

vi.mock("react-native", () => ({
  View: ({ children, ...props }: Props) => {
    observed.views.push(props);
    return <div>{children}</div>;
  },
  Pressable: ({ children, ...props }: Props) => {
    observed.tabs.push(props);
    return <button>{children}</button>;
  },
  StyleSheet: {
    create: (styles: unknown) => styles,
    absoluteFill: { position: "absolute" },
    hairlineWidth: 0.5,
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: Props) => <div>{children}</div> },
  useSharedValue: (value: number) => ({ value, get: () => value, set: vi.fn() }),
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => false,
  withTiming: (value: number) => value,
}));
vi.mock("expo-symbols", () => ({
  SymbolView: (props: { name: unknown; tintColor: unknown }) => {
    observed.glyphs.push({ name: props.name, tintColor: props.tintColor });
    return null;
  },
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("../components/dock/dock-context", () => ({
  DOCK_CAPSULE_TIMING: {},
  useDockColors: () => ({
    shadow: "shadow",
    border: "border",
    capsule: "capsule",
    inactive: "muted",
  }),
}));
vi.mock("../components/dock/dock-surface", () => ({
  DockSurface: (props: { hidden?: boolean }) => {
    observed.surfaces.push({ hidden: props.hidden });
    return null;
  },
}));


const theme = {
  color: { brand: "purple", accent: "blue" },
} as unknown as ThemeTokens;

beforeEach(() => {
  observed.views = [];
  observed.tabs = [];
  observed.glyphs = [];
  observed.surfaces = [];
});

describe("ModeSwitch", () => {
  it("is a tab list of two labelled tabs with the current one selected", () => {
    renderToStaticMarkup(<ModeSwitch theme={theme} mode="recent" onChange={vi.fn()} />);
    expect(observed.views[0]).toMatchObject({ accessibilityRole: "tabbar" });
    expect(
      observed.tabs.map((tab) => [tab.accessibilityRole, tab.accessibilityLabel, tab.accessibilityState]),
    ).toEqual([
      ["tab", "Favorites", { selected: false }],
      ["tab", "Recent", { selected: true }],
    ]);
  });

  it("colours only the current list's glyph, in that list's colour", () => {
    renderToStaticMarkup(<ModeSwitch theme={theme} mode="favorites" onChange={vi.fn()} />);
    expect(observed.glyphs).toEqual([
      { name: "heart.fill", tintColor: "purple" },
      { name: "clock.fill", tintColor: "muted" },
    ]);
    observed.glyphs = [];
    renderToStaticMarkup(<ModeSwitch theme={theme} mode="recent" onChange={vi.fn()} />);
    expect(observed.glyphs.map((glyph) => glyph.tintColor)).toEqual(["muted", "blue"]);
  });

  it("switches on a tap of the other list only", () => {
    const onChange = vi.fn();
    renderToStaticMarkup(<ModeSwitch theme={theme} mode="favorites" onChange={onChange} />);
    const [favorites, recent] = observed.tabs as { onPress: () => void }[];
    favorites.onPress();
    expect(onChange).not.toHaveBeenCalled();
    recent.onPress();
    expect(onChange).toHaveBeenCalledWith("recent");
  });

  it("hides a faded-out copy from touch and VoiceOver and fades its glass natively", () => {
    renderToStaticMarkup(
      <ModeSwitch theme={theme} mode="favorites" onChange={vi.fn()} hidden />,
    );
    expect(observed.views[0]).toMatchObject({
      accessibilityElementsHidden: true,
      pointerEvents: "none",
    });
    expect(observed.surfaces).toEqual([{ hidden: true }]);
  });
});
