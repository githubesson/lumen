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
vi.mock("@music-library/core", async () => {
  const media = await import("@music-library/core/api");
  return { albumArtUrl: media.albumArtUrl, trackArtUrl: media.trackArtUrl };
});
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
  expect(markup).not.toContain("/api/albums/");
});

it("sizes remote artwork from our cover endpoints like library covers", () => {
  const album = renderToStaticMarkup(
    <CoverArt size={40} album={{ id: "tidal:42", cover_url: "/api/covers/remote?u=x" }} />,
  );
  expect(album).toContain('src="/api/covers/remote?u=x&amp;size=80"');
  const track = renderToStaticMarkup(
    <CoverArt size={40} track={{ id: "t1", album_id: "a1", cover_url: "/api/covers/remote?u=y" }} />,
  );
  expect(track).toContain('src="/api/covers/remote?u=y&amp;size=80"');
  const local = renderToStaticMarkup(<CoverArt size={40} album={{ id: "a1", has_cover: true }} />);
  expect(local).toContain('src="/api/albums/a1/cover?size=80"');
});

it("never asks the library for a TIDAL release's art", () => {
  const markup = renderToStaticMarkup(
    <CoverArt size={40} album={{ id: "tidal:42", source: "tidal" }} />,
  );
  expect(markup).not.toContain("<img");
});

it("keeps artwork-free local albums on their placeholder", () => {
  const markup = renderToStaticMarkup(
    <CoverArt size={40} album={{ id: "local", has_cover: false }} />,
  );
  expect(markup).not.toContain("<img");
});
