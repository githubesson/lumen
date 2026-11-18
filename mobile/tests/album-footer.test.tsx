import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AlbumFooter } from "../components/album-footer";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ space: { lg: 16, xl: 24 }, color: { fgSubtle: "#eee", fgMuted: "#888" } }),
}));

const footer = (props: Partial<React.ComponentProps<typeof AlbumFooter>>) =>
  renderToStaticMarkup(<AlbumFooter length="13 tracks · 43 min" {...props} />);

it("spells out the release date, then the length and the copyright line", () => {
  const html = footer({ releaseDate: "2020-03-27", releaseYear: 2020, copyright: "© 2020 Label" });
  const date = new Date(Date.UTC(2020, 2, 27)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  expect(html).toBe(`<div><p>${date}</p><p>13 tracks · 43 min</p><p>© 2020 Label</p></div>`);
});

it("falls back to the year, and leaves out what it doesn't know", () => {
  expect(footer({ releaseDate: "2020", releaseYear: 2020 })).toBe(
    "<div><p>2020</p><p>13 tracks · 43 min</p></div>",
  );
  expect(footer({})).toBe("<div><p>13 tracks · 43 min</p></div>");
});
