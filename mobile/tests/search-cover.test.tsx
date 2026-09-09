import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CoverArt } from "../components/cover-art";

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PixelRatio: { get: () => 2 },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("expo-image", () => ({
  Image: ({ source }: { source: { uri: string } }) => (
    <img src={source.uri} alt="" />
  ),
}));
vi.mock("@music-library/core", () => ({
  albumCoverUrl: (id: string) => `/local-album/${id}`,
  trackCoverUrl: (track: { id: string }) => `/track/${track.id}`,
  resolveCoverUrl: (url: string) => url,
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ color: { bgElev2: "black" }, radius: { sm: 4 } }),
}));
vi.mock("../lib/downloads", () => ({
  downloadStore: { subscribe: () => () => {}, coverUriFor: () => undefined },
}));

it("renders remote search artwork without a local cover flag", () => {
  const markup = renderToStaticMarkup(
    <CoverArt
      size={40}
      album={{ id: "tidal:42", has_cover: false, cover_url: "/remote-cover" }}
    />,
  );
  expect(markup).toContain('src="/remote-cover"');
  expect(markup).not.toContain("/local-album/");
});

it("keeps artwork-free local albums on their placeholder", () => {
  const markup = renderToStaticMarkup(
    <CoverArt size={40} album={{ id: "local", has_cover: false }} />,
  );
  expect(markup).not.toContain("<img");
});
