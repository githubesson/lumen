import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AlbumHeader, albumHeroScrollState } from "../components/album-header";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  useWindowDimensions: () => ({ width: 440, height: 956 }),
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("expo-symbols", () => ({
  SymbolView: ({ name }: { name: string }) => <i>{name}</i>,
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  selectionAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: "medium" },
}));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 116 }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    scheme: "dark",
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

it("shows the nav title once the hero's title is under the bar, and keeps the status bar light over the cover's top half", () => {
  const geometry = { headerHeight: 116, titleBottom: 390, topInset: 62, coverSize: 440 };
  expect(albumHeroScrollState(0, geometry)).toEqual({ titleShown: false, overCover: true });
  expect(albumHeroScrollState(273, geometry).titleShown).toBe(false);
  expect(albumHeroScrollState(274, geometry).titleShown).toBe(true);
  expect(albumHeroScrollState(157, geometry).overCover).toBe(true);
  expect(albumHeroScrollState(158, geometry).overCover).toBe(false);
});
