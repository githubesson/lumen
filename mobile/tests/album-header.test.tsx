import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  AlbumHeader,
  AlbumTopScrim,
  albumHeroScrollState,
  albumScrollEdgeEffects,
  useAlbumCoverSize,
} from "../components/album-header";

const env = vi.hoisted(() => ({
  width: 440,
  scheme: "dark",
  focused: true,
  images: [] as { onError?: () => void }[],
  blocks: [] as { paddingHorizontal?: number }[],
}));

vi.mock("react-native", () => ({
  View: ({ children, style }: { children?: ReactNode; style?: { paddingHorizontal?: number } }) => {
    if (style?.paddingHorizontal !== undefined) env.blocks.push(style);
    return <div>{children}</div>;
  },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ActivityIndicator: () => <i>spinner</i>,
  Pressable: ({
    children,
    disabled,
    accessibilityRole,
    style,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    accessibilityRole?: string;
    style: (state: { pressed: boolean }) => { opacity: number };
  }) => (
    <button
      disabled={disabled}
      data-role={accessibilityRole}
      data-opacity={style({ pressed: false }).opacity}
    >
      {children}
    </button>
  ),
  useWindowDimensions: () => ({ width: env.width, height: 956 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: () => <div>scrim</div> },
  useSharedValue: (value: number) => ({ get: () => value, set: () => {} }),
  useAnimatedStyle: (style: () => object) => style(),
  withTiming: (value: number) => value,
}));
vi.mock("expo-image", () => ({
  Image: (props: { onError?: () => void }) => {
    env.images.push(props);
    return null;
  },
}));
vi.mock("expo-symbols", () => ({
  SymbolView: ({ name }: { name: string }) => <i>{name}</i>,
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  selectionAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: "medium" },
}));
vi.mock("expo-status-bar", () => ({
  StatusBar: ({ style }: { style: string }) => <i>{style} status bar</i>,
}));
vi.mock("expo-router", () => ({ useIsFocused: () => env.focused }));
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 116 }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    scheme: env.scheme,
    space: { sm: 8, md: 16, lg: 24, xl: 32 },
    radius: { md: 12, lg: 16 },
    color: {},
  }),
}));

const render = (props: Partial<React.ComponentProps<typeof AlbumHeader>> = {}) =>
  renderToStaticMarkup(
    <AlbumHeader
      title="Powiedz To"
      artist="Kayah"
      coverUri={null}
      metadata="1 track"
      onPlay={() => {}}
      onShuffle={() => {}}
      download={{ label: "Download album", onPress: () => {} }}
      versions={<nav>Explicit | Clean</nav>}
      {...props}
    />,
  );

it("puts the version switcher above Play", () => {
  const html = render();
  expect(html.indexOf("Explicit | Clean")).toBeLessThan(html.indexOf("Play"));
  expect(html).not.toContain("disabled");
});

it("disables Play, Shuffle and the album download while another version loads", () => {
  const html = render({ pending: true });
  expect(html.match(/<button disabled="" data-role="button" data-opacity="0.5">/g)).toHaveLength(3);
});

it("links the artist only when there's a page to open", () => {
  expect(render()).not.toContain('data-role="link"');
  const html = render({ onOpenArtist: () => {} });
  expect(html).toMatch(/data-role="link"[^>]*><span>Kayah<\/span><i>chevron.forward<\/i>/);
});

it("spins the download button while tracks are queued", () => {
  expect(render()).toContain("<i>arrow.down</i>");
  const html = render({ download: { label: "Downloading · 3 left", onPress: () => {}, queued: true } });
  expect(html).toContain("<i>spinner</i>");
  expect(html).not.toContain("<i>arrow.down</i>");
});

it("leaves Shuffle out when it isn't offered", () => {
  expect(render({ onShuffle: undefined })).not.toContain("Shuffle");
});

it("shows the nav title once the hero's title is under the bar, and counts the status bar over the cover until its fade", () => {
  const geometry = { headerHeight: 116, titleBottom: 390, topInset: 62, coverSize: 440 };
  expect(albumHeroScrollState(0, geometry)).toEqual({ titleShown: false, overCover: true });
  expect(albumHeroScrollState(273, geometry).titleShown).toBe(false);
  expect(albumHeroScrollState(274, geometry).titleShown).toBe(true);
  // 70% of the cover: 308pt, with the status bar's 62pt on top of the offset.
  expect(albumHeroScrollState(245, geometry).overCover).toBe(true);
  expect(albumHeroScrollState(246, geometry).overCover).toBe(false);
});

it("runs the cover edge to edge on a phone and stops it at 560pt on an iPad", () => {
  const size = (width: number) => {
    env.width = width;
    let out = 0;
    const Probe = () => {
      out = useAlbumCoverSize();
      return null;
    };
    renderToStaticMarkup(<Probe />);
    return out;
  };
  expect(size(440)).toBe(440);
  expect(size(820)).toBe(560);
  env.width = 440;
});

it("holds the light status bar only in light mode, on screen, over a cover", () => {
  const scrim = (props: { overCover: boolean; hasCover: boolean }, scheme = "light", focused = true) => {
    env.scheme = scheme;
    env.focused = focused;
    const html = renderToStaticMarkup(<AlbumTopScrim {...props} />);
    env.scheme = "dark";
    env.focused = true;
    return html;
  };
  expect(scrim({ overCover: true, hasCover: true })).toContain("light status bar");
  expect(scrim({ overCover: false, hasCover: true })).not.toContain("status bar");
  expect(scrim({ overCover: true, hasCover: false })).not.toContain("status bar");
  expect(scrim({ overCover: true, hasCover: true }, "light", false)).not.toContain("status bar");
  // Dark mode's status bar is light already, so it leaves it to the app.
  expect(scrim({ overCover: true, hasCover: true }, "dark")).not.toContain("status bar");
});

it("hands a cover that fails to load back to the caller", () => {
  env.images = [];
  const onCoverError = vi.fn();
  render({ coverUri: "https://example.com/cover.jpg", onCoverError });
  env.images.forEach((image) => image.onError?.());
  expect(onCoverError).toHaveBeenCalledTimes(1);
});

it("lines the text up with the centred cover on an iPad", () => {
  env.blocks = [];
  render();
  expect(env.blocks.at(-1)?.paddingHorizontal).toBe(24);
  env.width = 820;
  env.blocks = [];
  render();
  // (820 - 560) / 2 + the 24pt gutter.
  expect(env.blocks.at(-1)?.paddingHorizontal).toBe(154);
  env.width = 440;
});

it("keeps iOS's scroll edge blur off the cover, and soft once the songs are under the bar", () => {
  expect(albumScrollEdgeEffects(false).top).toBe("hidden");
  expect(albumScrollEdgeEffects(true).top).toBe("soft");
  expect(albumScrollEdgeEffects(false).bottom).toBe("automatic");
});
