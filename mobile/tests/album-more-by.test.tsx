import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ArtistRelease } from "@music-library/core/artist-releases";
import { AlbumMoreBy } from "../components/album-more-by";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children, accessibilityHint }: { children?: ReactNode; accessibilityHint?: string }) => (
    <button title={accessibilityHint}>{children}</button>
  ),
}));
vi.mock("expo-symbols", () => ({ SymbolView: ({ name }: { name: string }) => <i>{name}</i> }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../components/cover-art", () => ({ CoverArt: () => null }));
vi.mock("../components/horizontal-shelf", () => ({
  HorizontalShelf: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
}));
vi.mock("../components/shelf-tile", () => ({
  ShelfTile: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <li>
      {title} / {subtitle}
    </li>
  ),
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ space: { md: 12, lg: 16, xl: 24 }, color: { fg: "#fff", fgMuted: "#888" } }),
}));

const radical: ArtistRelease = {
  id: "tidal:1",
  title: "Radical Optimism",
  track_count: 11,
  release_year: 2024,
  kind: "Album",
  source: "tidal",
  source_id: "1",
};
const render = (props: Partial<React.ComponentProps<typeof AlbumMoreBy>>) =>
  renderToStaticMarkup(
    <AlbumMoreBy artist="Dua Lipa" releases={[radical]} onOpenRelease={() => {}} {...props} />,
  );

it("lists the artist's other releases under a heading that opens the artist", () => {
  const html = render({ onOpenArtist: () => {} });
  expect(html).toContain('<button title="Opens the artist"><span>More by Dua Lipa</span><i>chevron.forward</i></button>');
  expect(html).toContain("<li>Radical Optimism / 2024 · Album</li>");
});

it("keeps the heading plain without an artist page", () => {
  const html = render({});
  expect(html).not.toContain("<button");
  expect(html).not.toContain("chevron.forward");
  expect(html).toContain("More by Dua Lipa");
});

it("shows nothing without other releases or an artist name", () => {
  expect(render({ releases: [] })).toBe("");
  expect(render({ artist: "" })).toBe("");
});
